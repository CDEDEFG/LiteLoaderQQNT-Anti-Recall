var recalledMsgList = [];
var nowConfig = {};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

function escapeCssColor(value) {
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : "#ff6d6d";
}

export async function onSettingWindowCreated(view) {
  // Duck-typing 检查: 不用 instanceof (跨 realm 的 DOM 对象 instanceof 会误判)
  function isValidView(v) {
    return v && typeof v === "object" && typeof v.innerHTML === "string" && typeof v.querySelector === "function";
  }
  if (!isValidView(view)) {
    view = document.querySelector(".tab-view.anti_recall");
  }
  if (!view) {
    console.log("[Anti-Recall] view not found, creating fallback");
    // 等 LiteLoader 把它加到 DOM
    var tries = 0;
    while (!view && tries < 50) {
      await new Promise((r) => setTimeout(r, 100));
      view = document.querySelector(".tab-view.anti_recall");
      tries++;
    }
  }
  if (!view) {
    console.log("[Anti-Recall] view still not found after 5s, giving up");
    return;
  }
  console.log("[Anti-Recall] found view, injecting content");
  nowConfig = await getNowConfigCached();

  const new_navbar_item = `
    <div class="anti-recall-wrapper">
      <setting-item class="config_view">

        <setting-section data-title="操作">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item>
                <setting-text>清空已储存的撤回消息</setting-text>
                <setting-button data-type="secondary" id="clearDb">清空</setting-button>
              </setting-item>
              <setting-item>
                <setting-text>导出撤回消息 (JSON)</setting-text>
                <setting-button data-type="secondary" id="exportRecalled">导出</setting-button>
              </setting-item>
              <setting-item>
                <setting-text>查看撤回统计</setting-text>
                <setting-button data-type="secondary" id="showStats">统计</setting-button>
              </setting-item>
              <setting-item>
                <setting-text>打开归档目录</setting-text>
                <setting-button data-type="secondary" id="openArchiveDir">打开</setting-button>
              </setting-item>
              <setting-item>
                <setting-text>浏览撤回记录</setting-text>
                <setting-button data-type="secondary" id="showRecalledList">浏览</setting-button>
              </setting-item>
              <setting-item>
                <div id="statsPanel" style="display:none; width:100%; padding:10px; background:var(--fill_light_primary); border-radius:8px;">
                  <div id="statsContent">加载中...</div>
                </div>
              </setting-item>
              <setting-item>
                <div id="recalledListPanel" style="display:none; width:100%; padding:10px; background:var(--fill_light_primary); border-radius:8px; max-height:400px; overflow-y:auto;">
                  <div id="recalledListContent">加载中...</div>
                </div>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="基础配置">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item>
                <setting-text>撤回消息存入数据库</setting-text>
                <setting-text data-type="secondary">重启 QQ 后仍可恢复；数据库不加密</setting-text>
                <setting-switch id="switchSaveDb"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>反撤回自己的消息</setting-text>
                <setting-text data-type="secondary">自己发送的消息也会被反撤回</setting-text>
                <setting-switch id="switchAntiRecallSelf"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>内存中消息最多缓存条数</setting-text>
                <setting-text data-type="secondary">过多占内存，过少可能漏撤回</setting-text>
                <input id="maxMsgLimit" class="text_color path-input" type="number" min="1" max="99999999" style="width:100px;"/>
              </setting-item>
              <setting-item>
                <setting-text>超上限时一次清理条数</setting-text>
                <setting-text data-type="secondary">过多可能漏撤回，过少内存增长快</setting-text>
                <input id="deletePerTime" class="text_color path-input" type="number" min="1" max="99999" style="width:100px;"/>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="样式配置">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item>
                <setting-text>撤回主题色</setting-text>
                <setting-text data-type="secondary">影响阴影和"已撤回"提示颜色</setting-text>
                <input type="color" class="pick-color" />
              </setting-item>
              <setting-item>
                <setting-text>撤回后显示阴影</setting-text>
                <setting-switch id="switchShadow"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>撤回后显示"已撤回"提示</setting-text>
                <setting-switch id="switchTip"></setting-switch>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="下载与资源恢复">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item>
                <setting-text>图片/视频 CDN 地址恢复</setting-text>
                <setting-text data-type="secondary">将被撤回图片/视频的地址字段替换为 CDN 直链，由 QQ 尝试加载；不拦截网络协议，无法恢复服务器已删除的资源。</setting-text>
                <setting-switch id="switchUrlHijack"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>合并转发强制恢复</setting-text>
                <setting-text data-type="secondary">递归下载合并转发子消息的资源</setting-text>
                <setting-switch id="switchMultiForward"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>每分钟下载次数上限</setting-text>
                <setting-text data-type="secondary">建议 60-180，与正常浏览速度一致</setting-text>
                <input id="maxDownloadPerMinute" class="text_color path-input" type="number" min="1" max="999" style="width:100px;"/>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="反风控">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item>
                <setting-text>完全隐身模式</setting-text>
                <setting-text data-type="secondary">零网络请求，仅本地文件恢复；文字表情不受影响</setting-text>
                <setting-switch id="switchDisableImgDownload"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>反风控模式</setting-text>
                <setting-text data-type="secondary">日常用「自动」即可</setting-text>
                <select id="antiRiskModeSelect" class="path-input text_color" style="padding:4px 8px; border-radius:4px;">
                  <option value="auto">自动 — 标准防护，时间自适应</option>
                  <option value="strict">严格 — 低速率+强化延迟</option>
                  <option value="paranoid">偏执 — 插件零直接下载，仅地址恢复</option>
                  <option value="off">关闭 — 裸请求，仅调试</option>
                </select>
              </setting-item>
              <setting-item>
                <setting-text>伪装等级</setting-text>
                <setting-text data-type="secondary">等级越高特征越少，延迟略增</setting-text>
                <select id="stealthLevelSelect" class="path-input text_color" style="padding:4px 8px; border-radius:4px;">
                  <option value="0">0 — 关闭伪装</option>
                  <option value="1">1 — 基础（请求头+延迟）</option>
                  <option value="2">2 — 标准（十层防护）</option>
                  <option value="3">3 — 增强（AI学习+威胁响应）</option>
                </select>
              </setting-item>
              <setting-item>
                <setting-text>AI 行为学习引擎</setting-text>
                <setting-text data-type="secondary">学习你的自然节奏，伪装更像真人</setting-text>
                <setting-switch id="switchBehaviorLearning"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>威胁情报自动响应</setting-text>
                <setting-text data-type="secondary">检测异常自动降速或暂停</setting-text>
                <setting-switch id="switchThreatResponse"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>当前反风控状态</setting-text>
                <setting-button data-type="secondary" id="refreshAntiRiskStatus">刷新状态</setting-button>
                <div id="antiRiskStatusPanel" style="width:100%; margin-top:8px; padding:12px; background:var(--fill_light_primary); border-radius:8px; font-size:13px; line-height:1.8; display:none;"></div>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="本地历史恢复">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item>
                <setting-text>启用本机历史消息恢复</setting-text>
                <setting-text data-type="secondary">仅 Windows；QQ 保持登录时，从本机历史库按 msgId 恢复曾同步到本机的原文。密钥仅内存使用，不上传。默认关闭。</setting-text>
                <setting-switch id="switchHistoryRecovery"></setting-switch>
              </setting-item>
              <setting-item>
                <setting-text>指定要恢复的 QQ 号</setting-text>
                <setting-text data-type="secondary">多个账号时必须填写；单账号可留空。不能恢复本机从未收到过的离线原文。</setting-text>
                <input id="historyQqNumber" class="text_color path-input" type="text" inputmode="numeric" style="width:150px;" placeholder="QQ 号（可选）"/>
              </setting-item>
              <setting-item>
                <setting-text>历史恢复状态</setting-text>
                <setting-button data-type="secondary" id="refreshHistoryStatus">刷新状态</setting-button>
                <div id="historyStatusPanel" style="width:100%; margin-top:8px; padding:12px; background:var(--fill_light_primary); border-radius:8px; font-size:13px; line-height:1.8; display:none;"></div>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

      </div>
    </div>
  `;

  view.innerHTML = new_navbar_item;
  const node2 = view.querySelector(".anti-recall-wrapper");
  // setting-switch helper: is-active attribute controls on/off
  function setSwitch(el, on) { if (on) el.setAttribute("is-active", ""); else el.removeAttribute("is-active"); }
  function isSwitchOn(el) { return el.hasAttribute("is-active"); }
  function toggleSwitch(el) { if (el.hasAttribute("is-active")) { el.removeAttribute("is-active"); return false; } else { el.setAttribute("is-active", ""); return true; } }


  //清空消息
  node2.querySelector("#clearDb").addEventListener("click", async () => {
    await window.anti_recall.clearDb();
  });

  //导出撤回消息
  node2.querySelector("#exportRecalled").addEventListener("click", async () => {
    await window.anti_recall.exportRecalled();
  });

  //撤回统计
  node2.querySelector("#showStats").addEventListener("click", async () => {
    var panel = node2.querySelector("#statsPanel");
    var content = node2.querySelector("#statsContent");
    if (panel.style.display === "none") {
      panel.style.display = "block";
      content.innerHTML = "加载中...";
      try {
        var stats = await window.anti_recall.getRecallStats();
        var html = `<div style="font-size:14px; line-height:1.8;">
          <b>总计:</b> ${stats.total} 条撤回消息<br>
          <b>含媒体:</b> ${stats.withMedia} 条 | <b>纯文本:</b> ${stats.textOnly} 条<br>
          <b>按会话分布:</b><br>`;
        var sortedPeers = Object.entries(stats.byPeer).sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (var [peer, count] of sortedPeers) {
          html += `&nbsp;&nbsp;${peer}: ${count} 条<br>`;
        }
        html += `</div>`;
        content.innerHTML = html;
      } catch (e) {
        content.innerHTML = "加载失败: " + e.message;
      }
    } else {
      panel.style.display = "none";
    }
  });

  //打开归档目录
  node2.querySelector("#openArchiveDir").addEventListener("click", async () => {
    await window.anti_recall.openArchiveDir();
  });

  //浏览撤回记录
  node2.querySelector("#showRecalledList").addEventListener("click", async () => {
    var panel = node2.querySelector("#recalledListPanel");
    var content = node2.querySelector("#recalledListContent");
    if (panel.style.display === "none") {
      panel.style.display = "block";
      content.innerHTML = "加载中...";
      try {
        var msgs = await window.anti_recall.getRecalledMsgs();
        if (!msgs || msgs.length === 0) {
          content.innerHTML = "暂无撤回消息";
        } else {
          var html = `<div style="font-size:13px; line-height:1.6;">`;
          msgs.slice(0, 50).forEach((m, i) => {
            var time = m.recallTime ? new Date(m.recallTime * 1000).toLocaleString() : "未知时间";
            html += `<div style="padding:6px 8px; margin:4px 0; background:var(--bg_bottom_standard); border-radius:6px; border-left:3px solid var(--fill_light_primary);">
              <div style="color:var(--text_secondary); font-size:11px;">#${i+1} · ${escapeHtml(m.sender)} · ${time}</div>
              <div style="color:var(--text_primary); margin-top:2px; word-break:break-all;">${escapeHtml(m.preview)}</div>
            </div>`;
          });
          if (msgs.length > 50) html += `<div style="color:var(--text_secondary); text-align:center; padding:8px;">仅显示前 50 条, 共 ${msgs.length} 条</div>`;
          html += `</div>`;
          content.innerHTML = html;
        }
      } catch (e) {
        content.innerHTML = "加载失败: " + e.message;
      }
    } else {
      panel.style.display = "none";
    }
  });

  node2.querySelector("#maxMsgLimit").onblur = async () => {
    var limit = parseFloat(node2.querySelector("#maxMsgLimit").value);
    if (limit <= 0 || limit > 99999999) {
      alert("你的数量输入有误！将不会保存，请重新输入");
      return;
    }
    nowConfig.maxMsgSaveLimit = limit;
    await window.anti_recall.saveConfig(nowConfig);
  };

  node2.querySelector("#deletePerTime").onblur = async () => {
    var limit = parseFloat(node2.querySelector("#deletePerTime").value);
    if (limit <= 0 || limit > 99999) {
      alert("你的数量输入有误！将不会保存，请重新输入");
      return;
    }
    nowConfig.deleteMsgCountPerTime = limit;
    await window.anti_recall.saveConfig(nowConfig);
  };

  //选择颜色
  const pickColor = node2.querySelector(".pick-color");
  pickColor.value = nowConfig.mainColor;
  pickColor.addEventListener("change", async (event) => {
    nowConfig.mainColor = event.target.value;
    await window.anti_recall.saveConfig(nowConfig);
  });

  //存数据库开关
  var q_switch_savedb = node2.querySelector("#switchSaveDb");
  setSwitch(q_switch_savedb, nowConfig.saveDb == true);
  q_switch_savedb.addEventListener("click", async () => {
    nowConfig.saveDb = toggleSwitch(q_switch_savedb);
    await window.anti_recall.saveConfig(nowConfig);
  });
  var q_switch_antiself = node2.querySelector("#switchAntiRecallSelf");
  setSwitch(q_switch_antiself, nowConfig.isAntiRecallSelfMsg == true);
  q_switch_antiself.addEventListener("click", async () => {
    nowConfig.isAntiRecallSelfMsg = toggleSwitch(q_switch_antiself);
    await window.anti_recall.saveConfig(nowConfig);
  });
  var q_switch_nodl = node2.querySelector("#switchDisableImgDownload");
  setSwitch(q_switch_nodl, nowConfig.disableImgDownload == true);
  q_switch_nodl.addEventListener("click", async () => {
    nowConfig.disableImgDownload = toggleSwitch(q_switch_nodl);
    await window.anti_recall.saveConfig(nowConfig);
  });
  var q_switch_shadow = node2.querySelector("#switchShadow");
  setSwitch(q_switch_shadow, nowConfig.enableShadow !== false);
  q_switch_shadow.addEventListener("click", async () => {
    nowConfig.enableShadow = toggleSwitch(q_switch_shadow);
    await window.anti_recall.saveConfig(nowConfig);
  });
  var q_switch_tip = node2.querySelector("#switchTip");
  setSwitch(q_switch_tip, nowConfig.enableTip !== false);
  q_switch_tip.addEventListener("click", async () => {
    nowConfig.enableTip = toggleSwitch(q_switch_tip);
    await window.anti_recall.saveConfig(nowConfig);
  });
  // ===== 下载与资源恢复 =====

  // URL 劫持开关
  var q_switch_urlhijack = node2.querySelector("#switchUrlHijack");
  setSwitch(q_switch_urlhijack, nowConfig.enableUrlHijack != false);
  q_switch_urlhijack.addEventListener("click", async () => {
    nowConfig.enableUrlHijack = toggleSwitch(q_switch_urlhijack);
    await window.anti_recall.saveConfig(nowConfig);
  });

  // 合并转发强制恢复开关
  var q_switch_multiforward = node2.querySelector("#switchMultiForward");
  setSwitch(q_switch_multiforward, nowConfig.enableMultiForwardDownload != false);
  q_switch_multiforward.addEventListener("click", async () => {
    nowConfig.enableMultiForwardDownload = toggleSwitch(q_switch_multiforward);
    await window.anti_recall.saveConfig(nowConfig);
  });

  // 每分钟下载上限
  var dlLimitInput = node2.querySelector("#maxDownloadPerMinute");
  dlLimitInput.value = nowConfig.maxDownloadPerMinute != null ? nowConfig.maxDownloadPerMinute : 120;
  dlLimitInput.onblur = async () => {
    var v = parseInt(dlLimitInput.value);
    if (isNaN(v) || v < 1 || v > 999) {
      alert("请输入 1-999 之间的数字");
      dlLimitInput.value = nowConfig.maxDownloadPerMinute != null ? nowConfig.maxDownloadPerMinute : 120;
      return;
    }
    nowConfig.maxDownloadPerMinute = v;
    await window.anti_recall.saveConfig(nowConfig);
  };

  // ===== 反风控 =====

  // 反风控模式选择
  var antiRiskSelect = node2.querySelector("#antiRiskModeSelect");
  antiRiskSelect.value = nowConfig.antiRiskMode || "auto";
  antiRiskSelect.addEventListener("change", async () => {
    nowConfig.antiRiskMode = antiRiskSelect.value;
    await window.anti_recall.saveConfig(nowConfig);
  });

  // 伪装等级选择
  var stealthSelect = node2.querySelector("#stealthLevelSelect");
  stealthSelect.value = String(nowConfig.stealthLevel != null ? nowConfig.stealthLevel : 2);
  stealthSelect.addEventListener("change", async () => {
    nowConfig.stealthLevel = parseInt(stealthSelect.value);
    await window.anti_recall.saveConfig(nowConfig);
  });

  // AI 行为学习开关
  var q_switch_learning = node2.querySelector("#switchBehaviorLearning");
  setSwitch(q_switch_learning, nowConfig.enableBehaviorLearning != false);
  q_switch_learning.addEventListener("click", async () => {
    nowConfig.enableBehaviorLearning = toggleSwitch(q_switch_learning);
    await window.anti_recall.saveConfig(nowConfig);
  });

  // 威胁响应开关
  var q_switch_threat = node2.querySelector("#switchThreatResponse");
  setSwitch(q_switch_threat, nowConfig.enableThreatResponse != false);
  q_switch_threat.addEventListener("click", async () => {
    nowConfig.enableThreatResponse = toggleSwitch(q_switch_threat);
    await window.anti_recall.saveConfig(nowConfig);
  });

  // 本地历史恢复
  var q_switch_history = node2.querySelector("#switchHistoryRecovery");
  setSwitch(q_switch_history, nowConfig.enableHistoryRecovery == true);
  q_switch_history.addEventListener("click", async () => {
    nowConfig.enableHistoryRecovery = toggleSwitch(q_switch_history);
    await window.anti_recall.saveConfig(nowConfig);
  });

  var historyQqInput = node2.querySelector("#historyQqNumber");
  historyQqInput.value = nowConfig.historyQqNumber || "";
  historyQqInput.onblur = async () => {
    nowConfig.historyQqNumber = historyQqInput.value.trim().replace(/[^0-9]/g, "");
    historyQqInput.value = nowConfig.historyQqNumber;
    await window.anti_recall.saveConfig(nowConfig);
  };

  node2.querySelector("#refreshHistoryStatus").addEventListener("click", async () => {
    var panel = node2.querySelector("#historyStatusPanel");
    panel.style.display = "block";
    try {
      var status = await window.anti_recall.getHistoryStatus();
      panel.innerHTML =
        `<b>启用状态:</b> ${status.enabled ? "已启用" : "未启用"}<br>` +
        `<b>本机账号:</b> ${status.accounts.length ? status.accounts.map(escapeHtml).join("、") : "未发现"}<br>` +
        `<b>当前选择:</b> ${status.selectedAccount ? escapeHtml(status.selectedAccount) : "未指定（多账号需填写 QQ 号）"}<br>` +
        `<b>已恢复:</b> ${status.recoveredCount} 条<br>` +
        (status.lastError ? `<b>最近错误:</b> ${escapeHtml(status.lastError)}<br>` : "") +
        `<b>说明:</b> ${escapeHtml(status.note)}`;
    } catch (e) {
      panel.innerHTML = "获取失败: " + escapeHtml(e.message);
    }
  });

  // 反风控状态展示
  node2.querySelector("#refreshAntiRiskStatus").addEventListener("click", async () => {
    var panel = node2.querySelector("#antiRiskStatusPanel");
    try {
      var status = await window.anti_recall.getAntiRiskStatus();
      panel.style.display = "block";
      var threatColor = { LOW: "#4caf50", MEDIUM: "#ff9800", HIGH: "#ff5722", CRITICAL: "#d32f2f" };
      panel.innerHTML =
        `<b>策略模式:</b> ${status.policy.name}<br>` +
        `<b>有效速率:</b> ${status.threat.effectiveRate} 次/分钟<br>` +
        `<b>威胁级别:</b> <span style="color:${threatColor[status.threat.level] || "#888"};font-weight:bold;">${status.threat.level}</span> (${status.threat.signals} 个信号)<br>` +
        `<b>AI 学习:</b> ${status.learner.samples} 个样本, 平均延迟 ${status.learner.learnedAvg}ms (±${status.learner.learnedStd}ms)`;
    } catch (e) {
      panel.style.display = "block";
      panel.innerHTML = "获取失败: " + e.message;
    }
  });
}

