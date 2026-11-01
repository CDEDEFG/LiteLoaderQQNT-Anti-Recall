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
const { app, ipcMain, dialog } = require("electron");

const config = require("./src/config.js");
const database = require("./src/database.js");
const msgCache = require("./src/msgCache.js");
const recallHandler = require("./src/recallHandler.js");
const downloadQueue = require("./src/downloadQueue.js");
const ipcScanner = require("./src/ipcScanner.js");

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
[database, msgCache, recallHandler, downloadQueue, ipcScanner].forEach((m) =>
  m.setOutput(output)
);
msgCache.setConfigGetter(config.get);
recallHandler.setConfigGetter(config.get);
downloadQueue.setDownloader(imgDownloader);
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
