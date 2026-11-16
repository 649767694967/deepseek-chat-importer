/**
 * DeepSeek 网页端导出 → Chatbox / 通用格式 核心转换逻辑
 * 纯 JS，无依赖，浏览器与 Node 通用（ESM）。
 */

/* ---------------- 通用小工具 ---------------- */

export function fnvHex(input, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 稳定 UUID 形状 id（同输入得到同输出） */
export function stableId(seed) {
  const parts = [];
  let s = 0x811c9dc5;
  for (let i = 0; i < 4; i++) {
    s = fnvHex(seed + '#' + i, s);
    parts.push(s.toString(16).padStart(8, '0'));
  }
  const hex = parts.join('');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32)
  );
}

export function isoToMs(iso) {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

export function extOf(name = '') {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return m ? m[1] : '';
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  pdf: 'application/pdf',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

export function mimeOf(name = '') {
  const e = extOf(name);
  return MIME_BY_EXT[e] || (e ? 'application/octet-stream' : 'application/octet-stream');
}

export async function coreSha256Hex(bytes) {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // 退化路径：某些 file:// / 非安全上下文没有 crypto.subtle，用内联的纯 JS 实现（来自 zipkit）
  if (typeof sha256Hex === 'function') return sha256Hex(bytes);
  throw new Error('当前环境没有可用的 SHA-256 实现');
}

export function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

export function utf8Decode(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

export function base64ToBytes(b64) {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa(bin);
}

/* ---------------- DeepSeek 导出解析 ---------------- */

/**
 * 把一个 DeepSeek 会话 json 规范化成中性结构：
 * { id, title, createdAt, updatedAt, messages: [{ role, id, time, thinking, text, files, search, cards, notes }] }
 */
export function parseDeepSeekSession(raw) {
  const messages = [];
  const list = Array.isArray(raw?.messages) ? raw.messages : [];
  for (const m of list) {
    const role = String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant';
    const entry = {
      id: String(m.id ?? ''),
      role,
      time: isoToMs(m.inserted_at),
      thinking: '',
      text: '',
      files: [],
      search: [],
      cards: [],
      notes: [],
      status: m.status || '',
    };
    const frags = Array.isArray(m.fragments) ? m.fragments : [];
    for (const f of frags) {
      const t = f?.type || '';
      if (t === 'REQUEST' || t === 'RESPONSE' || t === 'TEMPLATE_RESPONSE') {
        if (typeof f.content === 'string' && f.content) {
          entry.text = entry.text ? entry.text + '\n' + f.content : f.content;
        }
      } else if (t === 'THINK') {
        if (typeof f.content === 'string' && f.content) {
          entry.thinking = entry.thinking ? entry.thinking + '\n' + f.content : f.content;
        }
      } else if (t === 'TOOL_SEARCH') {
        if (Array.isArray(f.queries) && f.queries.length) entry.search.push(...f.queries.map(String));
        if (Array.isArray(f.results) && f.results.length) {
          entry.search.push(...f.results.slice(0, 10).map((r) => String(r?.title || r?.url || '')));
        }
      } else if (t === 'TOOL_OPEN') {
        entry.cards.push({ title: f.title || '', url: f.url || '', site: f.site_name || '', snippet: f.snippet || '' });
      } else if (t === 'FILE') {
        const files = Array.isArray(f.files) ? f.files : [];
        for (const file of files) {
          entry.files.push({
            id: file?.id || '',
            name: file?.file_name || 'file',
            size: Number(file?.file_size) || 0,
            isImage: Boolean(file?.is_image),
            path: file?.export_path || '',
            width: file?.width || null,
            height: file?.height || null,
          });
        }
      } else if (t === 'CONTENT_RISK' || t === 'TIP') {
        if (f.content) entry.notes.push(String(f.content));
      } else if (f?.content) {
        entry.notes.push(String(f.content));
      }
    }
    if (entry.text || entry.thinking || entry.files.length || entry.search.length || entry.cards.length) {
      messages.push(entry);
    }
  }
  // 保持源文件顺序（DeepSeek 已按对话顺序排好，inserted_at 有毫秒级倒挂，不能重排）
  return {
    id: String(raw?.id || ''),
    title: String(raw?.title || '未命名会话').trim() || '未命名会话',
    pinned: Boolean(raw?.pinned),
    createdAt: isoToMs(raw?.inserted_at),
    updatedAt: isoToMs(raw?.updated_at),
    messages,
  };
}

/**
 * 解析「DeepSeek-Exporter」浏览器扩展导出的 Markdown（每会话一个 .md）：
 *
 *   # AI 对话记录
 *
 *   ## 用户
 *   ...
 *   ---
 *   ## AI
 *   正文
 *   > [思考过程]
 *   > ...
 */
export function parseMarkdownConversation(text, opts = {}) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const fileName = opts.fileName || '对话';
  const baseName = fileName.replace(/\.(md|markdown|txt)$/i, '');
  const lines = src.split('\n');
  const messages = [];
  const HEAD = /^#{1,3}\s*(用户|我|user|human|ai|assistant|助手|deepseek)\s*[:：]?\s*$/i;
  let cur = null;
  let mode = 'text';
  const flush = () => {
    if (!cur) return;
    const text = cur.text.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const thinking = cur.thinking.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text || thinking) {
      messages.push({
        id: String(messages.length + 1),
        role: cur.role,
        time: 0,
        thinking,
        text,
        files: [],
        search: [],
        cards: [],
        notes: [],
        status: 'FINISHED',
      });
    }
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const head = HEAD.exec(line.trim());
    if (head) {
      flush();
      const who = head[1].toLowerCase();
      const isUser = ['用户', '我', 'user', 'human'].includes(who);
      cur = { role: isUser ? 'user' : 'assistant', text: [], thinking: [] };
      mode = 'text';
      continue;
    }
    if (!cur) continue;
    if (/^>\s*\[?思考(过程|内容)?\]?\s*$/.test(line.trim())) {
      mode = 'think';
      continue;
    }
    if (mode === 'think') {
      if (/^>/.test(line)) {
        cur.thinking.push(line.replace(/^>\s?/, ''));
      } else if (!line.trim()) {
        cur.thinking.push('');
      } else {
        mode = 'text';
        cur.text.push(line);
      }
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue; // 分隔线
    if (/^#\s*AI\s*对话记录\s*$/.test(line.trim())) continue;
    cur.text.push(line);
  }
  flush();

  // 时间戳：文件名里的时间（若有），否则按顺序递增
  const stamp = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[-_ T]?(\d{2})?[-_.:]?(\d{2})?/.exec(baseName);
  let t = stamp
    ? new Date(
        Number(stamp[1]),
        Number(stamp[2]) - 1,
        Number(stamp[3]),
        Number(stamp[4] || 9),
        Number(stamp[5] || 0)
      ).getTime()
    : opts.mtime || Date.now();
  if (!Number.isFinite(t)) t = opts.mtime || Date.now();
  for (const m of messages) {
    m.time = t;
    t += 1000;
  }

  const firstUser = messages.find((m) => m.role === 'user');
  const cleanTitle = baseName
    .replace(/^(AI\s*)?对话记录[-_ ]*/i, '')
    .replace(/^(deepseek|chat)[-_ ]*/i, '')
    .replace(/[-_ ]*\d{4}[-_.]?\d{2}[-_.]?\d{2}.*$/, '')
    .trim();
  const title = cleanTitle || (firstUser ? firstUser.text.slice(0, 30) : '') || baseName || '未命名会话';

  return {
    id: opts.id || stableId('md:' + baseName + ':' + (opts.mtime || 0)),
    title,
    pinned: false,
    createdAt: messages[0]?.time || Date.now(),
    updatedAt: messages[messages.length - 1]?.time || Date.now(),
    messages,
  };
}

/* ---------------- Chatbox 备份生成 ---------------- */

const CHATBOX_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/pdf': 'pdf',
};

export function sessionPathComponent(sessionId) {
  const enc = encodeURIComponent(sessionId).replaceAll('.', '%2E');
  return enc.length <= 200 ? enc : 'id-' + fnvHex(sessionId).toString(16);
}

/**
 * 中性会话 → Chatbox session.json 对象 + 需要的资源二进制
 * @param ds 由 parseDeepSeekSession 得到
 * @param ctx { sessionId?: string, readFile?: async (exportPath) => Uint8Array|null, includeImages?: boolean }
 */
export async function buildChatboxSession(ds, ctx = {}) {
  const includeImages = ctx.includeImages !== false;
  const readFile = ctx.readFile || (async () => null);
  const sessionId =
    ctx.sessionId ||
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ds.id)
      ? ds.id
      : stableId('session:' + ds.id + ':' + ds.title));
  const resources = [];
  let resourceSeq = 0;
  const imageKeyCache = new Map();

  async function imageResource(file) {
    if (!file.path) return null;
    if (imageKeyCache.has(file.path)) return imageKeyCache.get(file.path);
    let bytes = null;
    try {
      bytes = await readFile(file.path);
    } catch {
      bytes = null;
    }
    if (!bytes || !bytes.length) return null;
    resourceSeq += 1;
    const id = 'resource-' + String(resourceSeq).padStart(6, '0');
    const mimeType = mimeOf(file.name);
    const storageKey = 'picture:' + stableId('img:' + ds.id + ':' + file.path);
    const ext = CHATBOX_EXTENSION[mimeType] || extOf(file.name) || 'bin';
    resources.push({
      id,
      path: `sessions/${sessionPathComponent(sessionId)}/resources/${id}.${ext}`,
      originalStorageKeys: [storageKey],
      sessionIds: [sessionId],
      scope: 'session',
      encoding: 'data-url-base64',
      mimeType,
      kind: 'image',
      filename: file.name,
      data: bytes,
    });
    imageKeyCache.set(file.path, storageKey);
    return storageKey;
  }

  const messages = [];
  for (const m of ds.messages) {
    const parts = [];
    if (m.role === 'assistant' && m.thinking) {
      parts.push({ type: 'reasoning', text: m.thinking });
    }
    if (m.search.length) {
      parts.push({ type: 'info', text: '🔍 联网搜索：' + m.search.slice(0, 12).join(' · ') });
    }
    for (const card of m.cards.slice(0, 8)) {
      parts.push({
        type: 'info',
        text: `🔗 ${card.title}${card.site ? '（' + card.site + '）' : ''}\n${card.url}`.trim(),
      });
    }
    for (const file of m.files) {
      if (file.isImage && includeImages) {
        const key = await imageResource(file);
        if (key) {
          parts.push({ type: 'image', storageKey: key });
          continue;
        }
      }
      parts.push({ type: 'info', text: `📎 附件：${file.name}` });
    }
    for (const note of m.notes) parts.push({ type: 'info', text: note });
    if (m.text) parts.push({ type: 'text', text: m.text });
    if (!parts.length) continue;
    messages.push({
      id: stableId(`msg:${ds.id}:${m.role}:${m.id}:${m.time}`),
      role: m.role,
      contentParts: parts,
      timestamp: m.time,
      ...(m.role === 'assistant' ? { model: 'deepseek-reasoner', aiProvider: 'DeepSeek' } : {}),
    });
  }

  return {
    session: {
      id: sessionId,
      name: ds.title,
      type: 'chat',
      starred: ds.pinned || undefined,
      messages,
    },
    resources,
    createdAt: ds.createdAt,
  };
}

