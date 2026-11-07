'use strict';
// 可选的本地 QQ 历史消息恢复。
// 只在用户明确开启后运行，且只在当前登录 QQ 进程中读取匹配 salt 的密钥候选。
// 密钥和明文仅内存使用；查询后立即释放，不写回原始 QQ 数据库。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { decryptDatabase } = require('./sqlcipher.js');
const { decode, last, str, num, buf } = require('./proto.js');

var outputFn = console.log;
var configGetter = null;
var currentRecovery = null;
var lastAttemptAt = 0;
var lastError = '';
var nextAttemptAt = 0;
var recoveredCount = 0;
var dbCache = new Map();
var mediaIndexCache = new Map();
var recoveryGeneration = 0;
var cleanupTimer = null;

function setOutput(fn) { outputFn = fn; }
function setConfigGetter(fn) { configGetter = fn; }
function output(...args) { outputFn(...args); }
function cfg() { return configGetter ? configGetter() : {}; }
function enabled() {
  const policy = require('./stealthNet.js').resolvePolicy();
  return cfg().enableHistoryRecovery === true && process.platform === 'win32' && policy.directDownload;
}

function connectionAllowed() {
  const policy = require('./stealthNet.js').resolvePolicy();
  return cfg().enableHistoryRecovery === true && process.platform === 'win32' && policy.directDownload;
}

function dataRoots() {
  const roots = [];
  const home = os.homedir();
  if (process.env.QQNT_TENCENT_FILES) roots.push(process.env.QQNT_TENCENT_FILES);
  for (const base of [path.join(home, 'Documents'), path.join(home, '文档'), path.join(home, 'OneDrive', 'Documents')]) {
    roots.push(path.join(base, 'Tencent Files'));
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) roots.push(path.join(drive + path.sep, 'Documents', 'Tencent Files'));
  return [...new Set(roots)].filter((p) => fs.existsSync(p));
}

function findAccounts() {
  const accounts = [];
  for (const root of dataRoots()) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'nt_qq') continue;
      const dir = path.join(root, entry.name);
      const dbDir = path.join(dir, 'nt_qq', 'nt_db');
      if (fs.existsSync(path.join(dbDir, 'nt_msg.db')) && fs.statSync(path.join(dbDir, 'nt_msg.db')).size > 5120) {
        accounts.push({ qq: entry.name, dir, dbDir });
      }
    }
  }
  return accounts;
}

function chooseAccount(accounts) {
  const configured = cfg().historyQqNumber ? String(cfg().historyQqNumber) : '';
  if (configured) return accounts.find((a) => a.qq === configured) || null;
  return accounts.length === 1 ? accounts[0] : null;
}

function selfUid(account) {
  const paths = [
    path.join(account.dir, 'nt_qq', 'global', 'nt_data', 'mmkv', 'nt_mmkv_global_misc'),
    path.join(account.dir, '..', 'nt_qq', 'global', 'nt_data', 'mmkv', 'nt_mmkv_global_misc'),
  ];
  for (const p of paths) {
    try {
      const content = fs.readFileSync(p).toString('latin1');
      const at = content.indexOf('kAutoLoginUid');
      const match = at >= 0 && content.slice(at, at + 120).match(/u_[A-Za-z0-9_-]{10,}/);
      if (match) return match[0];
    } catch {}
  }
  return null;
}

function keyCandidates(account) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'scan-keys-memory.ps1'), '-DbDir', account.dbDir,
    ], { windowsHide: true, timeout: 180000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const outputText = Buffer.from(stdout || []).toString('utf8');
      const errorText = Buffer.from(stderr || []).toString('utf8');
      if (error && (error.killed || error.signal === 'SIGTERM')) {
        return reject(new Error('历史库验证超时，请稍后重试或重启 QQ'));
      }
      let result = null;
      try { result = JSON.parse(outputText.trim()); } catch {}
      if (result && Array.isArray(result.candidates)) {
        const candidates = result.candidates.filter((line) => /^[0-9a-f]{64} [0-9a-f]{32}$/i.test(line))
          .map((line) => ({ key: line.slice(0, 64), salt: line.slice(65) }));
        if (result.ok) return resolve(candidates);
        const messages = {
          NO_QQ: 'QQ 未登录，或尚未加载消息数据库；登录并进入聊天窗口后重试',
          NO_KEY: '未找到匹配的历史库密钥，请保持 QQ 登录后重试',
          NO_DB: '未找到可读取的 QQ 历史数据库',
          SCAN_ERROR: '无法读取当前 QQ 的历史库密钥，请检查登录状态及权限',
        };
        return reject(new Error(messages[result.code] || '本机历史库连接验证失败'));
      }
      output('History key scanner failed:', errorText || error?.message || outputText.slice(0, 300));
      reject(new Error('历史库连接程序异常，请确认 QQ 已登录后重试'));
    });
  });
}

