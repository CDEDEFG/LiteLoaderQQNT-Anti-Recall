// NTQQ Anti-Recall - hardened full build for LiteLoaderQQNT 1.x (compat 0.x)
// 设计原则：
// 1. 完整保留原版两条拦截路径（全量列表原位替换 + 增量更新掐断），不做减法
// 2. 任意层级递归查找 msgList/cmdName，防御腾讯换包结构
// 3. send 包装带验证与自动重试，失败自动降级重试，构成保底
// 4. 拦截只发生在 主进程→渲染层 的本地 IPC 上，NT 内核仍正常接收并确认撤回包，
//    服务端视角与未装插件完全一致，这是防风控的根本基础
const fs = require("fs");
const path = require("path");
const { app, ipcMain, dialog } = require("electron");
const { ImgDownloader } = require("./imgDownloader.js");

function output(...args) {
  console.log("\x1b[32m%s\x1b[0m", "Anti-Recall:", ...args);
}

var configFilePath = "";
var pluginDataDir = path.join(LiteLoader.path.data, "anti_recall");

const imgDownloader = new ImgDownloader();

var LevelCtor = null;
try {
  LevelCtor = require("level-party");
} catch (e) {
  output("level-party 不可用，撤回消息将不会持久化到数据库:", e && e.message);
}
var db = null;
function openDb() {
  if (db != null || LevelCtor == null) return;
  try {
    db = LevelCtor(path.join(pluginDataDir, "qq-recalled-db"), {
      valueEncoding: "json",
    });
    db.open((e) => {
      if (e !== undefined && e !== null) {
        output("打开数据库失败,可能是上次QQ进程未完全退出:", e);
      }
    });
  } catch (e) {
    output("打开数据库失败:", e);
    db = null;
  }
}

var sampleConfig = {
  mainColor: "#ff6d6d",
  saveDb: false,
  enableShadow: true,
  enableTip: true,
  isAntiRecallSelfMsg: false,
  maxMsgSaveLimit: 10000,
  deleteMsgCountPerTime: 500,
  disableImgDownload: false, // 防风控开关: 开启后不向腾讯CDN重新拉取被撤回图片
};

var nowConfig = {};

function initConfig() {
  fs.writeFileSync(
    configFilePath,
    JSON.stringify(sampleConfig, null, 2),
    "utf-8"
  );
}

function loadConfig() {
  if (!fs.existsSync(configFilePath)) {
    initConfig();
    return Object.assign({}, sampleConfig);
  } else {
    try {
      return Object.assign(
        {},
        sampleConfig,
        JSON.parse(fs.readFileSync(configFilePath, "utf-8"))
      );
    } catch (e) {
      output("配置文件损坏,已重置为默认配置:", e && e.message);
      return Object.assign({}, sampleConfig);
    }
  }
}

onLoad();

async function onLoad() {
  if (!fs.existsSync(pluginDataDir)) {
    fs.mkdirSync(pluginDataDir, { recursive: true });
  }
  configFilePath = path.join(pluginDataDir, "config.json");
  nowConfig = loadConfig();
  fs.writeFileSync(configFilePath, JSON.stringify(nowConfig, null, 2), "utf-8");

  if (nowConfig.saveDb) {
    openDb();
  }

  ipcMain.handle(
    "LiteLoader.anti_recall.getNowConfig",
    async (event, message) => {
      return nowConfig;
    }
  );

  ipcMain.handle("LiteLoader.anti_recall.saveConfig", async (event, config) => {
    nowConfig = Object.assign({}, sampleConfig, config);
    imgDownloader.setEnabled(!nowConfig.disableImgDownload);
    if (nowConfig.saveDb) openDb();
    sendChatWindowsMessage("LiteLoader.anti_recall.mainWindow.repatchCss");
    fs.writeFileSync(
      configFilePath,
      JSON.stringify(nowConfig, null, 2),
      "utf-8"
    );
  });

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
          if (db != null) {
            await db.clear();
          }
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
    if (db != null) {
      try {
        await db.close();
      } catch (e) {}
    }
  });
}

// ==================== 内存缓存 ====================

