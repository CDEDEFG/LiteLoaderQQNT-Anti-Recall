// 配置加载/保存/校验
const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  mainColor: "#ff6d6d",
  saveDb: false,
  enableShadow: true,
  enableTip: true,
  isAntiRecallSelfMsg: false,
  maxMsgSaveLimit: 10000,
  deleteMsgCountPerTime: 500,
  disableImgDownload: false,
};

var configFilePath = "";
var nowConfig = Object.assign({}, DEFAULT_CONFIG);

function init(pluginDataDir) {
  configFilePath = path.join(pluginDataDir, "config.json");
  nowConfig = load();
}

function load() {
  if (!fs.existsSync(configFilePath)) {
    save(DEFAULT_CONFIG);
    return Object.assign({}, DEFAULT_CONFIG);
  }
  try {
    var loaded = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
    return Object.assign({}, DEFAULT_CONFIG, loaded);
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function save(config) {
  nowConfig = Object.assign({}, DEFAULT_CONFIG, config);
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(nowConfig, null, 2), "utf-8");
  } catch (e) {}
}

function get() {
  return nowConfig;
}

function getDefault() {
  return Object.assign({}, DEFAULT_CONFIG);
}

module.exports = { init, load, save, get, getDefault: getDefault, DEFAULT_CONFIG };
