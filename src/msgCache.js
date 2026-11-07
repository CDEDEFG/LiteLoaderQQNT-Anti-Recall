// 消息缓存: msgFlow (短期) + recalledMsg (撤回专用)
// 优化: Map 索引 O(1) 查找 + 数量上限 + id 统一为 string
const database = require("./database.js");
const historyRecovery = require("./historyRecovery.js");

// 统一 id 为 string, 避免 number/string 混用导致的查找失败
// 空字符串也返回 null (truthy false, 后续判断更安全)
function normalizeId(id) {
  if (id === null || id === undefined || id === "") return null;
  return String(id);
}

// msgFlow: 短期缓存 (maxMsgSaveLimit 上限, 默认 10000)
// recalledMsg: 撤回专用缓存 (无上限, 但配合 db 使用)
var msgFlow = []; // Array<{id, sender, msg}>
var msgFlowIndex = new Map(); // id -> index in msgFlow (O(1) 查找)
var recalledMsg = []; // Array<{id, sender, msg}>
var recalledIndex = new Set(); // id 集合 (O(1) 查找)

var outputFn = console.log;
var configGetter = null;

function setOutput(fn) { outputFn = fn; }
function setConfigGetter(fn) { configGetter = fn; historyRecovery.setConfigGetter(fn); }
function output(...args) { outputFn(...args); }
historyRecovery.setOutput(function (...args) { outputFn(...args); });

function cfg() {
  return configGetter ? configGetter() : {};
}

function cacheIncomingMsg(msg) {
  if (msg == null || msg.msgId === undefined || msg.msgId === null) return;
  var msgId = normalizeId(msg.msgId);
  if (msgId == null) return;

  // 已存在就更新 (msg 可能有新字段)
  var existingIdx = msgFlowIndex.get(msgId);
  if (existingIdx !== undefined && existingIdx < msgFlow.length && msgFlow[existingIdx].id === msgId) {
    msgFlow[existingIdx] = { id: msgId, sender: msg.peerUid, msg: msg };
    return;
  }

  // 新增
  msgFlow.push({ id: msgId, sender: msg.peerUid, msg: msg });
  msgFlowIndex.set(msgId, msgFlow.length - 1);

  // 上限控制
  var c = cfg();
  var lim = c.maxMsgSaveLimit || 10000;
  var del = c.deleteMsgCountPerTime || 500;
  if (msgFlow.length > lim) {
    // 批量删除头部 (最老的消息), 避免重建全量索引
    var removeCount = Math.min(del, msgFlow.length - lim);
    var removed = msgFlow.splice(0, removeCount);
    for (var r of removed) {
      msgFlowIndex.delete(r.id);
    }
    // 只更新受影响的索引 (splice 后, 原 [removeCount, len) 的下标都减 removeCount)
    var newIndex = new Map();
    for (var i = 0; i < msgFlow.length; i++) {
      newIndex.set(msgFlow[i].id, i);
    }
    msgFlowIndex = newIndex;
  }
}

// 三级查找: recalledMsg -> msgFlow -> db
// 返回 { id, sender, msg } 或 null
function findOriginalMsgSync(msgId) {
  var id = normalizeId(msgId);
  if (id == null) return null;

  // 1. 先从已撤回缓存找
  if (recalledIndex.has(id)) {
    return recalledMsg.find((i) => i.id === id);
  }

  // 2. 再从短期缓存找
  var idx = msgFlowIndex.get(id);
  if (idx !== undefined && idx < msgFlow.length && msgFlow[idx].id === id) {
    var found = msgFlow[idx];
    // 提升到撤回缓存
    if (!recalledIndex.has(id)) {
      recalledMsg.push(found);
      recalledIndex.add(id);
      if (cfg().saveDb) database.put(id, found);
    }
    return found;
  }

  return null;
}

async function findOriginalMsg(msgId) {
  var hit = findOriginalMsgSync(msgId);
  if (hit != null) return hit;
  var id = normalizeId(msgId);
  var dbMsg = await database.get(id);
  if (dbMsg != null) {
    if (!recalledIndex.has(id)) {
      recalledMsg.push(dbMsg);
      recalledIndex.add(id);
    }
    return dbMsg;
  }
  // 本机 QQ 历史库只按精确 msgId 恢复曾经同步到本机的消息
  var historyMsg = await historyRecovery.recoverMessage(id);
  if (historyMsg != null) {
    recalledMsg.push(historyMsg);
    recalledIndex.add(id);
    if (cfg().saveDb) database.put(id, historyMsg);
    return historyMsg;
  }
  return null;
}

