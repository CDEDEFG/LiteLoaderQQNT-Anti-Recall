// 配置加载/保存/校验 (v0.8.0 完整版)
const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  // ===== 基础配置 =====
  mainColor: "#ff6d6d",           // 撤回提示主题色
  enableShadow: true,             // 撤回消息红色阴影
  enableTip: true,                // 撤回消息下方"已撤回"标记
  isAntiRecallSelfMsg: false,     // 是否反撤回自己发送的消息

  // ===== 存储配置 =====
  saveDb: false,                  // 是否将撤回消息存入 LevelDB
  maxMsgSaveLimit: 10000,         // 内存中消息最多缓存条数
  deleteMsgCountPerTime: 500,     // 超出上限时一次性清理多少

  // ===== 网络/下载配置 =====
  disableImgDownload: false,      // 完全禁用媒体下载 (最大隐身)
  enableUrlHijack: true,          // 启用图片/视频 URL 劫持 (QQ 自己拉)
  enableMultiForwardDownload: true, // 合并转发消息强制递归下载

  // ===== 反风控配置 (v0.8.0) =====
  antiRiskMode: "auto",           // 反风控模式: off / auto / strict / paranoid
                                    //   off      = 原始行为 (不伪装)
                                    //   auto     = 十层防护, 正常速率 (日常使用)
                                    //   strict   = 低速率 + 加强延迟 (疑似风控环境)
                                    //   paranoid = 仅URL劫持, 插件零直接请求 (高度敏感)
  stealthLevel: 2,                // 伪装等级: 0-3
                                    //   0 = 关闭伪装
                                    //   1 = 基础 (请求头 + 延迟)
                                    //   2 = 标准 (十层防护)        [默认]
                                    //   3 = 增强 (AI行为学习 + 威胁响应)
  maxDownloadPerMinute: 120,      // 每分钟下载次数上限 (auto 模式有效)
  enableBehaviorLearning: true,   // AI 行为学习引擎
  enableThreatResponse: true,     // 威胁情报自动响应
  threatResponseLevel: "auto",    // 威胁响应阈值: auto / sensitive / aggressive
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
