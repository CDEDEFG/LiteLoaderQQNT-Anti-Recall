// 后台下载队列: 撤回消息的资源下载不阻塞 send 主链路
// 主链路只做内存级别的消息内容替换, 图片/语音/视频的下载异步执行
var downloadQueue = [];
var downloadQueueSet = new Set();
var downloadRunning = false;
var outputFn = console.log;
var downloader = null;

function setOutput(fn) { outputFn = fn; }
function setDownloader(d) { downloader = d; }
function output(...args) { outputFn(...args); }

function queue(savedMsgs) {
  if (!Array.isArray(savedMsgs)) savedMsgs = [savedMsgs];
  for (const s of savedMsgs) {
    if (s && s.msg && s.id != null && !downloadQueueSet.has(s.id)) {
      downloadQueueSet.add(s.id);
      downloadQueue.push(s.msg);
    }
  }
  if (!downloadRunning) {
    // 彻底脱离当前调用栈, 保证撤回分发主链路立即返回
    setImmediate(() => {
      drain().catch((e) => output("drain err:", e && e.message));
    });
  }
}

async function drain() {
  if (downloadRunning) return;
  downloadRunning = true;
  try {
    while (downloadQueue.length > 0) {
      const msg = downloadQueue.shift();
      if (msg && msg.msgId != null) downloadQueueSet.delete(msg.msgId);
      try {
        if (downloader) await downloader.downloadPic(msg);
      } catch (e) {
        output("background download err:", e && e.message);
      }
    }
  } finally {
    downloadRunning = false;
  }
}

module.exports = { setOutput, setDownloader, queue, drain };
