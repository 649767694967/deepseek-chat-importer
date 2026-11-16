# 聊天客户端页面 · 接口契约（CONTRACT）

目标：`chat.html` —— 与 `index.html`（转换器）并列的**单文件聊天客户端**。
纯前端、零依赖、可离线打开；API 由用户自己填（OpenAI 兼容 /chat/completions）。

构建产物：仓库根 `chat.html`（由 `_build/build-client.mjs` 把若干模块内联进 `chat/template.html` 生成）。

---

## 1. 文件与职责

| 文件 | 负责人 | 内容 |
|---|---|---|
| `chat/template.html` | **chat-ui** | HTML 骨架 + 全部 CSS（含手机/平板/电脑三档、深浅主题、头像、背景、对话框、toast） |
| `chat/prompts.mjs` | **prompts-writer** | 提示词预设（含「破甲」系列）、获取 API Key 教程文本、常见错误对照表 |
| `chat/core.mjs` | lead | SSE 流解析、上下文压缩、导入适配、存储层 |
| `chat/app.mjs` | lead | 交互逻辑、渲染消息、事件绑定 |
| `_build/build-client.mjs` | lead | 内联打包 → `chat.html` |

`template.html` 里的内联占位（构建时替换，**不要删**）：

```html
<script>/*__INLINE_DEVICE__*/</script>
<script type="module">
<!--INLINE:zipkit.js-->
<!--INLINE:core-lib.mjs-->
<!--INLINE:prompts.mjs-->
<!--INLINE:chat-core.mjs-->
<!--INLINE:chat-app.mjs-->
</script>
```

- `DEVICE` 脚本由 `device.js` 提供，会写 `<html data-device="phone|tablet|desktop">`
- `zipkit.js` / `core-lib.mjs`（= 现有 `core.mjs`）是转换器复用过来的解析器，用于「导入 DeepSeek 导出包」

---

## 2. DOM 契约（id 必须完全一致，JS 全靠这些 id 工作）

### 顶栏
```
header#topbar
  button#menuBtn            打开抽屉
  div.brand                 标题文字（静态）
  div#topActions
    span#connDot            连接状态：<i class="dot" data-state="off|ok|err"> 由 JS 改 data-state
    button#themeBtn         主题
    button#bgBtn            背景
    button#avatarBtn        头像
    button#helpBtn          教程
```

### 抽屉 / 会话列表
```
div#scrim                  （点击关闭抽屉）
aside#drawer
  button#drawerClose
  button#newChatBtn
  div#drawerActions
    button#importBtn
    button#exportBtn
    button#compressBtn
    button#jailbreakBtn
  div#sessionList          JS 填充，子元素结构见 §4
  button#settingsBtn       ← 新增：设置 / API Key（放在 drawer-foot 之上，整行按钮）
  div.drawer-foot          静态说明（版本号、返回转换器链接）
```

### 消息区
```
main#chatMain
  div#messages             JS 填充，子元素结构见 §4
  button#scrollBottomBtn   回到底部（hidden 默认）
footer#composer
  textarea#input
  div#composerBar
    span#tokenHint           "约 1234 tokens"
    button#stopBtn  [hidden]
    button#sendBtn
  div#composerTools
    select#modelSelect       JS 填充选项
    button#clearBtn          清空当前会话
```

