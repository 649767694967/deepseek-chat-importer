/* ================= 聊天客户端 · 交互层 =================
 * 依赖（均被内联在同一作用域）：
 *   zipkit.js        openZip
 *   core-lib.mjs     parseDeepSeekSession / parseMarkdownConversation
 *   prompts.mjs      DEFAULT_SYSTEM_PROMPT / PROMPT_PRESETS / HELP_HTML / explainError
 *   chat/core.mjs    cc* 工具
 */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const store = ccMakeStore(window.localStorage, 'dscc.v1');

const DEFAULTS = {
  apiBase: CC_DEFAULT_BASE,
  apiKey: '',
  modelPreset: 'deepseek-chat',
  modelName: 'deepseek-chat',
  temperature: 1,
  maxTokens: 0,
  promptPreset: 'default',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  theme: 'dark',
  bg: 'aurora',
  bgImage: '',
  bgDim: 45,
  bgBlur: 0,
  selfAvatar: '',
  botAvatar: '',
  selfEmoji: '🙂',
  botEmoji: '🐳',
  selfName: '我',
  botName: 'DeepSeek',
};

const state = {
  settings: { ...DEFAULTS },
  sessions: [],
  currentId: null,
  streaming: false,
  controller: null,
  index: [],
};

/* ---------------- 基础工具 ---------------- */

function toast(msg, kind = '') {
  const area = $('toastArea');
  if (!area) return;
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  area.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2800);
}

function cur() {
  return state.sessions.find((s) => s.id === state.currentId) || null;
}

function nowMs() {
  return Date.now();
}

function newId(p = 's') {
  return p + '-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function persistSettings() {
  store.set('settings', state.settings);
}

function persistSession(session) {
  store.set('session.' + session.id, session);
  const idx = state.index.filter((i) => i.id !== session.id);
  idx.unshift({
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    count: session.messages.length,
  });
  state.index = idx;
  store.set('index', idx);
}

function loadAll() {
  const s = store.get('settings', null);
  if (s && typeof s === 'object') state.settings = { ...DEFAULTS, ...s };
  const idx = store.get('index', []);
  state.index = Array.isArray(idx) ? idx : [];
  state.sessions = state.index
    .map((i) => store.get('session.' + i.id, null))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!state.sessions.length) createSession(false);
}

function createSession(render = true) {
  const s = {
    id: newId(),
    title: '新对话',
    createdAt: nowMs(),
    updatedAt: nowMs(),
    messages: [],
  };
  state.sessions.unshift(s);
  state.currentId = s.id;
  persistSession(s);
  if (render) {
    renderSessions();
    renderMessages();
  }
  return s;
}

function switchSession(id) {
  state.currentId = id;
  renderSessions();
  renderMessages();
  closeDrawer();
}

function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.messages.length && !confirm(`删除「${s.title}」？`)) return;
  state.sessions = state.sessions.filter((x) => x.id !== id);
  state.index = state.index.filter((x) => x.id !== id);
  store.remove('session.' + id);
  store.set('index', state.index);
  if (state.currentId === id) {
    state.currentId = state.sessions[0]?.id || null;
    if (!state.currentId) createSession(false);
  }
  renderSessions();
  renderMessages();
  toast('已删除会话');
}

/* ---------------- 主题 / 背景 / 头像 ---------------- */

