/* ================= DeepSeek 小客户端 =================
 * 纯前端：自填 API 地址与 Key，流式对话，可换背景，会话存本机。
 * 不依赖任何第三方库，所有请求只发往用户填写的 API 地址。
 */

const LS_SETTINGS = 'ds2cb.chat.settings.v1';
const LS_SESSIONS = 'ds2cb.chat.sessions.v1';

const $ = (id) => document.getElementById(id);
const now = () => Date.now();

const PRESETS = {
  ocean: { label: '深海', css: 'linear-gradient(180deg, #071a26, #0a2d3e 55%, #06141d)' },
  forest: { label: '森林', css: 'radial-gradient(900px 620px at 22% 8%, #16382c, transparent 60%), #09130f' },
  sunset: { label: '日落', css: 'linear-gradient(160deg, #2b1b2e 0%, #4a2233 46%, #6b2f2a 100%)' },
  paper: { label: '暖纸', css: 'linear-gradient(160deg, #241d15, #2f2418 58%, #191309)' },
  night: { label: '纯黑', css: 'linear-gradient(#0b0f16, #0b0f16)' },
  aurora: {
    label: '极光',
    css: 'radial-gradient(1100px 700px at 12% -8%, #1b2f52, transparent 62%), radial-gradient(900px 620px at 88% 8%, #23405f, transparent 58%), #0b0f16',
  },
};

/** 允许用 key 或中文 label 指定预设 */
function resolvePreset(value) {
  if (!value) return { key: 'aurora', ...PRESETS.aurora };
  if (PRESETS[value]) return { key: value, ...PRESETS[value] };
  const hit = Object.entries(PRESETS).find(([, v]) => v.label === value);
  if (hit) return { key: hit[0], ...hit[1] };
  return { key: 'aurora', ...PRESETS.aurora };
}

const DEFAULT_SETTINGS = {
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: '',
  temperature: 0.7,
  background: { type: 'preset', value: 'aurora', blur: 0, dim: 45 },
  currentId: null,
};

