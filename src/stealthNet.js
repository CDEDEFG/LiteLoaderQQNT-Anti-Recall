// ============================================================
// 反风控引擎 v4.0 - 策略驱动统一架构
// ============================================================
//
// 设计目标:
//   1. 拦截面(本地IPC) — 服务端永远不可见, 这一层是绝对的
//   2. 下载面(网络流量) — 与正常 QQ 渲染进程行为无法区分
//   3. 可配置性 — 所有行为可由用户在设置页调整
//   4. 自适应 — 根据环境信号自动升降级, 日常无感
//
// 与 v3.0 架构差异:
//   - v3.0: 十层防护 + 七模块固定全开, 无法调节, 设置页无控制
//   - v4.0: 单一引擎, 策略预设驱动, 每个防护都可配置/关闭
//
// 风控模式预设:
//   auto (默认)     标准十层防护, 白天120/分, 夜间60/分, 威胁自动降级
//   strict          低速率(30/分), 强化延迟, 检测到一次异常就降速
//   paranoid        只保留 URL 劫持(让 QQ 自己去拉), 插件零直接请求
//   off             关闭一切伪装, 裸请求 (仅限调试)
//
// 防护分工 (核心洞察):
//   - 图片/视频 → URL 劫持优先 (让 QQ 自己的请求去拉, 插件零特征)
//   - 语音/文件 → 伪装下载 (插件代拉, 带完整浏览器指纹)
//   - 文本/表情 → 零网络 (纯内存恢复)
//   - 合并转发 → 递归处理子消息 (每个子消息按自身类型处理)
// ============================================================

const https = require("https");
const http = require("http");
const { URL } = require("url");

var outputFn = console.log;
function setOutput(fn) { outputFn = fn; }
function output(...args) { outputFn(...args); }

// ============================================================
// 配置桥: 从主配置读取风控设置
// ============================================================

// configGetter 由 main.js 注入, 返回完整的插件配置
var configGetter = null;
function setConfigGetter(fn) { configGetter = fn; }

function cfg() {
  var c = configGetter ? configGetter() : {};
  return {
    antiRiskMode: c.antiRiskMode || "auto",
    stealthLevel: c.stealthLevel != null ? c.stealthLevel : 2,
    maxDownloadPerMinute: c.maxDownloadPerMinute || 120,
    enableBehaviorLearning: c.enableBehaviorLearning !== false,
    enableThreatResponse: c.enableThreatResponse !== false,
    disableImgDownload: !!c.disableImgDownload,
    enableUrlHijack: c.enableUrlHijack !== false,
    enableMultiForwardDownload: c.enableMultiForwardDownload !== false,
  };
}

// ============================================================
// 模式解析: 把用户选择的模式解析成运行时参数
// ============================================================

function resolvePolicy() {
  var c = cfg();

  // 最高优先级: 完全禁用媒体下载 (最大隐身, 用户主动选择)
  if (c.disableImgDownload) {
    return {
      name: "disabled",
      directDownload: false,     // 插件不直接请求网络
      urlHijack: false,          // 也不劫持 (因为劫持后 QQ 会去拉)
      multiForward: false,
      ratePerMinute: 0,
      stealth: 0,
    };
  }

  // paranoid: 只让 QQ 自己去拉, 插件零网络特征
  if (c.antiRiskMode === "paranoid") {
    return {
      name: "paranoid",
      directDownload: false,     // 插件零直接请求
      urlHijack: c.enableUrlHijack, // 但保留 URL 劫持 (QQ 自己拉)
      multiForward: c.enableMultiForwardDownload, // 合并转发只处理文本层
      ratePerMinute: 0,
      stealth: 0,
    };
  }

  // strict: 低速率 + 强化伪装
  if (c.antiRiskMode === "strict") {
    return {
      name: "strict",
      directDownload: true,
      urlHijack: c.enableUrlHijack,
      multiForward: c.enableMultiForwardDownload,
      ratePerMinute: Math.min(c.maxDownloadPerMinute, 30),
      stealth: Math.max(c.stealthLevel, 3),
      delayMultiplier: 2.5,      // 延迟放大 2.5 倍
    };
  }

  // off: 关闭伪装 (调试用途)
  if (c.antiRiskMode === "off") {
    return {
      name: "off",
      directDownload: true,
      urlHijack: c.enableUrlHijack,
      multiForward: c.enableMultiForwardDownload,
      ratePerMinute: 9999,       // 不限速
      stealth: 0,
      delayMultiplier: 0,
    };
  }

  // auto (默认): 标准防护, 时间自适应
  var hour = new Date().getHours();
  var isNight = hour >= 0 && hour < 6;
  var rate = c.maxDownloadPerMinute;
  if (isNight) rate = Math.floor(rate / 2); // 夜间减半, 更像真实用户

  return {
    name: "auto",
    directDownload: true,
    urlHijack: c.enableUrlHijack,
    multiForward: c.enableMultiForwardDownload,
    ratePerMinute: rate,
    stealth: c.stealthLevel,
    delayMultiplier: 1,
  };
}

