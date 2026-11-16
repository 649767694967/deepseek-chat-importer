# DeepSeek 聊天记录导入器

把 **DeepSeek 网页端的聊天记录**转换成本地客户端可以直接导入的备份 —— 全部在一个**单文件网页**里完成，纯离线、不联网、不上传。

> 在线使用：<https://649767694967.github.io/deepseek-chat-importer/>
> 离线使用：下载仓库里的 [`index.html`](index.html)，双击即可（Chrome / Edge）。

---

## 支持的输入

| 输入 | 说明 |
|---|---|
| `deepseek_data-*.zip` | DeepSeek 官方「导出数据」产物（设置 → 数据管理 → 导出数据） |
| 解压后的文件夹 | 内含 `chat_session_index.json` 与 `chat_sessions/` |
| `*.md` 对话记录 | [DeepSeek-Exporter](https://github.com/sati0121/DeepSeek-Exporter) 一类浏览器扩展导出的 Markdown（可多选，或整个文件夹） |

拖进页面即可。工具会自动识别格式；拖错了（比如拖进扩展源码包）会直接告诉你拖的是什么、该去哪儿拿数据。

## 支持的输出

| 目标 | 产物 | 说明 |
|---|---|---|
| **Chatbox 备份** | `.cbx` | 官方 zip 备份格式（`formatVersion: 2`）：`manifest.json` + 每会话 `session.json` + 图片资源。**图片与思考过程都保留**。Chatbox 1.23.5+ 可直接导入 |
| **Chatbox 旧版** | `-v1.json` | 单文件 `configVersion: 15`，只含文字与思考过程，兼容所有 Chatbox 版本 |
| **DeepSeek Harness** | `dsh-sessions-*.zip` | 内含 `session.v4.jsonl.zstd`（zstd 多帧 + JSONL）与一键安装脚本 `install.ps1` |
| **Markdown / JSON** | `.zip` / `.json` | 归档，或喂给别的工具 |

## 导入到 Chatbox

设置 → 数据 → 导入数据（Import Data）→ 选生成的 `.cbx`。导入按原 ID 覆盖同 ID 会话，其它本地会话保留。

## 导入到 DeepSeek Harness

解压生成的 zip → 运行 `install.ps1`（等价于把包里的 `sessions/` 合并进 `%USERPROFILE%\.dsh\sessions\`）→ **完全退出并重新打开** DeepSeek Harness。

会话文件落在：

```
%USERPROFILE%\.dsh\sessions\--<cwd 规范化目录名>--\session-<uuid>\session.v4.jsonl.zstd
```

页面上「工作区路径」填什么，会话就归属于哪个工作区（写进会话 header 的 `cwd`）；在 DeepSeek Harness 里打开该目录即可看到，无需额外建索引。

## 转换规则

- `REQUEST` → 用户文本；`RESPONSE` → 回答；`THINK` → 思考过程（Chatbox 的 `reasoning` 内容块 / DSH 的 `reasoning` block）
- `TOOL_SEARCH` / `TOOL_OPEN` → 折叠为「🔍 联网搜索 / 🔗 网页来源」信息块
- `FILE`（图片）→ Chatbox `image` 内容块 + 独立资源文件；非图片 → 「📎 附件」提示
- `CONTENT_RISK` / `TIP` / 模板错误 → 信息块保留原文
- 消息顺序严格保持源文件顺序（DeepSeek 的 `inserted_at` 存在毫秒级倒挂，不能按时间重排）
- 扩展导出的 Markdown：`## 用户` / `## AI` 分段，`> [思考过程]` 引用块 → 思考过程

## 实现说明

三个零依赖模块，全部内联进 `index.html`：

| 文件 | 作用 |
|---|---|
| [`src/zipkit.js`](src/zipkit.js) | zip 读写：EOCD/中央目录索引式**按需解压**、CRC32、ZIP64、纯 JS raw-inflate 兜底、写 zip（UTF-8 名称 flag、deflate 走 `CompressionStream`） |
| [`src/core.mjs`](src/core.mjs) | DeepSeek 导出 / 扩展 Markdown 解析、Chatbox V2/V1 构造、Markdown 导出、DSH 工作区目录名推导 |
| [`src/dsh_session_writer.js`](src/dsh_session_writer.js) | DSH v4 会话日志：zstd raw-block 帧（含 xxhash64 帧校验）、`seq` 连续的事件流 |

页面本身见 [`src/template.html`](src/template.html) + [`src/app.js`](src/app.js)。

### 正确性验证

- **Chatbox**：按官方 `import-backup.ts` 的导入校验逐项复刻（manifest 覆盖每个 entry、`size`/`sha256` 一致、session↔resource 双向映射、stats 计数），zip 另经 fflate 与 Python `zipfile` 交叉验证
- **DeepSeek Harness**：把生成的包解压到隔离目录，用**官方后端代码**（`dsh-session` + `dsh-session-persistence-jsonl` + `dsh-session-query-sqlite`）读取，`listSessions` / `readSurface` / `readTitleSnapshots` 全部还原
- **浏览器端**：无头 Chrome 中通过真实 `file input` 注入 80 MB 导出包，完成「解析 → 生成 .cbx → 生成 DSH 包 → 下载」全链路，无 JS 异常

格式细节（`manifest.json` 全部字段、DSH v4 事件序列、工作区目录名规则）见 [`docs/FORMAT-NOTES.md`](docs/FORMAT-NOTES.md)。

### 性能参考（本机实测）

80 MB 导出包：建 zip 索引只读约 120 KB；解析 244 会话 / 1536 条消息约 2 秒；全量带图 `.cbx`（79 MB / 434 条目）约 2 秒生成。关掉「包含图片附件」体积会降到几 MB。

## 重新构建单文件页面

```bash
node src/build.mjs          # 生成仓库根目录的 index.html
node test/zipkit.test.mjs   # zip 模块自测
```

## 已知限制

- 只做「导出数据 → 客户端备份」单向转换，不改动原始数据
- 图片体积占大头；不需要时取消勾选即可
- DSH 侧写入的是 v4 会话日志（当前版本格式）；客户端将来升级格式时，旧文件会被其自身的迁移机制处理

## License

[MIT](LICENSE)
