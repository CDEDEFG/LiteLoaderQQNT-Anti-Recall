//摘自LLOneBot, 加固版
// 多源 rkey + 本地缓存兜底: 单点故障(如证书过期)不会导致图片恢复失效
const https = require("https");
const fs = require("fs");
const path = require("path");

// 已知可用的 rkey 服务; 若全部失效, 自动回落到本地缓存
const RKEY_SERVERS = [
  "https://llob.linyuchen.net/rkey",
];

// 缓存文件在 LiteLoader 数据目录下, 重启 QQ 后仍能续用
const cacheDir = path.join(
  global.LiteLoader && LiteLoader.path && LiteLoader.path.data
    ? LiteLoader.path.data
    : process.cwd(),
  "anti_recall"
);
const CACHE_FILE = path.join(cacheDir, "rkey_caches.json");

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}
function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c), "utf-8");
  } catch {}
}

class RkeyManager {
  serverUrls = [];
  rkeyData = {
    group_rkey: "",
    private_rkey: "",
    expired_time: 0,
  };

  constructor(serverUrls) {
    this.serverUrls = Array.isArray(serverUrls) ? serverUrls : [serverUrls];
    // 启动先尽量用缓存
    const cached = loadCache();
    if (cached) this.rkeyData = cached;
  }

  async getRkey() {
    if (this.isExpired()) {
      try {
        await this.refreshRkey();
        saveCache(this.rkeyData);
      } catch (e) {
        console.log("Anti-Recall: 获取rkey失败(全部源), 使用缓存兜底", e && e.message);
        // 缓存兜底: 即使过期也比没有强, 部分图片可能仍能下载
      }
    }
    return this.rkeyData;
  }

  isExpired() {
    const now = new Date().getTime() / 1000;
    return now > this.rkeyData.expired_time;
  }

  async refreshRkey() {
    let lastErr = null;
    for (const url of this.serverUrls) {
      try {
        const data = await this.fetchServerRkey(url);
        if (data && (data.group_rkey || data.private_rkey)) {
          this.rkeyData = data;
          return;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("no rkey server available");
  }

  fetchServerRkey(url) {
    return new Promise((resolve, reject) => {
      https
        .get(url, { timeout: 5000, rejectUnauthorized: false }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("HTTP " + res.statusCode));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch (e) {
              reject(e);
            }
          });
          res.on("error", reject);
        })
        .on("error", reject)
        .on("timeout", function () {
          this.destroy(new Error("timeout"));
        });
    });
  }
}

module.exports.RkeyManager = RkeyManager;