var msgFlow = [];
var recalledMsg = [];

function insertDb(msg) {
  if (db != null) {
    db.get(String(msg.id), (error, value) => {
      if (error && error.status == 404) {
        db.put(String(msg.id), msg, (err) => {
          if (err) output(err);
        });
      } else if (error) {
        output(error);
      }
    });
  }
}

async function getMsgById(id) {
  if (db != null) {
    try {
      return await db.get(String(id));
    } catch (e) {
      if (e.status != 404) {
        output(e);
      }
      return null;
    }
  }
  return null;
}

function cacheIncomingMsg(msg) {
  if (msg == null || msg.msgId === undefined || msg.msgId === null) return;
  var msgId = msg.msgId;

  var olderMsgIdx = msgFlow.findIndex((i) => i.id == msgId);
  if (olderMsgIdx == -1) {
    msgFlow.push({});
    olderMsgIdx = msgFlow.length - 1;
  }
  msgFlow[olderMsgIdx] = {
    id: msgId,
    sender: msg.peerUid,
    msg: msg,
  };

  if (nowConfig.maxMsgSaveLimit == null) {
    nowConfig.maxMsgSaveLimit = 10000;
  }
  if (nowConfig.deleteMsgCountPerTime == null) {
    nowConfig.deleteMsgCountPerTime = 500;
  }

  if (msgFlow.length > nowConfig.maxMsgSaveLimit) {
    msgFlow.splice(0, nowConfig.deleteMsgCountPerTime);
  }
}

// ==================== 撤回识别 ====================

// 撤回提示的特征: msgType==5 && subMsgType==4 && elements[0].grayTipElement.revokeElement
function getRevokeElement(msg) {
  if (msg == null || msg.msgType != 5 || msg.subMsgType != 4) return null;
  var el = msg.elements && msg.elements[0];
  if (el == null || el.grayTipElement == null) return null;
  return el.grayTipElement.revokeElement || null;
}

function shouldIntercept(revokeElement) {
  return (
    nowConfig.isAntiRecallSelfMsg || !revokeElement.isSelfOperate
  );
}

// 撤回事件发生时: 通知渲染层 + 把消息移入专门的反撤回数组(必要时入库) + 下载图片
async function handleRecallEvent(msgId) {
  sendChatWindowsMessage("LiteLoader.anti_recall.mainWindow.recallTip", msgId);

  var inRecalled = recalledMsg.find((i) => i.id == msgId);
  if (inRecalled == null) {
    var fromFlow = msgFlow.find((i) => i.id == msgId);
    if (fromFlow != null) {
      recalledMsg.push(fromFlow);
      if (nowConfig.saveDb) {
        insertDb(fromFlow);
      }
      inRecalled = fromFlow;
    } else {
      var dbMsg = await getMsgById(msgId);
      if (dbMsg != null) {
        recalledMsg.push(dbMsg);
        inRecalled = dbMsg;
      }
    }
  }

  if (inRecalled != null && inRecalled.msg != null) {
    await imgDownloader.downloadPic(inRecalled.msg);
  }

  return inRecalled != null;
}

// 三级查找撤回消息原文: recalledMsg -> msgFlow -> db
async function findOriginalMsg(msgId) {
  var fromRecalled = recalledMsg.find((i) => i.id == msgId);
  if (fromRecalled != null) return fromRecalled;
  var fromFlow = msgFlow.find((i) => i.id == msgId);
  if (fromFlow != null) {
    recalledMsg.push(fromFlow);
    if (nowConfig.saveDb) insertDb(fromFlow);
    return fromFlow;
  }
  var dbMsg = await getMsgById(msgId);
  if (dbMsg != null) {
    recalledMsg.push(dbMsg);
    return dbMsg;
  }
  return null;
}