export function chatboxMeta(session, sortOrder, createdAt) {
  return {
    id: session.id,
    name: session.name,
    starred: session.starred,
    type: session.type,
    sortOrder,
    createdAt,
  };
}

/**
 * 生成 Chatbox 备份 zip 的 entries（manifest 必须最后或任意顺序，导入端做了全量校验）
 * @param built [{ session, resources:[] }]
 * @param opts { appVersion, platform, exportedAt }
 */
export async function buildChatboxArchive(built, opts = {}) {
  const entries = [];
  const sessions = [];
  const resources = [];
  const warnings = [];
  const usedResourceIds = new Set();

  for (let i = 0; i < built.length; i++) {
    const { session, resources: resList } = built[i];
    const path = `sessions/${sessionPathComponent(session.id)}/session.json`;
    const bytes = utf8Encode(JSON.stringify(session));
    sessions.push({
      path,
      size: bytes.length,
      checksum: { algorithm: 'sha256', value: await coreSha256Hex(bytes) },
      id: session.id,
      meta: chatboxMeta(session, built.length - i, built[i].createdAt || session.messages[0]?.timestamp || Date.now()),
      resourceIds: resList.map((r) => r.id),
    });
    entries.push({ path, data: bytes, deflate: true });
    for (const r of resList) {
      let id = r.id;
      let guard = 0;
      while (usedResourceIds.has(id) && guard++ < 1000) id = 'resource-' + stableId(r.path + ':' + guard).slice(0, 8);
      usedResourceIds.add(id);
      const finalPath = r.path.replace(/resources\/[^/]+\./, `resources/${id}.`);
      const data = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
      resources.push({
        id,
        path: finalPath,
        size: data.length,
        checksum: { algorithm: 'sha256', value: await coreSha256Hex(data) },
        originalStorageKeys: r.originalStorageKeys,
        sessionIds: [session.id],
        scope: 'session',
        encoding: r.encoding,
        mimeType: r.mimeType,
        kind: r.kind,
        filename: r.filename,
      });
      sessions[sessions.length - 1].resourceIds = sessions[sessions.length - 1].resourceIds.map((x) =>
        x === r.id ? id : x
      );
      entries.push({ path: finalPath, data, deflate: false });
    }
  }

  const manifest = {
    format: 'chatbox-backup',
    formatVersion: 2,
    exportedAt: (opts.exportedAt || new Date()).toISOString(),
    application: {
      name: 'Chatbox',
      version: opts.appVersion || '1.16.0',
      platform: opts.platform || 'win32',
    },
    exportItems: ['conversations'],
    data: {},
    sessions,
    resources,
    warnings,
    stats: {
      sessionCount: sessions.length,
      resourceCount: resources.length,
      deduplicatedResourceCount: 0,
      warningCount: warnings.length,
    },
  };

  const manifestBytes = utf8Encode(JSON.stringify(manifest));
  entries.push({ path: 'manifest.json', data: manifestBytes, deflate: true });
  return { manifest, entries };
}

