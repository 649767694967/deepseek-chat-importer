/**
 * 聊天客户端核心逻辑（纯函数 + fetch，无 DOM 依赖，可 node 测试）
 * 会被内联进 client.html。为与转换器的 core.mjs 共存，统一 cc* 前缀。
 */

export const CC_DEFAULT_BASE = 'https://api.deepseek.com';

export const CC_MODEL_PRESETS = [
  { id: 'deepseek-chat', name: 'deepseek-chat（通用，快）', model: 'deepseek-chat' },
  { id: 'deepseek-reasoner', name: 'deepseek-reasoner（深度思考）', model: 'deepseek-reasoner' },
  { id: 'custom', name: '自定义模型名…', model: '' },
];

/* ---------------- 地址与请求 ---------------- */

/** 归一化 base URL：去尾部斜杠；已带 /chat/completions 就原样用 */
export function ccNormalizeBase(base) {
  let b = String(base || '').trim();
  if (!b) return CC_DEFAULT_BASE;
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/+$/, '');
  return b;
}

export function ccEndpoint(base) {
  const b = ccNormalizeBase(base);
  return /\/chat\/completions$/i.test(b) ? b : b + '/chat/completions';
}

export function ccModelEndpoint(base) {
  const b = ccNormalizeBase(base);
  return /\/chat\/completions$/i.test(b) ? b.replace(/\/chat\/completions$/i, '/models') : b + '/models';
}

/* ---------------- token 估算 ---------------- */

export function ccEstimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.05 + other / 3.6);
}

export function ccEstimateMessages(messages) {
  return (messages || []).reduce(
    (sum, m) => sum + 4 + ccEstimateTokens(m.content) + ccEstimateTokens(m.reasoning || ''),
    0
  );
}

/* ---------------- SSE 流式请求 ---------------- */

/**
 * 流式调用 OpenAI 兼容 /chat/completions。
 * @returns {Promise<{content:string, reasoning:string, usage:any, aborted:boolean}>}
 */