function decryptMessages(account) {
  const source = fs.readFileSync(path.join(account.dbDir, 'nt_msg.db'));
  const walPath = path.join(account.dbDir, 'nt_msg.db-wal');
  const wal = fs.existsSync(walPath) ? fs.readFileSync(walPath) : null;
  return keyCandidates(account).then((candidates) => {
    for (const candidate of candidates) {
      const result = decryptDatabase(source, Buffer.from(candidate.key, 'hex'), wal);
      if (result.ok) return result;
    }
    throw new Error('未找到能通过数据库校验的密钥；QQ 需要保持登录状态');
  });
}

function openPlaintextDatabase(account) {
  const existing = dbCache.get(account.qq);
  if (existing && Date.now() - existing.createdAt < 60000) return Promise.resolve(existing);
  if (existing) {
    try { existing.db.close(); } catch {}
    try { fs.rmSync(existing.tempDir, { recursive: true, force: true }); } catch {}
    dbCache.delete(account.qq);
  }
  return decryptMessages(account).then((result) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-recall-history-'));
    try {
      const tempFile = path.join(tempDir, 'nt_msg.db');
      fs.writeFileSync(tempFile, result.buffer, { flag: 'wx' });
      const db = new DatabaseSync(tempFile, { readOnly: true });
      const entry = { db, tempDir, tempFile, createdAt: Date.now() };
      dbCache.set(account.qq, entry);
      // 明文快照只作短时查询缓存，60 秒到期自动删除，无需等待退出
      cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        closePlaintextDatabases();
      }, 60000);
      cleanupTimer.unref?.();
      return entry;
    } catch (error) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  });
}

function closePlaintextDatabases() {
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  for (const entry of dbCache.values()) {
    try { entry.db.close(); } catch {}
    try { fs.rmSync(entry.tempDir, { recursive: true, force: true }); } catch {}
  }
  dbCache.clear();
  mediaIndexCache.clear();
}

function indexMedia(account) {
  if (mediaIndexCache.has(account.qq)) return mediaIndexCache.get(account.qq);
  const files = new Map();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else {
        const match = entry.name.match(/^([0-9a-f]{32})/i);
        if (match) files.set(match[1].toLowerCase(), fullPath);
      }
    }
  }
  for (const sub of ['Pic', 'Video', 'Ptt', 'File']) walk(path.join(account.dir, 'nt_qq', 'nt_data', sub));
  mediaIndexCache.set(account.qq, files);
  return files;
}

function mediaPath(files, value) {
  if (!value || value.length !== 16) return '';
  return files.get(value.toString('hex')) || '';
}

function textElement(fields) {
  const text = buf(fields, 45101);
  if (!text) return null;
  const nested = decode(text);
  if (nested.length && nested[0].field === 45101 && nested[0].wire === 2) return nested[0].value.toString('utf8');
  if (nested.some((x) => x.field === 45102 || x.field === 45103)) {
    return nested.map((x) => (x.field === 45101 || x.field === 45107) ? x.value.toString('utf8') : (x.field === 45102 ? '@' : '')).join('');
  }
  return text.toString('utf8');
}

