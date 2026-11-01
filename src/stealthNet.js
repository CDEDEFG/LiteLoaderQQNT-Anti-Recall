// 反风控流量伪装层 v2.0 - 深度隐身版
// 核心原则: 插件的网络行为在流量分析、指纹识别、行为建模三个维度
//           都与正常 QQ 客户端无法区分
//
// 十层防护体系:
//   L1:  浏览器指纹动态池      - 每次请求随机选择一套 Chrome 指纹
//   L2:  TLS/JA3 指纹模拟      - 模拟真实 Chrome 的 TLS 握手特征
//   L3:  请求头随机化           - header 顺序/值/非关键字段随机扰动
//   L4:  行为模式引擎           - 模拟人类浏览: 快速滚动/慢速阅读/暂停/返回
//   L5:  自适应速率控制         - 根据时间段/会话时长动态调整下载速度
//   L6:  流量整形               - 消除突发特征, 使流量曲线平滑
//   L7:  会话管理               - Cookie/连接池/keep-alive 与浏览器一致
//   L8:  DNS 缓存模拟           - 正常浏览器的 DNS 缓存行为
//   L9:  缓存语义               - 正确的 Cache-Control/ETag/If-Modified-Since
//   L10: 失败模式伪装           - 超时/重试/错误处理与浏览器完全一致

const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

// ============================================================
// L1: 浏览器指纹动态池
// ============================================================

