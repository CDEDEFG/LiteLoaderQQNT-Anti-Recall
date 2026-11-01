// 撤回识别 + 恢复 + 灰条掐断
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

// 撤回提示的特征: msgType==5 && subMsgType==4 && elements[0].grayTipElement.revokeElement
function getRevokeElement(msg) {
  if (msg == null || msg.msgType != 5 || msg.subMsgType != 4) return null;
  var el = msg.elements && msg.elements[0];
  if (el == null || el.grayTipElement == null) return null;
  return el.grayTipElement.revokeElement || null;
}

function shouldIntercept(revokeElement) {
  return cfg().isAntiRecallSelfMsg || !revokeElement.isSelfOperate;
}

function handleRecallEventSync(msgId) {
  notifyRenderer("LiteLoader.anti_recall.mainWindow.recallTip", msgId);
  var saved = msgCache.handleRecallEventSync(msgId);
  if (saved != null && saved.msg != null) {
    downloadQueue.queue(saved);
  }
  return saved != null;
}

async function handleRecallEvent(msgId) {
  // 不在这里发通知; 由 handleRecallEventSync 统一发 (被调用一次)
  if (handleRecallEventSync(msgId)) return true;
  var dbMsg = await msgCache.handleRecallEvent(msgId);
  if (dbMsg != null && dbMsg.msg != null) {
    downloadQueue.queue(dbMsg);
    return true;
  }
  return false;
}

// 把撤回提示对象原位替换为原消息内容
function doRestore(recallTipMsg, saved) {
  var currMsgId = recallTipMsg.msgId;
  let msg = Object.assign({}, saved.msg); // 克隆
  msg.isOnlineMsg = true;
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
      handleRecallEventSync(item.msgId);
      var recovered = restoreRecallTipInPlaceSync(item);
      if (!recovered) {
        recovered = await restoreRecallTipInPlace(item);
      }
      if (!recovered && removeUnrecovered) {
        removeIdx.push(idx);
      }
      var savedMsg = msgCache.findOriginalMsgSync(item.msgId);
      if (savedMsg != null && savedMsg.sender != null) {
        recalledPeers.add(savedMsg.sender);
      } else if (item.peerUid != null) {
        recalledPeers.add(item.peerUid);
      }
    } else if (item.msgId !== undefined) {
      msgCache.cacheIncomingMsg(item);
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
