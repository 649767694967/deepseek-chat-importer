# 格式笔记

本项目要往两种「别人的私有格式」里写数据，所以把逆向出来、并经过实际验证的细节记在这里。

---

## 1. 输入：DeepSeek 官方导出（`export_format_version: 3`）

```
manifest.json              {"export_format_version":3}
user.json                  {user_id, email(打码), mobile, oauth_profiles}
chat_session_index.json    [{id,title,pinned,message_count,inserted_at,updated_at}]
chat_sessions/<uuid>.json  单个会话
chat_sessions/<uuid>_files/ 该会话的附件（图片等二进制）
```

会话结构：

```json
{
  "id": "…", "title": "…", "pinned": false, "current_message_id": 4,
  "inserted_at": "2026-08-08T13:46:29.190Z", "updated_at": "…",
  "messages": [
    { "id": 1, "parent_id": null, "role": "USER", "status": "FINISHED",
      "thinking_enabled": true, "search_enabled": false,
      "accumulated_token_usage": 45, "inserted_at": "…",
      "fragments": [
        {"type": "REQUEST", "content": "…"},
        {"type": "THINK", "content": "…", "elapsed_secs": 3.63},
        {"type": "RESPONSE", "content": "…"},
        {"type": "TOOL_SEARCH", "queries": [], "results": [], "status": "FAILED"},
        {"type": "TOOL_OPEN", "url": "…", "title": "…", "snippet": "…", "site_name": "…", "site_icon": "…", "status": "…"},
        {"type": "FILE", "files": [{"id":"…","file_name":"a.jpg","file_size":123,"is_image":true,"export_path":"chat_sessions/<uuid>_files/<id>_a.jpg"}]},
        {"type": "CONTENT_RISK", "content": "…", "style": "WARNING"},
        {"type": "TEMPLATE_RESPONSE", "content": "服务器繁忙，请稍后再试。"},
        {"type": "TIP", "content": "…", "style": "INFO"}
      ] }
  ]
}
```

实测 fragment 取值：`REQUEST / RESPONSE / THINK / TOOL_SEARCH / TOOL_OPEN / FILE / CONTENT_RISK / TEMPLATE_RESPONSE / TIP`。

**坑**：`inserted_at` 存在毫秒级倒挂（助手消息可能比对应的用户消息早几毫秒），不能按时间重排，必须按 `messages` 数组顺序。

---

## 2. 输出 A：Chatbox 备份（V2 zip，`formatVersion: 2`）

新版本 Chatbox 默认导出 V3（`sessions/<id>.jsonl` + `resources.jsonl`，无内容哈希），但仍能导入 V1/V2。这里选 **V2**：兼容面最广（1.23.5 起即可导入），且带完整校验，便于自证正确。

### 包结构

```
manifest.json
sessions/<encodeURIComponent(id)>/session.json
sessions/<id>/resources/<resource-id>.<ext>   # 会话内资源（可选）
resources/<resource-id>.<ext>                 # 共享资源（可选）
settings.json / copilots.json / session-settings.json   # 可选
```

### manifest.json

```json
{
  "format": "chatbox-backup",
  "formatVersion": 2,
  "exportedAt": "2026-11-16T10:00:00.000Z",
  "application": { "name": "Chatbox", "version": "1.24.x", "platform": "win32" },
  "exportItems": ["conversations"],
  "data": {},
  "sessions": [
    { "path": "sessions/<id>/session.json", "size": 1234,
      "checksum": { "algorithm": "sha256", "value": "<64 位小写 hex>" },
      "id": "<id>",
      "meta": { "id": "<id>", "name": "标题", "type": "chat", "sortOrder": 1, "createdAt": 1700000000000 },
      "resourceIds": [] }
  ],
  "resources": [],
  "warnings": [],
  "stats": { "sessionCount": 1, "resourceCount": 0, "deduplicatedResourceCount": 0, "warningCount": 0 }
}
```

导入端（`import-backup.ts` / `types.ts`）会强制校验：

- `readZipFileEntries` 遍历到的**每个 entry 都必须在 manifest 里**，反之亦然（`manifest.json` 自身也要在列表里）
- 每个 entry 的**未压缩字节数** = `descriptor.size`，**sha256（小写 hex）** = `descriptor.checksum.value`
- `isBackupSession`：对象、非空字符串 `id`、字符串 `name`、`messages` 是数组
- `session.id === manifest.sessions[i].id`，`meta.id === session.id`
- `stats.sessionCount/resourceCount/warningCount` 必须等于对应数组长度（`deduplicatedResourceCount` 不校验）
- resource ↔ session 双向映射一致；`scope: "session"` 时 `sessionIds` 恰好 1 个

### session.json

