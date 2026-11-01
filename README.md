# LiteLoaderQQNT - 防撤回 (Anti-Recall)

> 高性能 · 零阻塞 · 全覆盖的 QQNT 防撤回插件

[![Release](https://img.shields.io/github/v/release/CDEDEFG/LiteLoaderQQNT-Anti-Recall?style=flat-square&color=blue)](https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/CDEDEFG/LiteLoaderQQNT-Anti-Recall/total?style=flat-square&color=green)](https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![QQNT](https://img.shields.io/badge/QQNT-9.9.x-orange?style=flat-square)](https://im.qq.com)
[![LiteLoader](https://img.shields.io/badge/LiteLoaderQQNT-1.4.x-purple?style=flat-square)](https://liteloaderqqnt.github.io)

---

## 这是什么

基于 [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT) 的 QQNT 防撤回插件，重构自上游 [xh321/LiteLoaderQQNT-Anti-Recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall) 0.3.0。

**核心指标**

| 指标 | 数值 |
|---|---|
| 撤回消息 dispatch 延迟 | **< 2 ms** |
| 消息类型覆盖 | **12 种** |
| 多窗口通知投递 | **3/3 窗口** |
| 单机消息缓存 | **10000 条** |

---

## 为什么选择这个版本

相比上游 0.3.0，本版本解决了以下关键问题：

| 问题 | 根因 | 解决 |
|---|---|---|
| 撤回后消息卡死几秒 | 拦截时同步等待图片下载 | 后台队列异步下载，主链路 < 2ms |
| 撤回后消息不刷新 | SPA 切换后 DOM 重建丢失标记 | 1s 轮询主动补标 |
| 非聊天窗口失效 | URL 过滤在 SPA 路由变化时跳过 patch | 移除过滤，所有窗口都 patch |
| 重启后数据库失效 | 只在撤回时入库，重启查不到 | 启动时预加载 LevelDB 到内存 |
| 设置页空白 | renderer 加载失败（作用域错误） | 修复作用域，renderer 正常加载 |
| 多窗口不支持 | 通知只发主窗口 | 所有 BrowserWindow 都收到通知 |

---

## 功能一览

### 消息类型覆盖（12 种）

| 类型 | 状态 | 恢复方式 |
|---|---|---|
| 纯文本 | ✅ | 完整恢复 |
| 小黄脸/系统表情 | ✅ | 完整恢复 |
| 商城大表情 | ✅ | 本地路径 + URL |
| 图片 | ✅ | rkey 自动拉取 + 多域名兜底 |
| 语音 | ✅ | URL 字段 + md5 兜底 |
| 视频 | ✅ | 视频文件 + 封面缩略图 |
| 文件 | ✅ | 本地文件归档 |
| 引用回复 | ✅ | 随 msgList 递归处理 |
| 卡片/链接 (ARK) | ✅ | 数据直接恢复 |
| 小程序 | ✅ | 图标/首图本地恢复 |
| 合并转发 | ✅ | 递归处理所有子消息 |
| Markdown | ✅ | 数据直接恢复 |

### 群资源保护

- **群文件** — 捕获下载事件，自动本地归档（> 200MB 跳过）
- **群相册** — 相册照片变更时本地备份
- **群公告** — 公告内容快照到本地索引
- **群精华 / 作业 / 投票** — 事件触发即快照

归档位置：`LiteLoaderQQNT/data/anti_recall/archive/`，附带 `index.jsonl` 索引。

### 数据管理

- **导出撤回消息** — 设置页一键导出 JSON（含时间戳、发送者、完整内容）
- **撤回统计** — 总计、按会话分布、含媒体/纯文本分类
- **清空数据库** — 删除所有已储存的撤回消息

### 撤回恢复三级兜底

```
Level 1: 内存缓存 (msgFlow, 10000 条)     ← 最快
Level 2: 已撤回数组 (recalledMsg)          ← 已标记的撤回
Level 3: LevelDB 数据库 (可选开启)         ← 重启后仍可恢复
Level 4: JSON 全量快照 (自动)              ← 每条撤回前写入 <msgId>.json
```

### 防风控最小特征模式

开启后：
- 零外部网络请求
- 零 CDN 下载
- 零 rkey 服务请求
- 纯本地文件恢复

> 日常建议关闭（拦截只在本地 IPC，服务端感知不到），只在敏感场景开启。

---

## 安装

### 方法 1：LiteLoader 插件管理器（推荐）

1. 下载 [最新 Release](https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/latest) 的 `qq-anti-recall-x.x.x.zip`
2. QQ → 设置 → LiteLoaderQQNT → 插件管理 → 选择 zip 安装

### 方法 2：手动安装

```bash
# 1. 关闭 QQ
# 2. 解压 zip 得到 anti_recall 文件夹
# 3. 复制到 LiteLoaderQQNT 插件目录
cp -r anti_recall "C:/Users/<用户名>/AppData/Roaming/LiteLoaderQQNT/plugins/"
# 4. 启动 QQ
```

### 方法 3：覆盖升级

```bash
# 1. 关闭 QQ
# 2. 删除旧版
rm -rf "C:/Users/<用户名>/AppData/Roaming/LiteLoaderQQNT/plugins/anti_recall"
# 3. 放入新版
cp -r anti_recall "C:/Users/<用户名>/AppData/Roaming/LiteLoaderQQNT/plugins/"
```

---

## 兼容性

| 项目 | 支持版本 |
|---|---|
| LiteLoaderQQNT | 1.4.x（向下兼容 1.x） |
| QQNT | 9.9.x（已在 9.9.36-53644 实测） |
| 操作系统 | Windows / macOS / Linux |

---

## 设置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| 主颜色 | `#ff6d6d` | 撤回提示主题色 |
| 存数据库 | ❌ | 开启后重启 QQ 可恢复 |
| 阴影 | ✅ | 撤回消息红色阴影 |
| 提示 | ✅ | 撤回消息下方"已撤回" |
| 反撤回自己 | ❌ | 自己撤回的也拦截 |
| 内存缓存上限 | 10000 | 越多越占内存 |
| 单次清理条数 | 500 | 超上限时一次删多少 |
| **防风控模式** | ❌ | 零外部网络请求 |

---

## 原理

NTQQ 撤回机制：发送方发一条 `msgId` 相同、`msgType=5/subMsgType=4` 的灰条消息覆盖原消息。

本插件在 LiteLoaderQQNT 的 `onBrowserWindowCreated` 钩子里对 `webContents.send` 做代理：

```
1. 缓存    → 所有 incoming 消息存入 msgFlow
2. 识别    → 发现 msgList 里的撤回灰条，提取 revokeElement
3. 掐断    → 增量场景：cmdName="none" + msgList 清空（渲染层收不到）
4. 替换    → 历史场景：灰条字段替换为缓存里的原消息字段
5. 补标    → 渲染层收到通知，加红框 + "已撤回" 标记
```

> **关键点**：拦截只发生在 主进程 → 渲染进程 的本地 IPC，NT 内核正常接收并确认撤回包，服务端视角与未装插件完全一致。

---

## 常见问题

**Q: 撤回后图片一直转圈？**
图片本地无缓存时会从 CDN 拉取（几百 ms 延迟）。拉取失败则显示灰色占位。

**Q: 重启后撤回消息不见了？**
设置里开启「将撤回消息存入数据库」。LevelDB 偶尔启动失败（LOCK 残留），完全退出 QQ 再启动即可。

**Q: 群里撤回的文件还能看吗？**
本地缓存过的文件自动归档到 `data/anti_recall/archive/group_file/`，服务端删除也能恢复。

**Q: 会被封号吗？**
不修改协议层、不发伪造包、不访问外部服务。历史上未见因此被封的案例。如担心，开启「防风控模式」零外部请求。

---

## 更新日志

详细版本更新记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 协议

[MIT](LICENSE) | 仅供学习研究，请遵守当地法律法规