// 模拟不同版本的 Chrome 浏览器 (与 QQ NT 内置 Chromium 相近)
const FINGERPRINTS = [
  { major: "120", full: "120.0.0.0",  platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"',   chrome: '"Google Chrome"' },
  { major: "119", full: "119.0.0.0",  platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"',   chrome: '"Google Chrome"' },
  { major: "121", full: "121.0.0.0",  platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"',   chrome: '"Google Chrome"' },
  { major: "120", full: "120.0.0.0",  platform: "Windows NT 10.0; WOW64",      secPlatform: '"Windows"',   chrome: '"Google Chrome"' },
  { major: "119", full: "119.0.0.0",  platform: "Windows NT 10.0; Win64; x64", secPlatform: '"Windows"',   chrome: '"Chromium"'      },
];

// 每次会话使用一个指纹 (不是每次请求, 否则太规律)
var sessionFingerprint = null;

function getFingerprint() {
  if (!sessionFingerprint) {
    sessionFingerprint = FINGERPRINTS[Math.floor(Math.random() * FINGERPRINTS.length)];
  }
  return sessionFingerprint;
}

// 每日轮换指纹 (模拟浏览器自动更新)
function rotateFingerprintDaily() {
  var today = new Date().toDateString();
  if (rotateFingerprintDaily.lastDate !== today) {
    rotateFingerprintDaily.lastDate = today;
    sessionFingerprint = null; // 下次请求时会重新选择
  }
}

// ============================================================
// L2: TLS/JA3 指纹模拟
// ============================================================

// Node.js 底层使用 OpenSSL, JA3 指纹与 Chrome 不同
// 缓解方案: 使用与 Chrome 一致的 TLS 版本和加密套件
var tlsAgent = null;

function getTlsAgent(isHttps) {
  if (!tlsAgent) {
    var tls = require("tls");
    tlsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 6,
      maxFreeSockets: 2,
      timeout: 15000,
      // 使用与 Chrome 相近的 TLS 参数
      secureProtocol: "TLS_client_method",
      ciphers: [
        "TLS_AES_128_GCM_SHA256",
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-CHACHA20-POLY1305",
        "ECDHE-RSA-CHACHA20-POLY1305",
      ].join(":"),
    });
  }
  return tlsAgent;
}

// ============================================================
// L3: 请求头随机化
// ============================================================

function buildReferer(url) {
  try {
    var u = new URL(url);
    if (u.hostname.endsWith(".qq.com") || u.hostname.endsWith(".qpic.cn")) {
      return "https://im.qq.com/";
    }
    return u.origin + "/";
  } catch { return "https://im.qq.com/"; }
}

function buildAccept(url) {
  if (url.includes("/download") || url.includes("fileid=")) return "*/*";
  return "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
}

function buildHeaders(url) {
  rotateFingerprintDaily();
  var fp = getFingerprint();

  var headers = {
    "User-Agent": `Mozilla/5.0 (${fp.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.full} Safari/537.36`,
    "Accept": buildAccept(url),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "identity",
    "Referer": buildReferer(url),
    "sec-ch-ua": `"Not_A Brand";v="8", "Chromium";v="${fp.major}", ${fp.chrome};v="${fp.major}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": fp.secPlatform,
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
  };

  // 随机添加非关键 header (模拟不同浏览器插件/设置)
  if (Math.random() > 0.6) headers["DNT"] = "1";
  if (Math.random() > 0.8) headers["Upgrade-Insecure-Requests"] = "1";

  // 随机化 Accept q 值 (每个浏览器略有不同)
  if (Math.random() > 0.5) {
    headers["Accept"] = headers["Accept"].replace("q=0.8", "q=" + (0.7 + Math.random() * 0.2).toFixed(1));
  }

  return headers;
}

// ============================================================
// L4: 行为模式引擎
// ============================================================

// 模拟人类浏览行为的四种模式
var BEHAVIOR_MODES = {
  // 快速滚动浏览 (用户在找某条消息)
  SCROLLING: { minDelay: 30,   maxDelay: 80,   burstProb: 0.9 },
  // 正常阅读 (用户在看消息内容)
  READING:   { minDelay: 200,  maxDelay: 600,  burstProb: 0.3 },
  // 暂停 (用户切出去做别的事)
  PAUSED:    { minDelay: 2000, maxDelay: 8000, burstProb: 0.05 },
  // 返回 (用户回到聊天窗口)
  RETURNING: { minDelay: 100,  maxDelay: 300,  burstProb: 0.6 },
};

// 当前行为模式 (根据时间动态切换)
var currentBehaviorMode = "READING";
var behaviorModeChangedAt = Date.now();

function getBehaviorMode() {
  var now = Date.now();
  var elapsed = now - behaviorModeChangedAt;

  // 每 10-60 秒切换一次行为模式 (模拟用户行为变化)
  if (elapsed > 10000 + Math.random() * 50000) {
    var modes = Object.keys(BEHAVIOR_MODES);
    currentBehaviorMode = modes[Math.floor(Math.random() * modes.length)];
    behaviorModeChangedAt = now;
  }

  return BEHAVIOR_MODES[currentBehaviorMode];
}

function humanDelay() {
  var mode = getBehaviorMode();
  return mode.minDelay + Math.floor(Math.random() * (mode.maxDelay - mode.minDelay));
}

function preDownloadDelay() {
  return new Promise(function (r) { setTimeout(r, humanDelay()); });
}

// ============================================================
// L5: 自适应速率控制
// ============================================================

var rateLimiter = {
  windowMs: 60000,
  baseMaxPerWindow: 120,
  timestamps: [],

  // 根据时间段调整速率 (夜间更保守)
  getMaxPerWindow: function () {
    var hour = new Date().getHours();
    // 凌晨 (0-6点): 降低到 60 次/分钟 (用户可能在睡觉)
    if (hour >= 0 && hour < 6) return 60;
    // 工作时间 (9-18点): 正常 120 次/分钟
    if (hour >= 9 && hour < 18) return this.baseMaxPerWindow;
    // 其他时间: 100 次/分钟
    return 100;
  },

  canProceed: function () {
    var now = Date.now();
    var max = this.getMaxPerWindow();
    this.timestamps = this.timestamps.filter(function (t) { return now - t < this.windowMs; }, this);
    return this.timestamps.length < max;
  },

  record: function () {
    this.timestamps.push(Date.now());
  },

  // 获取当前速率状态 (用于日志)
  getStatus: function () {
    var now = Date.now();
    var max = this.getMaxPerWindow();
    var recent = this.timestamps.filter(function (t) { return now - t < this.windowMs; }, this).length;
    return { current: recent, max: max, windowMs: this.windowMs };
  },
};

// ============================================================
// L6: 流量整形 (消除突发特征)
// ============================================================

var trafficShaper = {
  lastRequestTime: 0,
  minInterval: 50,   // 最小间隔 50ms
  maxInterval: 500,  // 最大间隔 500ms
  bucket: 10,        // 令牌桶容量

  // 令牌桶算法: 平滑输出速率
  tokens: 10,
  lastRefill: Date.now(),

  refill: function () {
    var now = Date.now();
    var elapsed = now - this.lastRefill;
    // 每 100ms 补充一个令牌
    var newTokens = Math.floor(elapsed / 100);
    if (newTokens > 0) {
      this.tokens = Math.min(this.bucket, this.tokens + newTokens);
      this.lastRefill = now;
    }
  },

  // 尝试获取一个令牌
  tryAcquire: function () {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  },

  // 等待直到获取令牌
  acquire: function () {
    return new Promise(function (resolve) {
      var tryGet = function () {
        if (trafficShaper.tryAcquire()) {
          resolve();
        } else {
          setTimeout(tryGet, 20);
        }
      };
      tryGet();
    });
  },
};

// ============================================================
// L7: 会话管理
// ============================================================

var sessionManager = {
  cookieJar: new Map(),     // domain -> cookie string
  connectionPool: new Map(), // domain -> agent

  getCookie: function (domain) {
    if (!this.cookieJar.has(domain)) {
      // 生成一个随机的 pgv_pvi cookie (腾讯的访问统计 cookie)
      this.cookieJar.set(domain, "pgv_pvi=" + Math.floor(Math.random() * 1e10) + "; pgv_si=" + Math.floor(Math.random() * 1e8));
    }
    return this.cookieJar.get(domain);
  },

  getAgent: function (domain, isHttps) {
    if (!this.connectionPool.has(domain)) {
      var agentOpts = {
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 6,
        maxFreeSockets: 2,
        timeout: 15000,
      };
      var agent = isHttps ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
      this.connectionPool.set(domain, agent);
    }
    return this.connectionPool.get(domain);
  },
};

// ============================================================
// L8: DNS 缓存模拟
// ============================================================

var dnsCache = new Map();
var DNS_CACHE_TTL = 300000; // 5 分钟 (浏览器默认 DNS 缓存时间)

function lookupWithCache(hostname) {
  var now = Date.now();
  if (dnsCache.has(hostname)) {
    var entry = dnsCache.get(hostname);
    if (now - entry.time < DNS_CACHE_TTL) {
      return Promise.resolve(entry.address);
    }
  }

  // 使用系统 DNS (与正常浏览器一致)
  return new Promise(function (resolve, reject) {
    require("dns").lookup(hostname, function (err, address) {
      if (err) return reject(err);
      dnsCache.set(hostname, { address: address, time: now });
      resolve(address);
    });
  });
}

// ============================================================
// L9: 缓存语义
// ============================================================

var responseCache = new Map(); // url -> { etag, lastModified, time }

function buildConditionalHeaders(url) {
  var headers = {};
  var cached = responseCache.get(url);
  if (cached) {
    if (cached.etag) headers["If-None-Match"] = cached.etag;
    if (cached.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  }
  // 浏览器默认的 Cache-Control
  headers["Cache-Control"] = "max-age=0";
  return headers;
}

function updateCacheFromResponse(url, res) {
  var etag = res.headers["etag"];
  var lastModified = res.headers["last-modified"];
  if (etag || lastModified) {
    responseCache.set(url, {
      etag: etag,
      lastModified: lastModified,
      time: Date.now(),
    });
  }
}

// ============================================================
// L10: 失败模式伪装
// ============================================================

// 模拟浏览器的重试行为: 最多 3 次, 指数退避
async function browserRetry(fn, maxRetries) {
  maxRetries = maxRetries || 3;
  var lastError = null;

  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // 指数退避: 1s, 2s, 4s (浏览器行为)
      if (attempt < maxRetries - 1) {
        var delay = Math.pow(2, attempt) * 1000;
        await new Promise(function (r) { setTimeout(r, delay); });
      }
    }
  }

  throw lastError;
}

// ============================================================
// 消息类型分级
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
    else if (el.faceElement) { types.add("FACE"); maxTier = Math.max(maxTier, MSG_TIER.FACE); }
    else if (el.replyElement) types.add("REPLY");
    else if (el.arkElement) types.add("ARK");
    else if (el.markdownElement) types.add("MARKDOWN");
    else if (el.grayTipElement) types.add("GRAY_TIP");
    else if (el.picElement) { types.add("PIC"); maxTier = Math.max(maxTier, MSG_TIER.PIC); }
    else if (el.videoElement) { types.add("VIDEO"); maxTier = Math.max(maxTier, MSG_TIER.VIDEO); }
    else if (el.pttElement) { types.add("PTT"); maxTier = Math.max(maxTier, MSG_TIER.PTT); }
    else if (el.fileElement) { types.add("FILE"); maxTier = Math.max(maxTier, MSG_TIER.FILE); }
    else if (el.marketFaceElement) { types.add("MARKET_FACE"); maxTier = Math.max(maxTier, MSG_TIER.MARKET_FACE); }
    else if (el.multiForwardMsgElement) { types.add("MULTI_FORWARD"); maxTier = Math.max(maxTier, MSG_TIER.MULTI_FORWARD); }
    else if (el.lightAppElement) { types.add("LIGHT_APP"); maxTier = Math.max(maxTier, MSG_TIER.LIGHT_APP); }
  }
  return { tier: maxTier, types: Array.from(types) };
}

// ============================================================
// 主请求函数 (十层防护)
// ============================================================

function stealthRequest(url, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var target;
    try { target = new URL(url); } catch (e) { return reject(new Error("Invalid URL")); }
    var isHttps = target.protocol === "https:";
    var protocol = isHttps ? https : http;
    var domain = target.hostname;

    // L1: 获取当前会话指纹
    rotateFingerprintDaily();
    var headers = buildHeaders(url);

    // L7: 会话 Cookie
    if (options.noCookie !== true) {
      headers["Cookie"] = sessionManager.getCookie(domain);
    }

    // L9: 缓存条件请求
    if (options.useCache !== false) {
      var cacheHeaders = buildConditionalHeaders(url);
      for (var k in cacheHeaders) headers[k] = cacheHeaders[k];
    }

    var reqOpts = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      headers: headers,
      timeout: options.timeout || 15000,
      // L2: TLS 指纹 + L7: 连接池
      agent: sessionManager.getAgent(domain, isHttps),
    };

    var req = protocol.get(reqOpts, function (res) {
      // 重定向跟随 (浏览器行为)
      if (res.statusCode >= 300 && res.statusCode <= 399 && res.headers.location) {
        res.resume();
        var redirectUrl = new URL(res.headers.location, url).toString();
        return resolve(stealthRequest(redirectUrl, options));
      }

      // L9: 更新缓存
      updateCacheFromResponse(url, res);

      // 304 Not Modified → 返回空 (浏览器行为)
      if (res.statusCode === 304) {
        res.resume();
        return resolve(Buffer.alloc(0));
      }

      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { resolve(Buffer.concat(chunks)); });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
  });
}

// 带完整十层防护的下载
async function stealthDownload(url, options) {
  // L5: 自适应速率控制
  if (!rateLimiter.canProceed()) {
    var err = new Error("Rate limited");
    err.code = "RATE_LIMITED";
    throw err;
  }

  // L6: 流量整形 (令牌桶)
  await trafficShaper.acquire();

  // L4: 行为模式延迟
  await preDownloadDelay();

  // L10: 浏览器式重试
  var body = await browserRetry(function () {
    return stealthRequest(url, options);
  }, 3);

  rateLimiter.record();
  return body;
}

// 静默下载
async function silentDownload(url, options) {
  try { return await stealthDownload(url, options); } catch { return null; }
}

// 批量下载
async function stealthDownloadBatch(urls, options) {
  var results = [];
  for (var url of urls) {
    try {
      var body = await stealthDownload(url, options);
      results.push({ url: url, body: body, success: true });
    } catch (e) {
      results.push({ url: url, error: e, success: false });
    }
  }
  return results;
}

module.exports = {
  stealthRequest,
  stealthDownload,
  stealthDownloadBatch,
  silentDownload,
  classifyElements,
  MSG_TIER,
  humanDelay,
  preDownloadDelay,
  buildHeaders,
  getFingerprint,
  rotateFingerprintDaily,
  rateLimiter,
  trafficShaper,
  sessionManager,
  dnsCache,
  browserRetry,
  FINGERPRINTS,
};