/* ---------------- Chatbox V1（单文件 JSON，兼容所有版本） ---------------- */

/**
 * 生成 V1 键值对象：{configVersion, __exported_items, __exported_at, "session:<id>": {...}, "chat-sessions-list": [...]}
 * 只保留文本与思考，不含附件（与 Chatbox 自己的 V1 导出行为一致）。
 */
export function buildChatboxV1File(built, opts = {}) {
  const out = {
    configVersion: 15,
    __exported_items: ['conversations'],
    __exported_at: (opts.exportedAt || new Date()).toISOString(),
  };
  const list = [];
  built.forEach((b, i) => {
    const s = b.session;
    const lean = {
      id: s.id,
      name: s.name,
      type: 'chat',
      ...(s.starred ? { starred: true } : {}),
      messages: s.messages.map((m) => ({
        id: m.id,
        role: m.role,
        contentParts: (m.contentParts || []).filter((p) => p.type === 'text' || p.type === 'reasoning'),
        timestamp: m.timestamp,
        ...(m.model ? { model: m.model } : {}),
      })),
    };
    out['session:' + s.id] = lean;
    list.push({
      id: s.id,
      name: s.name,
      type: 'chat',
      ...(s.starred ? { starred: true } : {}),
      sortOrder: built.length - i,
      createdAt: b.createdAt || lean.messages[0]?.timestamp || Date.now(),
    });
  });
  out['chat-sessions-list'] = list;
  return JSON.stringify(out);
}

