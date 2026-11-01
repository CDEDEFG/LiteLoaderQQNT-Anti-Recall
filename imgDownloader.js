// NTQQ 撤回消息资源恢复中心
// 覆盖: 图片(picElement) / 语音(pttElement) / 视频(videoElement)
//       文件(fileElement) / 大表情(marketFaceElement) / 小程序(lightAppElement)
// 策略: 三级降级 -- 字段自带URL -> md5拼接CDN -> 本地残留文件；全部失败时仅记快照
const { RkeyManager } = require("./rkeyManager.js");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const IMAGE_HTTP_HOST = "https://gchat.qpic.cn";
const IMAGE_HTTP_HOST_NT = "https://multimedia.nt.qq.com.cn";

// 主流 NT 媒体 CDN 域名池 (按优先级, 用于 md5 拼接兜底)
const MEDIA_HOSTS = [
  IMAGE_HTTP_HOST_NT,
  "https://gchat.qpic.cn",
  "https://c2cpicdw.qpic.cn",
];

function output(...args) {
  console.log("\x1b[32m%s\x1b[0m", "Anti-Recall:", ...args);
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {}
}

function isValidLocalFile(p) {
  if (!p || typeof p !== "string") return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 100;
  } catch (e) {
    return false;
  }
}

// URL 自动拼接 rkey (仅图片需要)
function resolveRkeyIfNeeded(element, url) {
  if (!url) return Promise.resolve("");
  try {
    const parsedUrl = new URL(url.startsWith("http") ? url : IMAGE_HTTP_HOST + url);
    const imageAppid = parsedUrl.searchParams.get("appid");
    const isNewPic = imageAppid && ["1406", "1407"].includes(imageAppid);
    if (isNewPic && !parsedUrl.searchParams.get("rkey")) {
      return null; // 需要异步拉 rkey, 调用方处理
    }
  } catch (e) {}
  return Promise.resolve(url);
}

class ImgDownloader {
  constructor() {
    this.rkeyManager = new RkeyManager([
      "https://llob.linyuchen.net/rkey",
    ]);
    this.enabled = true;
    this.urlHijackMap = new Map(); // msgId -> { picUrls: [...], videoUrls: [...] }
    this.snapshotDir = path.join(
      global.LiteLoader && LiteLoader.path && LiteLoader.path.data
        ? LiteLoader.path.data
        : process.cwd(),
      "anti_recall",
      "recalled_snapshots"
    );
  }

  // 劫持图片 URL: 把被撤回图片的本地路径替换为 CDN 直链
  // QQ 渲染层会自己从 CDN 拉取, 插件不直接发请求
  hijackMediaUrls(msgItem) {
    if (!msgItem || !msgItem.msgId || !msgItem.elements) return;
    var hijacked = { pics: [], videos: [] };
    for (var el of msgItem.elements) {
      if (el?.picElement) {
        var pic = el.picElement;
        var cdnUrl = this.buildPicCdnUrl(pic);
        if (cdnUrl) {
          // 保存劫持映射, QQ 请求这个 URL 时由 protocol handler 拦截
          hijacked.pics.push({
            originalPath: pic.sourcePath,
            cdnUrl: cdnUrl,
          });
          // 直接把 originImageUrl 改成完整 CDN 地址
          if (!pic.originImageUrl || !pic.originImageUrl.startsWith("http")) {
            pic.originImageUrl = cdnUrl;
          }
        }
      } else if (el?.videoElement) {
        var video = el.videoElement;
        var vUrl = this.buildVideoCdnUrl(video);
        if (vUrl) {
          hijacked.videos.push({
            originalPath: video.filePath,
            cdnUrl: vUrl,
          });
        }
      }
    }
    if (hijacked.pics.length > 0 || hijacked.videos.length > 0) {
      this.urlHijackMap.set(String(msgItem.msgId), hijacked);
    }
  }

