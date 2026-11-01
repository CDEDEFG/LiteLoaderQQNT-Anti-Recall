// LevelDB 封装 + 启动时预加载
const path = require("path");

var LevelCtor = null;
try {
  LevelCtor = require("level-party");
} catch (e) {}

var db = null;
var outputFn = console.log;

function setOutput(fn) {
  outputFn = fn;
}

function output(...args) {
  outputFn(...args);
}

function isAvailable() {
  return LevelCtor != null;
}

function open(pluginDataDir, onReady) {
  if (db != null || LevelCtor == null) {
    if (onReady) onReady(null);
    return null;
  }
  try {
    db = LevelCtor(path.join(pluginDataDir, "qq-recalled-db"), {
      valueEncoding: "json",
    });
    db.open((e) => {
      if (e) {
        output("打开数据库失败:", e && e.message);
      }
      if (onReady) onReady(e);
    });
    return db;
  } catch (e) {
    output("打开数据库异常:", e && e.message);
    if (onReady) onReady(e);
    return null;
  }
}

function getDb() {
  return db;
}

// 统一 key 为 string
function toKey(id) {
  return String(id);
}

async function get(id) {
  if (db == null) return null;
  try {
    return await db.get(toKey(id));
  } catch (e) {
    if (e.status != 404) output("db get err:", e);
    return null;
  }
}

// upsert: 存在则覆盖, 不存在则插入
function put(id, msg) {
  if (db == null) return;
  db.put(toKey(id), msg, (err) => {
    if (err) output("db put err:", err);
  });
}

async function clear() {
  if (db == null) return;
  await db.clear();
}

async function close() {
  if (db == null) return;
  try {
    await db.close();
  } catch (e) {}
}

async function loadAll() {
  if (db == null) return [];
  return new Promise((resolve, reject) => {
    const items = [];
    db.createReadStream()
      .on("data", (data) => {
        try {
          if (data.value && data.value.id != null) items.push(data.value);
        } catch (e) {}
      })
      .on("error", reject)
      .on("end", () => resolve(items));
  });
}

module.exports = { setOutput, isAvailable, open, getDb, get, put, clear, close, loadAll };