function effectiveTheme() {
  const t = state.settings.theme;
  if (t === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return t === 'light' ? 'light' : 'dark';
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', effectiveTheme());
  const btn = $('themeBtn');
  if (btn) btn.title = effectiveTheme() === 'light' ? '切换到深色' : '切换到浅色';
}

function applyBackground() {
  const s = state.settings;
  document.body.setAttribute('data-bg', s.bg || 'aurora');
  // 模板约定：--bg-dim 是 0–100 的数字，--bg-blur 是 0–20 的数字（都不带单位）
  document.documentElement.style.setProperty('--bg-dim', String(Number(s.bgDim ?? 45)));
  document.documentElement.style.setProperty('--bg-blur', String(Number(s.bgBlur || 0)));
  document.body.style.backgroundImage = s.bg === 'custom' && s.bgImage ? `url("${s.bgImage}")` : '';
}

function avatarNode(role) {
  const s = state.settings;
  const src = role === 'user' ? s.selfAvatar : s.botAvatar;
  const emoji = role === 'user' ? s.selfEmoji : s.botEmoji;
  const wrap = el('div', 'avatar');
  if (src) {
    const img = el('img');
    img.src = src;
    img.alt = '';
    img.onerror = () => {
      img.remove();
      wrap.textContent = emoji || (role === 'user' ? '🙂' : '🐳');
    };
    wrap.appendChild(img);
  } else {
    wrap.textContent = emoji || (role === 'user' ? '🙂' : '🐳');
  }
  return wrap;
}

function whoName(role) {
  return role === 'user' ? state.settings.selfName || '我' : state.settings.botName || 'DeepSeek';
}

/* ---------------- 轻量 Markdown 渲染（不拼 innerHTML） ---------------- */

function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const src = String(text ?? '');
  const blocks = src.split(/```/);
  blocks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      // 代码块：第一行是语言
      const lines = chunk.replace(/^\n/, '').split('\n');
      let lang = '';
      if (lines[0] && /^[\w+#.-]{1,20}$/.test(lines[0].trim())) {
        lang = lines.shift().trim();
      }
      const pre = el('pre', 'code-block');
      if (lang) pre.setAttribute('data-lang', lang);
      pre.appendChild(el('code', '', lines.join('\n')));
      frag.appendChild(pre);
      return;
    }
    chunk.split(/\n{2,}/).forEach((para) => {
      const p = para.trim();
      if (!p) return;
      const lineWrap = el('div', 'para');
      p.split('\n').forEach((line, li) => {
        if (li) lineWrap.appendChild(document.createElement('br'));
        renderInline(line, lineWrap);
      });
      frag.appendChild(lineWrap);
    });
  });
  return frag;
}

function renderInline(line, host) {
  // 只处理 **粗体**、*斜体*、`行内代码`、http 链接
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|https?:\/\/[^\s<>"')]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) host.appendChild(document.createTextNode(line.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) {
      host.appendChild(el('strong', '', tok.slice(2, -2)));
    } else if (tok.startsWith('`')) {
      host.appendChild(el('code', 'inline-code', tok.slice(1, -1)));
    } else if (tok.startsWith('*')) {
      host.appendChild(el('em', '', tok.slice(1, -1)));
    } else {
      const a = el('a', '', tok);
      a.href = tok;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      host.appendChild(a);
    }
    last = m.index + tok.length;
  }
  if (last < line.length) host.appendChild(document.createTextNode(line.slice(last)));
}

/* ---------------- 渲染消息 ---------------- */

function renderMessages() {
  const box = $('messages');
  if (!box) return;
  box.replaceChildren();
  const s = cur();
  if (!s || !s.messages.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('h2', '', '开始一段新对话'));
    empty.appendChild(el('p', '', '在下面输入框里说话；右上角可以换背景、头像、提示词，也可以导入 DeepSeek 的聊天记录。'));
    const tips = el('div', 'empty-tips');
    tips.appendChild(el('span', 'chip', '⚙️ 先填 API Key'));
    tips.appendChild(el('span', 'chip', '🎨 换背景 / 头像'));
    tips.appendChild(el('span', 'chip', '🛡️ 破甲提示词'));
    tips.appendChild(el('span', 'chip', '📥 导入聊天记录'));
    empty.appendChild(tips);
    box.appendChild(empty);
    updateTokenHint();
    return;
  }
  for (const m of s.messages) box.appendChild(messageNode(m));
  scrollToBottom(true);
  updateTokenHint();
}

function messageNode(m) {
  const row = el('div', 'msg');
  row.dataset.role = m.role;
  row.dataset.id = m.id;
  row.appendChild(avatarNode(m.role));

  const wrap = el('div', 'bubble-wrap');
  const meta = el('div', 'meta');
  meta.appendChild(el('span', 'who', whoName(m.role)));
  meta.appendChild(el('span', 'time', ccFormatTime(m.time)));
  wrap.appendChild(meta);

  if (m.reasoning) {
    const det = el('details', 'think');
    det.appendChild(el('summary', '', '思考过程'));
    det.appendChild(el('div', 'think-body', m.reasoning));
    wrap.appendChild(det);
  }

  const bubble = el('div', 'bubble');
  bubble.appendChild(renderMarkdown(m.content || ''));
  if (m.error) {
    bubble.classList.add('error');
    bubble.appendChild(el('div', 'msg-error', m.error));
  }
  wrap.appendChild(bubble);

  const actions = el('div', 'msg-actions');
  const mk = (act, label) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.act = act;
    return b;
  };
  actions.appendChild(mk('copy', '复制'));
  if (m.role === 'user') actions.appendChild(mk('edit', '编辑'));
  if (m.role === 'assistant') actions.appendChild(mk('regen', '重生成'));
  actions.appendChild(mk('del', '删除'));
  wrap.appendChild(actions);

  row.appendChild(wrap);
  return row;
}

function updateMessageDom(m, streaming) {
  const row = document.querySelector(`.msg[data-id="${m.id}"]`);
  if (!row) return;
  const bubble = row.querySelector('.bubble');
  if (bubble) {
    bubble.replaceChildren();
    bubble.appendChild(renderMarkdown(m.content || ''));
    bubble.classList.toggle('error', !!m.error);
    if (m.error) bubble.appendChild(el('div', 'msg-error', m.error));
  }
  const think = row.querySelector('.think');
  if (m.reasoning) {
    if (think) {
      think.querySelector('.think-body').textContent = m.reasoning;
    } else {
      const det = el('details', 'think');
      det.appendChild(el('summary', '', '思考过程'));
      det.appendChild(el('div', 'think-body', m.reasoning));
      row.querySelector('.bubble-wrap')?.insertBefore(det, bubble);
    }
  }
  row.classList.toggle('streaming', !!streaming);
}