const WORKER_SNIPPET = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
      }});
    }
    const target = 'https://api.deepseek.com' + url.pathname + url.search;
    const resp = await fetch(target, {
      method: request.method,
      headers: { 'content-type': 'application/json', authorization: request.headers.get('authorization') || '' },
      body: request.method === 'GET' ? undefined : await request.text(),
    });
    const out = new Response(resp.body, resp);
    out.headers.set('Access-Control-Allow-Origin', '*');
    return out;
  }
}`;

/* ---------------- 状态 ---------------- */

let settings = loadSettings();
let sessions = loadSessions();
let currentId = settings.currentId && sessions.some((s) => s.id === settings.currentId)
  ? settings.currentId
  : (sessions[0] ? sessions[0].id : null);
let sending = false;
let aborter = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(DEFAULT_SETTINGS), ...parsed, background: { ...DEFAULT_SETTINGS.background, ...(parsed.background || {}) } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch (e) {
    toast('设置保存失败（本机存储可能已满）', 'err');
  }
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(LS_SESSIONS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSessions() {
  try {
    localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
  } catch (e) {
    toast('会话保存失败（本机存储可能已满）', 'err');
  }
}

function currentSession() {
  return sessions.find((s) => s.id === currentId) || null;
}

function ensureSession() {
  let s = currentSession();
  if (!s) {
    s = { id: 's' + now().toString(36) + Math.random().toString(36).slice(2, 7), title: '新对话', createdAt: now(), updatedAt: now(), messages: [] };
    sessions.unshift(s);
    currentId = s.id;
    settings.currentId = s.id;
    saveSettings();
    saveSessions();
  }
  return s;
}

/* ---------------- 提示 ---------------- */

let toastTimer = null;
function toast(text, kind = '') {
  const el = $('status');
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(text));
  el.hidden = false;
  clearTimeout(toastTimer);
  if (kind !== 'err') toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function htmlNotice(parts) {
  const el = $('status');
  el.className = 'status err';
  el.innerHTML = '';
  for (const p of parts) {
    if (typeof p === 'string') el.appendChild(document.createTextNode(p));
    else el.appendChild(p);
  }
  el.hidden = false;
}

function codeEl(text) {
  const c = document.createElement('code');
  c.textContent = text;
  return c;
}

/* ---------------- 渲染消息 ---------------- */

function renderContent(el, text) {
  el.textContent = '';
  const parts = String(text || '').split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      pre.textContent = part.replace(/^[a-zA-Z0-9+#._-]*\n/, '');
      el.appendChild(pre);
    } else if (part) {
      const span = document.createElement('span');
      span.textContent = part;
      el.appendChild(span);
    }
  });
}

function timeLabel(ts) {
  const d = new Date(ts || now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildMessageEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'user' : 'assistant');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.role === 'assistant' && (msg.reasoning || msg.streamingReasoning)) {
    const det = document.createElement('details');
    det.className = 'reasoning';
    const sum = document.createElement('summary');
    sum.textContent = '思考过程';
    const body = document.createElement('div');
    body.className = 'r-body';
    body.textContent = msg.reasoning || '';
    det.append(sum, body);
    if (!msg.reasoning) det.open = true;
    bubble.appendChild(det);
    msg.__reasoningEl = body;
  }

  const content = document.createElement('div');
  content.className = 'content';
  renderContent(content, msg.content || '');
  bubble.appendChild(content);
  msg.__contentEl = content;

  if (msg.role === 'assistant' && !msg.content && msg.streaming) {
    const caret = document.createElement('span');
    caret.className = 'typing';
    content.appendChild(caret);
    msg.__caret = caret;
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = timeLabel(msg.time);
  bubble.appendChild(time);

  wrap.appendChild(bubble);
  return wrap;
}

function renderMessages() {
  const wrap = $('messages');
  wrap.textContent = '';
  const s = currentSession();
  const msgs = s ? s.messages : [];

  if (!msgs.length) {
    wrap.appendChild(buildWelcome());
    return;
  }
  for (const m of msgs) wrap.appendChild(buildMessageEl(m));
  scrollToBottom(true);
}

function buildWelcome() {
  const box = document.createElement('div');
  box.className = 'welcome';

  const h = document.createElement('h1');
  h.textContent = '开始聊天';
  const p = document.createElement('p');
  const hasKey = Boolean(settings.apiKey);
  p.textContent = hasKey
    ? `当前模型：${settings.model || 'deepseek-chat'} · 会话只保存在本机`
    : '先在「设置」里填上 API 地址与 Key，就能开始了';
  box.append(h, p);

  const chips = document.createElement('div');
  chips.className = 'chips';
  const samples = ['用一句话解释量子纠缠', '帮我写一个 Python 快速排序', '把这段话改得更简洁：…'];
  for (const text of samples) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = text;
    b.onclick = () => {
      $('input').value = text;
      autoGrow();
      $('input').focus();
    };
    chips.appendChild(b);
  }
  box.appendChild(chips);

  if (!hasKey) {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.style.marginTop = '18px';
    btn.textContent = '去填 API 地址与 Key';
    btn.onclick = () => openDrawer('settings');
    box.appendChild(btn);
  }
  return box;
}

function scrollToBottom(force = false) {
  const el = $('messages');
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (force || near) el.scrollTop = el.scrollHeight;
}

function updateSelStat() {
  const n = currentSession()?.messages.length || 0;
  document.title = n ? `DeepSeek 小客户端 · ${currentSession().title}` : 'DeepSeek 小客户端';
}

/* ---------------- 背景 ---------------- */

function applyBackground(bg = settings.background) {
  const layer = $('bg');
  const body = document.body;
  const b = { ...DEFAULT_SETTINGS.background, ...(bg || {}) };

  let presetKey = null;
  if (b.type === 'url' && b.value) {
    const url = `url("${String(b.value).replace(/"/g, '%22')}")`;
    layer.style.background = '#0b0f16';
    layer.style.backgroundImage = url;
    layer.style.backgroundSize = 'cover';
    layer.style.backgroundPosition = 'center';
    layer.style.backgroundRepeat = 'no-repeat';
    // body 上也写一份：主题/外部工具有个统一读取点，视觉由 #bg 层负责模糊与遮罩
    body.style.backgroundColor = '#0b0f16';
    body.style.backgroundImage = url;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
  } else {
    const preset = resolvePreset(b.value);
    presetKey = preset.key;
    layer.style.backgroundImage = preset.css;
    layer.style.backgroundSize = '';
    layer.style.backgroundPosition = '';
    layer.style.background = preset.css;
    body.style.backgroundColor = '#0b0f16';
    body.style.backgroundImage = preset.css;
  }

  const blur = Number(b.blur) || 0;
  const dim = Number(b.dim) || 0;
  document.documentElement.style.setProperty('--blur', `${blur}px`);
  document.documentElement.style.setProperty('--dim', String(dim / 100));
  // 别名：方便外部工具/脚本按统一名字读取
  document.documentElement.style.setProperty('--bg-blur', `${blur}px`);
  document.documentElement.style.setProperty('--bg-dim', String(dim / 100));

  // 同步控件
  const blurInput = $('bgBlur');
  if (blurInput) {
    blurInput.value = String(blur);
    $('bgBlurVal').textContent = `${blur}px`;
  }
  const dimInput = $('bgDim');
  if (dimInput) {
    dimInput.value = String(dim);
    $('bgDimVal').textContent = `${dim}%`;
  }
  document.querySelectorAll('.bg-preset').forEach((el) => {
    el.classList.toggle('sel', b.type !== 'url' && el.dataset.key === (presetKey || resolvePreset(b.value).key));
  });
  const urlInput = $('bgUrl');
  if (urlInput && b.type === 'url' && !String(b.value).startsWith('data:')) urlInput.value = b.value;
}