```json
{
  "id": "…", "name": "标题", "type": "chat",
  "messages": [
    { "id": "…", "role": "user",
      "contentParts": [{ "type": "text", "text": "…" }],
      "timestamp": 1700000000000 },
    { "id": "…", "role": "assistant",
      "contentParts": [
        { "type": "reasoning", "text": "思考过程" },
        { "type": "text", "text": "回答" }
      ],
      "model": "deepseek-reasoner", "aiProvider": "DeepSeek" }
  ]
}
```

`MessageSchema` 必填：`id`、`role`（`system|user|assistant|tool`）、`contentParts[]`。
`contentParts` 联合类型：`text` / `image{storageKey}` / `info{text}` / `agent-mode-suggestion` / `reasoning{text}` / `tool-call`。

### 资源（图片）

- 资源文件里存**原始二进制**；manifest 里 `encoding: "data-url-base64"` 表示导入时会还原成 `data:<mimeType>;base64,…` 存进 blob 存储
- 消息里的图片用 `{ "type": "image", "storageKey": "picture:<uuid>" }` 引用，`originalStorageKeys` 与之对应即可（导入时若本地没有同名 key，会原样写入）

---

## 3. 输出 B：DeepSeek Harness 会话（v4 JSONL + zstd）

### 磁盘布局

```
%USERPROFILE%\.dsh\sessions\
  --<cwd 规范化>--\
    session-<uuid>\
      session.v4.jsonl.zstd
```

目录名规则：`\` `/` `:` 的连续段折叠成单个 `-`；`[A-Za-z0-9._-]` 原样；其余（含 `~`）写成 `~XXXX`（UTF-16 码元、大写十六进制）；整体包成 `--…--`，上限 251 字符。

例：`D:\work\我的项目` → `--D-work-~6211~7684~9879~76EE--`

### 物理格式

- 多个独立 zstd frame 拼接：**第一帧只含 header 一行**，之后每个 append 批次一帧
- 每行一个 JSON；每帧明文必须以 `\n` 结束
- 用未压缩 raw block（`windowLog=17`，单块 ≤128 KiB）即可，帧校验和 xxhash64 低 32 位
- 注意：`zlib.zstdDecompressSync` 一次只解**第一帧**，验证多帧要按魔数 `28 B5 2F FD` 切分逐帧解

### header

```json
{"type":"session","version":4,"id":"session-…","createdAt":1791518801245,
 "cwd":"D:\\work\\my-project","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

键集合严格：必填 `version/id/createdAt/isSeeded/delegationDepth`，可选 `cwd/parentSession/origin/agentPreset`，**多一个就拒**。

`cwd` 决定 GUI 能否看见（`list()` 里判 `record.header.cwd !== void 0`），且必须是绝对路径。

### 事件

```json
{"type":"permission/preset","seq":0,"time":…,"data":{"preset":"danger-full-access"}}
{"type":"sandbox/mode","seq":1,"time":…,"data":{"mode":"danger-full-access"}}
{"type":"approval/policy","seq":2,"time":…,"data":{"policy":"never"}}
{"type":"session/end-seed","seq":3,"time":…,"data":{}}
{"type":"model/selection","seq":4,"time":…,"data":{"provider":"…","model":"…","reasoningEffort":"high"}}
{"type":"turn/start","seq":5,"time":…,"data":{"turn":1}}
{"type":"step/start","seq":6,"time":…,"data":{"turn":1,"step":1}}
{"type":"user/message","seq":7,"time":…,"data":{"content":[{"type":"text","text":"…"}],"source":{"kind":"user","clientTimeZone":"Asia/Shanghai"},"role":"user","id":"…"},"surfaceOp":"append"}
{"type":"session/title","seq":8,"time":…,"data":{"title":"…","messageSeqs":[7],"source":{"kind":"fallback"}}}
{"type":"request/context","seq":9,"time":…,"data":{"provider":"…","model":"…","contextWindow":1048576}}
{"type":"assistant/message","seq":10,"time":…,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"…"},{"type":"text","text":"…"}],"source":{"kind":"model","provider":"…","model":"…"},"id":"…"},"usage":{…},"stream":[]},"surfaceOp":"append"}
{"type":"step/end","seq":11,"time":…,"data":{"turn":1,"step":1}}
{"type":"turn/end","seq":12,"time":…,"data":{"turn":1,"reason":{"kind":"completed"}}}
```

要点：

- `seq` 必须从 0 连续、无空洞（等于数组下标）
- **`assistant/message` 同样需要 `surfaceOp: "append"`**（所有 surface 事件都要）
- `assistant/message` 必须落在已打开的 step 内；`stream` 必须是数组
- 不要伪造 tool-call（未结清会被拒）；`system/message` 不需要
- 最后一条应是 `turn/end`，否则 GUI 以写模式打开时会追加 interrupted 修补事件