function scrollToBottom(force) {
  const main = $('chatMain');
  if (!main) return;
  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 160;
  if (force || nearBottom) main.scrollTop = main.scrollHeight;
}

function updateTokenHint() {
  const s = cur();
  const hint = $('tokenHint');
  if (!hint) return;
  if (!s || !s.messages.length) {
    hint.textContent = '';
    return;
  }
  const total = ccEstimateMessages([{ role: 'system', content: state.settings.systemPrompt }, ...s.messages]);
  hint.textContent = `上下文约 ${total.toLocaleString()} tokens`;
}

/* ---------------- 会话列表 ---------------- */

function renderSessions() {
  const box = $('sessionList');
  if (!box) return;
  box.replaceChildren();
  for (const s of state.sessions) {
    const item = el('div', 'session-item' + (s.id === state.currentId ? ' active' : ''));
    item.dataset.id = s.id;
    const title = el('div', 's-title', s.title || '新对话');
    const meta = el('div', 's-meta', `${s.messages.length} 条 · ${ccFormatTime(s.updatedAt)}`);
    const del = el('button', 's-del', '×');
    del.type = 'button';
    del.title = '删除会话';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });
    item.append(title, meta, del);
    item.addEventListener('click', () => switchSession(s.id));
    box.appendChild(item);
  }
  if (!state.sessions.length) box.appendChild(el('div', 's-empty', '还没有会话'));
}

/* ---------------- 发送 / 流式 ---------------- */

function buildRequestMessages(session) {
  const msgs = [];
  const sys = (state.settings.systemPrompt || '').trim();
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of session.messages) {
    if (m.role === 'system') {
      msgs.push({ role: 'system', content: m.content });
      continue;
    }
    if (!m.content) continue;
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

async function send(text) {
  const s = cur();
  if (!s || state.streaming) return;
  const content = String(text ?? '').trim();
  if (!content) return;

  s.messages.push({ id: newId(), role: 'user', content, time: nowMs() });
  if (s.title === '新对话') s.title = ccTruncate(content, 24);
  s.updatedAt = nowMs();
  persistSession(s);
  renderSessions();
  renderMessages();

  await runAssistant(s);
}

async function runAssistant(session) {
  const settings = state.settings;
  const asst = { id: newId(), role: 'assistant', content: '', reasoning: '', time: nowMs(), streaming: true };
  session.messages.push(asst);
  session.updatedAt = nowMs();
  renderMessages();

  state.streaming = true;
  state.controller = new AbortController();
  const stopBtn = $('stopBtn');
  const sendBtn = $('sendBtn');
  if (stopBtn) stopBtn.hidden = false;
  if (sendBtn) sendBtn.disabled = true;

  let lastPaint = 0;
  const paint = (force) => {
    const t = nowMs();
    if (!force && t - lastPaint < 60) return;
    lastPaint = t;
    updateMessageDom(asst, true);
    scrollToBottom(false);
  };

  try {
    if (!settings.apiKey) throw Object.assign(new Error('未填 API Key'), { status: 0, body: 'no-key' });
    const res = await ccStreamChat({
      base: settings.apiBase,
      apiKey: settings.apiKey,
      model: settings.modelName || 'deepseek-chat',
      // 最后一条 assistant 目前是空内容，会被 buildRequestMessages 跳过
      messages: buildRequestMessages(session),
      temperature: Number(settings.temperature),
      maxTokens: Number(settings.maxTokens) || 0,
      signal: state.controller.signal,
      onEvent: (ev) => {
        if (ev.type === 'content') {
          asst.content += ev.text;
          paint();
        } else if (ev.type === 'reasoning') {
          asst.reasoning += ev.text;
          paint();
        }
      },
    });
    asst.content = res.content || asst.content;
    asst.reasoning = res.reasoning || asst.reasoning;
    if (res.usage) asst.tokens = res.usage;
    if (res.aborted) asst.aborted = true;
    if (!asst.content) asst.content = asst.aborted ? '（已停止）' : '（模型没有返回内容）';
  } catch (err) {
    const msg = err?.status !== undefined ? explainError(err.status, err.body) : err?.message || String(err);
    asst.error = msg;
    if (!asst.content) asst.content = '（请求失败）';
    if (asst.reasoning) asst.reasoning = asst.reasoning;
  } finally {
    asst.streaming = false;
    delete asst.streaming;
    session.updatedAt = nowMs();
    persistSession(session);
    state.streaming = false;
    state.controller = null;
    if (stopBtn) stopBtn.hidden = true;
    if (sendBtn) sendBtn.disabled = false;
    updateMessageDom(asst, false);
    renderSessions();
    updateTokenHint();
    scrollToBottom(false);
  }
}

function lastUserText(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'user') return m.content;
  }
  return '';
}