function handleRecallEventSync(msgId) {
  var id = normalizeId(msgId);
  if (id == null) return null;

  // 已撤回过
  if (recalledIndex.has(id)) {
    return recalledMsg.find((i) => i.id === id);
  }

  // 从 msgFlow 提升到 recalledMsg
  var idx = msgFlowIndex.get(id);
  if (idx !== undefined && idx < msgFlow.length && msgFlow[idx].id === id) {
    var found = msgFlow[idx];
    recalledMsg.push(found);
    recalledIndex.add(id);
    if (cfg().saveDb) database.put(id, found);
    return found;
  }

  return null;
}

async function handleRecallEvent(msgId) {
  var hit = handleRecallEventSync(msgId);
  if (hit != null) return hit;
  var id = normalizeId(msgId);
  var dbMsg = await database.get(id);
  if (dbMsg != null) {
    if (!recalledIndex.has(id)) {
      recalledMsg.push(dbMsg);
      recalledIndex.add(id);
    }
    return dbMsg;
  }
  // 本机 QQ 历史库只按精确 msgId 恢复曾经同步到本机的消息
  var historyMsg = await historyRecovery.recoverMessage(id);
  if (historyMsg != null) {
    recalledMsg.push(historyMsg);
    recalledIndex.add(id);
    if (cfg().saveDb) database.put(id, historyMsg);
    return historyMsg;
  }
  return null;
}

function getRecalledMsgList() {
  return recalledMsg;
}

// 获取已撤回消息的 id 列表
// peer == null: 返回所有
// peer != null: 返回 sender 匹配的 (包括 sender 为 null 的兜底)
function getRecalledIds(peer) {
  if (peer == null) return recalledMsg.map((i) => i.id);
  return recalledMsg
    .filter((i) => i.sender == null || i.sender === peer)
    .map((i) => i.id);
}

async function preloadFromDb() {
  if (database.getDb() == null) return 0;
  try {
    var items = await database.loadAll();
    var count = 0;
    for (var v of items) {
      var id = normalizeId(v.id);
      if (id != null && !recalledIndex.has(id)) {
        recalledMsg.push({ id: id, sender: v.sender, msg: v.msg });
        recalledIndex.add(id);
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

// 撤回时序竞态修复: 撤回在消息本体前到达时, 记录下来等消息到了再恢复
var pendingRecallQueue = new Map(); // id -> { timestamp, revokeElement }
var PENDING_RECALL_TTL = 60000; // 1分钟内的撤回等待消息本体

function addPendingRecall(msgId, revokeElement) {
  var id = normalizeId(msgId);
  if (id == null) return;
  // 清理过期的
  var now = Date.now();
  for (var [k, v] of pendingRecallQueue) {
    if (now - v.timestamp > PENDING_RECALL_TTL) {
      pendingRecallQueue.delete(k);
    }
  }
  pendingRecallQueue.set(id, { timestamp: now, revokeElement: revokeElement });
}

function checkPendingRecall(msgId) {
  var id = normalizeId(msgId);
  if (id == null) return null;
  return pendingRecallQueue.get(id);
}

function removePendingRecall(msgId) {
  var id = normalizeId(msgId);
  if (id != null) pendingRecallQueue.delete(id);
}

function getMsgFlow() {
  return msgFlow;
}

function reset() {
  msgFlow = [];
  msgFlowIndex.clear();
  recalledMsg = [];
  recalledIndex.clear();
  pendingRecallQueue.clear();
}

module.exports = {
  setOutput,
  setConfigGetter,
  normalizeId,
  cacheIncomingMsg,
  findOriginalMsgSync,
  findOriginalMsg,
  handleRecallEventSync,
  handleRecallEvent,
  getRecalledMsgList,
  getRecalledIds,
  preloadFromDb,
  getHistoryStatus: function () { return historyRecovery.status(); },
  closeHistoryRecovery: function () { historyRecovery.closePlaintextDatabases(); },
  addPendingRecall,
  checkPendingRecall,
  removePendingRecall,
  getMsgFlow,
  reset,
};
