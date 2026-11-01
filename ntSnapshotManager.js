// NT 群文件 / 群相册 / 群公告 快照管理器
// 原理: 这些资源一旦在服务端删除就无法恢复, 只能在客户端第一次访问时本地备份
// 通过代理 NT 内部服务(如果 LiteLoader 暴露了内核接口)或监听 DOM/文件系统, 做本地归档
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function output(...args) {
  console.log("\x1b[36m%s\x1b[0m", "Anti-Recall-Snap:", ...args);
}

const ARCHIVE_DIR = path.join(
  global.LiteLoader && LiteLoader.path && LiteLoader.path.data
    ? LiteLoader.path.data
    : process.cwd(),
  "anti_recall",
  "archive"
);

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {}
}

function sanitizeName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

// 对一个本地文件做归档 (返回归档路径或 null)
function archiveLocalFile(srcPath, kind, groupCode, nameHint) {
  try {
    if (!srcPath || typeof srcPath !== "string") return null;
    if (!fs.existsSync(srcPath)) return null;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile() || stat.size === 0) return null;
    // 大于 200MB 的不做自动备份
    if (stat.size > 200 * 1024 * 1024) {
      output("File too large, skip archive:", srcPath, stat.size);
      return null;
    }

    const dir = path.join(ARCHIVE_DIR, kind, sanitizeName(groupCode || "unknown"));
    ensureDir(dir);

    const ext = path.extname(srcPath) || "";
    const basename = sanitizeName(nameHint || path.basename(srcPath, ext)) || Date.now().toString(36);
    const hash = crypto.createHash("md5").update(fs.readFileSync(srcPath)).digest("hex").slice(0, 10);
    const target = path.join(dir, `${basename}_${hash}${ext}`);

    if (fs.existsSync(target)) return target; // 已备份

    fs.copyFileSync(srcPath, target);
    output("Archived", kind, ":", srcPath, "->", target);
    return target;
  } catch (e) {
    output("Archive failed:", srcPath, e && e.message);
    return null;
  }
}