function stopStreaming() {
  if (state.controller) state.controller.abort();
}

async function regenerate() {
  const s = cur();
  if (!s || state.streaming) return;
  while (s.messages.length && s.messages[s.messages.length - 1].role === 'assistant') s.messages.pop();
  if (!s.messages.length) return renderMessages();
  renderMessages();
  await runAssistant(s);
}

async function editMessage(id) {
  const s = cur();
  const m = s?.messages.find((x) => x.id === id);
  if (!m || m.role !== 'user') return;
  const next = prompt('编辑这条消息（保存后会截断它之后的内容并重新回答）：', m.content);
  if (next == null) return;
  const text = next.trim();
  if (!text) return;
  const idx = s.messages.findIndex((x) => x.id === id);
  s.messages = s.messages.slice(0, idx);
  s.messages.push({ id: newId(), role: 'user', content: text, time: nowMs() });
  s.updatedAt = nowMs();
  persistSession(s);
  renderMessages();
  await runAssistant(s);
}

function deleteMessage(id) {
  const s = cur();
  if (!s) return;
  s.messages = s.messages.filter((x) => x.id !== id);
  s.updatedAt = nowMs();
  persistSession(s);
  renderMessages();
}

async function copyMessage(id) {
  const s = cur();
  const m = s?.messages.find((x) => x.id === id);
  if (!m) return;
  try {
    await navigator.clipboard.writeText(m.content || '');
    toast('已复制');
  } catch {
    toast('复制失败，请手动选择', 'err');
  }
}

/* ---------------- 压缩 ---------------- */

async function compressContext() {
  const s = cur();
  if (!s || s.messages.length < 4) {
    toast('消息太少，不需要压缩');
    return;
  }
  if (!state.settings.apiKey) {
    toast('先填 API Key 才能压缩', 'err');
    openDlg('settingsDlg');
    return;
  }
  const before = ccEstimateMessages(s.messages);
  toast('正在压缩上下文…');
  try {
    const res = await ccCompressConversation({
      messages: s.messages,
      keepRecent: 6,
      llm: async (msgs) => {
        const r = await ccSimpleChat({
          base: state.settings.apiBase,
          apiKey: state.settings.apiKey,
          model: state.settings.modelName || 'deepseek-chat',
          messages: msgs,
          temperature: 0.3,
          maxTokens: 600,
        });
        return r.content;
      },
    });
    if (res.skipped) {
      toast('消息不多，无需压缩');
      return;
    }
    s.messages = res.messages.map((m) => ({ ...m, id: m.id || newId(), time: m.time || nowMs() }));
    s.updatedAt = nowMs();
    persistSession(s);
    renderMessages();
    const after = ccEstimateMessages(s.messages);
    toast(`已压缩 ${res.compressed} 条历史：约 ${before} → ${after} tokens`);
  } catch (err) {
    toast('压缩失败：' + (err?.message || err), 'err');
  }
}

/* ---------------- 对话框 ---------------- */

function openDlg(id) {
  const d = $(id);
  if (id === 'settingsDlg') ensureDangerZone();
  if (d && !d.open) d.showModal();
}

/** 设置面板底部的「清除本机数据」——不依赖模板，运行时插入 */
function ensureDangerZone() {
  const dlg = $('settingsDlg');
  if (!dlg || dlg.querySelector('#wipeBtn')) return;
  const wrap = document.createElement('div');
  wrap.className = 'dlg-danger';
  const note = document.createElement('p');
  note.className = 'dlg-note';
  note.textContent = 'API Key 与所有会话只存在这台设备的浏览器里（localStorage 明文）。公用电脑请用完清理。';
  const btn = document.createElement('button');
  btn.id = 'wipeBtn';
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = '清除本机数据（会话 + Key + 设置）';
  btn.addEventListener('click', () => {
    if (!confirm('清除后本机保存的所有会话、API Key 与设置都会删除，确定？')) return;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('dscc.v1.')) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {}
    location.reload();
  });
  wrap.append(note, btn);
  dlg.appendChild(wrap);
}

function closeDlg(id) {
  const d = $(id);
  if (d && d.open) d.close();
}

function fillSettingsForm() {
  const s = state.settings;
  $('apiBase').value = s.apiBase || '';
  $('apiKey').value = s.apiKey || '';
  $('temperature').value = String(s.temperature ?? 1);
  $('maxTokens').value = String(s.maxTokens ?? 0);

  const presetSel = $('modelPreset');
  presetSel.replaceChildren();
  for (const p of CC_MODEL_PRESETS) {
    const o = el('option', '', p.name);
    o.value = p.id;
    presetSel.appendChild(o);
  }
  presetSel.value = s.modelPreset || 'deepseek-chat';
  $('modelName').value = s.modelName || 'deepseek-chat';

  const promptSel = $('promptPreset');
  promptSel.replaceChildren();
  for (const p of PROMPT_PRESETS) {
    const o = el('option', '', p.name);
    o.value = p.id;
    promptSel.appendChild(o);
  }
  promptSel.value = s.promptPreset || 'default';
  $('systemPrompt').value = s.systemPrompt || '';
  $('testConnOut').textContent = '';
}

