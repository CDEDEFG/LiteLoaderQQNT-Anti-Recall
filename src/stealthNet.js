// 反风控流量伪装层 - 日常使用无感版
// 核心原则: 插件的网络行为与正常 QQ 用户浏览行为无法区分
//
// 消息类型分级策略:
//   TIER 1 (静默恢复): 纯文本/表情/引用/ARK/Markdown — 零网络请求, 纯内存操作
//   TIER 2 (被动恢复): 图片/视频/语音/文件/大表情 — 仅当用户已看过该消息才恢复
//   TIER 3 (跳过):     合并转发/小程序 — 结构复杂, 恢复特征明显, 默认不恢复资源
//
// 反风控四层:
//   L1: 浏览器级请求头伪造    - 每个请求带完整 Chrome UA + Referer + sec-ch-ua
//   L2: 行为级延迟模拟         - 人类浏览模式的长尾延迟分布
//   L3: 消息类型感知下载       - 只恢复"用户已看过"的资源, 不主动扫描
//   L4: 流量速率限制           - 每分钟下载次数限制, 防止突发特征

const https = require("https");
const http = require("http");
const { URL } = require("url");

// ============================================================
// 消息类型分级
// ============================================================

const MSG_TIER = {
  // TIER 1: 零网络请求, 纯内存恢复
  TEXT: 1,        // 纯文本
  FACE: 1,        // 小黄脸
  REPLY: 1,       // 引用回复
  ARK: 1,         // 卡片/链接
  MARKDOWN: 1,    // Markdown
  GRAY_TIP: 1,    // 撤回灰条 (识别用)

  // TIER 2: 被动恢复 (用户看过才下载)
  PIC: 2,         // 图片
  VIDEO: 2,       // 视频
  PTT: 2,         // 语音
  FILE: 2,        // 文件
  MARKET_FACE: 2, // 大表情

  // TIER 3: 默认不恢复资源 (结构复杂/特征明显)
  MULTI_FORWARD: 3, // 合并转发
  LIGHT_APP: 3,     // 小程序
};