function buildElements(blob, files) {
  const outer = decode(blob);
  const rawElements = outer.filter((x) => x.field === 40800 && x.wire === 2).map((x) => x.value);
  const elements = [];
  for (const raw of (rawElements.length ? rawElements : [blob])) {
    const fields = decode(raw);
    const type = num(fields, 45002) || 0;
    if (type === 1) {
      const content = textElement(fields);
      if (content) elements.push({ elementType: 1, elementId: '0', textElement: { content, atType: 0, atUid: '', atNtUid: '' } });
    } else if (type === 2) {
      const md5 = buf(fields, 45406);
      const url = str(fields, 45802) || str(fields, 45803) || str(fields, 45804);
      const local = mediaPath(files, md5);
      elements.push({ elementType: 2, elementId: '0', picElement: {
        picSubType: 0, fileName: str(fields, 45402), picWidth: num(fields, 45411) || 0,
        picHeight: num(fields, 45412) || 0, original: true,
        md5HexStr: md5 ? md5.toString('hex').toUpperCase() : '', sourcePath: local,
        originImageUrl: url.startsWith('http') ? url : (url ? 'https://multimedia.nt.qq.com.cn' + url : ''),
        thumbPath: local ? new Map([[0, local], [198, local], [720, local]]) : new Map(),
      } });
    } else if (type === 3 || type === 4 || type === 5) {
      const md5 = buf(fields, 45406);
      const local = mediaPath(files, md5);
      const url = str(fields, 45802) || str(fields, 45803) || str(fields, 45804);
      const fullUrl = url.startsWith('http') ? url : (url ? 'https://multimedia.nt.qq.com.cn' + url : '');
      const common = { fileName: str(fields, 45402), filePath: local, fileSize: String(num(fields, 45405) || 0), md5HexStr: md5 ? md5.toString('hex').toUpperCase() : '', url: fullUrl };
      if (type === 3) elements.push({ elementType: 3, elementId: '0', fileElement: common });
      else if (type === 4) elements.push({ elementType: 4, elementId: '0', pttElement: { ...common, duration: num(fields, 45410) || num(fields, 45905) || 0 } });
      else elements.push({ elementType: 5, elementId: '0', videoElement: { ...common, videoDuration: num(fields, 45410) || 0, thumbPath: local } });
    } else if (type === 6) {
      const id = num(fields, 47601);
      if (id != null) elements.push({ elementType: 6, elementId: '0', faceElement: { faceIndex: id, faceType: 1 } });
    } else if (type === 7) {
      const reply = buf(fields, 47423);
      if (reply) {
        const d = decode(reply);
        elements.push({ elementType: 7, elementId: '0', replyElement: { sourceMsgId: String(num(d, 45001) || '0'), sourceMsgText: str(d, 45101) } });
      }
    } else if (type === 10) elements.push({ elementType: 10, elementId: '0', arkElement: { bytesData: raw.toString('utf8') } });
    else if (type === 14) {
      const content = str(fields, 48701);
      if (content) elements.push({ elementType: 14, elementId: '0', markdownElement: { content } });
    } else if (type === 16) elements.push({ elementType: 16, elementId: '0', multiForwardMsgElement: { xmlContent: raw.toString('utf8'), multiMsgItem: { msgList: [] } } });
  }
  return elements;
}

function rowToMessage(row, files) {
  const elements = buildElements(Buffer.from(row.content || []), files);
  if (!elements.length) return null;
  return {
    msgId: String(row.id), msgRandom: String(row.random || '0'), msgSeq: String(row.seq || '0'),
    cntSeq: '0', chatType: row.chatType || 2, msgType: 2, subMsgType: 0,
    sendType: 0, senderUid: String(row.sender || ''), peerUid: String(row.peer || ''),
    channelId: '', guildId: '', guildCode: '0', fromAppid: '0', fromUid: String(row.sender || ''),
    fromNtUid: String(row.sender || ''), fromChannelId: '', fromGuildId: '', fromGroupCode: '0',
    time: String(row.time || 0), msgTime: String(row.time || 0), msgDate: String(row.time || 0),
    sendStatus: 2, isOnlineMsg: true, elements,
  };
}

function queryMessage(entry, msgId) {
  for (const table of ['group_msg_table', 'c2c_msg_table']) {
    const statement = entry.db.prepare(`SELECT "40001" id, "40002" random, "40003" seq, "40010" chatType, "40020" sender, "40021" peer, "40050" time, "40800" content FROM ${table} WHERE "40001" = ? LIMIT 1`);
    statement.setReadBigInts(true);
    const row = statement.get(BigInt(msgId));
    if (row) return row;
  }
  return null;
}