function saveSettingsFromForm() {
  const s = state.settings;
  s.apiBase = ccNormalizeBase($('apiBase').value);
  s.apiKey = $('apiKey').value.trim();
  s.modelPreset = $('modelPreset').value;
  s.modelName = $('modelName').value.trim() || 'deepseek-chat';
  s.temperature = Number($('temperature').value);
  s.maxTokens = Number($('maxTokens').value) || 0;
  s.promptPreset = $('promptPreset').value;
  s.systemPrompt = $('systemPrompt').value;
  persistSettings();
  refreshModelSelect();
  updateConnDot();
  toast('设置已保存');
  closeDlg('settingsDlg');
}

function refreshModelSelect() {
  const sel = $('modelSelect');
  if (!sel) return;
  sel.replaceChildren();
  const seen = new Set();
  for (const p of CC_MODEL_PRESETS) {
    if (p.id === 'custom') continue;
    const o = el('option', '', p.model);
    o.value = p.model;
    seen.add(p.model);
    sel.appendChild(o);
  }
  const currentModel = state.settings.modelName;
  if (currentModel && !seen.has(currentModel)) {
    const o = el('option', '', currentModel);
    o.value = currentModel;
    sel.appendChild(o);
  }
  sel.value = currentModel || 'deepseek-chat';
}

function updateConnDot() {
  const dot = $('connDot');
  if (!dot) return;
  const i = dot.querySelector('i') || dot.appendChild(document.createElement('i'));
  i.className = 'dot';
  if (!state.settings.apiKey) {
    i.dataset.state = 'off';
    dot.title = '未填 API Key';
  } else {
    i.dataset.state = 'ok';
    dot.title = '已填 API Key（' + ccNormalizeBase(state.settings.apiBase) + '）';
  }
}

async function testConnection() {
  const out = $('testConnOut');
  out.textContent = '测试中…';
  try {
    const base = ccNormalizeBase($('apiBase').value);
    const key = $('apiKey').value.trim();
    const model = $('modelName').value.trim() || 'deepseek-chat';
    if (!key) {
      out.textContent = '先填 API Key';
      return;
    }
    const r = await ccTestConnection({ base, apiKey: key, model });
    out.textContent = r.via === 'models' ? `连接正常，可用模型 ${r.models.length} 个` : '连接正常';
  } catch (err) {
    out.textContent = explainError(err?.status ?? 0, err?.body || err?.message);
  }
}

/* ---------------- 背景 / 头像 ---------------- */

const BG_PRESETS = [
  { id: 'aurora', name: '极光' },
  { id: 'grid', name: '网格' },
  { id: 'paper', name: '纸张' },
  { id: 'plain', name: '纯色' },
];

function fillBgPresets() {
  const box = $('bgPresets');
  if (!box) return;
  box.replaceChildren();
  for (const p of BG_PRESETS) {
    const b = el('button', 'bg-chip' + (state.settings.bg === p.id ? ' active' : ''), p.name);
    b.type = 'button';
    b.dataset.bg = p.id;
    b.addEventListener('click', () => {
      state.settings.bg = p.id;
      applyBackground();
      persistSettings();
      fillBgPresets();
    });
    box.appendChild(b);
  }
  const custom = el('button', 'bg-chip' + (state.settings.bg === 'custom' ? ' active' : ''), '自定义图片');
  custom.type = 'button';
  custom.dataset.bg = 'custom';
  custom.addEventListener('click', () => {
    state.settings.bg = 'custom';
    applyBackground();
    persistSettings();
    fillBgPresets();
  });
  box.appendChild(custom);
  $('bgDim').value = String(state.settings.bgDim ?? 45);
  $('bgBlur').value = String(state.settings.bgBlur ?? 0);
  $('bgUrl').value = state.settings.bgImage && !state.settings.bgImage.startsWith('data:') ? state.settings.bgImage : '';
}