// 把撤回提示对象原位替换为原消息内容 (用于全量列表/历史拉取场景)
// 返回是否成功恢复
async function restoreRecallTipInPlace(recallTipMsg) {
  var currMsgId = recallTipMsg.msgId;
  var saved = await findOriginalMsg(currMsgId);
  if (saved == null || !(saved.msg instanceof Object)) return false;

  let msg = Object.assign({}, saved.msg); // 克隆
  msg.isOnlineMsg = true;
  await imgDownloader.downloadPic(msg);
  output("Detected recall, intercepted and recovered msgId=" + currMsgId);

  // 撤回提示消息中一些对象存在特殊属性，保留这些特殊属性以兼容某些情况不显示消息的问题
  for (let key in msg) {
    if (
      [
        "msgSeq", // 保持序列
        "cntSeq", // 保持序列
        "clientSeq", // 保持序列
        "sendStatus", // 防止消息一直在加载
        "emojiLikesList", // 表情回应
      ].includes(key)
    ) {
      continue;
    }
    let newValue = msg[key];
    let oldValue = recallTipMsg[key];
    let value = newValue;
    if (
      ["msgAttrs", "msgMeta", "generalFlags"].includes(key) &&
      newValue instanceof Object &&
      oldValue instanceof Object
    ) {
      for (let key in oldValue) {
        if (oldValue.hasOwnProperty(key)) {
          delete oldValue[key];
        }
      }
      value = Object.assign(oldValue, newValue);
    }
    try {
      recallTipMsg[key] = value;
    } catch (e) {}
  }
  return true;
}

// ==================== 核心: 对一条 webContents.send 的载荷做完整处理 ====================

// 统一的 msgList 处理器
// - 普通消息 -> 存入 msgFlow
// - 撤回提示 -> 触发反撤回 (事件通知 + 缓存迁移 + 图片下载)
//              有原文 -> 原位替换; 没有原文且是增量场景 -> 从列表中掐掉
// removeUnrecovered: true=无法恢复的撤回提示从列表删除(增量场景保证UI上的原消息不被替换成灰条)
//                    false=无法恢复就保留灰条原样(历史拉取场景, 避免消息凭空消失)
async function processMsgList(msgList, removeUnrecovered) {
  if (!(msgList instanceof Array) || msgList.length === 0) return null;

  var currentMsgPeer = "";
  var sawRecall = false;
  var removeIdx = [];

  for (let idx = 0; idx < msgList.length; idx++) {
    var item = msgList[idx];
    if (item == null || typeof item !== "object") continue;
    if (item.peerUid !== undefined && item.peerUid !== null) {
      currentMsgPeer = item.peerUid;
    }

    var revokeEl = getRevokeElement(item);
    if (revokeEl != null) {
      if (!shouldIntercept(revokeEl)) continue;
      sawRecall = true;
      await handleRecallEvent(item.msgId);
      var recovered = await restoreRecallTipInPlace(item);
      if (!recovered && removeUnrecovered) {
        removeIdx.push(idx);
      }
    } else if (item.msgId !== undefined) {
      cacheIncomingMsg(item);
    }
  }

  // 掐掉无法恢复的撤回提示 (增量场景: 原消息还显示在界面上, 不把灰条放进去就不会被替换)
  if (removeIdx.length > 0) {
    for (let i = removeIdx.length - 1; i >= 0; i--) {
      msgList.splice(removeIdx[i], 1);
    }
    output("Removed unrecoverable recall tip(s) from msgList");
  }

  return sawRecall ? currentMsgPeer : null;
}

function recallTipListFor(peer) {
  return recalledMsg
    .filter((i) => i.sender == peer || i?.sender == null)
    .map((i) => i.id);
}

// 是否是"实时增量撤回更新" (这种更新只含撤回灰条, 原版做法是直接掐掉)
function isIncrementalRecallChannel(cmdName) {
  if (typeof cmdName !== "string") return false;
  return (
    cmdName.indexOf("onMsgInfoListUpdate") != -1 ||
    cmdName.indexOf("onActiveMsgInfoUpdate") != -1 ||
    cmdName.indexOf("onMsgInfoListHalfScreenUpdate") != -1
  );
}

// 是否是"接收新消息"的事件名
function isIncomingMsgChannel(cmdName) {
  if (typeof cmdName !== "string") return false;
  return (
    cmdName.indexOf("onRecvMsg") != -1 ||
    cmdName.indexOf("onRecvActiveMsg") != -1 ||
    cmdName.indexOf("onAddSendMsg") != -1 ||
    cmdName.indexOf("onMsgInfoListUpdate") != -1 ||
    cmdName.indexOf("onActiveMsgInfoUpdate") != -1
  );
}

