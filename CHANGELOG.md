# 更新日志 (Changelog)

所有版本的更新记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [v0.6.6] - 2026-11-01

### 修复

- **设置页空白** — `getNowConfigCached` 定义在 `onLoad()` 内部，但 `patchCss()` 和 `onLoad()` 在函数外部调用 → `ReferenceError` → LiteLoader 静默跳过 renderer → 设置页空白。移到模块顶层修复。
- **撤回后卡顿** — 资源下载从 send 热路径移到后台队列，dispatch 延迟 167ms → **< 2ms**
- **撤回后不刷新** — 渲染层 1s 轮询主动拉取 + 页面恢复时立即拉取补标
- **非聊天窗口失效** — 移除 URL 过滤（`#/main/message` / `#/chat`），所有 BrowserWindow 都 patch
- **重启后数据库失效** — 启动时预加载 LevelDB 所有撤回消息到内存
- **多窗口通知** — 撤回通知同时投递到所有窗口（主聊天窗/独立聊天窗/群通知窗）

### 重构

- 761 行 main.js 拆成 6 个职责单一模块：`config` / `database` / `msgCache` / `recallHandler` / `downloadQueue` / `ipcScanner`

### 新功能

- **撤回消息导出** — 设置页一键导出所有已撤回消息为 JSON
- **撤回统计** — 总计 / 按会话分布 / 含媒体 / 纯文本分类
- **防风控最小特征模式** — 零外部网络请求选项
- **撤回时序竞态处理** — 撤回先于消息到达时，等待消息本体再恢复
- **群精华 / 作业 / 投票** — 加入本地归档

---

## [v0.6.0] - 2026-11-01

### 修复（4 轮审查，17 个 bug）

**Round 1（11 个核心 bug）**

| Bug | 修复 |
|---|---|
| id 类型不一致 | `normalizeId()` 统一 string |
| 缓存 O(n) 查找 | Map/Set 索引，O(1) |
| recalledMsg 无上限 | Set 索引控制 |
| 撤回时序竞态 | `pendingRecallQueue` 等待消息本体 |
| db.put 非 upsert | 直接 put |
| 跨窗口通知泄漏 | 精确 peer 匹配 |
| 撤回时间戳丢失 | 保留 `recallTime` |
| db 恢复无重试 | 同步→异步→时序队列 |
| sender null 过滤错误 | null-sender 兜底 |
| renderer 崩溃 | `?.` 防护 |

**Round 2（5 个细节 bug）**

- 空字符串 id 处理
- 无 revokeElement 兜底
- IPC 频繁（1s 缓存）
- 定时器泄漏（beforeunload）
- 索引重建性能

**Round 3（1 个 bug）**

- 重复撤回通知防抖（100ms）

### 新功能

- 撤回消息导出（JSON 格式）
- 撤回统计（总计/按会话/含媒体/纯文本）
- 群精华 / 作业 / 投票 本地归档

---

## [v0.5.1] - 2026-11-01

### 验证

- 多窗口触发仿真测试通过（3 个并行窗口全部收到通知）

### 扩展

- 群精华 / 作业 / 投票 加入本地归档快照

---

## [v0.5.0] - 2026-11-01

### 修复

- **非聊天窗口失效** — `tryPatchWindowSend` URL 过滤导致 SPA 路由变化时永久跳过 patch
- **重启后数据库失效** — 启动时预加载 LevelDB 到内存

### 重构

761 行 main.js 拆成 6 个模块：`config` / `database` / `msgCache` / `recallHandler` / `downloadQueue` / `ipcScanner`

---

## [v0.4.6] - 2026-11-01

### 修复

- **设置页空白** — `<plugin-menu>` 未注册自定义元素 → 改用 `<div>`
- **跨文档节点不渲染** — `DOMParser` 返回节点不被识别 → 改用 `document.importNode()`
- **innerHTML 不渲染** — 改用 `view.innerHTML` 直接注入

---

## [v0.4.2] - 2026-11-01

### 性能优化

- 撤回主链路改为同步优先：`findOriginalMsg`/`handleRecallEvent` 拆分为同步内存命中和异步 db 查询两条路径
- 下载队列彻底解耦：`queueBackgroundDownload` 通过 `setImmediate` 完全脱离 send 调用栈
- 撤回 3 条消息 dispatch 延迟：167ms → **< 2ms**（约 85 倍提速）

### 体验改进

- 渲染层轮询从 500ms 降至 1s（CPU 占用减半）
- 页面隐藏时暂停轮询，恢复时立即拉取
- 撤回列表推送不再跨窗口污染
- `sendChatWindowsMessage` 自动清理已销毁窗口引用

---

## [v0.4.0] - 2026-11-01

### 重构

- LiteLoader 1.4.x 兼容：原 0.3.0 的 `webContents.send` 覆盖在新框架 Proxy 机制下失效，改为带验证的多层 patch + 自动重试

### 新功能

- 媒体覆盖：语音 / 视频 / 文件 / 大表情 / 小程序 / 合并转发 / Markdown
- 群资源保护：群文件 / 群相册 / 群公告 本地归档
- JSON 全量快照：每条撤回消息恢复前写入 `<msgId>.json`
- 防风控最小特征模式：可选关闭一切外部请求

### 修复

- rkey 服务证书过期导致图片恢复失败：增加本地缓存兜底
- md5 拼接图片走老域名 404：改为 `multimedia.nt.qq.com.cn`
- send 包装失败时静默丢失：增加自动重试

---

## [v0.3.0] 及之前

见上游原仓库 [xh321/LiteLoaderQQNT-Anti-Recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall)。

---

[v0.6.6]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.6.6
[v0.6.0]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.6.0
[v0.5.1]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.5.1
[v0.5.0]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.5.0
[v0.4.6]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.6.1
[v0.4.2]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.4.2
[v0.4.0]: https://github.com/CDEDEFG/LiteLoaderQQNT-Anti-Recall/releases/tag/v0.4.0
