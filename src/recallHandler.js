// 撤回识别 + 恢复 + 灰条掐断
// 修复: 撤回时序竞态 + 撤回时间戳保留 + 完整恢复流程
const msgCache = require("./msgCache.js");
const downloadQueue = require("./downloadQueue.js");

var outputFn = console.log;
var configGetter = null;
var notifyRendererFn = null;

function setOutput(fn) { outputFn = fn; }
function setConfigGetter(fn) { configGetter = fn; }
function setNotifyRenderer(fn) { notifyRendererFn = fn; }
function output(...args) { outputFn(...args); }
function cfg() { return configGetter ? configGetter() : {}; }
function notifyRenderer(...args) { if (notifyRendererFn) notifyRendererFn(...args); }

// 撤回提示的特征: msgType==5 && subMsgType==4 && 任意元素含 grayTipElement.revokeElement
function getRevokeElement(msg) {
  if (msg == null || msg.msgType != 5 || msg.subMsgType != 4 || !Array.isArray(msg.elements)) return null;
  for (const el of msg.elements) {
    const revoke = el?.grayTipElement?.revokeElement;
    if (revoke != null) return revoke;
  }
  return null;
}

function shouldIntercept(revokeElement) {
  return cfg().isAntiRecallSelfMsg || !revokeElement.isSelfOperate;
}

// 撤回事件处理: 通知渲染层 + 缓存迁移 + 下载
// 支持时序竞态: 撤回先于消息到达时, 记录下来等消息到了再恢复
var lastNotifiedRecallId = null;
var lastNotifyTime = 0;

function handleRecallEventSync(msgId, revokeElement) {
  var id = msgCache.normalizeId(msgId);
  if (id == null) return false;

  // 去重: 同一条撤回 100ms 内只通知一次
  var now = Date.now();
  if (lastNotifiedRecallId !== id || now - lastNotifyTime > 100) {
    notifyRenderer("LiteLoader.anti_recall.mainWindow.recallTip", id);
    lastNotifiedRecallId = id;
    lastNotifyTime = now;
  }

  var saved = msgCache.handleRecallEventSync(id);
  if (saved != null) {
    if (saved.msg != null) {
      downloadQueue.queue(saved);
    }
    return true;
  }

  // 缓存没有 -> 记录到时序队列, 等消息本体到达后再恢复
  // revokeElement 可能为 undefined (直接调用时), 用空对象兜底
  msgCache.addPendingRecall(id, revokeElement || {});
  return false;
}

async function handleRecallEvent(msgId, revokeElement) {
  if (handleRecallEventSync(msgId, revokeElement)) return true;

  // 缓存没有, 走 db
  var id = msgCache.normalizeId(msgId);
  var dbMsg = await msgCache.findOriginalMsg(id);
  if (dbMsg != null && dbMsg.msg != null) {
    downloadQueue.queue(dbMsg);
    return true;
  }
  return false;
}

// 把撤回提示对象原位替换为原消息内容
// 保留撤回时间戳供渲染层显示
function doRestore(recallTipMsg, saved) {
  var currMsgId = recallTipMsg.msgId;
  let msg = Object.assign({}, saved.msg); // 克隆
  msg.isOnlineMsg = true;

  // 保存撤回时间 (撤回提示里的 recallTime 或当前时间)
  if (recallTipMsg.recallTime != null) {
    msg.recallTime = recallTipMsg.recallTime;
  } else {
    msg.recallTime = Math.floor(Date.now() / 1000);
  }

  downloadQueue.queue(saved);
  output("Detected recall, intercepted and recovered msgId=" + currMsgId);

  // 撤回提示消息中一些对象存在特殊属性，保留这些特殊属性以兼容某些情况不显示消息的问题
  for (let key in msg) {
    if (
      [
        "msgSeq",
        "cntSeq",
        "clientSeq",
        "sendStatus",
        "emojiLikesList",
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

function restoreRecallTipInPlaceSync(recallTipMsg) {
  var currMsgId = recallTipMsg.msgId;
  var saved = msgCache.findOriginalMsgSync(currMsgId);
  if (saved == null) return false;
  if (!(saved.msg instanceof Object)) return false;
  return doRestore(recallTipMsg, saved);
}

async function restoreRecallTipInPlace(recallTipMsg) {
  if (restoreRecallTipInPlaceSync(recallTipMsg)) return true;
  var currMsgId = recallTipMsg.msgId;
  var saved = await msgCache.findOriginalMsg(currMsgId);
  if (saved == null || !(saved.msg instanceof Object)) return false;
  return doRestore(recallTipMsg, saved);
}

// 统一的 msgList 处理器
// 返回涉及到的 peer 列表 (用于 recallTipList 通知)
async function processMsgList(msgList, removeUnrecovered) {
  if (!(msgList instanceof Array) || msgList.length === 0) return null;

  var sawRecall = false;
  var removeIdx = [];
  var recalledPeers = new Set();

  for (let idx = 0; idx < msgList.length; idx++) {
    var item = msgList[idx];
    if (item == null || typeof item !== "object") continue;

    var revokeEl = getRevokeElement(item);
    if (revokeEl != null) {
      if (!shouldIntercept(revokeEl)) continue;
      sawRecall = true;

      // 同步处理撤回事件 (含时序竞态处理)
      handleRecallEventSync(item.msgId, revokeEl);

      // 尝试恢复
      var recovered = restoreRecallTipInPlaceSync(item);
      if (!recovered) {
        recovered = await restoreRecallTipInPlace(item);
      }
      if (!recovered && removeUnrecovered) {
        removeIdx.push(idx);
      }

      // 记录 peer
      var savedMsg = msgCache.findOriginalMsgSync(item.msgId);
      if (savedMsg != null && savedMsg.sender != null) {
        recalledPeers.add(savedMsg.sender);
      } else if (item.peerUid != null) {
        recalledPeers.add(item.peerUid);
      }
    } else if (item.msgId !== undefined) {
      // 检查是否有时序竞态的撤回在等待这条消息
      var pendingRecall = msgCache.checkPendingRecall(item.msgId);
      if (pendingRecall != null) {
        msgCache.removePendingRecall(item.msgId);
        // 消息到了, 立即标记为撤回并缓存
        msgCache.cacheIncomingMsg(item);
        handleRecallEventSync(item.msgId, pendingRecall.revokeElement);
        sawRecall = true;
        var savedMsg = msgCache.findOriginalMsgSync(item.msgId);
        if (savedMsg != null && savedMsg.sender != null) {
          recalledPeers.add(savedMsg.sender);
        }
      } else {
        msgCache.cacheIncomingMsg(item);
      }
    }
  }

  if (removeIdx.length > 0) {
    for (let i = removeIdx.length - 1; i >= 0; i--) {
      msgList.splice(removeIdx[i], 1);
    }
    output("Removed unrecoverable recall tip(s) from msgList");
  }

  return sawRecall ? Array.from(recalledPeers) : null;
}

module.exports = {
  setOutput,
  setConfigGetter,
  setNotifyRenderer,
  getRevokeElement,
  shouldIntercept,
  handleRecallEventSync,
  handleRecallEvent,
  restoreRecallTipInPlaceSync,
  restoreRecallTipInPlace,
  processMsgList,
};
