// NTQQ Anti-Recall - 重构版入口
// 模块拆分:
//   src/config.js          配置加载/保存/校验
//   src/database.js        LevelDB 封装 + 启动时预加载
//   src/msgCache.js        msgFlow/recalledMsg 三级缓存
//   src/recallHandler.js   撤回识别/恢复/灰条掐断
//   src/downloadQueue.js   后台下载队列 (撤回资源异步下载)
//   src/ipcScanner.js      send 包装 + 递归扫描 + 窗口 patch
// 拦截点只位于主进程发往渲染进程的本地 IPC, 不触碰 NT 内核的收发与确认流程
const fs = require("fs");
const path = require("path");
const { app, ipcMain, dialog, shell } = require("electron");

const config = require("./src/config.js");
const database = require("./src/database.js");
const msgCache = require("./src/msgCache.js");
const recallHandler = require("./src/recallHandler.js");
const downloadQueue = require("./src/downloadQueue.js");
const ipcScanner = require("./src/ipcScanner.js");
const stealthNet = require("./src/stealthNet.js");

const { ImgDownloader } = require("./imgDownloader.js");
const { NtSnapshotManager } = require("./ntSnapshotManager.js");

function output(...args) {
  console.log("\x1b[32m%s\x1b[0m", "Anti-Recall:", ...args);
}

var pluginDataDir = path.join(LiteLoader.path.data, "anti_recall");

// 初始化模块
config.init(pluginDataDir);
const imgDownloader = new ImgDownloader();
const snapshotManager = new NtSnapshotManager();

// 模块间注入
[database, msgCache, recallHandler, downloadQueue, ipcScanner, stealthNet].forEach((m) =>
  m.setOutput ? m.setOutput(output) : null
);
msgCache.setConfigGetter(config.get);
recallHandler.setConfigGetter(config.get);
downloadQueue.setDownloader(imgDownloader);
stealthNet.setConfigGetter(config.get); // 反风控引擎接管配置
recallHandler.setNotifyRenderer(ipcScanner.notifyRenderer);
ipcScanner.setNotifyRenderer(ipcScanner.notifyRenderer);
ipcScanner.setSnapshotHook((a) => {
  try {
    snapshotManager.processIpcPayload(a);
  } catch (e) {}
});