async function patchCss() {
  nowConfig = await getNowConfigCached();

  var cssNode = document
    .evaluate("/html/head/style[@id='anti-recall-css']", document)
    .iterateNext();
  if (cssNode) {
    cssNode.parentElement.removeChild(cssNode);
  }
  var stylee = document.createElement("style");
  stylee.type = "text/css";
  stylee.id = "anti-recall-css";

  // 用 CSS 变量管理主题色, 后续改色不用重拼整个 style 块
  var mainColor = escapeCssColor(nowConfig.mainColor);

  var sHtml = `   :root {
                    --anti-recall-color: ${mainColor};
                  }

                  .message-content__wrapper {
                    color: var(--bubble_guest_text);
                    display: flex;
                    grid-row-start: content;
                    grid-column-start: content;
                    grid-row-end: content;
                    grid-column-end: content;
                    max-width: -webkit-fill-available;
                    min-height: 38px;
                    overflow: visible !important;
                    border-radius: 10px;
                  }

                  .message-content__wrapper.message-content-recalled-parent {
                    padding: 0px !important;
                  }

                  .message-content-recalled-parent {
                    border-radius: 10px;
                    position: relative;
                    overflow: unset !important;`;
  if (nowConfig.enableShadow == true) {
    sHtml += `      margin-top:3px;
                    margin-left:3px;
                    margin-right:3px;
                    margin-bottom: 25px;
                    box-shadow: 0px 0px 8px 5px var(--anti-recall-color) !important;`;
  } else {
    sHtml += `margin-bottom: 15px;`;
  }
  sHtml += `                }
            .recalledNoMargin {
                margin-top: 0px!important;
            }

            .message-content-recalled {
                position: absolute;
                top: calc(100% + 6px);
                left: 0;
                font-size: 12px;
                white-space: nowrap;
                color: var(--anti-recall-color);
                text-shadow: 0px 0px 4px rgba(0,0,0,0.3), 0px 0px 4px rgba(255,255,255,0.3);
                background-color: var(--background-color-05);
                backdrop-filter: blur(28px);
                padding: 4px 8px;
                margin-bottom: 2px;
                border-radius: 6px;
                box-shadow: var(--box-shadow);
                transition: 300ms;
                transform: translateX(-30%);
                opacity: 0;
                pointer-events: none;
            }
        `;
  stylee.innerHTML = sHtml;
  document.getElementsByTagName("head")[0].appendChild(stylee);
}