// 递归扫描 send 的全部参数, 找出所有 {msgList:[...]} 容器与 {cmdName,payload} 结构
// 不依赖固定层级, 腾讯把 payload 再套一层也能处理
function scanAndProcess(node, context, depth, seen) {
  if (node == null || typeof node !== "object" || depth > 8) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (node instanceof Array) {
    for (var it of node) scanAndProcess(it, context, depth + 1, seen);
    return;
  }

  // 带 cmdName 的事件结构
  if (typeof node.cmdName === "string" && node.payload != null) {
    context.cmdName = node.cmdName;
    if (isIncrementalRecallChannel(node.cmdName)) {
      context.isIncremental = true;
    }
    if (isIncomingMsgChannel(node.cmdName)) {
      context.isIncoming = true;
    }
    if (node.cmdName.indexOf("onProfileDetailInfoChanged") != -1) {
      try {
        context.myUid = node.payload.info.uid;
      } catch (e) {}
    }
  }

  // 携带 msgList 的容器
  if (node.msgList instanceof Array && node.msgList.length > 0) {
    // 增量撤回场景下, 整条更新只有撤回灰条 -> 原版行为是掐掉整个更新
    var isPureRecallUpdate =
      context.isIncremental &&
      node.msgList.every(
        (m) => getRevokeElement(m) != null && shouldIntercept(getRevokeElement(m))
      );

    if (isPureRecallUpdate && node.msgList.length <= 2) {
      // 原版增量路径: cmdName="none" + 清空msgList
      for (var m of node.msgList) {
        context.pending.push(handleRecallEvent(m.msgId));
      }
      node.msgList.splice(0, node.msgList.length);
      if (context.cmdNameOwner != null && context.cmdNameOwner.cmdName) {
        context.cmdNameOwner.cmdName = "none";
      }
      context.sawRecall = true;
      output("Detected recall, intercepted (neutralized incremental update)");
    } else {
      // 全量/历史/混合路径: 原位替换或掐掉无法恢复的灰条
      var removeUnrecovered = context.isIncremental === true;
      context.pending.push(
        processMsgList(node.msgList, removeUnrecovered).then((peer) => {
          if (peer !== null) {
            context.sawRecall = true;
            context.peers.add(peer);
          }
        })
      );
    }
    // msgList 已处理, 不再深入 (避免元素被重复扫描)
    return;
  }

  // 单条消息结构 (onAddSendMsg 的 msgRecord)
  if (
    node.msgRecord != null &&
    typeof node.msgRecord === "object" &&
    node.msgRecord.msgId !== undefined
  ) {
    cacheIncomingMsg(node.msgRecord);
  }

  for (var key in node) {
    var v = node[key];
    if (v != null && typeof v === "object") {
      scanAndProcess(v, context, depth + 1, seen);
    }
  }
}

// ==================== send 包装 ====================

function makePatchedSend(wc, original_send) {
  return async function patched_send(channel, ...args) {
    try {
      if (args.length >= 1) {
        var context = {
          pending: [],
          sawRecall: false,
          peers: new Set(),
          cmdName: "",
          cmdNameOwner: null,
          isIncremental: false,
          isIncoming: false,
          myUid: null,
        };

        // args[0] 通常是 {type:"request", eventName:"ns-ntApi-2"}, args[1] 才是 {cmdName, cmdType, payload}
        // 记录 cmdName 归属对象以便掐断时改写
        for (var a of args) {
          if (a != null && typeof a === "object" && typeof a.cmdName === "string") {
            context.cmdNameOwner = context.cmdNameOwner || a;
            break;
          }
        }

        var seen = new Set();
        for (var a of args) {
          scanAndProcess(a, context, 0, seen);
        }
        await Promise.all(context.pending);

        if (context.sawRecall) {
          for (var peer of context.peers) {
            original_send.call(
              wc,
              "LiteLoader.anti_recall.mainWindow.recallTipList",
              recallTipListFor(peer)
            );
          }
          if (context.peers.size === 0) {
            original_send.call(
              wc,
              "LiteLoader.anti_recall.mainWindow.recallTipList",
              recallTipListFor(null)
            );
          }
        }
      }
    } catch (e) {
      output(
        "NTQQ Anti-Recall Error: ",
        e,
        "Please report to https://github.com/xh321/LiteLoaderQQNT-Anti-Recall/issues"
      );
    }

    return original_send.call(wc, channel, ...args);
  };
}