### 对话框（都用原生 `<dialog>`，class 统一 `.dlg`）
```
dialog#settingsDlg
  input#apiBase   input#apiKey   select#modelPreset  input#modelName
  input#temperature  input#maxTokens
  select#promptPreset  textarea#systemPrompt
  button#testConnBtn  #testConnOut(span)
  button#saveSettingsBtn  button#closeSettingsBtn

dialog#bgDlg
  div#bgPresets            JS 填充按钮（data-bg="…"）
  input#bgUrl              button#bgUploadBtn  input#bgFile(type=file hidden)
  input#bgDim(type=range)  input#bgBlur(type=range)
  button#bgResetBtn  button#closeBgBtn

dialog#avatarDlg
  div#selfAvatarSlot  input#selfAvatarFile(hidden)  button#selfAvatarBtn
  input#selfName       ← 新增：对方名字（默认「我」）
  div#botAvatarSlot   input#botAvatarFile(hidden)   button#botAvatarBtn
  input#botName        ← 新增：机器人名字（默认「DeepSeek」）
  input#selfEmoji  input#botEmoji
  button#closeAvatarBtn

dialog#jailbreakDlg
  select#jbList            JS 填充（预设名）
  div#jbDesc               预设说明
  textarea#jbText          可编辑内容
  button#jbApplyBtn  button#jbSaveBtn  button#closeJbBtn

dialog#helpDlg
  div#helpBody              JS 注入教程 HTML（来自 prompts.mjs）
  button#closeHelpBtn

dialog#importDlg
  div#importDrop           拖拽区
  input#importFile(type=file hidden)  button#importPickBtn
  div#importHint            提示（支持 deepseek_data zip / .md / .cbx / 本客户端 json）
  div#importLog             日志
  button#closeImportBtn

div#toastArea               toast 容器
```

**约定**：所有 dialog 用 `showModal()` / `close()`；关闭按钮 id 已在上面列全。

---

## 3. 视觉与设备

- 用 CSS 变量做主题：`:root` 定义 `--bg --bg-elev --fg --muted --accent --bubble-self --bubble-bot --line --radius`；`html[data-theme="light"]` 覆盖一套
- 背景：`body` 上挂 `data-bg="aurora|grid|paper|plain|custom"`，自定义背景图用内联 `background-image`（JS 设置），支持 `--bg-dim`（遮罩不透明度）与 `--bg-blur`
- 三档设备（`html[data-device]`）：
  - `phone`：抽屉全屏滑出、消息气泡最大宽 86%、输入区贴底 + `safe-area-inset-bottom`、字号 15px、按钮 ≥44px
  - `tablet`：抽屉宽 320px 常驻侧栏（≥700px 宽时）、气泡最大宽 76%
  - `desktop`：抽屉 300px 常驻、主区居中最大宽 860px、气泡最大宽 70%
- 消息渲染骨架（JS 用，**CSS 必须覆盖**）：
```html
<div class="msg" data-role="user|assistant">
  <div class="avatar"><img|span></div>
  <div class="bubble-wrap">
    <div class="meta"><span class="who"></span><span class="time"></span></div>
    <details class="think" hidden><summary>思考过程</summary><div class="think-body"></div></details>
    <div class="bubble"></div>
    <div class="msg-actions">
      <button data-act="copy">复制</button>
      <button data-act="edit">编辑</button>
      <button data-act="regen">重生成</button>
      <button data-act="del">删除</button>
    </div>
  </div>
</div>
```
```html
<div class="session-item" data-id="…"><div class="s-title">…</div><div class="s-meta">…</div><button class="s-del">×</button></div>
```

---

## 4. 数据形状（JS 侧，UI 只需照渲染）

```js
session = { id, title, createdAt, updatedAt, messages: [ { id, role: 'user'|'assistant'|'system',
             content, reasoning?, time, error?, tokens? } ] }
settings = { apiBase, apiKey, modelPreset, modelName, temperature, maxTokens,
             promptPreset, systemPrompt, theme, bg, bgImage, bgDim, bgBlur,
             selfAvatar, botAvatar, selfEmoji, botEmoji }
```

---

## 5. 可访问性 / 交互要求

- 所有按钮 `type="button"`，焦点可见
- 抽屉打开时点 `#scrim` 关闭；`Esc` 关闭当前 dialog（原生行为即可）
- `#input` 支持 `Enter` 发送、`Shift+Enter` 换行（JS 处理，注意中文输入法 `isComposing`）
- 流式输出时可以点 `#stopBtn` 中断
- 手机端软键盘弹出时输入框不被遮挡（`dvh` + `visualViewport` 由 JS 处理，CSS 只需 `height: 100dvh`）

---

## 6. 不要做的事

- 不要写任何业务逻辑（发送请求、流解析、存储）——那在 `app.mjs`
- 不要引入外部字体 / 图标库 / CDN
- 不要用 `innerHTML` 拼消息内容（XSS），渲染由 JS 用 `textContent` + 轻量 markdown