async function onLoad() {
  if (!fs.existsSync(pluginDataDir)) {
    fs.mkdirSync(pluginDataDir, { recursive: true });
  }

  // 数据库打开 + 预加载已撤回消息
  if (config.get().saveDb) {
    database.open(pluginDataDir, () => {
      msgCache.preloadFromDb().catch((e) => output("preload err:", e && e.message));
    });
  }

  // 图片下载器启用状态
  imgDownloader.setEnabled(!config.get().disableImgDownload);

  // IPC: 配置
  ipcMain.handle("LiteLoader.anti_recall.getNowConfig", async () => config.get());

  ipcMain.handle("LiteLoader.anti_recall.saveConfig", async (e, newConfig) => {
    config.save(newConfig);
    imgDownloader.setEnabled(!config.get().disableImgDownload);
    if (config.get().saveDb && database.getDb() == null) {
      database.open(pluginDataDir, () => {
        msgCache.preloadFromDb().catch(() => {});
      });
    }
    ipcScanner.notifyRenderer("LiteLoader.anti_recall.mainWindow.repatchCss");
  });

  // IPC: 渲染层主动拉取已撤回消息 id 列表
  ipcMain.handle("LiteLoader.anti_recall.getRecallList", async () =>
    msgCache.getRecalledIds(null)
  );

  // IPC: 导出撤回消息 (JSON 格式)
  ipcMain.handle("LiteLoader.anti_recall.exportRecalled", async () => {
    const { dialog } = require("electron");
    const recalledList = msgCache.getRecalledMsgList();
    if (recalledList.length === 0) {
      dialog.showMessageBox({
        type: "info",
        title: "提示",
        message: "当前没有已撤回的消息可导出。",
        buttons: ["确定"],
      });
      return;
    }
    const result = await dialog.showSaveDialog({
      title: "导出撤回消息",
      defaultPath: `recalled_msgs_${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: "JSON 文件", extensions: ["json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (!result.canceled && result.filePath) {
      try {
        const exportData = recalledList.map((item) => ({
          id: item.id,
          sender: item.sender,
          msg: item.msg,
          recallTime: item.msg?.recallTime,
          exportTime: new Date().toISOString(),
        }));
        fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), "utf-8");
        dialog.showMessageBox({
          type: "info",
          title: "导出成功",
          message: `已导出 ${recalledList.length} 条撤回消息到:\n${result.filePath}`,
          buttons: ["确定"],
        });
      } catch (e) {
        dialog.showMessageBox({
          type: "error",
          title: "导出失败",
          message: `导出失败: ${e.message}`,
          buttons: ["确定"],
        });
      }
    }
  });

  // IPC: 反风控状态 (设置页展示用)
  ipcMain.handle("LiteLoader.anti_recall.getAntiRiskStatus", async () => {
    return {
      policy: stealthNet.getPolicy(),
      threat: stealthNet.getThreatStatus(),
      learner: {
        samples: stealthNet.learner.samples.length,
        learnedAvg: Math.round(stealthNet.learner.learnedAvg),
        learnedStd: Math.round(stealthNet.learner.learnedStd),
      },
    };
  });

  // IPC: 打开归档目录
  ipcMain.handle("LiteLoader.anti_recall.openArchiveDir", async () => {
    var archiveDir = path.join(pluginDataDir, "archive");
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    await shell.openPath(archiveDir);
  });

  // IPC: 浏览撤回记录 (返回轻量列表供设置页展示)
  ipcMain.handle("LiteLoader.anti_recall.getRecalledMsgs", async () => {
    var list = msgCache.getRecalledMsgList();
    return list.map(function (item) {
      var msg = item.msg || {};
      var previewText = "";
      if (msg.elements) {
        for (var el of msg.elements) {
          if (el && el.textElement && el.textElement.content) {
            previewText += el.textElement.content;
          } else if (el && el.picElement) previewText += "[图片]";
          else if (el && el.videoElement) previewText += "[视频]";
          else if (el && el.pttElement) previewText += "[语音]";
          else if (el && el.fileElement) previewText += "[文件]";
          else if (el && el.faceElement) previewText += "[表情]";
        }
      }
      if (!previewText) previewText = "[无内容]";
      return {
        id: item.id,
        sender: item.sender || "未知",
        preview: previewText.substring(0, 100),
        recallTime: msg.recallTime || null,
        msgSeq: msg.msgSeq || null,
      };
    }).reverse(); // 最新的在前
  });

  // IPC: 撤回统计
  ipcMain.handle("LiteLoader.anti_recall.getRecallStats", async () => {
    const recalledList = msgCache.getRecalledMsgList();
    const stats = {
      total: recalledList.length,
      byPeer: {},
      byType: {},
      withMedia: 0,
      textOnly: 0,
    };
    for (const item of recalledList) {
      const peer = item.sender || "unknown";
      stats.byPeer[peer] = (stats.byPeer[peer] || 0) + 1;

      const msg = item.msg;
      if (msg && msg.elements) {
        let hasMedia = false;
        for (const el of msg.elements) {
          if (el.picElement || el.pttElement || el.videoElement || el.fileElement) {
            hasMedia = true;
            break;
          }
        }
        if (hasMedia) stats.withMedia++;
        else stats.textOnly++;
      } else {
        stats.textOnly++;
      }
    }
    return stats;
  });

  // IPC: 清空数据库
  ipcMain.handle("LiteLoader.anti_recall.clearDb", async (event, message) => {
    dialog
      .showMessageBox({
        type: "warning",
        title: "警告",
        message: "清空所有已储存的撤回消息后不可恢复，是否确认清空？",
        buttons: ["确定", "取消"],
        cancelId: 1,
      })
      .then(async (idx) => {
        if (idx.response == 0) {
          await database.clear();
          dialog.showMessageBox({
            type: "info",
            title: "提示",
            message:
              "清空完毕，之前保存的所有已撤回消息均被删除，重启QQ后就能看见效果。",
            buttons: ["确定"],
          });
        }
      });
  });

  app.on("quit", async () => {
    output("Closing db...");
    await database.close();
  });
}

onLoad();

module.exports = {
  onBrowserWindowCreated: ipcScanner.onBrowserWindowCreated,
};