  // 构造图片 CDN 直链 (用于劫持, QQ 自己会去拉)
  buildPicCdnUrl(pic) {
    if (!pic) return "";
    // 已有完整 URL 直接用
    if (pic.originImageUrl && pic.originImageUrl.startsWith("http")) {
      return pic.originImageUrl;
    }
    var url = pic.originImageUrl || "";
    var md5 = (pic.md5HexStr || "").toUpperCase();
    // 有路径但没有域名 → 补全
    if (url && !url.startsWith("http")) {
      // 已有 rkey 的新格式
      if (url.includes("rkey=")) return IMAGE_HTTP_HOST_NT + url;
      // 老格式
      if (url.startsWith("/")) return IMAGE_HTTP_HOST + url;
    }
    // 只有 md5 → 拼接
    if (md5) return `${IMAGE_HTTP_HOST_NT}/gchatpic_new/0/0-0-${md5}/0`;
    return "";
  }

  // 构造视频 CDN 直链
  buildVideoCdnUrl(video) {
    if (!video) return "";
    if (video.url && video.url.startsWith("http")) return video.url;
    var md5 = (video.md5HexStr || video.md5 || "").toUpperCase();
    if (md5) {
      return `${IMAGE_HTTP_HOST_NT}/download?appid=1407&fileid=vid_${md5}`;
    }
    return "";
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  // ---------- URL 构造 ----------

  async getImageUrl(element) {
    if (!element) return "";
    const url = element.originImageUrl;
    const md5HexStr = element.md5HexStr;
    if (url) {
      const parsedUrl = new URL(IMAGE_HTTP_HOST + url);
      const imageAppid = parsedUrl.searchParams.get("appid");
      const isNewPic = imageAppid && ["1406", "1407"].includes(imageAppid);
      if (isNewPic) {
        const rkey = parsedUrl.searchParams.get("rkey");
        if (rkey) return IMAGE_HTTP_HOST_NT + url;
        try {
          const rkeyData = await this.rkeyManager.getRkey();
          return (
            IMAGE_HTTP_HOST_NT +
            url +
            (imageAppid === "1406" ? rkeyData.private_rkey : rkeyData.group_rkey)
          );
        } catch (e) {
          output("rkey 获取失败, 尝试不带rkey的原URL:", e && e.message);
          return IMAGE_HTTP_HOST_NT + url; // 偶尔能连上
        }
      } else {
        return IMAGE_HTTP_HOST_NT + url || IMAGE_HTTP_HOST + url;
      }
    } else if (md5HexStr) {
      return `${IMAGE_HTTP_HOST_NT}/gchatpic_new/0/0-0-${md5HexStr.toUpperCase()}/0`;
    }
    output("Pic url get error: empty url and no md5");
    return "";
  }

  // NT 资源通用 URL 构造: 先信任元素自带的 url/downloadUrl/urlExpires 类字段, 其次用 md5 拼 URL
  buildGenericUrl(kind, element) {
    if (!element) return "";
    // 优先取直接 URL 字段
    const directUrl =
      element.url ||
      element.downloadUrl ||
      element.fileUrl ||
      element.downloadUrlStreaming ||
      element.urlExpireFree ||
      "";
    if (directUrl) {
      return directUrl.startsWith("http") ? directUrl : IMAGE_HTTP_HOST_NT + directUrl;
    }
    // 按类型用 md5 拼接
    const md5 = (element.md5HexStr || element.md5 || "").toUpperCase();
    if (!md5) return "";
    switch (kind) {
      case "pic":
        return `${IMAGE_HTTP_HOST_NT}/gchatpic_new/0/0-0-${md5}/0`;
      case "video":
        return `${IMAGE_HTTP_HOST_NT}/download?appid=1407&fileid=vid_${md5}`;
      case "ptt":
      case "file":
      default:
        return `${IMAGE_HTTP_HOST_NT}/download?md5=${md5}`;
    }
  }

  // ---------- 下载核心 (集成反风控) ----------

  async request(url) {
    // 使用 stealthNet 的伪装请求替代裸 HTTP
    // 浏览器级请求头 + 行为延迟 + 速率限制
    const stealth = require("./src/stealthNet.js");
    return stealth.stealthRequest(url, { timeout: 15000 });
  }

  // 下载失败时尝试其它域名
  async requestWithFallback(urls) {
    let lastErr = null;
    for (const u of urls) {
      if (!u) continue;
      try {
        const body = await this.request(u);
        try {
          JSON.parse(body); // JSON 响应 = 过期提示
        } catch (e) {
          return body; // 二进制内容
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async ensureLocal(localPath, urls, label) {
    if (!localPath || typeof localPath !== "string") return;
    if (isValidLocalFile(localPath)) return; // 已有
    const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
    if (list.length === 0) return;
    try {
      output("Download " + label + ":", list[0], "to", localPath);
      const body = await this.requestWithFallback(list);
      ensureDir(path.dirname(localPath));
      fs.writeFileSync(localPath, body);
    } catch (e) {
      output(label, "download failed:", e && e.message);
    }
  }

  // 消息全元素快照到本地 JSON (恢复底线)
  snapshotMsg(msgItem) {
    if (!msgItem || !msgItem.msgId) return null;
    try {
      ensureDir(this.snapshotDir);
      const file = path.join(this.snapshotDir, `${msgItem.msgId}.json`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(msgItem, null, 2), "utf-8");
      }
      return file;
    } catch (e) {
      output("snapshot failed:", e && e.message);
      return null;
    }
  }

  // ---------- 按元素类型下载 ----------

  async downloadPicElement(pic, msgItem) {
    if (!pic) return;
    const urls = [];
    const imgUrl = await this.getImageUrl(pic).catch(() => "");
    if (imgUrl) urls.push(imgUrl);
    // 兜底: md5 拼接多域名
    const md5 = (pic.md5HexStr || "").toUpperCase();
    if (md5) {
      for (const host of MEDIA_HOSTS) {
        urls.push(`${host}/gchatpic_new/0/0-0-${md5}/0`);
      }
    }
    await this.ensureLocal(pic.sourcePath, urls, "pic");
    if (pic?.thumbPath && (pic.thumbPath instanceof Array || pic.thumbPath instanceof Object)) {
      pic.thumbPath = new Map([[0, pic.sourcePath], [198, pic.sourcePath], [720, pic.sourcePath]]);
    }
  }

  async downloadPttElement(ptt, msgItem) {
    if (!ptt) return;
    const urls = [ptt.url, ptt.downloadUrl, ptt.fileUrl, ptt.urlExpires].filter(Boolean);
    const md5 = (ptt.md5HexStr || ptt.md5 || "").toUpperCase();
    if (md5) urls.push(`${IMAGE_HTTP_HOST_NT}/download?md5=${md5}`);
    await this.ensureLocal(ptt.filePath, urls, "ptt");
  }

  async downloadVideoElement(video, msgItem) {
    if (!video) return;
    const urls = [video.url, video.downloadUrl, video.fileUrl, video.thumbUrl].filter(Boolean);
    const md5 = (video.md5HexStr || video.md5 || "").toUpperCase();
    if (md5) urls.push(`${IMAGE_HTTP_HOST_NT}/download?appid=1407&fileid=vid_${md5}`);
    await this.ensureLocal(video.filePath, urls, "video");
    if (video.thumbPath && typeof video.thumbPath === "string") {
      await this.ensureLocal(video.thumbPath, [video.thumbUrl || video.url].filter(Boolean), "video-thumb");
    }
  }

  async downloadFileElement(file, msgItem) {
    if (!file) return;
    const urls = [file.url, file.fileUrl, file.downloadUrl, file.jumpLink].filter(Boolean);
    const md5 = (file.md5HexStr || file.md5 || "").toUpperCase();
    if (md5) urls.push(`${IMAGE_HTTP_HOST_NT}/download?md5=${md5}`);
    await this.ensureLocal(file.filePath, urls, "file");
    // fileName 可能含拼写错误的字段名, 处理没扩展名也无妨
  }

  async downloadMarketFaceElement(face, msgItem) {
    if (!face) return;
    const urls = [face.url, face.packageUrl, face.previewUrl].filter(Boolean);
    await this.ensureLocal(face.localPath, urls, "marketFace");
    // 修复缩略图引用
    if (face.localPath && fs.existsSync(face.localPath)) {
      try {
        if (face.thumbPath && !fs.existsSync(face.thumbPath)) {
          fs.copyFileSync(face.localPath, face.thumbPath);
        }
      } catch (e) {}
    }
  }

  async downloadLightAppElement(lapp, msgItem) {
    if (!lapp) return;
    // 小程序图标/首图 url
    const urls = [lapp.iconUrl, lapp.previewImg, lapp.sharePicUrl, lapp.thumbUrl, lapp.url].filter(Boolean);
    const localPaths = [lapp.localPath, lapp.iconPath].filter((p) => typeof p === "string" && p.length > 3);
    if (urls.length === 0 || localPaths.length === 0) return;
    await this.ensureLocal(localPaths[0], urls, "lightApp");
  }

  // 合并转发消息 (multiForwardMsgElement)
  async downloadMultiForwardElement(mf, msgItem) {
    if (!mf) return;
    const items = mf.multiMsgItem?.msgList || mf.msgList || [];
    for (const subMsg of items) {
      if (subMsg && typeof subMsg === "object") {
        try {
          await this.downloadAllElementsInMsg(subMsg);
        } catch (e) {
          output("multiForward sub-msg restore failed:", e && e.message);
        }
      }
    }
  }

  // ##### 统一入口: 一条消息的全部媒体元素下载 (反风控版 v0.7.1) #####
  // 策略: 核心资源(图片/视频/语音/文件/合并转发)必须完整恢复
  //   TIER 1 (文本/表情/引用/ARK/Markdown): 零网络请求, 纯内存恢复
  //   TIER 2 (图片/视频/语音/文件): URL 劫持 + 伪装下载, 必须恢复
  //   TIER 3 (合并转发): 强制递归下载所有子消息, 必须恢复
  async downloadAllElementsInMsg(msgItem) {
    if (!this.enabled) return;
    this.snapshotMsg(msgItem); // 恢复底线: 元素全量快照 (纯本地, 无网络)

    if (!msgItem || !msgItem.elements || !Array.isArray(msgItem.elements)) {
      if (msgItem?.multiForwardMsgElement) {
        // TIER 3: 合并转发, 强制递归
        output("TIER 3 multiForward: force recursive download");
        await this.downloadMultiForwardElement(msgItem.multiForwardMsgElement, msgItem);
      }
      return;
    }

    // 分级判断
    const stealth = require("./src/stealthNet.js");
    const cls = stealth.classifyElements(msgItem.elements);

    // TIER 1: 零网络请求
    if (cls.tier === 1) {
      output("TIER 1 (text/face/reply/ark): zero network requests");
      return;
    }

    // TIER 2/3: 核心资源, 必须恢复
    // 先尝试 URL 劫持 (图片/视频 → CDN 直链, QQ 自己拉)
    this.hijackMediaUrls(msgItem);

    // 然后伪装下载 (备份到本地, 防止 CDN 过期)
    for (const el of msgItem.elements) {
      try {
        if (el?.picElement) await this.downloadPicElement(el.picElement, msgItem);
        else if (el?.pttElement) await this.downloadPttElement(el.pttElement, msgItem);
        else if (el?.videoElement) await this.downloadVideoElement(el.videoElement, msgItem);
        else if (el?.fileElement) await this.downloadFileElement(el.fileElement, msgItem);
        else if (el?.multiForwardMsgElement) {
          // TIER 3: 合并转发, 强制递归下载所有子消息
          output("TIER 3 multiForward: force recursive download of sub-msgs");
          await this.downloadMultiForwardElement(el.multiForwardMsgElement, msgItem);
        }
        // 大表情/小程序: 不主动下载
      } catch (e) {
        output("element download err:", e && e.message);
      }
    }
  }

  // 兼容老接口名 (main.js 里的调用都是 downloadPic)
  async downloadPic(msgItem) {
    return this.downloadAllElementsInMsg(msgItem);
  }
}

module.exports.ImgDownloader = ImgDownloader;
