var recalledMsgList = [];

var nowConfig = {};

export async function onSettingWindowCreated(view) {
  nowConfig = await getNowConfigCached();

  const new_navbar_item = `
    <div class="anti-recall-wrapper">
      <setting-item class="config_view">
        <setting-section data-title="主配置">
          <setting-panel>
            <setting-list data-direction="column">     
                <setting-item data-direction="row">
                  <setting-text>操作</setting-text>
                    <button id="clearDb" class="q-button q-button--small q-button--secondary">清空已储存的撤回消息</button>
                </setting-item>
                <setting-item data-direction="row">
                  <setting-text>导出</setting-text>
                    <button id="exportRecalled" class="q-button q-button--small q-button--secondary">导出撤回消息 (JSON)</button>
                </setting-item>
                <setting-item data-direction="row">
                  <setting-text>统计</setting-text>
                    <button id="showStats" class="q-button q-button--small q-button--secondary">查看撤回统计</button>
                </setting-item>
                <setting-item data-direction="row">
                  <div id="statsPanel" style="display:none; width:100%; padding:10px; background:var(--fill_light_primary); border-radius:8px; margin-top:8px;">
                    <div id="statsContent">加载中...</div>
                  </div>
                </setting-item>
                <setting-item data-direction="row">
                    <div style="width:90%;" >
                      <setting-text>是否将撤回消息存入数据库</setting-text>
                      <span class="secondary-text">数据库不加密，若开启风险自负；若不开启，重启QQ后撤回消息会丢失；开启选项后，反撤回消息才会开始保存；若之前开过，现在关闭，储存的消息不会被删除，需要你手动清理。</span>
                    </div>
                    <div id="switchSaveDb" class="q-switch">
                      <span class="q-switch__handle"></span>
                    </div>
                </setting-item>
                <div class="vertical-list-item">
                    <div style="width:90%;" >
                      <h2>是否反撤回自己的消息</h2>
                      <span class="secondary-text">如果开启，则自己发送的消息也会被反撤回。开启后，从下一条消息开始起生效。</span>
                    </div>
                    <div id="switchAntiRecallSelf" class="q-switch">
                      <span class="q-switch__handle"></span>
                    </div>
                </div>
                <div class="vertical-list-item">
                    <div style="width:90%;" >
                      <h2>防风控最小特征模式</h2>
                      <span class="secondary-text">开启后，不主动链接腾讯 CDN/rkey 服务重下载过期图片/语音/视频，完全只依赖本地残留文件。撤回的文字/普通表情不受影响，仅富媒体可能无法显示。</span>
                    </div>
                    <div id="switchDisableImgDownload" class="q-switch">
                      <span class="q-switch__handle"></span>
                    </div>
                </div>
                <setting-item data-direction="row">
                  <div>
                    <h2>内存中消息最多缓存条数</h2>
                    <span class="secondary-text">修改将自动保存并立即生效；如果过少可能导致消息接受太快时来不及反撤回，如果过多可能导致内存占用过高。</span>
                  </div>
                  <div style="width:30%;pointer-events: auto;margin-left:10px;">
                    <input id="maxMsgLimit" min="1" max="99999999" maxlength="8" class="text_color path-input" style="width:65%;" type="number" value="${
                  nowConfig.maxMsgSaveLimit == null
                    ? 10000
                    : nowConfig.maxMsgSaveLimit
                        }"/>条
                  </div>
                </setting-item>
    
                <setting-item data-direction="row">
                  <div>
                    <h2>清理内存缓存消息时一次性清理多少</h2>
                    <span class="secondary-text">修改将自动保存并立即生效；一次性清理过多可能导致某些消息反撤回失败，过少则可能导致内存增长过快。</span>
                  </div>
                  <div style="width:30%;pointer-events: auto;margin-left:10px;">
                    <input id="deletePerTime" min="1" max="99999" maxlength="5" class="text_color path-input" style="width:65%; margin-left: 3px" type="number" value="${
                  nowConfig.deleteMsgCountPerTime == null
                    ? 500
                    : nowConfig.deleteMsgCountPerTime
                        }"/>条
                  </div>
                </setting-item>
            </setting-list>

          </setting-panel>
        </setting-section>

        
        <setting-section data-title="样式配置">
          <setting-panel>

            <setting-list data-direction="column">

              <setting-item data-direction="row">
                <div>
                  <h2>撤回主题色</h2></h2>
                  <span class="secondary-text">将会同时影响阴影和“已撤回”提示的颜色</span>
                </div>
                <div>
                  <input type="color" value="#ff0000" class="q-button q-button--small q-button--secondary pick-color" />
                </div>
              </setting-item>

              <hr class="horizontal-dividing-line" />          

              <div class="vertical-list-item">
                <div>
                  <h2>撤回后消息是否显示阴影</h2>
                  <span class="secondary-text">修改将自动保存并实时生效</span>
                </div>
                <div id="switchShadow" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </div>

              <hr class="horizontal-dividing-line" />          

              <div class="vertical-list-item">
                <div>
                  <h2>撤回后消息下方是否显示“已撤回”提示</h2>
                  <span class="secondary-text">修改将自动保存并在重新滚动消息后生效</span>
                </div>
                <div id="switchTip" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </div>
              
            </setting-list>
          </setting-panel>
        </setting-section>


        <style>
          .img-hidden {
            display:none;
          }

          .path-input {
            align-self: normal;
            flex: 1;
            border-radius: 4px;
            margin-right: 16px;
            transition: all 100ms ease-out;
            border: 1px solid #464646;
          }
        
          .path-input:focus {
            padding-left: 4px;
          }
          
          .bq-icon {
            height:16px;
            width:16px;
          }
          
          /* 通用 */
          .config_view {
              margin: 20px;
          }
          
          .config_view h1 {
              color: var(--text_primary);
              font-weight: var(--font-bold);
              font-size: min(var(--font_size_3), 18px);
              line-height: min(var(--line_height_3), 24px);
              padding: 0px 16px;
              margin-bottom: 8px;
          }
          
          .config_view .wrap {
              /* Linux样式兼容：--fg_white */
              background-color: var(--fill_light_primary, var(--fg_white));
              border-radius: 8px;
              font-size: min(var(--font_size_3), 18px);
              line-height: min(var(--line_height_3), 24px);
              margin-bottom: 20px;
              overflow: hidden;
              padding: 0px 16px;
          }
          
          .config_view .vertical-list-item {
              margin: 12px 0px;
              display: flex;
              justify-content: space-between;
              align-items: center;
          }
          
          .config_view .horizontal-dividing-line {
              border: unset;
              margin: unset;
              height: 1px;
              background-color: rgba(127, 127, 127, 0.15);
          }
          
          .config_view .vertical-dividing-line {
              border: unset;
              margin: unset;
              width: 1px;
              background-color: rgba(127, 127, 127, 0.15);
          }
          
          .config_view .ops-btns {
              display: flex;
          }
          
          .config_view .hidden {
              display: none !important;
          }
          
          .config_view .disabled {
              pointer-events: none;
              opacity: 0.5;
          }
          
          .config_view .secondary-text {
              color: var(--text_secondary);
              font-size: min(var(--font_size_2), 16px);
              line-height: min(var(--line_height_2), 22px);
              margin-top: 4px;
          }
          
          .config_view .wrap .title {
              cursor: pointer;
              font-size: min(var(--font_size_3), 18px);
              line-height: min(var(--line_height_3), 24px);
          }
          
          .config_view .wrap .title svg {
              width: 1em;
              height: 1em;
              transform: rotate(-180deg);
              transition-duration: 0.2s;
              transition-timing-function: ease;
              transition-delay: 0s;
              transition-property: transform;
          }
          
          .config_view .wrap .title svg.is-fold {
              transform: rotate(0deg);
          }
          
          
          /* 模态框 */
          .config_view .modal-window {
              display: flex;
              justify-content: center;
              align-items: center;
              position: fixed;
              top: 0;
              right: 0;
              bottom: 0;
              left: 0;
              z-index: 999;
              background-color: rgba(0, 0, 0, 0.5);
          }
          
          .config_view .modal-dialog {
              width: 480px;
              border-radius: 8px;
              /* Linux样式兼容：--fg_white */
              background-color: var(--bg_bottom_standard, var(--fg_white));
          }
          
          .config_view .modal-dialog header {
              font-size: 12px;
              height: 30px;
              line-height: 30px;
              text-align: center;
          }
          
          .config_view .modal-dialog main {
              padding: 0px 16px;
          }
          
          .config_view .modal-dialog main p {
              margin: 8px 0px;
          }
          
          .config_view .modal-dialog footer {
              height: 30px;
              display: flex;
              justify-content: right;
              align-items: center;
          }
          
          .config_view .modal-dialog .q-icon {
              width: 22px;
              height: 22px;
              margin: 8px;
          }
          
          
          /* 版本号 */
          .config_view .versions .wrap {
              display: flex;
              justify-content: space-between;
              padding: 16px 0px;
          }
          
          .config_view .versions .wrap>div {
              flex: 1;
              margin: 0px 10px;
              border-radius: 8px;
              text-align: center;
          }
          
          
          /* 数据目录 */
          .config_view .path .path-input {
              align-self: normal;
              flex: 1;
              border-radius: 4px;
              margin-right: 16px;
              transition: all 100ms ease-out;
          }
          
          .config_view .path .path-input:focus {
              padding-left: 5px;
              background-color: rgba(127, 127, 127, 0.1);
          }
          
          /* 选择框容器 */
          .config_view .list-ctl .ops-selects {
              display: flex;
              gap: 8px;
          }
          

          @media (prefers-color-scheme: light) {
              .text_color {
                  color: black;
              }
          }
          
          @media (prefers-color-scheme: dark) {
              .text_color {
                  color: white;
              }
          }

        </style>
      </div>
    </div>
  `;

  // 直接用 innerHTML 注入, 避免跨文档节点问题
  view.innerHTML = new_navbar_item;
  const node2 = view.querySelector(".anti-recall-wrapper");

  //清空消息
  node2.querySelector("#clearDb").onclick = async () => {
    await window.anti_recall.clearDb();
  };

  //导出撤回消息
  node2.querySelector("#exportRecalled").onclick = async () => {
    await window.anti_recall.exportRecalled();
  };

  //撤回统计
  node2.querySelector("#showStats").onclick = async () => {
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
  };

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

  if (nowConfig.saveDb == null || nowConfig.saveDb == true) {
    q_switch_savedb.classList.toggle("is-active");
  }

  q_switch_savedb.addEventListener("click", async () => {
    if (q_switch_savedb.classList.contains("is-active")) {
      nowConfig.saveDb = false;
    } else {
      nowConfig.saveDb = true;
    }
    q_switch_savedb.classList.toggle("is-active");
    await window.anti_recall.saveConfig(nowConfig);
  });

  //反撤回自己消息开关
  var q_switch_antiself = node2.querySelector("#switchAntiRecallSelf");

  if (nowConfig.isAntiRecallSelfMsg == true) {
    q_switch_antiself.classList.toggle("is-active");
  }

  q_switch_antiself.addEventListener("click", async () => {
    if (q_switch_antiself.classList.contains("is-active")) {
      nowConfig.isAntiRecallSelfMsg = false;
    } else {
      nowConfig.isAntiRecallSelfMsg = true;
    }
    q_switch_antiself.classList.toggle("is-active");
    await window.anti_recall.saveConfig(nowConfig);
  });

  //防风控开关
  var q_switch_nodl = node2.querySelector("#switchDisableImgDownload");

  if (nowConfig.disableImgDownload == true) {
    q_switch_nodl.classList.toggle("is-active");
  }

  q_switch_nodl.addEventListener("click", async () => {
    if (q_switch_nodl.classList.contains("is-active")) {
      nowConfig.disableImgDownload = false;
    } else {
      nowConfig.disableImgDownload = true;
    }
    q_switch_nodl.classList.toggle("is-active");
    await window.anti_recall.saveConfig(nowConfig);
  });

  //阴影开关
  var q_switch_shadow = node2.querySelector("#switchShadow");

  if (nowConfig.enableShadow == null || nowConfig.enableShadow == true) {
    q_switch_shadow.classList.toggle("is-active");
  }

  q_switch_shadow.addEventListener("click", async () => {
    if (q_switch_shadow.classList.contains("is-active")) {
      nowConfig.enableShadow = false;
    } else {
      nowConfig.enableShadow = true;
    }
    q_switch_shadow.classList.toggle("is-active");
    await window.anti_recall.saveConfig(nowConfig);
  });

  //提示开关
  var q_switch_tip = node2.querySelector("#switchTip");

  if (nowConfig.enableTip == null || nowConfig.enableTip == true) {
    q_switch_tip.classList.toggle("is-active");
  }

  q_switch_tip.addEventListener("click", async () => {
    if (q_switch_tip.classList.contains("is-active")) {
      //取消
      nowConfig.enableTip = false;
    } else {
      //重新设置
      nowConfig.enableTip = true;
    }
    q_switch_tip.classList.toggle("is-active");
    await window.anti_recall.saveConfig(nowConfig);
  });

  view.appendChild(node2);
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

  var sHtml = `   .message-content__wrapper {
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
                    box-shadow: 0px 0px 8px 5px ${nowConfig.mainColor} !important;`;
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
                color: var(--text-color);
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
                color:${nowConfig.mainColor};
            }
        `;
  stylee.innerHTML = sHtml;
  document.getElementsByTagName("head").item(0).appendChild(stylee);
}

onLoad();

async function onLoad() {
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
      cachedConfig = await window.anti_recall.getNowConfig();
      configLastFetch = now;
      return cachedConfig;
    } catch (e) {
      return cachedConfig || {};
    }
  }
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