export async function ccStreamChat(opts) {
  const {
    base,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens,
    signal,
    onEvent = () => {},
    fetchImpl = globalThis.fetch.bind(globalThis),
  } = opts;

  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  const res = await fetchImpl(ccEndpoint(base), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {}
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  if (!res.body || !res.body.getReader) {
    // 极老浏览器：退回非流式
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    onEvent({ type: 'content', text: msg.content || '' });
    return { content: msg.content || '', reasoning: msg.reasoning_content || '', usage: data?.usage, aborted: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let aborted = false;

  const handleLine = (line) => {
    const t = line.trim();
    if (!t || !t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.usage) usage = json.usage;
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onEvent({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onEvent({ type: 'content', text: delta.content });
    }
    if (json.choices?.[0]?.finish_reason) onEvent({ type: 'finish', reason: json.choices[0].finish_reason });
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer);
  } catch (err) {
    if (err && err.name === 'AbortError') aborted = true;
    else throw err;
  }

  return { content, reasoning, usage, aborted };
}

/** 非流式单次请求（测试连接 / 压缩摘要用） */
export async function ccSimpleChat(opts) {
  const { base, apiKey, model, messages, temperature, maxTokens, signal, fetchImpl = globalThis.fetch.bind(globalThis) } = opts;
  const body = { model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  const res = await fetchImpl(ccEndpoint(base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {}
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  return { content: msg.content || '', reasoning: msg.reasoning_content || '', usage: data?.usage };
}

/** 测试连接：优先 GET /models，失败再退化为一次极短对话 */
export async function ccTestConnection({ base, apiKey, model, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  try {
    const res = await fetchImpl(ccModelEndpoint(base), {
      headers: { ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const models = (data?.data || []).map((m) => m.id).filter(Boolean);
      return { ok: true, via: 'models', models };
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      err.body = text;
      throw err;
    }
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) throw err;
  }
  const ret = await ccSimpleChat({
    base,
    apiKey,
    model,
    messages: [{ role: 'user', content: 'ping（只回 ok 两个字符）' }],
    maxTokens: 8,
    fetchImpl,
  });
  return { ok: true, via: 'chat', sample: ret.content.slice(0, 40) };
}

/* ---------------- 上下文压缩 ---------------- */

export function ccSplitForCompression(messages, keepRecent = 6) {
  const list = (messages || []).filter((m) => m.role !== 'system');
  if (list.length <= keepRecent + 1) return { head: [], tail: list, canCompress: false };
  const cut = Math.max(0, list.length - keepRecent);
  return { head: list.slice(0, cut), tail: list.slice(cut), canCompress: cut > 0 };
}

export function ccCompressionPrompt(head) {
  const body = head
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 1200)}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        '你是对话压缩器。把下面的历史对话压成一份供后续对话使用的摘要，要求：保留事实、结论、用户偏好与未完成事项；' +
        '删掉寒暄与重复；用条目式中文；不超过 400 字；不要评论、不要复述这段指令。',
    },
    { role: 'user', content: body },
  ];
}

/**
 * 压缩会话：把较早消息换成一条 system 摘要。
 * @param {{messages:Array, keepRecent?:number, llm:(messages:Array)=>Promise<string>}} opts
 */
export async function ccCompressConversation({ messages, keepRecent = 6, llm }) {
  const { head, tail, canCompress } = ccSplitForCompression(messages, keepRecent);
  if (!canCompress) return { messages, summary: '', compressed: 0, skipped: true };
  const summary = String((await llm(ccCompressionPrompt(head))) || '').trim();
  if (!summary) throw new Error('摘要为空');
  const newMessages = [{ role: 'system', content: '【历史对话摘要】' + summary }, ...tail];
  return { messages: newMessages, summary, compressed: head.length, skipped: false };
}

/* ---------------- 导入 / 导出 ---------------- */

function nowId(prefix = 'm') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/** 由「转换器」的 parseDeepSeekSession 结果生成客户端会话 */
export function ccImportFromDeepSeek(ds) {
  const messages = [];
  for (const m of ds.messages || []) {
    if (m.role === 'system') continue;
    messages.push({
      id: nowId(),
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text || '',
      reasoning: m.thinking || '',
      time: m.time || Date.now(),
      files: (m.files || []).map((f) => f.name),
    });
  }
  return {
    id: nowId('s'),
    title: ds.title || '导入的会话',
    createdAt: ds.createdAt || Date.now(),
    updatedAt: ds.updatedAt || Date.now(),
    messages,
    importedFrom: 'deepseek',
  };
}

/** Chatbox session.json → 客户端会话 */
export function ccImportFromChatbox(session) {
  const messages = [];
  for (const m of session.messages || []) {
    const parts = Array.isArray(m.contentParts) ? m.contentParts : [];
    let text = '';
    let reasoning = '';
    for (const p of parts) {
      if (p.type === 'text') text += p.text;
      else if (p.type === 'reasoning') reasoning += p.text;
      else if (p.type === 'info') text += (text ? '\n' : '') + p.text;
      else if (p.type === 'image') text += '\n[图片]';
    }
    if (!text && !reasoning) continue;
    messages.push({
      id: nowId(),
      role: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant',
      content: text,
      reasoning,
      time: m.timestamp || Date.now(),
    });
  }
  return {
    id: session.id || nowId('s'),
    title: session.name || '导入的会话',
    createdAt: messages[0]?.time || Date.now(),
    updatedAt: messages[messages.length - 1]?.time || Date.now(),
    messages,
    importedFrom: 'chatbox',
  };
}

/** 本客户端导出的 json → 会话（数组或单对象都接受） */
export function ccImportFromClientJson(obj) {
  const list = Array.isArray(obj) ? obj : obj && obj.sessions ? obj.sessions : [obj];
  return list
    .filter((s) => s && Array.isArray(s.messages))
    .map((s) => ({
      id: s.id || nowId('s'),
      title: s.title || '导入的会话',
      createdAt: s.createdAt || Date.now(),
      updatedAt: s.updatedAt || Date.now(),
      messages: s.messages.map((m) => ({
        id: m.id || nowId(),
        role: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant',
        content: String(m.content ?? ''),
        reasoning: m.reasoning || '',
        time: m.time || Date.now(),
      })),
      importedFrom: 'client',
    }));
}

/** 依据文件内容猜类型：返回 'deepseek'|'chatbox-session'|'client'|'markdown'|'unknown' */
export function ccDetectImport({ name = '', text = '', isZip = false, paths = [] }) {
  if (isZip) {
    if (paths.some((p) => /(^|\/)chat_session_index\.json$/i.test(p))) return 'deepseek-zip';
    if (paths.some((p) => /(^|\/)sessions\/[^/]+\/session\.json$/i.test(p))) return 'chatbox-zip';
    return 'unknown-zip';
  }
  const t = String(text || '').trim();
  if (/^#\s*AI\s*对话记录/m.test(t) || /^##\s*(用户|AI)\s*$/m.test(t)) return 'markdown';
  if (/\.(md|markdown|txt)$/i.test(name)) return 'markdown';
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj) && obj[0] && Array.isArray(obj[0].messages)) return 'client';
      if (obj.messages && obj.name) return 'chatbox-session';
      if (obj.sessions && Array.isArray(obj.sessions)) return 'client';
      if (obj['chat-sessions-list']) return 'chatbox-v1';
      if (Array.isArray(obj) && obj[0] && obj[0].mapping) return 'chatgpt-export';
    }
  } catch {}
  return 'unknown';
}

export function ccSessionToMarkdown(session) {
  const lines = [`# ${session.title || '会话'}`, ''];
  for (const m of session.messages || []) {
    lines.push(`## ${m.role === 'user' ? '用户' : m.role === 'system' ? '系统' : 'AI'}`, '');
    if (m.reasoning) lines.push('<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>', '');
    if (m.content) lines.push(m.content, '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

export function ccSessionToJson(session) {
  return JSON.stringify(
    {
      format: 'ds-chat-client',
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: [
        {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: (session.messages || []).map((m) => ({
            role: m.role,
            content: m.content,
            reasoning: m.reasoning || undefined,
            time: m.time,
          })),
        },
      ],
    },
    null,
    2
  );
}

/* ---------------- 存储 ---------------- */

export function ccMakeStore(storage, namespace = 'dscc.v1') {
  const key = (k) => `${namespace}.${k}`;
  return {
    get(k, fallback) {
      try {
        const raw = storage.getItem(key(k));
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(k, value) {
      try {
        storage.setItem(key(k), JSON.stringify(value));
        return true;
      } catch (err) {
        return false;
      }
    },
    remove(k) {
      try {
        storage.removeItem(key(k));
      } catch {}
    },
    keys() {
      const out = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(namespace + '.')) out.push(k.slice(namespace.length + 1));
        }
      } catch {}
      return out;
    },
  };
}

/* ---------------- 小工具 ---------------- */

export function ccTruncate(text, max = 40) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function ccTitleFrom(messages, fallback = '新对话') {
  const first = (messages || []).find((m) => m.role === 'user' && m.content);
  return first ? ccTruncate(first.content, 24) : fallback;
}

export function ccFormatTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
