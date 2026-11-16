# DeepSeek 聊天记录导入器

把 **DeepSeek 网页端的聊天记录**转换成本地客户端可以直接导入的备份 —— 全部在一个**单文件网页**里完成，纯离线、不联网、不上传。

> 在线使用：<https://649767694967.github.io/deepseek-chat-importer/>
> 离线使用：下载仓库里的 [`index.html`](index.html)，双击即可（Chrome / Edge）。

---

## 配套的聊天客户端

另有独立仓库的单文件网页聊天客户端（自填 API Key、可换背景、带破甲 / 回退 / 压缩）：
<https://649767694967.github.io/deepseek-chat-client/>

---

## 支持的输入

| 输入 | 说明 |
|---|---|
| `deepseek_data-*.zip` | DeepSeek 官方「导出数据」产物（设置 → 数据管理 → 导出数据） |
| 解压后的文件夹 | 内含 `chat_session_index.json` 与 `chat_sessions/` |
| `*.md` 对话记录 | [DeepSeek-Exporter](https://github.com/sati0121/DeepSeek-Exporter) 一类浏览器扩展导出的 Markdown（可多选，或整个文件夹） |

拖进页面即可。工具会自动识别格式；拖错了（比如拖进扩展源码包）会直接告诉你拖的是什么、该去哪儿拿数据。

## 设备自适应（手机 / 平板 / 电脑）

页面会自己判断设备档位并调整布局尺度，也会跟着**窗口缩放、横竖屏切换、平板分屏**实时切换（防抖 160ms，只在档位真的变了才重排）。

| 档位 | 判定依据 | 布局表现 |
|---|---|---|
| **手机** | iPhone/iPod、Android + Mobile；或触屏设备且可用宽度 < 600 | 单列、控件 ≥44px、主按钮 48px、输入框 16px（防 iOS 自动缩放）、列表 52dvh、隐藏拖拽与选文件夹入口、默认不带图片 |
| **平板** | iPad（含 iPadOS 伪装成 Mac 的 UA）、Android 平板、其它触屏设备；或触屏且宽 < 900 | 容器 920px、导出目标**两列**、控件 46px、列表更高、字号 15px |
| **电脑** | Windows / macOS / Linux（**即使带触屏也按桌面处理**，避免误关图片） | 容器 1080px、可拖拽、可选文件夹、默认带图片 |

- 判定逻辑只有一处：`src/device.js`。它在 `<head>` 里先于样式执行，首帧就写好 `<html data-device="…">`，不会闪一下桌面布局；`src/app.js` 复用同一个函数，在 `resize` / `orientationchange` / `visualViewport.resize` / 指针类型变化时重新判定。
- 手动勾过的「包含图片附件」和导出目标不会被自动重置（只在用户没动过时套用默认值）。
- 日志里会打印当前档位，例如「界面按「平板」布局（768×1024）」。

## 载入进度与防重复添加

- 选完文件后会出现**载入进度条**：先是「正在读取数据…」，再是「正在解析会话 37/244」，百分比实时更新。手机 / 平板解析慢一些也不会像卡住。
- 解析期间拖拽区会置灰、不再响应点击，避免误点第二次。
- 载入成功后会出现一条绿色状态条：**「已载入 244 个会话（xxx.zip）· 不需重复添加」**，旁边是「重新选择数据」。
- 若已有数据时又拖入 / 选择了新文件，不会静默覆盖，而是弹出确认条：可以「替换现有数据」或「取消」（取消则保留当前数据）。

### 手机 / 平板上的使用要点

- **不支持拖拽，也不支持"选文件夹"** —— 点一下选择区，从「文件」里挑 `.zip` / `.md` 即可（这些入口会自动隐藏）
- **默认关闭「包含图片附件」**：触屏设备内存有限，全量带图的备份可能到几十 MB；先只要文字，需要图片时再在电脑上补
- **保存**：走系统分享/下载面板 —— iPhone / iPad 存到「文件 → 下载」，Android 存到「下载」，也可以直接分享给 Chatbox 等 App
- **导入**：Chatbox 的 iOS/Android App 同样支持 zip 备份（设置 → 数据 → 导入数据）
- 只导几个会话会比一次导全部更稳；解析几十个会话通常在 1～2 秒内完成

## 手机上的 DeepSeek Harness

DSH 的手机形态有两种，导出的会话包都支持：

| 你的情况 | 怎么装 |
|---|---|
| **手机远程用电脑里的 DSH**（[dsh-mobile](https://github.com/saya-ch/dsh-mobile) 插件 / 局域网访问 / Tailscale 等） | 会话仍存在电脑上 —— 把包拿到电脑，跑 `install.ps1`（Windows）或 `install.sh` |
| **手机上本机跑 DSH**（Android + Termux、iOS + iSH / a-Shell、[phone-dsh](https://github.com/launsion-boop/phone-dsh) 一类移植版） | 解压后执行 `sh install.sh`，默认写入 `~/.dsh/sessions` |
| 会话目录不在默认位置（App 沙盒等） | `sh install.sh /你的路径/.dsh/sessions` |

包里自带 `install.ps1`（Windows）、`install.sh`（macOS / Linux / Termux / iSH）和 `安装说明.txt`（分平台步骤）。Termux 里可能需要先 `pkg install unzip`。

> 手机端这条路是第三方社区方案（DSH 本体是桌面应用），装完后会话在 DSH 里按 `cwd` 归属的工作区出现，和桌面端一致。

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
