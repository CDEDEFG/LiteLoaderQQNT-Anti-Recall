// 消息缓存: msgFlow (短期) + recalledMsg (撤回专用)
const database = require("./database.js");

var msgFlow = [];
var recalledMsg = [];
var outputFn = console.log;
var configGetter = null;

function setOutput(fn) { outputFn = fn; }
function setConfigGetter(fn) { configGetter = fn; }
function output(...args) { outputFn(...args); }

function cfg() {
  return configGetter ? configGetter() : {};
}

function cacheIncomingMsg(msg) {
  if (msg == null || msg.msgId === undefined || msg.msgId === null) return;
  var msgId = msg.msgId;

  var idx = msgFlow.findIndex((i) => i.id == msgId);
  var rec = { id: msgId, sender: msg.peerUid, msg: msg };
  if (idx == -1) msgFlow.push(rec);
  else msgFlow[idx] = rec;

  var c = cfg();
  var lim = c.maxMsgSaveLimit || 10000;
  var del = c.deleteMsgCountPerTime || 500;
  if (msgFlow.length > lim) {
    msgFlow.splice(0, msgFlow.length - lim);
  }
}

// 三级查找: recalledMsg -> msgFlow -> db
function findOriginalMsgSync(msgId) {
  var fromRecalled = recalledMsg.find((i) => i.id == msgId);
  if (fromRecalled != null) return fromRecalled;
  var fromFlow = msgFlow.find((i) => i.id == msgId);
  if (fromFlow != null) {
    recalledMsg.push(fromFlow);
    if (cfg().saveDb) database.put(msgId, fromFlow);
    return fromFlow;
  }
  return null;
}

async function findOriginalMsg(msgId) {
  var hit = findOriginalMsgSync(msgId);
  if (hit != null) return hit;
  var dbMsg = await database.get(msgId);
  if (dbMsg != null) {
    recalledMsg.push(dbMsg);
    return dbMsg;
  }
  return null;
}

function handleRecallEventSync(msgId) {
  var inRecalled = recalledMsg.find((i) => i.id == msgId);
  if (inRecalled == null) {
    var fromFlow = msgFlow.find((i) => i.id == msgId);
    if (fromFlow != null) {
      recalledMsg.push(fromFlow);
      if (cfg().saveDb) database.put(msgId, fromFlow);
      inRecalled = fromFlow;
    }
  }
  return inRecalled != null ? inRecalled : null;
}

async function handleRecallEvent(msgId) {
  var hit = handleRecallEventSync(msgId);
  if (hit != null) return hit;
  var dbMsg = await database.get(msgId);
  if (dbMsg != null) {
    recalledMsg.push(dbMsg);
    return dbMsg;
  }
  return null;
}

function getRecalledMsgList() {
  return recalledMsg;
}

function getRecalledIds(peer) {
  if (peer == null) return recalledMsg.map((i) => i.id);
  return recalledMsg
    .filter((i) => i.sender != null && i.sender == peer)
    .map((i) => i.id);
}

async function preloadFromDb() {
  if (database.getDb() == null) return 0;
  try {
    var items = await database.loadAll();
    var count = 0;
    for (var v of items) {
      if (!recalledMsg.some((i) => i.id == v.id)) {
        recalledMsg.push(v);
        count++;
      }
    }
    output("Preloaded " + count + " recalled msgs from db");
    return count;
  } catch (e) {
    output("preloadFromDb failed:", e && e.message);
    return 0;
  }
}

function getMsgFlow() {
  return msgFlow;
}

function reset() {
  msgFlow = [];
  recalledMsg = [];
}

module.exports = {
  setOutput,
  setConfigGetter,
  cacheIncomingMsg,
  findOriginalMsgSync,
  findOriginalMsg,
  handleRecallEventSync,
  handleRecallEvent,
  getRecalledMsgList,
  getRecalledIds,
  preloadFromDb,
  getMsgFlow,
  reset,
};