// 识别消息元素类型
function classifyElements(elements) {
  if (!Array.isArray(elements)) return { tier: 1, types: [] };
  var types = new Set();
  var maxTier = 1;
  for (var el of elements) {
    if (!el) continue;
    if (el.textElement) { types.add("TEXT"); }
    else if (el.faceElement) { types.add("FACE"); maxTier = Math.max(maxTier, MSG_TIER.FACE); }
    else if (el.replyElement) { types.add("REPLY"); }
    else if (el.arkElement) { types.add("ARK"); }
    else if (el.markdownElement) { types.add("MARKDOWN"); }
    else if (el.grayTipElement) { types.add("GRAY_TIP"); }
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
// L1: 浏览器级请求头伪造
// ============================================================

const CHROME_MAJOR = "120";
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

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
  return {
    "User-Agent": UA,
    "Accept": buildAccept(url),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "identity",
    "Referer": buildReferer(url),
    "sec-ch-ua": `"Not_A Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
}

// ============================================================
// L2: 行为级延迟模拟 (人类浏览模式)
// ============================================================

function humanDelay() {
  var r = Math.random();
  if (r < 0.75) return Math.floor(Math.random() * 150);      // 75%: 0-150ms (快速浏览)
  if (r < 0.95) return 150 + Math.floor(Math.random() * 400); // 20%: 150-550ms (正常)
  return 550 + Math.floor(Math.random() * 1500);               // 5%: 550-2050ms (慢)
}

function preDownloadDelay() {
  return new Promise(function (r) { setTimeout(r, humanDelay()); });
}

var lastRequestTime = 0;
var MIN_INTERVAL = 80;

async function throttle() {
  var now = Date.now();
  var wait = MIN_INTERVAL - (now - lastRequestTime);
  if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
  lastRequestTime = Date.now();
}

// ============================================================
// L3: 消息类型感知下载 (被动式)
// ============================================================

// 判断消息是否"已被用户看到过"
// 用户看过的消息才恢复资源, 没看过的说明可能是历史拉取, 不主动下载
function hasUserSeenMsg(msgItem) {
  if (!msgItem) return false;
  // isOnlineMsg = true: 消息实时到达, 用户正在看聊天窗口
  if (msgItem.isOnlineMsg === true) return true;
  // sendStatus 2: 消息已送达并显示
  if (msgItem.sendStatus === 2) return true;
  // msgSeq 存在且不是历史消息 (cntSeq > 0 表示实时消息)
  if (msgItem.cntSeq != null && msgItem.cntSeq > 0) return true;
  return false;
}

// 判断是否应该下载该消息的资源
function shouldDownloadResources(msgItem) {
  if (!msgItem || !msgItem.elements) return false;
  var cls = classifyElements(msgItem.elements);
  // TIER 1: 零网络请求
  if (cls.tier === 1) return false;
  // TIER 3: 默认不恢复 (合并转发/小程序)
  if (cls.tier === 3) return false;
  // TIER 2: 被动恢复 (用户看过才下载)
  if (cls.tier === 2) return hasUserSeenMsg(msgItem);
  return false;
}

// 判断是否应该下载特定元素
function shouldDownloadElement(element, msgItem) {
  if (!element) return false;
  // 图片/视频/语音/文件: 用户看过才下载
  if (element.picElement || element.videoElement || element.pttElement || element.fileElement) {
    return hasUserSeenMsg(msgItem);
  }
  // 大表情: 本地缓存优先, 不主动从 CDN 拉
  if (element.marketFaceElement) return false;
  return false;
}

// ============================================================
// L4: 流量速率限制
// ============================================================

var rateLimiter = {
  windowMs: 60000,
  maxPerWindow: 20, // 每分钟最多 20 次下载 (正常用户浏览速度)
  timestamps: [],

  canProceed: function () {
    var now = Date.now();
    this.timestamps = this.timestamps.filter(function (t) { return now - t < this.windowMs; }, this);
    return this.timestamps.length < this.maxPerWindow;
  },

  record: function () {
    this.timestamps.push(Date.now());
  },
};

// ============================================================
// 主请求函数 (带完整反风控)
// ============================================================

function stealthRequest(url, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var target;
    try { target = new URL(url); } catch (e) { return reject(new Error("Invalid URL")); }
    var isHttps = target.protocol === "https:";
    var protocol = isHttps ? https : http;

    var headers = buildHeaders(url);
    if (options.noCookie !== true) {
      headers["Cookie"] = "pgv_pvi=" + Math.floor(Math.random() * 1e10);
    }

    var reqOpts = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      headers: headers,
      timeout: options.timeout || 15000,
      agent: new (isHttps ? https : http).Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 6,
      }),
    };

    var req = protocol.get(reqOpts, function (res) {
      if (res.statusCode >= 300 && res.statusCode <= 399 && res.headers.location) {
        res.resume();
        var redirectUrl = new URL(res.headers.location, url).toString();
        return resolve(stealthRequest(redirectUrl, options));
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

// 带完整反风控流程的下载
async function stealthDownload(url, options) {
  // 速率限制
  if (!rateLimiter.canProceed()) {
    var err = new Error("Rate limited");
    err.code = "RATE_LIMITED";
    throw err;
  }
  // 人类延迟 + 节流
  await preDownloadDelay();
  await throttle();
  // 执行
  var body = await stealthRequest(url, options);
  rateLimiter.record();
  return body;
}

// 静默下载 (失败返回 null, 不抛异常)
async function silentDownload(url, options) {
  try { return await stealthDownload(url, options); } catch { return null; }
}

// 批量下载 (带间隔)
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
  shouldDownloadResources,
  shouldDownloadElement,
  hasUserSeenMsg,
  classifyElements,
  MSG_TIER,
  humanDelay,
  preDownloadDelay,
  buildHeaders,
  UA,
  rateLimiter,
};