onLoad();

// 缓存 nowConfig, 避免频繁 IPC; 配置变更时主进程会主动推送 repatchCss 更新
var cachedConfig = null;
var configLastFetch = 0;
async function getNowConfigCached() {
  var now = Date.now();
  // 1秒内缓存有效
  if (cachedConfig != null && now - configLastFetch < 1000) {
    return cachedConfig;
  }
  try {
    cachedConfig = (await window.anti_recall.getNowConfig()) || {};
    configLastFetch = now;
    return cachedConfig;
  } catch (e) {
    return cachedConfig || {};
  }
}

async function onLoad() {
  // 主进程通知配置变更时立即失效缓存
  anti_recall.repatchCss(async () => {
    cachedConfig = null;
    configLastFetch = 0;
    await patchCss();
  });

  // 按优先级尝试所有可能的消息容器选择器, 命中第一个非灰条就返回
  function findMsgContainer(msgId) {
    // 1. 老版本消息容器
    var el = document.getElementById(`${msgId}-msgContainerMsgContent`);
    if (el && !el.classList.contains("gray-tip-message")) return { el: el, addNoMargin: false };
    // 2. 新版本/卡片/Ark 共享容器
    el = document.getElementById(`${msgId}-msgContent`);
    if (el && !el.classList.contains("gray-tip-message")) {
      return { el: el.parentElement, addNoMargin: true };
    }
    // 3. Unix-like 消息 ID 前缀
    el = document.getElementById(`ml-${msgId}`)?.querySelector(".msg-content-container");
    if (el && !el.classList.contains("gray-tip-message")) return { el: el.parentElement, addNoMargin: false };
    // 4. Ark 专用容器
    el = document.getElementById(`ark-msg-content-container_${msgId}`);
    if (el && !el.classList.contains("gray-tip-message")) return { el: el.parentElement, addNoMargin: true };
    // 5. 兜底: 列表项内任意内容容器
    el = document.querySelector(`.ml-item[id='${msgId}'] .msg-content-container`);
    if (el && !el.classList.contains("gray-tip-message")) return { el: el, addNoMargin: false };
    return null;
  }

  //消息更新回调
  anti_recall.recallTip(async (event, msgId) => {
    var found = findMsgContainer(msgId);
    if (found) {
      if (found.addNoMargin) found.el.classList.add("recalledNoMargin");
      await appendRecalledTag(found.el);
    }
  });
  //消息列表更新回调
  anti_recall.recallTipList(async (event, msgIdList) => {
    recalledMsgList = msgIdList;
    await render();
  });

  // 周期性拉取撤回列表并补标 —— 解决QQ SPA切会话/重渲染后标记丢失导致撤回显示为灰条
  // 聊天区域存在时拉取, 1s 一次; 页面隐藏/失焦时暂停, 恢复时重新启动
  var pullTimer = null;
  function startPullLoop() {
    if (pullTimer != null) return;
    pullTimer = setInterval(async () => {
      // 页面不可见时跳过本次 (空转浪费)
      if (document.hidden) return;
      try {
        if (typeof anti_recall.requestRecallList !== "function") return;
        var list = await anti_recall.requestRecallList();
        if (Array.isArray(list) && list.length > 0) {
          // 合并: 之前推送的 + 主进程存的
          var merged = Array.from(new Set([...(recalledMsgList || []), ...list]));
          if (merged.length !== (recalledMsgList || []).length) {
            recalledMsgList = merged;
            await render();
          }
        }
      } catch (e) {}
    }, 1000);
  }
  // 页面卸载时清理定时器, 避免泄漏
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (pullTimer != null) {
        clearInterval(pullTimer);
        pullTimer = null;
      }
    });
  }
  // 从隐藏恢复时立即拉一次, 避免卡顿等下一轮
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && pullTimer != null) {
        (async () => {
        try {
          if (typeof anti_recall.requestRecallList !== "function") return;
          var list = await anti_recall.requestRecallList();
          if (Array.isArray(list) && list.length > 0) {
            var merged = Array.from(new Set([...(recalledMsgList || []), ...list]));
            if (merged.length > (recalledMsgList || []).length) {
              recalledMsgList = merged;
              await render();
            }
          }
        } catch (e) {}
      })();
      }
    });
  }

  await patchCss();

  var observerRendering = false;
  //监控消息列表，如果有撤回则渲染
  const observer = new MutationObserver(async (mutationsList) => {
    for (let mutation of mutationsList) {
      if (mutation.type === "childList") {
        if (
          mutation.addedNodes != null &&
          mutation.addedNodes.length > 0 &&
          mutation.addedNodes[0].classList != null &&
          mutation.addedNodes[0].classList.contains("message-content-recalled")
        ) {
          //是添加的撤回标记，直接忽略
        } else {
          if (observerRendering) continue;
          observerRendering = true;
          setTimeout(() => {
            observerRendering = false;
            render();
          }, 50);
        }
      }
    }
  });

  var finder = setInterval(() => {
    if (document.querySelector(".ml-list.list")) {
      clearInterval(finder);
      console.log("[Anti-Recall]", "检测到聊天区域，已在当前页面加载反撤回");
      startPullLoop(); // 开启周期性补标
      const targetNode = document.querySelector(".ml-list.list");
      const config = {
        attributes: false,
        childList: true,
        subtree: true,
      };
      observer.observe(targetNode, config);
    }
  }, 100);

  async function render() {
    // console.log("[Anti-Recall]", "尝试反撤回消息列表", recalledMsgList);

    var elements = document
      .querySelector(".chat-msg-area__vlist")
      ?.querySelectorAll(".ml-item");

    if (!elements) return;

    nowConfig = await getNowConfigCached();

    for (var el of elements) {
      var findMsgId = recalledMsgList.find((i) => i == el.id);
      if (findMsgId != null) {
        var msgId = findMsgId;
        try {
          // 复用 findMsgContainer (来自 recallTip 回调)
          var found = findMsgContainer(msgId);
          if (found) {
            if (found.addNoMargin) found.el.classList.add("recalledNoMargin");
            await appendRecalledTag(found.el);
          } else {
            // 列表项兜底
            var container = el.querySelector(".msg-content-container") ||
                            el.querySelector(".file-message--content") ||
                            el.querySelector(".msg-preview");
            if (container) await appendRecalledTag(container);
          }
        } catch (e) {
          console.log("[Anti-Recall]", "反撤回消息时出错", e);
        }
      }
    }
  }

  async function appendRecalledTag(msgElement) {
    if (!msgElement) return;

    // 恢复后的消息可能还带着 gray-tip-message 类, 移除它以恢复主题色
    msgElement.classList.remove("gray-tip-message");
    // 也移除父级可能残留的灰条样式
    var parent = msgElement.closest(".ml-item");
    if (parent) parent.classList.remove("gray-tip-message");

    var currRecalledTip = msgElement.querySelector(".message-content-recalled");
    if (currRecalledTip == null) {
      msgElement.classList.add("message-content-recalled-parent");

      if (nowConfig.enableTip == true) {
        const recalledEl = document.createElement("div");
        recalledEl.innerText = "已撤回";
        recalledEl.classList.add("message-content-recalled");

        msgElement.appendChild(recalledEl);
        setTimeout(() => {
          recalledEl.style.transform = "translateX(0)";
          recalledEl.style.opacity = "1";
        }, 5);
      }
    } else {
      //已经有撤回标记了，不再重复添加
    }
  }
}