// 对单个窗口执行 patch, 带验证; 成功返回 true
function tryPatchWindowSend(window) {
  try {
    var wc = window.webContents;
    if (wc == null || wc.isDestroyed()) return false;
    if (wc.__anti_recall_patched === true) return true;

    var url = "";
    try {
      url = wc.getURL() || "";
    } catch (e) {}
    // 只针对主界面和独立聊天界面; URL 尚未就绪时先不打(等待事件再试)
    if (
      url !== "" &&
      url.indexOf("#/main/message") == -1 &&
      url.indexOf("#/chat") == -1
    ) {
      return false;
    }

    var original_send = wc.send;
    if (typeof original_send !== "function") return false;

    var patched_send = makePatchedSend(wc, original_send);

    var ok = false;
    // 新版 Electron/QQ 可能把 send 定义在原型链上且不可写, 优先 defineProperty 压到实例上
    try {
      Object.defineProperty(wc, "send", {
        configurable: true,
        writable: true,
        value: patched_send,
      });
      ok = wc.send === patched_send;
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      try {
        wc.send = patched_send;
        ok = wc.send === patched_send;
      } catch (e) {
        ok = false;
      }
    }

    if (!ok) {
      output("!!! 包装 webContents.send 失败, 等待重试:", url);
      return false;
    }

    wc.__anti_recall_patched = true;
    // 兼容旧版 QQNTIM
    if (wc.__qqntim_original_object) {
      try {
        wc.__qqntim_original_object.send = patched_send;
      } catch (e) {}
    }

    if (mainWindowObjs.indexOf(window) == -1) {
      mainWindowObjs.push(window);
    }

    output("NTQQ Anti-Recall loaded for window: " + url);
    return true;
  } catch (e) {
    output("tryPatchWindowSend error:", e);
    return false;
  }
}

function sendChatWindowsMessage(message, ...args) {
  for (var window of mainWindowObjs) {
    try {
      if (window.isDestroyed()) continue;
      window.webContents.send(message, ...args);
    } catch (e) {}
  }
}

var mainWindowObjs = [];

function onBrowserWindowCreated(window) {
  if (window == null || window.webContents == null) return;
  var wc = window.webContents;

  var attemptPatch = () => {
    tryPatchWindowSend(window);
  };

  //补充知识:
  //撤回的原理是, 你先发了一条消息, 这条消息有一个msgId, 然后又撤回了它, 那腾讯就会发一条一样msgId的撤回消息包来替换,
  //这样你以后拉取的话, 这个msgId只会对应一条撤回提示了;
  //本插件的原理是, 先在内存中临时储存所有消息(上限可配置), 然后如果有撤回发生, 则将撤回的提示替换为之前保存的消息;
  //拦截点只位于主进程发往渲染进程的本地IPC, 不触碰NT内核的收发与确认流程, 服务端感知不到任何差异.

  wc.on("did-stop-loading", attemptPatch);
  wc.on("did-finish-load", attemptPatch);
  wc.on("did-navigate-in-page", attemptPatch);

  // 保底: patch 失败或时机不对时自动重试 (约30秒窗口期)
  var tries = 0;
  var timer = setInterval(() => {
    tries++;
    try {
      if (wc.isDestroyed() || tryPatchWindowSend(window) || tries > 15) {
        clearInterval(timer);
      }
    } catch (e) {
      clearInterval(timer);
    }
  }, 2000);
  window.on("closed", () => {
    clearInterval(timer);
  });
}

module.exports = {
  onBrowserWindowCreated,
};