// ============================================================
// L1: 浏览器指纹 (按 stealth 等级启用)
// ============================================================

var FINGERPRINTS = [
  { major: "120", full: "120.0.0.0", platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"', brand: '"Google Chrome"' },
  { major: "119", full: "119.0.0.0", platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"', brand: '"Google Chrome"' },
  { major: "121", full: "121.0.0.0", platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"', brand: '"Google Chrome"' },
  { major: "120", full: "120.0.0.0", platform: "Windows NT 10.0; WOW64",      secPlatform: '"Windows"', brand: '"Google Chrome"' },
];

var sessionFP = null;
var fpDate = "";

function getFingerprint() {
  var today = new Date().toDateString();
  if (!sessionFP || fpDate !== today) {
    fpDate = today;
    sessionFP = FINGERPRINTS[Math.floor(Math.random() * FINGERPRINTS.length)];
  }
  return sessionFP;
}

function buildReferer(url) {
  try {
    var u = new URL(url);
    if (u.hostname.endsWith(".qq.com") || u.hostname.endsWith(".qpic.cn")) return "https://im.qq.com/";
    return u.origin + "/";
  } catch { return "https://im.qq.com/"; }
}

// stealth >= 1: 完整请求头; stealth 0: 最少请求头
function buildHeaders(url) {
  if (cfg().stealthLevel < 1) {
    return { "User-Agent": "Mozilla/5.0" }; // 最少伪装 (off 模式)
  }
  var fp = getFingerprint();
  return {
    "User-Agent": `Mozilla/5.0 (${fp.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.full} Safari/537.36`,
    "Accept": url.includes("/download") || url.includes("fileid=")
      ? "*/*"
      : "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "identity",
    "Referer": buildReferer(url),
    "sec-ch-ua": `"Not_A Brand";v="8", "Chromium";v="${fp.major}", ${fp.brand};v="${fp.major}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": fp.secPlatform,
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
  };
}

// ============================================================
// L2: 行为延迟 (stealth >= 1 启用, AI 学习可接管)
// ============================================================

// 四种人类行为模式
var BEHAVIOR = {
  SCROLLING: { min: 30,  max: 90 },
  READING:   { min: 180, max: 550 },
  PAUSED:    { min: 2000, max: 7000 },
  RETURNING: { min: 90,  max: 280 },
};
var currentMode = "READING";
var modeChangedAt = Date.now();

function pickMode() {
  // 每 10-60 秒自然切换行为模式
  if (Date.now() - modeChangedAt > 10000 + Math.random() * 50000) {
    var keys = Object.keys(BEHAVIOR);
    currentMode = keys[Math.floor(Math.random() * keys.length)];
    modeChangedAt = Date.now();
  }
  return BEHAVIOR[currentMode];
}

// AI 学习: 从历史下载间隔学出用户的"自然节奏"
var learner = {
  samples: [],
  learnedAvg: 300,
  learnedStd: 120,
  record(interval) {
    this.samples.push(interval);
    if (this.samples.length > 100) this.samples.shift();
    if (this.samples.length >= 10) {
      var avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      var variance = this.samples.reduce((a, b) => a + (b - avg) * (b - avg), 0) / this.samples.length;
      this.learnedAvg = avg;
      this.learnedStd = Math.sqrt(variance);
    }
  },
  // Box-Muller 正态采样, 返回符合用户自然节奏的延迟
  sample() {
    var u = Math.random(), v = Math.random();
    var z = Math.sqrt(-2 * Math.log(Math.max(u, 1e-9))) * Math.cos(2 * Math.PI * v);
    var d = this.learnedAvg + z * this.learnedStd;
    return Math.max(40, Math.min(2500, d));
  },
};

var lastDownloadAt = 0;

async function preDownloadDelay() {
  var policy = resolvePolicy();
  if (policy.stealth < 1 || policy.delayMultiplier === 0) return;

  var delay;
  if (cfg().enableBehaviorLearning && learner.samples.length >= 10) {
    // AI 学习模式: 用学出的自然节奏
    delay = learner.sample();
  } else {
    // 内置行为模式
    var m = pickMode();
    delay = m.min + Math.random() * (m.max - m.min);
  }
  delay *= policy.delayMultiplier;

  await new Promise(function (r) { setTimeout(r, delay); });

  // 记录本次间隔供学习
  var now = Date.now();
  if (lastDownloadAt > 0) learner.record(now - lastDownloadAt);
  lastDownloadAt = now;
}

// ============================================================
// L3: 威胁情报 (stealth >= 3 或 enableThreatResponse 时启用)
// ============================================================

var threat = {
  level: "LOW",   // LOW / MEDIUM / HIGH / CRITICAL
  signals: [],
  configKey: "",

  report(type, detail) {
    if (!cfg().enableThreatResponse) return;
    this.signals.push({ type: type, time: Date.now(), detail: detail || "" });
    // 只保留 5 分钟内的信号
    var cutoff = Date.now() - 300000;
    this.signals = this.signals.filter(function (s) { return s.time > cutoff; });
    this.assess();
  },

  assess() {
    var score = 0;
    for (var s of this.signals) {
      switch (s.type) {
        case "http_403": score += 3; break;
        case "http_429": score += 5; break;
        case "conn_reset": score += 4; break;
        case "timeout": score += 1; break;
        case "cert_error": score += 3; break;
        default: score += 1;
      }
    }
    var prev = this.level;
    if (score >= 15) this.level = "CRITICAL";
    else if (score >= 10) this.level = "HIGH";
    else if (score >= 5) this.level = "MEDIUM";
    else this.level = "LOW";

    if (this.level !== prev) {
      output("Threat level changed:", prev, "->", this.level, "(" + this.signals.length + " signals)");
    }
  },

  // 威胁级别对实际速率的修正
  rateOverride() {
    // 关闭威胁响应时必须立即恢复策略速率，不能沿用历史异常级别
    if (!cfg().enableThreatResponse) return null;
    switch (this.level) {
      case "CRITICAL": return 0;
      case "HIGH": return 5;
      case "MEDIUM": return Math.floor(resolvePolicy().ratePerMinute / 3);
      default: return null; // 用策略默认
    }
  },

  status() {
    return {
      level: this.level,
      signals: this.signals.length,
      policy: resolvePolicy().name,
      effectiveRate: this.rateOverride() != null ? this.rateOverride() : resolvePolicy().ratePerMinute,
    };
  },
};

// ============================================================
// L4: 速率控制 (令牌桶 + 时间感知)
// ============================================================

var rateWindow = [];

function canDownload() {
  var policy = resolvePolicy();
  var limit = threat.rateOverride();
  if (limit == null) limit = policy.ratePerMinute;
  if (limit <= 0) return false;

  var cutoff = Date.now() - 60000;
  rateWindow = rateWindow.filter(function (t) { return t > cutoff; });
  return rateWindow.length < limit;
}

function recordDownload() {
  rateWindow.push(Date.now());
}

// ============================================================
// L5: 会话管理 (连接池 + Cookie, stealth >= 1)
// ============================================================

var agents = new Map();
var cookies = new Map();

function getAgent(domain, isHttps) {
  if (cfg().stealthLevel < 1) return undefined; // off 模式用默认
  if (!agents.has(domain)) {
    var opts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 6, timeout: 15000 };
    agents.set(domain, isHttps ? new https.Agent(opts) : new http.Agent(opts));
  }
  return agents.get(domain);
}

function getCookie(domain) {
  if (!cookies.has(domain)) {
    cookies.set(domain, "pgv_pvi=" + Math.floor(Math.random() * 1e10));
  }
  return cookies.get(domain);
}

// ============================================================
// 域名安全: 只信任腾讯系域名 (所有模式都启用, 这是安全底线)
// ============================================================

function isTrustedUrl(url) {
  try {
    var u = new URL(url);
    return u.hostname.endsWith(".qq.com") || u.hostname.endsWith(".qpic.cn") || u.hostname.endsWith(".qq.com.cn");
  } catch { return false; }
}

// ============================================================
// 核心请求 (所有防护在此汇合)
// ============================================================

function stealthRequest(url, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    if (!isTrustedUrl(url)) {
      return reject(new Error("Untrusted domain rejected"));
    }
    var target;
    try { target = new URL(url); } catch (e) { return reject(new Error("Invalid URL")); }

    var isHttps = target.protocol === "https:";
    var protocol = isHttps ? https : http;
    var headers = buildHeaders(url);

    // stealth >= 1: 带会话 cookie
    if (cfg().stealthLevel >= 1 && options.noCookie !== true) {
      headers["Cookie"] = getCookie(target.hostname);
    }

    var reqOpts = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      headers: headers,
      timeout: options.timeout || 15000,
      agent: getAgent(target.hostname, isHttps),
    };

    var req = protocol.get(reqOpts, function (res) {
      // 重定向跟随 (浏览器行为)
      if (res.statusCode >= 300 && res.statusCode <= 399 && res.headers.location) {
        res.resume();
        var redirectUrl = new URL(res.headers.location, url).toString();
        if (!isTrustedUrl(redirectUrl)) return reject(new Error("Redirect to untrusted domain"));
        return resolve(stealthRequest(redirectUrl, options));
      }

      // 威胁信号采集
      if (res.statusCode === 403) threat.report("http_403", url);
      if (res.statusCode === 429) threat.report("http_429", url);

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }

      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { resolve(Buffer.concat(chunks)); });
      res.on("error", function (e) { threat.report("conn_reset", e.message); reject(e); });
    });

    req.on("error", function (e) {
      if (e.message === "timeout" || e.code === "ETIMEDOUT") threat.report("timeout", url);
      reject(e);
    });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
  });
}

// 重试: stealth >= 2 启用浏览器式指数退避
async function retryRequest(url, options) {
  var attempts = cfg().stealthLevel >= 2 ? 3 : 1;
  var lastErr = null;
  for (var i = 0; i < attempts; i++) {
    try {
      return await stealthRequest(url, options);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        var backoff = Math.pow(2, i) * 1000 * (cfg().stealthLevel >= 3 ? 1.5 : 1);
        await new Promise(function (r) { setTimeout(r, backoff); });
      }
    }
  }
  throw lastErr;
}

// ============================================================
// 对外主接口: 是否允许/执行直接下载
// ============================================================

// 判断是否应该下载某条消息的资源 (由 downloadQueue/imgDownloader 调用)
function shouldDownloadResources(msgItem) {
  var policy = resolvePolicy();
  if (!policy.directDownload) return false;

  if (!msgItem || !msgItem.elements) return false;

  // 有核心媒体元素才需要网络
  for (var el of msgItem.elements) {
    if (el && (el.picElement || el.videoElement || el.pttElement || el.fileElement)) {
      return true;
    }
  }
  return false;
}

// 判断是否应该处理合并转发
function shouldProcessMultiForward() {
  return resolvePolicy().multiForward;
}

// 判断是否应该做 URL 劫持
function shouldHijackUrls() {
  return resolvePolicy().urlHijack;
}

// 执行完整流程: 速率检查 → 行为延迟 → 请求
async function stealthDownload(url, options) {
  var policy = resolvePolicy();
  if (!policy.directDownload) {
    var err = new Error("Direct download disabled by policy: " + policy.name);
    err.code = "POLICY_DISABLED";
    throw err;
  }
  if (!canDownload()) {
    var err2 = new Error("Rate limited (policy=" + policy.name + ", threat=" + threat.level + ")");
    err2.code = "RATE_LIMITED";
    throw err2;
  }
  await preDownloadDelay();
  var body = await retryRequest(url, options);
  recordDownload();
  return body;
}

// 同一资源的候选 URL 只消耗一次速率配额和一次行为延迟，避免备用地址放大流量
async function stealthDownloadWithFallback(urls, options) {
  var list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (list.length === 0) throw new Error("No candidate URL");
  var policy = resolvePolicy();
  if (!policy.directDownload) {
    var err = new Error("Direct download disabled by policy: " + policy.name);
    err.code = "POLICY_DISABLED";
    throw err;
  }
  if (!canDownload()) {
    var limited = new Error("Rate limited (policy=" + policy.name + ", threat=" + threat.level + ")");
    limited.code = "RATE_LIMITED";
    throw limited;
  }
  await preDownloadDelay();
  var lastError = null;
  try {
    for (var url of list) {
      try {
        var body = await stealthRequest(url, options);
        recordDownload();
        return body;
      } catch (e) {
        lastError = e;
      }
    }
  } finally {
    // 网络错误也计入实际尝试，防止故障时无限快速重试
    recordDownload();
  }
  throw lastError;
}

async function silentDownload(url, options) {
  try { return await stealthDownload(url, options); } catch { return null; }
}

// ============================================================
// 消息类型分级 (保留供 imgDownloader 使用)
// ============================================================

const MSG_TIER = {
  TEXT: 1, FACE: 1, REPLY: 1, ARK: 1, MARKDOWN: 1, GRAY_TIP: 1,
  PIC: 2, VIDEO: 2, PTT: 2, FILE: 2,
  MULTI_FORWARD: 3, LIGHT_APP: 3, MARKET_FACE: 3,
};

function classifyElements(elements) {
  if (!Array.isArray(elements)) return { tier: 1, types: [] };
  var types = new Set();
  var maxTier = 1;
  for (var el of elements) {
    if (!el) continue;
    if (el.textElement) types.add("TEXT");
    else if (el.faceElement) { types.add("FACE"); }
    else if (el.replyElement) types.add("REPLY");
    else if (el.arkElement) types.add("ARK");
    else if (el.markdownElement) types.add("MARKDOWN");
    else if (el.grayTipElement) types.add("GRAY_TIP");
    else if (el.picElement) { types.add("PIC"); maxTier = Math.max(maxTier, 2); }
    else if (el.videoElement) { types.add("VIDEO"); maxTier = Math.max(maxTier, 2); }
    else if (el.pttElement) { types.add("PTT"); maxTier = Math.max(maxTier, 2); }
    else if (el.fileElement) { types.add("FILE"); maxTier = Math.max(maxTier, 2); }
    else if (el.multiForwardMsgElement) { types.add("MULTI_FORWARD"); maxTier = Math.max(maxTier, 3); }
    else if (el.lightAppElement) { types.add("LIGHT_APP"); maxTier = Math.max(maxTier, 3); }
    else if (el.marketFaceElement) { types.add("MARKET_FACE"); maxTier = Math.max(maxTier, 3); }
  }
  return { tier: maxTier, types: Array.from(types) };
}

module.exports = {
  setOutput,
  setConfigGetter,
  // 核心
  stealthRequest,
  stealthDownload,
  stealthDownloadWithFallback,
  silentDownload,
  // 策略
  resolvePolicy,
  shouldDownloadResources,
  shouldProcessMultiForward,
  shouldHijackUrls,
  // 状态查询 (设置页展示用)
  threat,
  learner,
  getThreatStatus: function () { return threat.status(); },
  getPolicy: function () { return resolvePolicy(); },
  // 工具
  classifyElements,
  MSG_TIER,
  isTrustedUrl,
  FINGERPRINTS,
  buildHeaders,
};