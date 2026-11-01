//大部分摘自LLOneBot
const { RkeyManager } = require("./rkeyManager.js");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const IMAGE_HTTP_HOST = "https://gchat.qpic.cn";
const IMAGE_HTTP_HOST_NT = "https://multimedia.nt.qq.com.cn";

//一个会话内只需拉一次rkey
class ImgDownloader {
  constructor() {
    this.rkeyManager = new RkeyManager([
      "https://llob.linyuchen.net/rkey",
    ]);
    this.enabled = true; // 可用 setEnabled 关闭 (对应配置 disableImgDownload)
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  async getImageUrl(element) {
    if (!element) {
      return "";
    }
    const url = element.originImageUrl; // 没有域名
    const md5HexStr = element.md5HexStr;
    if (url) {
      const parsedUrl = new URL(IMAGE_HTTP_HOST + url); //临时解析拼接
      const imageAppid = parsedUrl.searchParams.get("appid");
      const isNewPic = imageAppid && ["1406", "1407"].includes(imageAppid);
      if (isNewPic) {
        let rkey = parsedUrl.searchParams.get("rkey");
        if (rkey) {
          return IMAGE_HTTP_HOST_NT + url;
        }
        const rkeyData = await this.rkeyManager.getRkey();
        rkey =
          imageAppid === "1406" ? rkeyData.private_rkey : rkeyData.group_rkey;
        return IMAGE_HTTP_HOST_NT + url + rkey;
      } else {
        // 老的图片url，不需要rkey
        return IMAGE_HTTP_HOST + url;
      }
    } else if (md5HexStr) {
      // 没有url，需要自己拼接; 优先新域名(2024后腾讯大部分资源已迁移)
      return `${IMAGE_HTTP_HOST_NT}/gchatpic_new/0/0-0-${md5HexStr.toUpperCase()}/0`;
    }
    this.output("Pic url get error:", element);
    return "";
  }

  // 统一入口: 一条消息里可能同时有图片/语音/视频/文件/大表情, 全部都要恢复
  async downloadPic(msgItem) {
    if (!this.enabled) return;
    if (!Array.isArray(msgItem?.elements)) {
      return;
    }
    for (let el of msgItem.elements) {
      if (el?.picElement) {
        await this.downloadPicElement(el.picElement, msgItem);
      } else if (el?.pttElement) {
        await this.downloadPttElement(el.pttElement, msgItem);
      } else if (el?.videoElement) {
        await this.downloadVideoElement(el.videoElement, msgItem);
      } else if (el?.fileElement) {
        await this.downloadFileElement(el.fileElement, msgItem);
      } else if (el?.marketFaceElement) {
        await this.downloadMarketFaceElement(el.marketFaceElement, msgItem);
      }
    }
  }

  async ensureLocal(localPath, buildUrl, label) {
    if (!localPath || typeof localPath !== "string") return;
    try {
      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 100) {
        return; // 本地已有有效文件
      }
    } catch (e) {}
    let url;
    try {
      url = typeof buildUrl === "function" ? await buildUrl() : buildUrl;
    } catch (e) {
      this.output(label, "url build failed:", e && e.message);
      return;
    }
    if (!url) return;
    try {
      this.output("Download " + label + ":", url, " to ", localPath);
      const body = await this.request(url);
      try {
        JSON.parse(body);
        this.output(label + " already expired:", url);
        return;
      } catch (e) {}
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, body);
    } catch (e) {
      this.output("Download " + label + " failed:", e && e.message);
    }
  }

  async downloadPicElement(pic, msgItem) {
    if (!pic) return;
    const thumbMap = new Map([
      [0, pic.sourcePath],
      [198, pic.sourcePath],
      [720, pic.sourcePath],
    ]);
    await this.ensureLocal(pic.sourcePath, () => this.getImageUrl(pic), "pic");
    // 修复本地数据中的错误
    if (
      pic?.thumbPath &&
      (pic.thumbPath instanceof Array || pic.thumbPath instanceof Object)
    ) {
      pic.thumbPath = thumbMap;
    }
  }

  // 语音/视频/文件/大表情 的 URL 构造与下载
  async downloadPttElement(ptt, msgItem) {
    if (!ptt) return;
    // NTQQ 语音: 原始 url 在 ptt.url / ptt.downloadUrl, 本地缓存路径在 filePath
    const url = ptt.url || ptt.downloadUrl || ptt.fileUrl || "";
    if (!url) return;
    await this.ensureLocal(ptt.filePath, url, "ptt");
  }

  async downloadVideoElement(video, msgItem) {
    if (!video) return;
    // NTQQ 视频: url 字段直接给出下载地址
    const url = video.url || video.downloadUrl || "";
    if (!url) return;
    await this.ensureLocal(video.filePath, url, "video");
    if (video.thumbPath && typeof video.thumbPath === "string") {
      // 封面: 同url即可, 服务端会返回适当内容
      await this.ensureLocal(video.thumbPath, url, "video-thumb");
    }
  }

  async downloadFileElement(file, msgItem) {
    if (!file) return;
    // NTQQ 文件: fileUrl 字段
    const url = file.url || file.fileUrl || file.downloadUrl || "";
    if (!url) return;
    await this.ensureLocal(file.filePath, url, "file");
  }

  async downloadMarketFaceElement(face, msgItem) {
    if (!face) return;
    // 大表情: 本地路径字段由 QQ 存储, 需要从本地包内找回, 不从CDN拉
    // marketFace 的 url 若存在则尝试恢复, 但成功率不高, 此字段保留为占位
    if (face.url) {
      await this.ensureLocal(face.localPath, face.url, "marketFace");
    }
  }

  async request(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith("https") ? https : http;
      const req = protocol.get(url);
      req.on("error", (error) => {
        this.output("Download error", error);
        reject(error);
      });
      req.on("response", (res) => {
        // 发生跳转就继续请求
        if (res.statusCode >= 300 && res.statusCode <= 399) {
          return resolve(this.request(res.headers.location));
        }
        const chunks = [];
        res.on("error", (error) => {
          this.output("Download error", error);
          reject(error);
        });
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
    });
  }

  output(...args) {
    console.log("\x1b[32m%s\x1b[0m", "Anti-Recall:", ...args);
  }
}

module.exports.ImgDownloader = ImgDownloader;