async function fileToDataUrl(file, maxSide = 1600, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

async function handleBgFile(file) {
  if (!file) return;
  try {
    state.settings.bgImage = await fileToDataUrl(file, 1600, 0.85);
    state.settings.bg = 'custom';
    applyBackground();
    persistSettings();
    fillBgPresets();
    toast('背景已更新');
  } catch (err) {
    toast('图片读取失败：' + (err?.message || err), 'err');
  }
}

async function handleAvatarFile(role, file) {
  if (!file) return;
  try {
    const dataUrl = await fileToDataUrl(file, 160, 0.9);
    if (role === 'user') state.settings.selfAvatar = dataUrl;
    else state.settings.botAvatar = dataUrl;
    persistSettings();
    renderMessages();
    toast('头像已更新');
  } catch (err) {
    toast('图片读取失败：' + (err?.message || err), 'err');
  }
}

/* ---------------- 破甲 / 提示词 ---------------- */

function fillJailbreak() {
  const sel = $('jbList');
  if (!sel) return;
  sel.replaceChildren();
  for (const p of PROMPT_PRESETS) {
    const o = el('option', '', p.name);
    o.value = p.id;
    sel.appendChild(o);
  }
  const active = PROMPT_PRESETS.find((p) => p.id === (state.settings.promptPreset || 'default')) || PROMPT_PRESETS[0];
  sel.value = active.id;
  $('jbDesc').textContent = active.desc || '';
  $('jbText').value = state.settings.systemPrompt || active.text;
}

function applyJailbreak() {
  const id = $('jbList').value;
  const preset = PROMPT_PRESETS.find((p) => p.id === id);
  const text = $('jbText').value.trim() || preset?.text || '';
  state.settings.promptPreset = id;
  state.settings.systemPrompt = text;
  persistSettings();
  const sys = $('systemPrompt');
  if (sys) sys.value = text;
  toast('已应用提示词：' + (preset?.name || id));
  closeDlg('jailbreakDlg');
  updateTokenHint();
}

/* ---------------- 导入 / 导出 ---------------- */

function importLog(msg, kind) {
  const box = $('importLog');
  if (!box) return;
  box.appendChild(el('div', 'import-line' + (kind ? ' ' + kind : ''), msg));
  box.scrollTop = box.scrollHeight;
}

async function importFile(file) {
  if (!file) return;
  importLog(`读取 ${file.name}（${(file.size / 1024).toFixed(0)} KB）`);
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.zip')) {
      if (typeof openZip !== 'function') throw new Error('zip 模块缺失');
      const zip = await openZip(file);
      const paths = zip.entries.map((e) => e.path);
      const kind = ccDetectImport({ isZip: true, paths });
      if (kind === 'deepseek-zip') {
        const idx = paths.filter((p) => /^chat_sessions\/[^/]+\.json$/.test(p));
        importLog(`识别为 DeepSeek 导出包，共 ${idx.length} 个会话`, 'ok');
        let added = 0;
        for (const p of idx) {
          const raw = JSON.parse(new TextDecoder().decode(await zip.read(p)));
          const ds = parseDeepSeekSession(raw);
          if (!ds.messages.length) continue;
          const session = ccImportFromDeepSeek(ds);
          state.sessions.unshift(session);
          persistSession(session);
          added++;
        }
        importLog(`已导入 ${added} 个会话`, 'ok');
        state.currentId = state.sessions[0]?.id || state.currentId;
      } else if (kind === 'chatbox-zip') {
        const sess = paths.filter((p) => /^sessions\/[^/]+\/session\.json$/.test(p));
        importLog(`识别为 Chatbox 备份，共 ${sess.length} 个会话`, 'ok');
        for (const p of sess) {
          const obj = JSON.parse(new TextDecoder().decode(await zip.read(p)));
          const session = ccImportFromChatbox(obj);
          state.sessions.unshift(session);
          persistSession(session);
        }
        importLog(`已导入 ${sess.length} 个会话`, 'ok');
        state.currentId = state.sessions[0]?.id || state.currentId;
      } else {
        throw new Error('这个 zip 里没找到 chat_sessions/ 或 sessions/*/session.json');
      }
      renderSessions();
      renderMessages();
      return;
    }

    const text = await file.text();
    const kind = ccDetectImport({ name: file.name, text });
    importLog('识别类型：' + kind);
    if (kind === 'markdown') {
      const ds = parseMarkdownConversation(text, { fileName: file.name });
      if (!ds.messages.length) throw new Error('没有解析到消息');
      const session = ccImportFromDeepSeek(ds);
      state.sessions.unshift(session);
      persistSession(session);
      state.currentId = session.id;
    } else if (kind === 'client') {
      const list = ccImportFromClientJson(JSON.parse(text));
      for (const s of list) {
        state.sessions.unshift(s);
        persistSession(s);
      }
      state.currentId = state.sessions[0]?.id || state.currentId;
      importLog(`已导入 ${list.length} 个会话`, 'ok');
    } else if (kind === 'chatbox-session') {
      const session = ccImportFromChatbox(JSON.parse(text));
      state.sessions.unshift(session);
      persistSession(session);
      state.currentId = session.id;
    } else {
      throw new Error('无法识别的文件格式');
    }
    renderSessions();
    renderMessages();
    importLog('导入完成', 'ok');
  } catch (err) {
    importLog('失败：' + (err?.message || err), 'err');
  }
}