function setBackground(next) {
  settings.background = { ...settings.background, ...next };
  saveSettings();
  applyBackground();
}

function buildPresets() {
  const box = $('bgPresets');
  box.textContent = '';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const el = document.createElement('button');
    el.className = 'bg-preset';
    el.type = 'button';
    el.dataset.key = key;
    el.style.background = preset.css;
    const label = document.createElement('span');
    label.textContent = preset.label;
    el.appendChild(label);
    el.onclick = () => setBackground({ type: 'preset', value: key });
    box.appendChild(el);
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        URL.revokeObjectURL(url);
        resolve(dataUrl);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

/* ---------------- 设置抽屉同步 ---------------- */

function syncSettingsForm() {
  $('baseURL').value = settings.baseURL || '';
  $('apiKey').value = settings.apiKey || '';
  $('model').value = settings.model || '';
  $('systemPrompt').value = settings.systemPrompt || '';
  $('temperature').value = String(settings.temperature ?? 0.7);
  applyBackground();
}

function readSettingsForm() {
  return {
    baseURL: $('baseURL').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'deepseek-chat',
    systemPrompt: $('systemPrompt').value,
    temperature: Math.max(0, Math.min(2, Number($('temperature').value) || 0.7)),
  };
}

function applySettings(patch) {
  settings = { ...settings, ...patch, background: { ...settings.background, ...(patch.background || {}) } };
  saveSettings();
  syncSettingsForm();
  applyBackground();
  if (!(currentSession()?.messages.length)) renderMessages();
}

/* ---------------- API ---------------- */

function endpointFor(baseURL) {
  let base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!base) base = 'https://api.deepseek.com';
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

function modelsEndpoint(baseURL) {
  const e = endpointFor(baseURL);
  return e.replace(/\/chat\/completions$/i, '/models');
}

function buildRequestBody(messages) {
  const out = [];
  if (settings.systemPrompt && settings.systemPrompt.trim()) {
    out.push({ role: 'system', content: settings.systemPrompt.trim() });
  }
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') out.push({ role: m.role, content: m.content || '' });
  }
  return {
    model: settings.model || 'deepseek-chat',
    messages: out,
    stream: true,
    temperature: Number(settings.temperature ?? 0.7),
  };
}