async function recoverMessage(msgId) {
  if (!enabled() || !/^\d+$/.test(String(msgId))) return null;
  if (Date.now() < nextAttemptAt) return null;
  // 多线程/批量撤回共享一次恢复查询，避免重复扫描进程和全库解密
  if (currentRecovery) {
    await currentRecovery;
    return recoverMessage(msgId);
  }
  currentRecovery = (async () => {
    const generation = recoveryGeneration;
    try {
      const accounts = findAccounts();
      const account = chooseAccount(accounts);
      if (!account) throw new Error(accounts.length ? '检测到多个 QQ 账号，请在设置中填写要恢复的 QQ 号' : '未找到本机 QQ 历史数据库');
      const entry = await openPlaintextDatabase(account);
      const row = queryMessage(entry, String(msgId));
      if (!row) {
        lastError = '';
        return null;
      }
      const msg = rowToMessage(row, indexMedia(account));
      if (!msg || generation !== recoveryGeneration || !enabled()) return null;
      recoveredCount++;
      lastError = '';
      return { id: String(msgId), sender: msg.peerUid, msg };
    } catch (error) {
      lastError = error.message;
      // 失败后退避，避免批量历史撤回时反复扫描 QQ 进程
      nextAttemptAt = Date.now() + 60000;
      output('Local history recovery unavailable:', error.message);
      return null;
    } finally {
      lastAttemptAt = Date.now();
      currentRecovery = null;
    }
  })();
  return currentRecovery;
}

function reset() {
  recoveryGeneration++;
  nextAttemptAt = 0;
  currentRecovery = null;
  closePlaintextDatabases();
}

function status() {
  return {
    enabled: enabled(), supported: process.platform === 'win32',
    requested: cfg().enableHistoryRecovery === true,
    connectionAllowed: connectionAllowed(),
    accounts: findAccounts().map((a) => a.qq), recoveredCount,
    selectedAccount: chooseAccount(findAccounts())?.qq || null,
    lastAttemptAt: lastAttemptAt || null, lastError,
    nextAttemptAt: nextAttemptAt || null,
    note: '只能恢复曾经同步到本机的原文；离线期间从未到达本机的消息无法恢复。',
  };
}

async function testConnection() {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  if (cfg().enableHistoryRecovery !== true) return { ok: false, error: '请先启用本地历史恢复' };
  if (!connectionAllowed()) return { ok: false, error: '完全隐身/偏执模式不会扫描 QQ 进程，请切换到自动或严格模式' };
  try {
    const accounts = findAccounts();
    const account = chooseAccount(accounts);
    if (!account) throw new Error(accounts.length ? '检测到多个 QQ 账号，请先填写 QQ 号' : '未找到本机 QQ 历史数据库');
    const entry = await openPlaintextDatabase(account);
    // 只检查消息表和计数，不读取消息正文；损坏的解密快照不能报成功
    const tables = entry.db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)').all('table', 'group_msg_table', 'c2c_msg_table');
    if (!tables.length) throw new Error('历史库未找到消息表，请等待 QQ 完成登录同步后重试');
    for (const table of tables) {
      if (table.name === 'group_msg_table' || table.name === 'c2c_msg_table') {
        entry.db.prepare(`SELECT COUNT(*) AS count FROM ${table.name}`).get();
      }
    }
    closePlaintextDatabases();
    lastError = '';
    return { ok: true, account: account.qq, message: '本机历史库连接验证通过，未读取消息正文' };
  } catch (error) {
    lastError = /malformed|not a database/i.test(error.message)
      ? '历史库快照校验失败，QQ 正在更新数据库；请稍后重新测试'
      : error.message;
    closePlaintextDatabases();
    return { ok: false, error: error.message };
  }
}

module.exports = { setOutput, setConfigGetter, recoverMessage, testConnection, reset, status, closePlaintextDatabases, findAccounts, buildElements, queryMessage, rowToMessage };
