'use strict';
// QQ NT 的 SQLCipher 页格式（已由页 1 HMAC 双向验证确认）
//
// 文件布局：
//   [0, 1024)            QQ 自定义明文头
//                        0x00 'SQLite header 3\0'  ← 伪造的，真库是 'SQLite format 3\0'
//                        0x20 'QQ_NT DB'
//                        0x2f 起 128 hex = key_meta（服务器兑换凭证，不是密码）
//                        0xaf 起 protobuf: 3='1.1.0.1' 4='HMAC_SHA1' 5=<varint>
//   [1024, 1040)         本库独有的 salt（16 字节，每库不同）
//   [1040, 1040+PAGE)    page 1
//   ...                  每页 PAGE 字节
//
// 单页布局（PAGE=4096, RESERVE=48）：
//   page1 : [0,16) salt | [16, 4048) AES-256-CBC(real[16..4048]) | [4048,4064) iv | [4064,4084) hmac | [4084,4096) pad
//   pageN : [0, 4048)    AES-256-CBC(real[0..4048])            | [4048,4064) iv | [4064,4084) hmac | [4084,4096) pad
//
// 注意 page1 的真实前 16 字节（'SQLite format 3\0' + 页大小/版本字段的开头）从不落盘，
// 盘上那个位置被 salt 占了，所以解密时要自己补魔数。

const crypto = require('crypto');

const PAGE = 4096;
const RESERVE = 48;
const USABLE = PAGE - RESERVE; // 4048
const MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
const QQ_HDR = 1024;
const QQ_HDR_MAGIC = 'SQLite header 3\u0000';

/** 文件是否带 QQ 的 1024 字节自定义头 */
function hasQQHeader(buf) {
  return buf.length >= 16 && buf.subarray(0, 16).toString('latin1') === QQ_HDR_MAGIC;
}

/** 头长度：带 QQ 头就是 1024，否则 0（纯 SQLCipher 库） */
function headerLen(buf) { return hasQQHeader(buf) ? QQ_HDR : 0; }

/** 取某页参与加密/校验的那段（page1 要跳过前 16 字节 salt） */
function pageSlice(buf, base, isPage1) {
  return isPage1 ? buf.subarray(base + 16, base + PAGE) : buf.subarray(base, base + PAGE);
}

function ivOf(enc) { return enc.subarray(enc.length - RESERVE, enc.length - RESERVE + 16); }
function macOf(enc) { return enc.subarray(enc.length - RESERVE + 16, enc.length - RESERVE + 36); }
function ctOf(enc) { return enc.subarray(0, enc.length - RESERVE); }

/**
 * 页 1 HMAC 校验——这是判断"key 对不对"的唯一可靠手段。
 * 做法：hmacKey = PBKDF2-SHA512(rawKey32, salt XOR 0x3a, 2 iters, 32B)
 *       mac = HMAC-SHA1(ct || iv || LE32(pgno))
 */
function verifyKey(enc, key, salt, pgno) {
  const saltXor = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) saltXor[i] = salt[i] ^ 0x3a;
  const hmacKey = crypto.pbkdf2Sync(key, saltXor, 2, 32, 'sha512');
  const pg = Buffer.alloc(4);
  pg.writeUInt32LE(pgno, 0);
  const mac = crypto.createHmac('sha1', hmacKey)
    .update(ctOf(enc)).update(ivOf(enc)).update(pg).digest();
  return mac.equals(macOf(enc));
}

/** 解一页，返回 4096 字节明文（page1 会补回魔数） */
function decryptPage(enc, key, isPage1) {
  const d = crypto.createDecipheriv('aes-256-cbc', key, ivOf(enc));
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(ctOf(enc)), d.final()]);
  const out = Buffer.alloc(plain.length + (isPage1 ? 16 : 0));
  if (isPage1) { MAGIC.copy(out, 0); plain.copy(out, 16); } else plain.copy(out, 0);
  return out;
}

/**
 * 解整库。返回 { ok, salt, pages, badPages, walPages, buffer } 或 { ok:false, reason }
 *
 * @param {Buffer} src     原始文件内容（带 QQ 头的副本）
 * @param {Buffer} key     32 字节原始 AES key
 * @param {Buffer} [wal]   同名 -wal 文件内容（可选，但强烈建议带上）
 */
function decryptDatabase(src, key, wal) {
  const HDR = headerLen(src);
  if (src.length < HDR + PAGE) return { ok: false, reason: 'file too small' };
  const salt = Buffer.from(src.subarray(HDR, HDR + 16));

  const p1 = pageSlice(src, HDR, true);
  if (!verifyKey(p1, key, salt, 1)) {
    return { ok: false, reason: 'page1 hmac mismatch', salt: salt.toString('hex') };
  }

  const filePages = Math.floor((src.length - HDR) / PAGE);
  const pages = new Map();
  const bad = [];
  const empty = [];
  let declared = filePages;

  // 页 1 的明文字段 offset 28 是库实际使用的页数；文件尾部常有用零预留的空间
  const p1plain = decryptPage(p1, key, true);
  const declaredPages = p1plain.readUInt32BE(28);
  if (declaredPages > 0 && declaredPages <= filePages) declared = declaredPages;

  for (let i = 1; i <= filePages; i++) {
    const enc = pageSlice(src, HDR + (i - 1) * PAGE, i === 1);
    // 全零页是预分配但还没写的空间，不是坏页
    let allZero = true;
    for (let k = 0; k < enc.length; k += 64) {
      if (enc[k] !== 0 || enc[k + 1] !== 0) { allZero = false; break; }
    }
    if (allZero) { empty.push(i); continue; }

    if (!verifyKey(enc, key, salt, i)) bad.push(i);
    pages.set(i, i === 1 ? p1plain : decryptPage(enc, key, false));
  }

  // WAL：32 字节头 + 每帧 (24 头 + PAGE 数据)。页 1 的帧要额外核对 salt。
  let walPages = 0;
  if (wal && wal.length > 32) {
    const FRAME = 24 + PAGE;
    for (let off = 32; off + FRAME <= wal.length; off += FRAME) {
      const pgno = wal.readUInt32BE(off);
      if (pgno === 0) continue;
      const frame = wal.subarray(off + 24, off + 24 + PAGE);
      let plain;
      if (pgno === 1) {
        if (!frame.subarray(0, 16).equals(salt)) continue;
        plain = decryptPage(frame.subarray(16), key, true);
      } else {
        plain = decryptPage(frame, key, false);
      }
      pages.set(pgno, plain);
      walPages++;
    }
  }

  const maxPage = Math.max(declared, ...pages.keys());
  const out = Buffer.alloc(maxPage * PAGE);
  for (const [n, p] of pages) p.copy(out, (n - 1) * PAGE);
  return {
    ok: true, salt: salt.toString('hex'), pages: filePages,
    declaredPages: declared, outPages: maxPage,
    badPages: bad, emptyPages: empty.length, walPages, buffer: out,
  };
}

module.exports = {
  PAGE, RESERVE, USABLE, MAGIC, QQ_HDR,
  hasQQHeader, headerLen, verifyKey, decryptPage, decryptDatabase,
};