function describeNetworkError(err) {
  if (err && err.name === 'AbortError') return null;
  const isFile = location.protocol === 'file:';
  const nodes = [];
  nodes.push('请求没发出去或连接被中断（' + (err?.message || err) + '）。');
  nodes.push('常见原因：① 浏览器跨域（CORS）被拦——请填写支持跨域的中转地址；② 地址写错；③ 网络不通。');
  if (isFile) nodes.push('当前是本地文件打开（file://），部分浏览器会限制跨域请求，可换成本地 http 方式打开。');
  return nodes;
}

async function send(text) {
  if (sending) return;
  const input = $('input');
  const content = String(text !== undefined ? text : input.value).trim();
  if (!content) return;

  if (!settings.apiKey) {
    toast('还没填 API Key —— 点右上角 ⚙ 设置', 'err');
    openDrawer('settings');
    return;
  }

  const s = ensureSession();
  s.messages.push({ id: 'm' + now().toString(36), role: 'user', content, time: now() });
  s.title = s.title === '新对话' ? content.slice(0, 20) : s.title;
  s.updatedAt = now();
  if (text === undefined) {
    input.value = '';
    autoGrow();
  }

  const reply = {
    id: 'm' + (now() + 1).toString(36),
    role: 'assistant',
    content: '',
    reasoning: '',
    time: now(),
    streaming: true,
  };
  s.messages.push(reply);
  saveSessions();
  renderMessages();
  updateSelStat();

  const contentEl = reply.__contentEl;
  const reasoningEl = reply.__reasoningEl;
  const caret = reply.__caret;

  sending = true;
  setComposerBusy(true);
  aborter = new AbortController();

  let buffer = '';
  let finished = false;
  const timer = { raf: 0 };
  const paint = () => {
    if (timer.raf) return;
    timer.raf = requestAnimationFrame(() => {
      timer.raf = 0;
      if (contentEl) renderContent(contentEl, reply.content);
      if (reasoningEl) reasoningEl.textContent = reply.reasoning;
      if (caret && reply.content) {
        caret.remove();
        reply.__caret = null;
      }
      scrollToBottom();
    });
  };

  try {
    const resp = await fetch(endpointFor(settings.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(s.messages.slice(0, -1))),
      signal: aborter.signal,
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status, bodyText });
    }
    if (!resp.body) throw new Error('接口没有返回可读取的流（可能不是 OpenAI 兼容格式）');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          finished = true;
          break;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta || json.choices?.[0]?.message || {};
          if (delta.reasoning_content) {
            reply.reasoning += delta.reasoning_content;
            paint();
          }
          if (typeof delta.content === 'string' && delta.content) {
            reply.content += delta.content;
            paint();
          }
        } catch {
          /* 单行解析失败不影响后续 */
        }
      }
      scrollToBottom();
    }
    reply.streaming = false;
    reply.time = now();
    s.updatedAt = now();
    saveSessions();
    if (contentEl) renderContent(contentEl, reply.content);
    if (timer.raf) cancelAnimationFrame(timer.raf);
    renderMessages();
  } catch (err) {
    reply.streaming = false;
    const status = err?.status;
    if (err?.name === 'AbortError') {
      reply.content += reply.content ? '\n\n（已停止）' : '（已停止）';
      toast('已停止生成');
    } else if (status === 401 || status === 403) {
      reply.content = reply.content || '（认证失败）';
      htmlNotice([`认证失败（HTTP ${status}）：API Key 无效或没有权限。`, ' ', codeEl('设置 → API Key'), ' 里检查一下。']);
    } else if (status === 404) {
      reply.content = reply.content || '（接口地址不对）';
      htmlNotice([`接口返回 404：地址可能不对。当前请求的是 `, codeEl(endpointFor(settings.baseURL)), '，请确认 baseURL 是否需要带 ', codeEl('/v1'), '。']);
    } else if (status === 429) {
      htmlNotice(['请求过于频繁（HTTP 429），稍等一会儿再试。']);
    } else if (status >= 500) {
      htmlNotice([`服务端错误（HTTP ${status}），可能稍后恢复；也可以换个中转地址。`]);
    } else if (status) {
      htmlNotice([`请求失败（HTTP ${status}）。`]);
    } else {
      htmlNotice(describeNetworkError(err));
      showCorsNotice(true);
    }
    s.updatedAt = now();
    saveSessions();
    renderMessages();
  } finally {
    sending = false;
    setComposerBusy(false);
    aborter = null;
    updateSelStat();
    $('input').focus();
  }
}