/* ---------------- Markdown 导出 ---------------- */

export function toMarkdown(ds) {
  const lines = [`# ${ds.title}`, '', `> 会话 ID: ${ds.id}　创建: ${new Date(ds.createdAt).toLocaleString()}`, ''];
  for (const m of ds.messages) {
    lines.push(`## ${m.role === 'user' ? '🧑 用户' : '🤖 DeepSeek'}　${new Date(m.time).toLocaleString()}`);
    lines.push('');
    if (m.thinking) {
      lines.push('<details><summary>思考过程</summary>', '', m.thinking, '', '</details>', '');
    }
    if (m.text) {
      lines.push(m.text, '');
    }
    for (const f of m.files) lines.push(`📎 附件：${f.name}${f.path ? ' (`' + f.path + '`)' : ''}`, '');
    for (const c of m.cards) lines.push(`🔗 [${c.title}](${c.url})`, '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

/* ---------------- DSH workspace key ---------------- */

export function workspaceKey(cwd) {
  const p = String(cwd || '');
  let out = '';
  let separatorRun = false;
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '\\' || ch === '/' || ch === ':') {
      if (!separatorRun) out += '-';
      separatorRun = true;
      continue;
    }
    separatorRun = false;
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return '--' + (out.replace(/^-+/, '') || 'root').slice(0, 251) + '--';
}
