/* ================= 页面逻辑 ================= */

const $ = (id) => document.getElementById(id);
const logEl = $('log');
let logLines = 0;

function log(msg, kind = '') {
  if (logLines === 0) logEl.textContent = '';
  const span = document.createElement('span');
  if (kind) span.className = kind;
  span.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
  logLines++;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function download(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'win32';
  if (/Mac/i.test(ua)) return 'darwin';
  return 'linux';
}

/* ---------------- 数据源抽象 ---------------- */

let SOURCE = null;
let SESSIONS = [];

async function sourceFromZip(file) {
  if (typeof openZip !== 'function') throw new Error('zip 读取模块缺失');
  log(`读取 ${file.name}（${fmtBytes(file.size)}）…`);
  // openZip(File) 只读 EOCD + 中央目录建索引，不会把整个 80MB 读进内存
  const zip = await openZip(file);
  const paths = zip.entries.filter((e) => !e.isDirectory).map((e) => e.path);
  log(`zip 条目 ${paths.length} 个（压缩总大小 ${fmtBytes(zip.stats ? zip.stats.compressedSize : file.size)}）`, 'dim');

  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const baseIndex = new Map();
  for (const p of paths) {
    const b = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    if (!baseIndex.has(b)) baseIndex.set(b, p);
  }
  const resolve = (want) => {
    const w = String(want).replace(/^\.?\//, '').toLowerCase();
    if (lower.has(w)) return lower.get(w);
    const b = w.slice(w.lastIndexOf('/') + 1);
    if (baseIndex.has(b)) return baseIndex.get(b);
    for (const [k, v] of lower) if (k.endsWith('/' + w)) return v;
    return null;
  };

  return {
    kind: 'zip',
    label: file.name,
    count: paths.length,
    paths,
    has: (p) => resolve(p) !== null,
    text: async (p) => {
      const real = resolve(p);
      if (!real) throw new Error('找不到 ' + p);
      return utf8Decode(await zip.read(real));
    },
    bytes: async (p) => {
      const real = resolve(p);
      if (!real) return null;
      return await zip.read(real);
    },
    listSessions: () =>
      paths.filter((p) => /(^|\/)chat_sessions\/[^/]+\.json$/i.test(p) && !/_files\//.test(p)),
    listMarkdown: () => paths.filter((p) => /\.(md|markdown)$/i.test(p)),
    hasPath: (re) => paths.some((p) => re.test(p)),
  };
}

function sourceFromFiles(files) {
  const map = new Map();
  const base = new Map();
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    map.set(rel, f);
    const b = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
    if (!base.has(b)) base.set(b, f);
  }
  const resolve = (want) => {
    const w = String(want).replace(/^\.?\//, '');
    if (map.has(w)) return map.get(w);
    const b = w.slice(w.lastIndexOf('/') + 1).toLowerCase();
    if (base.has(b)) return base.get(b);
    for (const k of map.keys()) if (k.toLowerCase().endsWith('/' + w.toLowerCase())) return map.get(k);
    return null;
  };
  const paths = [...map.keys()];
  const topDir = files[0]?.webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : '';
  return {
    kind: 'dir',
    label: topDir || (files.length === 1 ? files[0].name : files.length + ' 个文件'),
    count: files.length,
    paths,
    has: (p) => resolve(p) !== null,
    text: async (p) => {
      const f = resolve(p);
      if (!f) throw new Error('找不到 ' + p);
      return await f.text();
    },
    bytes: async (p) => {
      const f = resolve(p);
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    listSessions: () =>
      paths.filter((p) => /(^|\/)chat_sessions\/[^/]+\.json$/i.test(p) && !/_files\//.test(p)),
    listMarkdown: () => paths.filter((p) => /\.(md|markdown)$/i.test(p)),
    hasPath: (re) => paths.some((p) => re.test(p)),
  };
}

/* ---------------- 载入会话 ---------------- */

async function loadSessions() {
  const t0 = performance.now();
  SESSIONS = [];
  const sessionPaths = SOURCE.listSessions();

  if (sessionPaths.length) {
    log(`发现 ${sessionPaths.length} 个会话文件`, 'dim');
    let done = 0;
    for (const p of sessionPaths) {
      try {
        const raw = JSON.parse(await SOURCE.text(p));
        const ds = parseDeepSeekSession(raw);
        if (!ds.id) ds.id = p.slice(p.lastIndexOf('/') + 1).replace(/\.json$/i, '');
        SESSIONS.push({
          id: ds.id,
          title: ds.title,
          createdAt: ds.createdAt,
          updatedAt: ds.updatedAt,
          count: ds.messages.length,
          pinned: ds.pinned,
          ds,
          selected: true,
        });
      } catch (err) {
        log('解析失败：' + p + ' — ' + err.message, 'err');
      }
      done++;
      if (done % 25 === 0) log(`已解析 ${done}/${sessionPaths.length} …`, 'dim');
    }
    finishLoad(t0, 'DeepSeek 官方导出');
    return;
  }

  // 先排除「扩展/项目源码包」：这类包里往往有 README 里抄的示例对话，不能当数据
  const hasManifest = typeof SOURCE.hasPath === 'function' && SOURCE.hasPath(/(^|\/)manifest\.json$/i);
  const hasPackage = typeof SOURCE.hasPath === 'function' && SOURCE.hasPath(/(^|\/)package\.json$/i);
  const hasExtJs =
    typeof SOURCE.hasPath === 'function' &&
    (SOURCE.hasPath(/(^|\/)background\/index\.js$/i) || SOURCE.hasPath(/(^|\/)content\/extractor\.js$/i));
  const looksLikeExtension = hasExtJs || (hasManifest && hasPackage);

  // 不是官方导出包：看看是不是扩展导出的 Markdown
  const mdPaths = typeof SOURCE.listMarkdown === 'function' ? SOURCE.listMarkdown() : [];
  if (mdPaths.length && !looksLikeExtension) {
    log(`没找到官方导出结构，尝试按 Markdown 会话解析（${mdPaths.length} 个 .md）`, 'warn');
    for (const p of mdPaths) {
      const name = p.slice(p.lastIndexOf('/') + 1);
      try {
        const text = await SOURCE.text(p);
        if (!looksLikeExporterMarkdown(text)) {
          log(`跳过（不是对话记录）：${name}`, 'dim');
          continue;
        }
        const ds = parseMarkdownConversation(text, { fileName: name });
        if (!ds.messages.length) {
          log(`跳过（没有消息）：${name}`, 'dim');
          continue;
        }
        SESSIONS.push({
          id: ds.id,
          title: ds.title,
          createdAt: ds.createdAt,
          updatedAt: ds.updatedAt,
          count: ds.messages.length,
          pinned: false,
          ds,
          selected: true,
        });
        log(`  ✓ ${name} → ${ds.messages.length} 条消息`, 'dim');
      } catch (err) {
        log('解析失败：' + name + ' — ' + err.message, 'err');
      }
    }
    if (SESSIONS.length) {
      finishLoad(t0, 'DeepSeek-Exporter 扩展的 Markdown');
      return;
    }
  }

  diagnoseSource({ looksLikeExtension });
}

/** 扩展导出的 .md 必然以 `# AI 对话记录` 开头（README 里的示例在代码块中，不在开头） */
function looksLikeExporterMarkdown(text) {
  const head = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 3)
    .join('\n');
  return /^#\s*AI\s*对话记录\s*$/m.test(head);
}

/** 载入不了时，尽量告诉用户他拖进来的是什么 */
function diagnoseSource(opts = {}) {
  const isExtension =
    opts.looksLikeExtension ||
    (typeof SOURCE.hasPath === 'function' &&
      (SOURCE.hasPath(/(^|\/)background\/index\.js$/i) || (SOURCE.hasPath(/manifest\.json$/i) && SOURCE.hasPath(/(^|\/)package\.json$/i))));

  let msg;
  if (isExtension) {
    msg =
      `这是浏览器扩展/项目源码包（检测到 manifest.json / background/ 等），里面没有聊天记录。` +
      `插件本身只是导出工具，要用它导出的 .md 文件或官方数据包。`;
    log('识别结果：浏览器扩展源码包，不是聊天数据', 'warn');
    log('👉 正确做法一：在 chat.deepseek.com 点「设置 → 数据管理 → 导出数据」，下载 deepseek_data-*.zip 再拖进来', 'warn');
    log('👉 正确做法二：用扩展把对话导出成 .md，再把 .md 拖进来（本工具现已支持）', 'warn');
  } else if (!SOURCE.count) {
    msg = '这个数据源是空的。';
    log('数据源为空', 'err');
  } else {
    msg =
      `没有识别到 chat_session_index.json / chat_sessions/（官方导出）或对话 Markdown。` +
      `当前是 ${SOURCE.count} 个文件：${(SOURCE.paths || []).slice(0, 6).join('、')}`;
    log('识别失败：结构不符合任何已知格式', 'err');
    log('官方导出：chat.deepseek.com → 设置 → 数据管理 → 导出数据 → 得到 deepseek_data-*.zip', 'warn');
  }
  $('sourceStat').innerHTML = `<span style="color:var(--warn)">${msg}</span>`;
}

function finishLoad(t0, formatName) {
  SESSIONS.sort((a, b) => b.updatedAt - a.updatedAt);
  const msgs = SESSIONS.reduce((a, s) => a + s.count, 0);
  $('sourceStat').innerHTML =
    `已载入 <b>${SOURCE.label}</b>（${formatName}）：${SESSIONS.length} 个会话 / ${msgs} 条消息（${SOURCE.kind === 'zip' ? SOURCE.count + ' 个 zip 条目' : SOURCE.count + ' 个文件'}）`;
  log(`载入完成：${SESSIONS.length} 会话 / ${msgs} 消息，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');

  renderList();
  $('sessionsCard').style.display = '';
  $('exportCard').style.display = '';
  $('go').disabled = false;
  $('cwdInput').value = guessCwd();
  updateSelStat();
}

function guessCwd() {
  return 'D:\\DeepSeek-Imported';
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of SESSIONS) {
    if (q && !s.title.toLowerCase().includes(q)) continue;
    const row = document.createElement('label');
    row.className = 'item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.selected;
    cb.onchange = () => {
      s.selected = cb.checked;
      updateSelStat();
    };
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = (s.pinned ? '📌 ' : '') + s.title;
    t.title = s.title;
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = `${s.count} 条 · ${new Date(s.updatedAt).toLocaleDateString()}`;
    row.append(cb, t, m);
    frag.appendChild(row);
  }
  list.appendChild(frag);
  if (!list.children.length) {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = '没有匹配的会话';
    list.appendChild(d);
  }
}

function updateSelStat() {
  const sel = SESSIONS.filter((s) => s.selected);
  const msgs = sel.reduce((a, s) => a + s.count, 0);
  $('selStat').textContent = `已选 ${sel.length}/${SESSIONS.length} 个会话 · ${msgs} 条消息`;
}

/* ---------------- 导出 ---------------- */

const CHATBOX_VERSION = '1.16.0';

function messagesForDsh(ds) {
  return ds.messages.map((m) => ({
    role: m.role,
    text: m.text,
    reasoning: m.thinking,
    time: m.time,
    files: m.files.map((f) => f.name),
    search: m.search,
  }));
}

function dshEncode(opts) {
  const W = typeof DshWriter !== 'undefined' ? DshWriter : null;
  let out = null;
  if (W && typeof W.buildSessionLog === 'function') out = W.buildSessionLog(opts);
  else if (W && typeof W.encodeSessionLog === 'function' && W.buildSessionEvents) {
    out = W.encodeSessionLog(W.buildSessionEvents(opts));
  } else if (typeof buildSessionLog === 'function') {
    out = buildSessionLog(opts);
  } else {
    throw new Error('DSH 会话写入模块缺失');
  }
  if (out instanceof Uint8Array) return { bytes: out };
  if (out && out.bytes instanceof Uint8Array) return out;
  throw new Error('DSH 会话编码结果无效');
}

async function exportChatbox(sel, opts = {}) {
  const say = opts.quiet ? () => {} : log;
  say(`正在转换 ${sel.length} 个会话为 Chatbox 备份…`);
  const includeImages = opts.includeImages !== undefined ? opts.includeImages : $('wantImages').checked;
  const built = [];
  for (let i = 0; i < sel.length; i++) {
    const s = sel[i];
    built.push(await buildChatboxSession(s.ds, { readFile: (p) => SOURCE.bytes(p), includeImages }));
    if ((i + 1) % 20 === 0) say(`  转换 ${i + 1}/${sel.length}`, 'dim');
  }
  const imgCount = built.reduce((a, b) => a + b.resources.length, 0);
  say(`转换完成：${built.length} 会话，${imgCount} 张图片`, 'ok');
  say('生成备份归档…', 'dim');
  const { entries, manifest } = await buildChatboxArchive(built, {
    appVersion: CHATBOX_VERSION,
    platform: detectPlatform(),
  });
  const bytes = await writeZip(entries);
  if (opts.download !== false) download(bytes, `chatbox-backup-deepseek-${stamp()}.cbx`, 'application/zip');
  say(`已生成 .cbx：${fmtBytes(bytes.length)}`, 'ok');
  return { bytes, manifest, entries: entries.length, images: imgCount };
}

const INSTALL_PS1 = `param([string]$Dest = (Join-Path $env:USERPROFILE ".dsh\\sessions"))
$src = Join-Path $PSScriptRoot "sessions"
if (-not (Test-Path $src)) { Write-Error "找不到 sessions 目录（请保持 zip 解压后的目录结构）"; exit 1 }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $src "*") -Destination $Dest
Write-Host ""
Write-Host "已写入：" $Dest -ForegroundColor Green
Get-ChildItem $src -Directory | ForEach-Object { Write-Host ("  + " + $_.Name) }
Write-Host ""
Write-Host "请完全退出并重新打开 DeepSeek Harness，会话会出现在对应工作区的侧栏中。" -ForegroundColor Cyan
`;

async function exportChatboxV1(sel, opts = {}) {
  log(`正在转换 ${sel.length} 个会话为 Chatbox V1 JSON…`);
  const built = [];
  for (const s of sel) {
    built.push(await buildChatboxSession(s.ds, { includeImages: false }));
  }
  const json = buildChatboxV1File(built, { exportedAt: new Date() });
  const bytes = utf8Encode(json);
  if (opts.download !== false) download(bytes, `chatbox-backup-deepseek-${stamp()}-v1.json`, 'application/json');
  log(`已生成 V1 JSON：${fmtBytes(bytes.length)}（${built.length} 个会话）`, 'ok');
  return { bytes, count: built.length };
}

async function exportDsh(sel, opts = {}) {
  const say = opts.quiet ? () => {} : log;
  const cwd = opts.cwd || ($('cwdInput').value || '').trim() || guessCwd();
  const key = workspaceKey(cwd);
  say(`DSH 工作区：${cwd}`);
  say(`目录键：${key}`, 'dim');
  const files = [];
  for (let i = 0; i < sel.length; i++) {
    const s = sel[i];
    const uuid = (crypto.randomUUID ? crypto.randomUUID() : stableId(s.id + Math.random())).toLowerCase();
    const sessionId = 'session-' + uuid;
    const data = dshEncode({
      id: sessionId,
      cwd,
      createdAt: s.createdAt,
      title: s.title,
      messages: messagesForDsh(s.ds),
    });
    const rel = data.relativePath || `sessions/${key}/${sessionId}/session.v4.jsonl.zstd`;
    files.push({ path: rel, data: data.bytes, deflate: false });
    if ((i + 1) % 20 === 0) say(`  编码 ${i + 1}/${sel.length}`, 'dim');
  }
  files.push({ path: 'install.ps1', data: utf8Encode(INSTALL_PS1), deflate: true });
  files.push({
    path: '安装说明.txt',
    data: utf8Encode(
      `DeepSeek Harness 会话包\n\n1) 解压本 zip\n2) 右键 install.ps1 → 使用 PowerShell 运行（或 powershell -ExecutionPolicy Bypass -File install.ps1）\n3) 完全退出并重新打开 DeepSeek Harness\n\n工作区：${cwd}\n会话数：${sel.length}\n`
    ),
    deflate: true,
  });
  const bytes = await writeZip(files);
  if (opts.download !== false) download(bytes, `dsh-sessions-deepseek-${stamp()}.zip`, 'application/zip');
  say(`已生成 DSH 会话包：${fmtBytes(bytes.length)}（${sel.length} 个会话）`, 'ok');
  return { bytes, pathPrefix: `sessions/${key}/`, count: sel.length };
}

async function exportMarkdown(sel) {
  const files = [];
  for (const s of sel) {
    const md = toMarkdown(s.ds);
    const safe = s.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || s.id;
    files.push({ path: `${safe}.md`, data: utf8Encode(md), deflate: true });
  }
  const bytes = await writeZip(files);
  download(bytes, `deepseek-markdown-${stamp()}.zip`, 'application/zip');
  log(`已生成 Markdown 归档：${sel.length} 个文件`, 'ok');
}

async function exportJson(sel) {
  const out = sel.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.ds.messages.map((m) => ({
      role: m.role,
      content: m.text,
      reasoning: m.thinking || undefined,
      time: m.time,
      files: m.files.map((f) => ({ name: f.name, path: f.path, isImage: f.isImage })),
      search: m.search.length ? m.search : undefined,
    })),
  }));
  const bytes = utf8Encode(JSON.stringify(out, null, 2));
  download(bytes, `deepseek-chats-${stamp()}.json`, 'application/json');
  log(`已生成 JSON：${fmtBytes(bytes.length)}`, 'ok');
}

/* ---------------- 事件绑定 ---------------- */

let busy = false;

async function withBusy(fn) {
  if (busy) return;
  busy = true;
  const btn = $('go');
  btn.disabled = true;
  $('prog').hidden = false;
  $('prog').value = 0;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    log('出错：' + (err?.message || err), 'err');
  } finally {
    busy = false;
    btn.disabled = false;
    $('prog').hidden = true;
  }
}

async function handleSource(source) {
  SOURCE = source;
  log(`数据源：${source.label}（${source.kind === 'zip' ? 'zip' : '文件夹'}，${source.count} 项）`, 'ok');
  await loadSessions();
}

$('drop').addEventListener('click', () => $('fileInput').click());
$('pickZip').addEventListener('click', (e) => {
  e.stopPropagation();
  $('fileInput').click();
});
$('pickDir').addEventListener('click', (e) => {
  e.stopPropagation();
  $('dirInput').click();
});
$('fileInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  e.target.value = '';
  await withBusy(async () => {
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      await handleSource(await sourceFromZip(files[0]));
    } else {
      log(`读入 ${files.length} 个文件`, 'dim');
      await handleSource(sourceFromFiles(files));
    }
  });
});
$('dirInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  await withBusy(async () => handleSource(sourceFromFiles(files)));
});

const drop = $('drop');
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
drop.addEventListener('drop', async (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  const items = [...(dt.items || [])];
  const entry = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).find(Boolean);
  await withBusy(async () => {
    if (entry && entry.isDirectory) {
      const files = [];
      await walkEntry(entry, files);
      log(`从文件夹读入 ${files.length} 个文件`, 'dim');
      await handleSource(sourceFromFiles(files));
      return;
    }
    const dropped = [...(dt.files || [])];
    if (!dropped.length) {
      log('没有识别到文件', 'warn');
      return;
    }
    const zip = dropped.find((f) => /\.zip$/i.test(f.name));
    if (zip && dropped.length === 1) {
      await handleSource(await sourceFromZip(zip));
      return;
    }
    // 多个文件 / 非 zip：按「文件夹内容」处理（支持扩展导出的 .md）
    log(`读入 ${dropped.length} 个文件`, 'dim');
    await handleSource(sourceFromFiles(dropped));
  });
});

function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(
        (f) => {
          try {
            Object.defineProperty(f, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') });
          } catch {}
          out.push(f);
          resolve();
        },
        () => resolve()
      );
      return;
    }
    const reader = entry.createReader();
    const all = [];
    const readBatch = () => {
      reader.readEntries(
        async (batch) => {
          if (!batch.length) {
            for (const e of all) await walkEntry(e, out);
            resolve();
            return;
          }
          all.push(...batch);
          readBatch();
        },
        () => resolve()
      );
    };
    readBatch();
  });
}

$('search').addEventListener('input', renderList);
$('selAll').addEventListener('click', () => {
  SESSIONS.forEach((s) => (s.selected = true));
  renderList();
  updateSelStat();
});
$('selNone').addEventListener('click', () => {
  SESSIONS.forEach((s) => (s.selected = false));
  renderList();
  updateSelStat();
});

document.querySelectorAll('.target').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.target').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
    el.querySelector('input').checked = true;
    $('dshOpts').hidden = el.dataset.target !== 'dsh';
  });
});

$('go').addEventListener('click', async () => {
  const sel = SESSIONS.filter((s) => s.selected);
  if (!sel.length) {
    log('没有选中任何会话', 'warn');
    return;
  }
  const target = document.querySelector('input[name=target]:checked')?.value || 'chatbox';
  await withBusy(async () => {
    if (target === 'chatbox') await exportChatbox(sel);
    else if (target === 'chatboxV1') await exportChatboxV1(sel);
    else if (target === 'dsh') await exportDsh(sel);
    else if (target === 'markdown') await exportMarkdown(sel);
    else await exportJson(sel);
  });
});

logEl.textContent = '';
log('就绪。把一个 deepseek_data-*.zip 拖进上面的区域开始。', 'dim');

/* 供自动化测试/调试使用（不影响正常使用） */
globalThis.__DS2CB__ = {
  sourceFromZip,
  sourceFromFiles,
  loadSessions,
  getSessions: () => SESSIONS,
  getSource: () => SOURCE,
  exportChatbox,
  exportDsh,
  exportChatboxV1: (sel, opts = {}) => exportChatboxV1(sel, opts),
  workspaceKey,
  log,
};