function indexFile(entry) {
  const idxPath = path.join(ARCHIVE_DIR, "index.jsonl");
  ensureDir(ARCHIVE_DIR);
  try {
    fs.appendFileSync(idxPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (e) {}
}

class NtSnapshotManager {
  constructor() {
    this.groupFiles = new Map(); // fileId -> {path, name, group, size}
    this.groupNotices = [];
    this.groupAlbumPhotos = new Map();
  }

  // 从一条发往渲染层的 IPC 载荷里收集群文件 / 群通知 / 群相册数据
  processIpcPayload(args1) {
    if (!args1 || typeof args1 !== "object") return;
    const cmdName = typeof args1.cmdName === "string" ? args1.cmdName : "";
    const payload = args1.payload;

    // 群通知变化 (公告属于通知的一种)
    if (cmdName.indexOf("GroupNotice") !== -1 || cmdName.indexOf("onGroupNotice") !== -1) {
      this.handleGroupNotice(cmdName, payload);
    }
    // 群文件列表变化 / 收到群文件消息
    if (cmdName.indexOf("RichMedia") !== -1 || cmdName.indexOf("onGroupFile") !== -1 || cmdName.indexOf("FileMsg") !== -1) {
      this.handleGroupFile(cmdName, payload);
    }
    // 群相册
    if (cmdName.indexOf("Album") !== -1 || cmdName.indexOf("Photo") !== -1) {
      this.handleGroupAlbum(cmdName, payload);
    }
    // 群精华消息 (撤回精华会消失, 快照可回看历史)
    if (cmdName.indexOf("GroupEssence") !== -1 || cmdName.indexOf("onGroupEssenceMsgChanged") !== -1) {
      this.handleGroupEssence(cmdName, payload);
    }
    // 群作业 (GroupSchoolHomework / onGroupHomeworkChanged)
    if (cmdName.indexOf("Homework") !== -1 || cmdName.indexOf("SchoolHomeWork") !== -1) {
      this.handleGroupHomework(cmdName, payload);
    }
    // 群投票 (GroupPollVote)
    if (cmdName.indexOf("GroupPoll") !== -1 || cmdName.indexOf("onGroupPoll") !== -1) {
      this.handleGroupPoll(cmdName, payload);
    }
  }

  handleGroupEssence(cmdName, payload) {
    try {
      if (!payload) return;
      const items = payload.essenceList || payload.msgs || [payload];
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== "object") continue;
        const entry = {
          type: "group_essence",
          time: new Date().toISOString(),
          cmdName,
          groupCode: it.groupCode || it.groupUin || "",
          msgSeq: it.msgSeq || "",
          raw: it,
        };
        indexFile(entry);
      }
    } catch (e) {}
  }

  handleGroupHomework(cmdName, payload) {
    try {
      if (!payload) return;
      const items = payload.homeworkList || [payload];
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== "object") continue;
        indexFile({
          type: "group_homework",
          time: new Date().toISOString(),
          cmdName,
          groupCode: it.groupCode || "",
          raw: it,
        });
      }
    } catch (e) {}
  }

  handleGroupPoll(cmdName, payload) {
    try {
      if (!payload) return;
      const items = payload.pollList || [payload];
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== "object") continue;
        indexFile({
          type: "group_poll",
          time: new Date().toISOString(),
          cmdName,
          groupCode: it.groupCode || "",
          raw: it,
        });
      }
    } catch (e) {}
  }

  handleGroupNotice(cmdName, payload) {
    try {
      if (!payload) return;
      const notices = payload.noticeList || payload.notices || payload.groupNoticeList || [payload];
      for (const n of Array.isArray(notices) ? notices : []) {
        if (!n || typeof n !== "object") continue;
        const entry = {
          type: "group_notice",
          time: new Date().toISOString(),
          cmdName,
          groupCode: n.groupCode || n.guildId || n.groupUin || "",
          title: n.title || n.content || "",
          raw: n,
        };
        this.groupNotices.push(entry);
        indexFile(entry);
        output("Snapshot group notice:", entry.title.slice(0, 40));
      }
    } catch (e) {
      output("handleGroupNotice error:", e && e.message);
    }
  }

  handleGroupFile(cmdName, payload) {
    try {
      if (!payload) return;
      // 收到群文件消息 / 获取群文件列表时, 备份文件元素里的本地路径
      const files = payload.fileList || payload.files || [payload];
      for (const f of Array.isArray(files) ? files : []) {
        if (!f || typeof f !== "object") continue;
        // 尝试从各种常见字段拿本地缓存路径
        const localPath = f.filePath || f.localPath || f.serverFilePath || f.path;
        const entry = {
          type: "group_file",
          time: new Date().toISOString(),
          cmdName,
          groupCode: f.groupCode || f.peerUid || "",
          fileName: f.fileName || f.name || "",
          fileSize: f.fileSize || 0,
          localPath: localPath || "",
        };
        if (localPath && typeof localPath === "string") {
          const archived = archiveLocalFile(localPath, "group_file", entry.groupCode, entry.fileName);
          if (archived) entry.archivedPath = archived;
        }
        indexFile(entry);
      }
    } catch (e) {
      output("handleGroupFile error:", e && e.message);
    }
  }

  handleGroupAlbum(cmdName, payload) {
    try {
      if (!payload) return;
      const photos = payload.photoList || payload.photos || payload.picList || [payload];
      for (const p of Array.isArray(photos) ? photos : []) {
        if (!p || typeof p !== "object") continue;
        const localPath = p.path || p.localPath || p.filePath;
        const entry = {
          type: "group_album_photo",
          time: new Date().toISOString(),
          cmdName,
          groupCode: p.groupCode || "",
          localPath: localPath || "",
        };
        if (localPath && typeof localPath === "string") {
          const archived = archiveLocalFile(localPath, "group_album", entry.groupCode, path.basename(localPath));
          if (archived) entry.archivedPath = archived;
        }
        indexFile(entry);
      }
    } catch (e) {
      output("handleGroupAlbum error:", e && e.message);
    }
  }
}

module.exports.NtSnapshotManager = NtSnapshotManager;