function setComposerBusy(on) {
  $('sendBtn').disabled = on;
  $('stopBtn').hidden = !on;
  $('input').disabled = false;
  $('sendBtn').hidden = on;
}

function stop() {
  if (aborter) aborter.abort();
}

function showCorsNotice(on) {
  const el = $('corsNotice');
  if (el) el.hidden = !on;
}

async function testConnection() {
  const patch = readSettingsForm();
  if (!patch.apiKey) {
    toast('先填 API Key 再测试', 'err');
    return;
  }
  toast('正在测试…');
  try {
    const resp = await fetch(modelsEndpoint(patch.baseURL), {
      headers: { Authorization: `Bearer ${patch.apiKey}` },
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    if (resp.ok) {
      toast('连接正常 ✓ 可以开始聊天了');
      showCorsNotice(false);
    } else if (resp.status === 401 || resp.status === 403) {
      toast(`密钥无效（HTTP ${resp.status}）`, 'err');
    } else if (resp.status === 404) {
      toast('地址不对（404）：确认 baseURL 是否要带 /v1', 'err');
      showCorsNotice(false);
    } else {
      toast(`接口返回 HTTP ${resp.status}`, 'err');
    }
  } catch (err) {
    htmlNotice(describeNetworkError(err));
    showCorsNotice(true);
  }
}

/* ---------------- 会话列表 ---------------- */

function renderSessions() {
  const box = $('sessionsList');
  box.textContent = '';
  if (!sessions.length) {
    const p = document.createElement('div');
    p.className = 'empty-tip';
    p.textContent = '还没有会话';
    box.appendChild(p);
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === currentId ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'st';
    info.textContent = s.title || '新对话';
    const meta = document.createElement('div');
    meta.className = 'sd';
    meta.textContent = `${s.messages.length} 条 · ${new Date(s.updatedAt).toLocaleDateString()}`;
    const left = document.createElement('div');
    left.style.minWidth = '0';
    left.style.flex = '1';
    left.append(info, meta);

    item.appendChild(left);

    const del = document.createElement('button');
    del.className = 'session-del';
    del.textContent = '✕';
    del.title = '删除';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    };
    item.appendChild(del);

    item.onclick = () => {
      currentId = s.id;
      settings.currentId = s.id;
      saveSettings();
      renderMessages();
      updateSelStat();
      renderSessions();
      closeDrawers();
    };
    box.appendChild(item);
  }
}

function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);
  if (currentId === id) {
    currentId = sessions[0] ? sessions[0].id : null;
    settings.currentId = currentId;
    saveSettings();
  }
  saveSessions();
  renderMessages();
  renderSessions();
  updateSelStat();
}

function newChat() {
  const s = { id: 's' + now().toString(36) + Math.random().toString(36).slice(2, 7), title: '新对话', createdAt: now(), updatedAt: now(), messages: [] };
  sessions.unshift(s);
  currentId = s.id;
  settings.currentId = s.id;
  saveSettings();
  saveSessions();
  renderMessages();
  renderSessions();
  updateSelStat();
  closeDrawers();
  $('input').focus();
}

/* ---------------- 抽屉 ---------------- */

function openDrawer(which) {
  closeDrawers();
  const el = $(which);
  if (!el) return;
  el.hidden = false;
  $('scrim').hidden = false;
  if (which === 'settings') syncSettingsForm();
  if (which === 'sessions') renderSessions();
}

function closeDrawers() {
  $('settings').hidden = true;
  $('sessions').hidden = true;
  $('scrim').hidden = true;
}

/* ---------------- 迭代输入框高度 ---------------- */

function autoGrow() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(132, el.scrollHeight) + 'px';
}

/* ---------------- 视口高度（移动端键盘） ---------------- */

function syncViewportHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('sendBtn').onclick = () => send();
  $('stopBtn').onclick = () => stop();
  $('newChatBtn').onclick = () => newChat();
  $('newChatBtn2').onclick = () => newChat();
  $('sessionsBtn').onclick = () => openDrawer('sessions');
  $('settingsBtn').onclick = () => openDrawer('settings');
  $('openSettingsLink').onclick = () => openDrawer('settings');
  $('sessionsClose').onclick = () => closeDrawers();
  $('settingsClose').onclick = () => closeDrawers();
  $('scrim').onclick = () => closeDrawers();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawers();
    if (e.key === 'Enter' && !e.shiftKey && document.activeElement === $('input')) {
      if (window.matchMedia('(pointer: coarse)').matches) return;
      e.preventDefault();
      send();
    }
  });

  $('input').addEventListener('input', autoGrow);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      send();
    }
  });

  $('saveSettings').onclick = () => {
    settings = { ...settings, ...readSettingsForm() };
    settings.currentId = currentId;
    saveSettings();
    syncSettingsForm();
    toast('已保存');
    showCorsNotice(false);
    renderMessages();
  };
  $('toggleKey').onclick = () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('toggleKey').textContent = el.type === 'password' ? '显示' : '隐藏';
  };
  $('testConn').onclick = () => testConnection();

  $('bgUrlApply').onclick = () => {
    const url = $('bgUrl').value.trim();
    if (!url) return;
    setBackground({ type: 'url', value: url });
    toast('背景已更新');
  };
  $('bgFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('正在处理图片…');
      const dataUrl = await compressImage(file);
      if (dataUrl.length > 2_200_000) {
        toast('图片太大，已压缩仍超过本机存储上限，换一张小一点的', 'err');
        return;
      }
      setBackground({ type: 'url', value: dataUrl });
      toast('背景已更新');
    } catch (err) {
      toast('图片读取失败：' + (err?.message || err), 'err');
    }
  };
  $('bgReset').onclick = () => {
    setBackground({ type: 'preset', value: 'aurora', blur: 0, dim: 45 });
    $('bgUrl').value = '';
    toast('已恢复默认背景');
  };
  $('bgBlur').oninput = (e) => setBackground({ blur: Number(e.target.value) });
  $('bgDim').oninput = (e) => setBackground({ dim: Number(e.target.value) });

  $('clearAll').onclick = () => {
    if (!confirm('确定清除本机保存的会话、API Key 和背景设置？')) return;
    localStorage.removeItem(LS_SETTINGS);
    localStorage.removeItem(LS_SESSIONS);
    settings = structuredClone(DEFAULT_SETTINGS);
    sessions = [];
    currentId = null;
    syncSettingsForm();
    applyBackground();
    renderMessages();
    renderSessions();
    updateSelStat();
    closeDrawers();
    toast('已清除本机数据');
  };

  window.addEventListener('resize', syncViewportHeight);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewportHeight);
}

/* ---------------- 启动 ---------------- */

buildPresets();
bind();
syncViewportHeight();
syncSettingsForm();
applyBackground();
renderMessages();
renderSessions();
updateSelStat();
if (settings.apiKey) showCorsNotice(false);

/* 供联调/自动化测试与调试使用 */
globalThis.__CHAT__ = {
  settings: () => ({ ...settings, background: { ...settings.background } }),
  applySettings: (patch) => applySettings(patch || {}),
  send: (text) => send(text),
  messages: () =>
    currentSession()
      ? currentSession().messages.map((m) => ({
          role: m.role,
          content: m.content,
          text: m.content, // 兼容不同测试/调用方的命名
          reasoning: m.reasoning,
          streaming: !!m.streaming,
          time: m.time,
        }))
      : [],
  stop: () => stop(),
  setBackground: (bg) => setBackground(bg || {}),
  clearAll: () => {
    localStorage.removeItem(LS_SETTINGS);
    localStorage.removeItem(LS_SESSIONS);
    settings = structuredClone(DEFAULT_SETTINGS);
    sessions = [];
    currentId = null;
    renderMessages();
    renderSessions();
    applyBackground();
  },
  endpoint: () => endpointFor(settings.baseURL),
  isSending: () => sending,
  workerSnippet: WORKER_SNIPPET,
};

$('workerSnippet').textContent = WORKER_SNIPPET;
