// send 包装 + IPC 递归扫描 + 窗口 patch
const recallHandler = require("./recallHandler.js");
const msgCache = require("./msgCache.js");

var outputFn = console.log;
var snapshotHook = null;
var notifyRendererFn = null;

function setOutput(fn) { outputFn = fn; }
function setSnapshotHook(fn) { snapshotHook = fn; }
function setNotifyRenderer(fn) { notifyRendererFn = fn; }
function output(...args) { outputFn(...args); }
function notifyRenderer(...args) { if (notifyRendererFn) notifyRendererFn(...args); }

// 是否是"实时增量撤回更新" (这种更新只含撤回灰条, 原版做法是直接掐掉)
function isIncrementalRecallChannel(cmdName) {
  if (typeof cmdName !== "string") return false;
  return (
    cmdName.indexOf("onMsgInfoListUpdate") != -1 ||
    cmdName.indexOf("onActiveMsgInfoUpdate") != -1 ||
    cmdName.indexOf("onMsgInfoListHalfScreenUpdate") != -1
  );
}

// 递归扫描 send 的全部参数, 找出所有 {msgList:[...]} 容器与 {cmdName,payload} 结构
function scanAndProcess(node, context, depth, seen) {
  if (node == null || typeof node !== "object" || depth > 16) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (node instanceof Array) {
    for (var it of node) scanAndProcess(it, context, depth + 1, seen);
    return;
  }

  if (typeof node.cmdName === "string" && node.payload != null) {
    context.cmdName = node.cmdName;
    if (isIncrementalRecallChannel(node.cmdName)) {
      context.isIncremental = true;
    }
  }

  if (node.msgList instanceof Array && node.msgList.length > 0) {
    var isPureRecallUpdate =
      context.isIncremental &&
      node.msgList.every(
        (m) => recallHandler.getRevokeElement(m) != null &&
               recallHandler.shouldIntercept(recallHandler.getRevokeElement(m))
      );

    if (isPureRecallUpdate) {
      // 原版增量路径: cmdName="none" + 清空msgList
      for (var m of node.msgList) {
        context.pending.push(recallHandler.handleRecallEvent(m.msgId));
      }
      node.msgList.splice(0, node.msgList.length);
      if (context.cmdNameOwner != null && context.cmdNameOwner.cmdName) {
        context.cmdNameOwner.cmdName = "none";
      }
      context.sawRecall = true;
      output("Detected recall, intercepted (neutralized incremental update, count=" + context.pending.length + ")");
    } else {
      var removeUnrecovered = context.isIncremental === true;
      context.pending.push(
        recallHandler.processMsgList(node.msgList, removeUnrecovered).then((peers) => {
          if (peers != null && peers.length > 0) {
            context.sawRecall = true;
            for (var p of peers) context.peers.add(p);
          }
        })
      );
    }
    return;
  }

  if (
    node.msgRecord != null &&
    typeof node.msgRecord === "object" &&
    node.msgRecord.msgId !== undefined
  ) {
    msgCache.cacheIncomingMsg(node.msgRecord);
  }

  for (var key in node) {
    var v = node[key];
    if (v != null && typeof v === "object") {
      scanAndProcess(v, context, depth + 1, seen);
    }
  }
}

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
        };

        for (var a of args) {
          if (a != null && typeof a === "object" && typeof a.cmdName === "string") {
            context.cmdNameOwner = context.cmdNameOwner || a;
            break;
          }
        }

        var seen = new Set();
        for (var a of args) {
          scanAndProcess(a, context, 0, seen);
          if (snapshotHook) {
            try {
              if (a && typeof a === "object" && typeof a.cmdName === "string") {
                snapshotHook(a);
              }
            } catch (e) {
              output("snapshot hook err:", e && e.message);
            }
          }
        }
        await Promise.all(context.pending);

        if (context.sawRecall) {
          for (var peer of context.peers) {
            original_send.call(
              wc,
              "LiteLoader.anti_recall.mainWindow.recallTipList",
              msgCache.getRecalledIds(peer)
            );
          }
          if (context.peers.size === 0) {
            original_send.call(
              wc,
              "LiteLoader.anti_recall.mainWindow.recallTipList",
              msgCache.getRecalledIds(null)
            );
          }
        }
      }
    } catch (e) {
      output(
        "NTQQ Anti-Recall Error: ",
        e,
        "Please report to https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/issues"
      );
    }

    return original_send.call(wc, channel, ...args);
  };
}

var mainWindowObjs = [];

function notifyRenderer(channel, ...args) {
  // 清理已销毁的引用, 防止数组无限膨胀
  mainWindowObjs = mainWindowObjs.filter((w) => {
    try {
      return w && !w.isDestroyed();
    } catch (e) {
      return false;
    }
  });
  for (var window of mainWindowObjs) {
    try {
      if (window.isDestroyed()) continue;
      window.webContents.send(channel, ...args);
    } catch (e) {}
  }
}

function getMainWindowObjs() {
  return mainWindowObjs;
}

// 对单个窗口执行 patch, 带验证; 成功返回 true
// 策略: 任何 BrowserWindow 都尝试 patch (消息数据流只会在聊天窗口出现, 误 patch 别的窗口无副作用)
function tryPatchWindowSend(window) {
  try {
    var wc = window.webContents;
    if (wc == null || wc.isDestroyed()) return false;
    if (wc.__anti_recall_patched === true) return true;

    var original_send = wc.send;
    if (typeof original_send !== "function") return false;

    var patched_send = makePatchedSend(wc, original_send);

    var ok = false;
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
      output("!!! 包装 webContents.send 失败, 等待重试");
      return false;
    }

    wc.__anti_recall_patched = true;
    if (wc.__qqntim_original_object) {
      try {
        wc.__qqntim_original_object.send = patched_send;
      } catch (e) {}
    }

    if (mainWindowObjs.indexOf(window) == -1) {
      mainWindowObjs.push(window);
    }

    var url = "";
    try { url = wc.getURL() || ""; } catch (e) {}
    output("NTQQ Anti-Recall loaded for window: " + url);
    return true;
  } catch (e) {
    output("tryPatchWindowSend error:", e);
    return false;
  }
}

function onBrowserWindowCreated(window) {
  if (window == null || window.webContents == null) return;
  var wc = window.webContents;

  var attemptPatch = () => {
    tryPatchWindowSend(window);
  };

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
  setOutput,
  setSnapshotHook,
  setNotifyRenderer,
  scanAndProcess,
  makePatchedSend,
  tryPatchWindowSend,
  notifyRenderer,
  onBrowserWindowCreated,
  getMainWindowObjs,
};