function download(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function exportCurrent() {
  const s = cur();
  if (!s || !s.messages.length) {
    toast('当前会话是空的');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  download(ccSessionToMarkdown(s), `${(s.title || 'chat').slice(0, 30)}-${stamp}.md`, 'text/markdown');
  download(ccSessionToJson(s), `${(s.title || 'chat').slice(0, 30)}-${stamp}.json`, 'application/json');
  toast('已导出 Markdown 与 JSON');
}

/* ---------------- 抽屉 / 设备 ---------------- */

function openDrawer() {
  document.body.classList.add('drawer-open');
}
function closeDrawer() {
  document.body.classList.remove('drawer-open');
}

const DEVINFO = window.__DS2CB_DEVICE__ || null;
let deviceTimer = null;

/** 按 device.js 的判定刷新 <html data-device>：窗口缩放 / 旋转 / 分屏 / 键盘弹出都会触发 */
function applyDeviceUi() {
  if (DEVINFO && typeof DEVINFO.detect === 'function') {
    const d = DEVINFO.detect();
    if (d !== document.documentElement.getAttribute('data-device')) {
      document.documentElement.setAttribute('data-device', d);
    }
    DEVINFO.current = d;
  }
  document.body.dataset.device = document.documentElement.getAttribute('data-device') || 'desktop';
}

function scheduleDevice() {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(applyDeviceUi, 120);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('menuBtn')?.addEventListener('click', openDrawer);
  $('drawerClose')?.addEventListener('click', closeDrawer);
  $('scrim')?.addEventListener('click', closeDrawer);

  $('newChatBtn')?.addEventListener('click', () => {
    createSession();
    closeDrawer();
    $('input')?.focus();
  });

  $('themeBtn')?.addEventListener('click', () => {
    const order = ['dark', 'light', 'system'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    state.settings.theme = next;
    applyTheme();
    persistSettings();
    toast('主题：' + (next === 'system' ? '跟随系统' : next === 'light' ? '浅色' : '深色'));
  });

  $('bgBtn')?.addEventListener('click', () => {
    fillBgPresets();
    openDlg('bgDlg');
  });
  $('closeBgBtn')?.addEventListener('click', () => closeDlg('bgDlg'));
  $('bgUploadBtn')?.addEventListener('click', () => $('bgFile')?.click());
  $('bgFile')?.addEventListener('change', (e) => handleBgFile(e.target.files?.[0]));
  $('bgUrl')?.addEventListener('change', (e) => {
    const url = e.target.value.trim();
    state.settings.bgImage = url;
    state.settings.bg = url ? 'custom' : state.settings.bg;
    applyBackground();
    persistSettings();
  });
  $('bgDim')?.addEventListener('input', (e) => {
    state.settings.bgDim = Number(e.target.value);
    applyBackground();
    persistSettings();
  });
  $('bgBlur')?.addEventListener('input', (e) => {
    state.settings.bgBlur = Number(e.target.value);
    applyBackground();
    persistSettings();
  });
  $('bgResetBtn')?.addEventListener('click', () => {
    state.settings.bg = 'aurora';
    state.settings.bgImage = '';
    state.settings.bgDim = 45;
    state.settings.bgBlur = 0;
    applyBackground();
    persistSettings();
    fillBgPresets();
  });

  $('avatarBtn')?.addEventListener('click', () => {
    $('selfEmoji').value = state.settings.selfEmoji || '';
    $('botEmoji').value = state.settings.botEmoji || '';
    if ($('selfName')) $('selfName').value = state.settings.selfName || '我';
    if ($('botName')) $('botName').value = state.settings.botName || 'DeepSeek';
    openDlg('avatarDlg');
  });
  $('closeAvatarBtn')?.addEventListener('click', () => {
    state.settings.selfEmoji = $('selfEmoji').value.trim() || '🙂';
    state.settings.botEmoji = $('botEmoji').value.trim() || '🐳';
    if ($('selfName')) state.settings.selfName = $('selfName').value.trim() || '我';
    if ($('botName')) state.settings.botName = $('botName').value.trim() || 'DeepSeek';
    persistSettings();
    renderMessages();
    closeDlg('avatarDlg');
  });
  $('selfAvatarBtn')?.addEventListener('click', () => $('selfAvatarFile')?.click());
  $('botAvatarBtn')?.addEventListener('click', () => $('botAvatarFile')?.click());
  $('selfAvatarFile')?.addEventListener('change', (e) => handleAvatarFile('user', e.target.files?.[0]));
  $('botAvatarFile')?.addEventListener('change', (e) => handleAvatarFile('bot', e.target.files?.[0]));

  $('settingsBtn')?.addEventListener('click', () => {
    fillSettingsForm();
    openDlg('settingsDlg');
  });
  $('closeSettingsBtn')?.addEventListener('click', () => closeDlg('settingsDlg'));
  $('saveSettingsBtn')?.addEventListener('click', saveSettingsFromForm);
  $('testConnBtn')?.addEventListener('click', testConnection);
  $('modelPreset')?.addEventListener('change', (e) => {
    const p = CC_MODEL_PRESETS.find((x) => x.id === e.target.value);
    if (p && p.model) $('modelName').value = p.model;
  });
  $('promptPreset')?.addEventListener('change', (e) => {
    const p = PROMPT_PRESETS.find((x) => x.id === e.target.value);
    if (p) $('systemPrompt').value = p.text;
  });

  $('helpBtn')?.addEventListener('click', () => {
    const body = $('helpBody');
    if (body && !body.childElementCount) body.innerHTML = HELP_HTML;
    openDlg('helpDlg');
  });
  $('closeHelpBtn')?.addEventListener('click', () => closeDlg('helpDlg'));

  $('jailbreakBtn')?.addEventListener('click', () => {
    fillJailbreak();
    openDlg('jailbreakDlg');
  });
  $('closeJbBtn')?.addEventListener('click', () => closeDlg('jailbreakDlg'));
  $('jbApplyBtn')?.addEventListener('click', applyJailbreak);
  $('jbSaveBtn')?.addEventListener('click', () => {
    const text = $('jbText').value.trim();
    if (!text) return toast('内容为空', 'err');
    state.settings.systemPrompt = text;
    persistSettings();
    toast('已保存为当前提示词');
  });
  $('jbList')?.addEventListener('change', (e) => {
    const p = PROMPT_PRESETS.find((x) => x.id === e.target.value);
    if (p) {
      $('jbDesc').textContent = p.desc || '';
      $('jbText').value = p.text;
    }
  });

  $('importBtn')?.addEventListener('click', () => {
    openDlg('importDlg');
    closeDrawer();
  });
  $('closeImportBtn')?.addEventListener('click', () => closeDlg('importDlg'));
  $('importPickBtn')?.addEventListener('click', () => $('importFile')?.click());
  $('importFile')?.addEventListener('change', (e) => importFile(e.target.files?.[0]));
  const drop = $('importDrop');
  if (drop) {
    ['dragenter', 'dragover'].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.add('hot');
      })
    );
    ['dragleave', 'drop'].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.remove('hot');
      })
    );
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) importFile(f);
    });
    drop.addEventListener('click', () => $('importFile')?.click());
  }

  $('exportBtn')?.addEventListener('click', exportCurrent);
  $('compressBtn')?.addEventListener('click', compressContext);
  $('clearBtn')?.addEventListener('click', () => {
    const s = cur();
    if (!s || !s.messages.length) return;
    if (!confirm('清空当前会话的所有消息？')) return;
    s.messages = [];
    s.title = '新对话';
    s.updatedAt = nowMs();
    persistSession(s);
    renderMessages();
    renderSessions();
  });

  $('sendBtn')?.addEventListener('click', () => {
    const ta = $('input');
    const v = ta.value;
    ta.value = '';
    autoGrow(ta);
    send(v);
  });
  $('stopBtn')?.addEventListener('click', stopStreaming);
  $('input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('sendBtn')?.click();
    }
  });
  $('input')?.addEventListener('input', (e) => autoGrow(e.target));

  $('modelSelect')?.addEventListener('change', (e) => {
    state.settings.modelName = e.target.value;
    state.settings.modelPreset = CC_MODEL_PRESETS.find((p) => p.model === e.target.value)?.id || 'custom';
    persistSettings();
    toast('模型：' + e.target.value);
  });

  const main = $('chatMain');
  main?.addEventListener('scroll', () => {
    const btn = $('scrollBottomBtn');
    if (!btn) return;
    const near = main.scrollHeight - main.scrollTop - main.clientHeight < 200;
    btn.hidden = near;
  });
  $('scrollBottomBtn')?.addEventListener('click', () => scrollToBottom(true));

  // 消息操作（事件委托）
  $('messages')?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.msg-actions button');
    if (!btn) return;
    const row = btn.closest('.msg');
    const id = row?.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;
    if (act === 'copy') copyMessage(id);
    else if (act === 'edit') editMessage(id);
    else if (act === 'regen') regenerate();
    else if (act === 'del') deleteMessage(id);
  });

  // 软键盘 / 视口变化
  if (window.visualViewport) {
    const fix = () => {
      document.documentElement.style.setProperty('--vvh', window.visualViewport.height + 'px');
    };
    visualViewport.addEventListener('resize', fix);
    fix();
  }

  window.addEventListener('resize', scheduleDevice, { passive: true });
  window.addEventListener('orientationchange', scheduleDevice, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleDevice, { passive: true });
  window.addEventListener('beforeunload', persistSettings);
}

function autoGrow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
}

/* ---------------- 启动 ---------------- */

function boot() {
  loadAll();
  applyTheme();
  applyBackground();
  applyDeviceUi();
  refreshModelSelect();
  fillSettingsForm();
  updateConnDot();
  renderSessions();
  renderMessages();
  bindEvents();
  if (!state.settings.apiKey) {
    setTimeout(() => {
      toast('还没填 API Key，点右上角 ⚙ 设置', 'err');
    }, 600);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* 供自动化测试 */
globalThis.__DSCC__ = {
  state,
  send,
  compressContext,
  importFile,
  exportCurrent,
  boot,
  ccEstimateMessages,
};
