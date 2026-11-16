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

/* ---------------- 运行环境 / 设备 ---------------- */

const UA = navigator.userAgent || '';
const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);

// device.js（内联在 <head>，首帧就设置 data-device）是设备判定的唯一真源
const DEVINFO = window.__DS2CB_DEVICE__ || null;
const deviceDetect = DEVINFO ? DEVINFO.detect : () => 'desktop';
const deviceLabel = DEVINFO ? DEVINFO.label : (d) => d;

let DEVICE = deviceDetect();
const isTouchLikeDevice = () => DEVICE !== 'desktop';
// 兼容旧调用点：非桌面（手机/平板）都按"触屏设备"处理保存方式
const MOBILE = () => isTouchLikeDevice();

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * 保存/分享产物。
 * - 手机/平板：优先系统分享（iOS「存储到文件」、Android「保存到设备/发送给 App」）
 * - 电脑 / 分享不可用：走 <a download>
 * 返回 'shared' | 'downloaded' | 'cancelled'
 */
async function saveFile(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });

  if (MOBILE() && typeof File === 'function' && typeof navigator.canShare === 'function') {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        log(`已通过系统「分享 / 存储」交出：${filename}`, 'ok');
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        log('已取消分享（文件没有保存）', 'warn');
        return 'cancelled';
      }
      // 常见于浏览器要求「必须在用户手势内」——不再打扰用户，直接走下载
      log('系统分享未启用，改用下载', 'dim');
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (MOBILE()) log(`已发起下载：${filename}（iPhone 会存到「文件 → 下载」，Android 存到「下载」）`, 'ok');
    return 'downloaded';
  } catch (err) {
    // 极老 iOS 不支持 a.download：退回新标签打开
    try {
      window.open(url, '_blank');
      log('已在新标签页打开，长按选择「存储到文件」', 'warn');
      return 'downloaded';
    } catch {
      throw err;
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}

const download = (bytes, filename, mime) => saveFile(bytes, filename, mime);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function detectPlatform() {
  if (IS_IOS) return 'ios';
  if (IS_ANDROID) return 'android';
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

/* ---------------- 载入进度 ---------------- */

function showLoad(title, ratio, sub) {
  const box = $('loadBox');
  if (!box) return;
  box.hidden = false;
  $('loadTitle').textContent = title;
  const pct = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  $('loadProg').value = pct;
  $('loadPct').textContent = Number.isFinite(ratio) ? Math.round(pct * 100) + '%' : '';
  if (sub !== undefined) $('loadSub').textContent = sub;
}

function hideLoad() {
  const box = $('loadBox');
  if (box) box.hidden = true;
}

/** 解析阶段的进度：0 → 0.15 读索引，0.15 → 0.98 逐会话解析 */
function phaseProgress(done, total, from, to) {
  const r = total ? done / total : 1;
  return from + (to - from) * r;
}

/* ---------------- 载入会话 ---------------- */

async function loadSessions() {
  SESSIONS = [];
  const sessionPaths = SOURCE.listSessions();

  if (sessionPaths.length) {
    const total = sessionPaths.length;
    log(`发现 ${total} 个会话文件`, 'dim');
    showLoad('正在解析会话…', 0.15, `共 ${total} 个会话，手机 / 平板上可能需要几秒，请稍等。`);
    await tick();
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
      // 每 3 个让出一次主线程，进度条在手机上也能动起来
      if (done % 3 === 0 || done === total) {
        showLoad(`正在解析会话 ${done}/${total}`, phaseProgress(done, total, 0.15, 0.98));
        await tick();
        if (done % 30 === 0) log(`已解析 ${done}/${total} …`, 'dim');
      }
    }
    finishLoad('DeepSeek 官方导出');
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
    showLoad('正在解析 Markdown…', 0.1, `共 ${mdPaths.length} 个文件`);
    await tick();
    for (let i = 0; i < mdPaths.length; i++) {
      const p = mdPaths[i];
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
      showLoad(`正在解析 ${i + 1}/${mdPaths.length}`, phaseProgress(i + 1, mdPaths.length, 0.1, 0.98));
      await tick();
    }
    if (SESSIONS.length) {
      finishLoad('DeepSeek-Exporter 扩展的 Markdown');
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
  hideLoad();
  const bar = $('loadedBar');
  if (bar && !SESSIONS.length) bar.hidden = true;
}

function finishLoad(formatName) {
  SESSIONS.sort((a, b) => b.updatedAt - a.updatedAt);
  const msgs = SESSIONS.reduce((a, s) => a + s.count, 0);

  showLoad('载入完成', 1, '');
  setTimeout(hideLoad, 400);

  $('sourceStat').innerHTML =
    `已载入 <b>${SOURCE.label}</b>（${formatName}）：${SESSIONS.length} 个会话 / ${msgs} 条消息（${SOURCE.kind === 'zip' ? SOURCE.count + ' 个 zip 条目' : SOURCE.count + ' 个文件'}）`;
  log(`载入完成：${SESSIONS.length} 会话 / ${msgs} 消息`, 'ok');

  const bar = $('loadedBar');
  if (bar) {
    bar.hidden = false;
    $('loadedText').textContent = `已载入 ${SESSIONS.length} 个会话（${SOURCE.label}）· 不需重复添加`;
  }
  const confirm = $('confirmBar');
  if (confirm) confirm.hidden = true;

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

function setProgress(ratio, text) {
  const p = $('prog');
  if (p) {
    p.hidden = false;
    p.value = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  }
  if (text) $('goStat').textContent = text;
}

async function exportChatbox(sel, opts = {}) {
  const say = opts.quiet ? () => {} : log;
  say(`正在转换 ${sel.length} 个会话为 Chatbox 备份…`);
  const includeImages = opts.includeImages !== undefined ? opts.includeImages : $('wantImages').checked;
  const built = [];
  for (let i = 0; i < sel.length; i++) {
    const s = sel[i];
    built.push(await buildChatboxSession(s.ds, { readFile: (p) => SOURCE.bytes(p), includeImages }));
    // 每 5 个会话让出一次主线程：手机端才不会「卡住没反应」
    if (i % 5 === 4 || i === sel.length - 1) {
      setProgress(((i + 1) / sel.length) * 0.7, `转换中 ${i + 1}/${sel.length}`);
      await tick();
    }
    if ((i + 1) % 20 === 0) say(`  转换 ${i + 1}/${sel.length}`, 'dim');
  }
  const imgCount = built.reduce((a, b) => a + b.resources.length, 0);
  say(`转换完成：${built.length} 会话，${imgCount} 张图片`, 'ok');
  say('生成备份归档…', 'dim');
  setProgress(0.8, '打包中…');
  await tick();
  const { entries, manifest } = await buildChatboxArchive(built, {
    appVersion: CHATBOX_VERSION,
    platform: detectPlatform(),
  });
  const bytes = await writeZip(entries);
  setProgress(0.95, '保存中…');
  if (opts.download !== false) await saveFile(bytes, `chatbox-backup-deepseek-${stamp()}.cbx`, 'application/zip');
  say(`已生成 .cbx：${fmtBytes(bytes.length)}`, 'ok');
  if (MOBILE() && bytes.length > 40 * 1024 * 1024) {
    say('手机端提示：文件较大，若保存失败可取消勾选「包含图片附件」后重试', 'warn');
  }
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

// POSIX：macOS / Linux / Android Termux / iOS iSH·a-Shell
const INSTALL_SH = `#!/bin/sh
# DeepSeek Harness 会话包安装脚本
#   sh install.sh              -> 装到 ~/.dsh/sessions
#   sh install.sh /目标/路径    -> 装到指定会话根目录（例如 App 沙盒里的路径）
set -e
DEST="\${1:-$HOME/.dsh/sessions}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$HERE/sessions"
if [ ! -d "$SRC" ]; then
  echo "找不到 sessions/ 目录：请保持解压后的目录结构（install.sh 与 sessions/ 同级）" >&2
  exit 1
fi
mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/
echo ""
echo "已写入：$DEST"
for d in "$SRC"/*; do
  [ -d "$d" ] && echo "  + $(basename "$d")"
done
echo ""
echo "如果 DeepSeek Harness 正在运行，请完全退出后重新打开；会话会出现在对应工作区的侧栏中。"
`;

function installReadme(cwd, count) {
  return `DeepSeek Harness 会话包
========================

包里是什么
  sessions/--<工作区目录名>--/session-<uuid>/session.v4.jsonl.zstd
  这些会话会出现在 cwd 对应的工作区里。

一、DSH 跑在电脑上（Windows / macOS / Linux）—— 最常见
  Windows：右键 install.ps1 →「使用 PowerShell 运行」
  其它：  sh install.sh
  然后完全退出并重开 DeepSeek Harness。

二、DSH 跑在手机本机
  Android（Termux）：
    pkg install unzip
    cd ~/Download
    unzip dsh-sessions-deepseek-*.zip -d dsh-import
    cd dsh-import && sh install.sh
  iPhone / iPad（iSH 或 a-Shell）：
    同样解压后执行 sh install.sh
  若你的会话目录不在 ~/.dsh/sessions（例如在某个 App 的沙盒目录里），
  把路径传进去：sh install.sh /该路径/.dsh/sessions

三、手机上用插件远程访问电脑里的 DSH（如 dsh-mobile）
  这类方案里会话仍然存在电脑上 —— 请把本包拿到电脑，按「一」安装即可。

四、装完没看到会话？
  · 确认完全退出了 DeepSeek Harness（不是最小化）再重开
  · 确认工作区路径是：${cwd}
  · 会话文件必须叫 session.v4.jsonl.zstd，且与 uuid 目录同级

工作区：${cwd}
会话数：${count}
`;
}

async function exportChatboxV1(sel, opts = {}) {
  log(`正在转换 ${sel.length} 个会话为 Chatbox V1 JSON…`);
  const built = [];
  for (const s of sel) {
    built.push(await buildChatboxSession(s.ds, { includeImages: false }));
  }
  const json = buildChatboxV1File(built, { exportedAt: new Date() });
  const bytes = utf8Encode(json);
  if (opts.download !== false) await saveFile(bytes, `chatbox-backup-deepseek-${stamp()}-v1.json`, 'application/json');
  log(`已生成 V1 JSON：${fmtBytes(bytes.length)}（${built.length} 个会话）`, 'ok');
  return { bytes, count: built.length };
}

/** 把选中的会话送进聊天客户端（写 localStorage 后跳转） */
async function sendToChatClient() {
  const sel = SESSIONS.filter((s) => s.selected);
  if (!sel.length) {
    log('没有选中任何会话', 'warn');
    return;
  }
  const sessions = sel.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.ds.messages.map((m) => ({
      role: m.role,
      content: m.text || '',
      reasoning: m.thinking || undefined,
      time: m.time,
    })),
  }));
  try {
    localStorage.setItem('dscc.v1.pendingImport', JSON.stringify({ format: 'ds-chat-client', version: 1, sessions }));
  } catch (err) {
    log('写入本机存储失败（隐私模式？）：' + (err?.message || err), 'err');
    return;
  }
  log(`已把 ${sessions.length} 个会话交给聊天客户端，正在跳转…`, 'ok');
  location.href = 'chat.html?import=pending';
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
    // 统一放进 sessions/ 目录：安装脚本按「sessions/ 与脚本同级」复制
    const rel = (data.relativePath || `${key}/${sessionId}/session.v4.jsonl.zstd`).replace(/^sessions\//, '');
    files.push({ path: `sessions/${rel}`, data: data.bytes, deflate: false });
    if (i % 5 === 4 || i === sel.length - 1) {
      setProgress(((i + 1) / sel.length) * 0.8, `编码中 ${i + 1}/${sel.length}`);
      await tick();
    }
    if ((i + 1) % 20 === 0) say(`  编码 ${i + 1}/${sel.length}`, 'dim');
  }
  // install.ps1 必须带 UTF-8 BOM：Windows PowerShell 5.1 会把无 BOM 的中文当 ANSI 解析而报语法错
  files.push({ path: 'install.ps1', data: utf8Encode('\uFEFF' + INSTALL_PS1), deflate: true });
  files.push({ path: 'install.sh', data: utf8Encode(INSTALL_SH), deflate: true });
  files.push({
    path: '安装说明.txt',
    data: utf8Encode(installReadme(cwd, sel.length)),
    deflate: true,
  });
  const bytes = await writeZip(files);
  if (opts.download !== false) await saveFile(bytes, `dsh-sessions-deepseek-${stamp()}.zip`, 'application/zip');
  say(`已生成 DSH 会话包：${fmtBytes(bytes.length)}（${sel.length} 个会话，含 install.ps1 / install.sh）`, 'ok');
  if (isTouchLikeDevice()) {
    say('手机端：可把包分享到电脑后用 install.ps1 安装；若 DSH 跑在手机（Termux / iSH），用 sh install.sh', 'dim');
  }
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
  await saveFile(bytes, `deepseek-markdown-${stamp()}.zip`, 'application/zip');
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
  await saveFile(bytes, `deepseek-chats-${stamp()}.json`, 'application/json');
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
  $('drop').classList.add('busy'); // 解析期间不再响应拖拽/点击，避免重复添加
  try {
    await fn();
  } catch (err) {
    console.error(err);
    log('出错：' + (err?.message || err), 'err');
  } finally {
    busy = false;
    btn.disabled = false;
    $('prog').hidden = true;
    $('goStat').textContent = '';
    $('drop').classList.remove('busy');
  }
}

/* ---- 防重复添加：已有数据时先确认 ---- */

let pendingSource = null;
let allowReplace = false;

async function doLoadSource(source) {
  SOURCE = source;
  const kindText = source.kind === 'zip' ? 'zip' : '文件夹';
  log(`数据源：${source.label}（${kindText}，${source.count} 项）`, 'ok');
  showLoad('正在读取数据…', 0.05, `${source.label} · ${source.count} ${source.kind === 'zip' ? '个条目' : '个文件'}`);

  // 读取索引/建立数据源很轻，给一帧让进度条先画出来
  await tick();
  await loadSessions();
}

async function handleSource(source) {
  if (SESSIONS.length && !allowReplace) {
    pendingSource = source;
    const bar = $('confirmBar');
    if (bar) {
      bar.hidden = false;
      $('confirmText').textContent =
        `已经载入过 ${SESSIONS.length} 个会话（${SOURCE ? SOURCE.label : '上一次选择的数据'}），不需要重复添加。` +
        `如果确实要换成「${source.label}」，点下面的按钮。`;
    }
    log('检测到重复添加，已暂停：请点「替换现有数据」或「取消」', 'warn');
    hideLoad();
    return;
  }
  allowReplace = false;
  const bar = $('confirmBar');
  if (bar) bar.hidden = true;
  await doLoadSource(source);
}

$('confirmReplace').addEventListener('click', async () => {
  const src = pendingSource;
  pendingSource = null;
  $('confirmBar').hidden = true;
  if (!src) return;
  allowReplace = true;
  await withBusy(async () => {
    await doLoadSource(src);
  });
  allowReplace = false;
});
$('confirmCancel').addEventListener('click', () => {
  pendingSource = null;
  $('confirmBar').hidden = true;
  log('已取消，保留当前已载入的数据', 'dim');
});
$('reloadBtn').addEventListener('click', () => {
  allowReplace = true;
  $('confirmBar').hidden = true;
  $('fileInput').click();
});

$('drop').addEventListener('click', () => {
  if (busy) return;
  $('fileInput').click();
});
$('pickZip').addEventListener('click', (e) => {
  e.stopPropagation();
  if (busy) return;
  $('fileInput').click();
});
$('pickDir').addEventListener('click', (e) => {
  e.stopPropagation();
  if (busy) return;
  $('dirInput').click();
});
$('fileInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) {
    allowReplace = false;
    return;
  }
  await withBusy(async () => {
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      await handleSource(await sourceFromZip(files[0]));
    } else {
      log(`读入 ${files.length} 个文件`, 'dim');
      await handleSource(sourceFromFiles(files));
    }
  });
  allowReplace = false;
});
$('dirInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) {
    allowReplace = false;
    return;
  }
  await withBusy(async () => handleSource(sourceFromFiles(files)));
  allowReplace = false;
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

$('toChatBtn')?.addEventListener('click', () => { sendToChatClient(); });

$('go').addEventListener('click', async () => {
  const sel = SESSIONS.filter((s) => s.selected);
  if (!sel.length) {
    log('没有选中任何会话', 'warn');
    return;
  }
  const target = document.querySelector('input[name=target]:checked')?.value || 'chatbox';
  $('goStat').textContent = '';
  await withBusy(async () => {
    if (target === 'chatbox') await exportChatbox(sel);
    else if (target === 'chatboxV1') await exportChatboxV1(sel);
    else if (target === 'dsh') await exportDsh(sel);
    else if (target === 'markdown') await exportMarkdown(sel);
    else await exportJson(sel);
  });
  $('goStat').textContent = '';
  setTimeout(() => {
    $('prog').hidden = true;
  }, 800);
});

/* ---------------- 设备档位：手机 / 平板 / 电脑 ---------------- */

const SOURCE_HINT_DESKTOP =
  '支持直接拖入 <code>deepseek_data-*.zip</code>（官方导出），或解压后的整个文件夹（里面有 <code>chat_session_index.json</code> 和 <code>chat_sessions/</code>）；也支持 DeepSeek-Exporter 等扩展导出的 <code>.md</code> 对话记录（可多选/整个文件夹）。';
const SOURCE_HINT_TOUCH =
  '在 DeepSeek 网页端点「设置 → 数据管理 → 导出数据」，把下载到的 <code>deepseek_data-*.zip</code> 选进来；也可以选扩展导出的 <code>.md</code>（可多选）。';

let userTouchedImages = false;
let userTouchedTarget = false;
let firstApply = true;

function syncTargetUi(name) {
  document.querySelectorAll('.target').forEach((x) => x.classList.toggle('sel', x.dataset.target === name));
  const radio = document.querySelector(`input[name=target][value="${name}"]`);
  if (radio) radio.checked = true;
  $('dshOpts').hidden = name !== 'dsh';
}

/** 按设备档位切换布局相关的 DOM 状态（CSS 部分由 data-device 驱动） */
function applyDevice(device) {
  DEVICE = device;
  if (DEVINFO) DEVINFO.current = device;
  document.documentElement.setAttribute('data-device', device);
  const touchLike = device !== 'desktop';

  const note = $('mobileNote');
  if (note) note.hidden = !touchLike;
  const noteTitle = $('noteTitle');
  if (noteTitle) noteTitle.textContent = device === 'tablet' ? '平板端' : device === 'phone' ? '手机端' : '触屏设备';

  const big = $('dropBig');
  if (big) big.textContent = touchLike ? '点这里选择 .zip / .md 文件' : '把 zip / 文件夹 / .md 拖到这里';
  const sub = $('dropSub');
  if (sub) {
    sub.innerHTML = touchLike
      ? '<span style="color:var(--accent2)">点按选择</span>　支持官方导出 zip 与对话 .md'
      : '或者 <span style="color:var(--accent2)">点击选择文件</span>　·　也可以选文件夹';
  }

  // 触屏上没有拖拽、也没有文件夹选择，隐藏这些入口
  const pk = $('pickZip');
  if (pk) pk.style.display = touchLike ? 'none' : '';
  const pd = $('pickDir');
  if (pd) pd.style.display = touchLike ? 'none' : '';

  const sourceHint = document.querySelector('section.card .hint');
  if (sourceHint) sourceHint.innerHTML = touchLike ? SOURCE_HINT_TOUCH : SOURCE_HINT_DESKTOP;

  const dshTip = document.querySelector('.target[data-target=dsh] .td');
  if (dshTip) {
    dshTip.textContent = touchLike
      ? '手机本机跑 DSH（Termux / iSH）用包里的 install.sh；DSH 在电脑上就用 install.ps1。'
      : '解压到 %USERPROFILE%\\.dsh\\sessions\\ 覆盖同名目录即可；包内附 install.ps1 与 install.sh。';
  }

  // 默认值只在用户没手动改过时套用
  const wi = $('wantImages');
  if (wi && !userTouchedImages) wi.checked = device === 'desktop';
  if (!userTouchedTarget && touchLike) syncTargetUi('chatbox');

  log(
    `界面按「${deviceLabel(device)}」布局（${window.innerWidth}×${window.innerHeight}）` +
      (touchLike ? '：默认关闭图片附件、默认 Chatbox 目标' : ''),
    'dim'
  );
}

function refreshDevice(reason) {
  const next = deviceDetect();
  if (next === DEVICE && !firstApply) return;
  const changed = next !== DEVICE;
  applyDevice(next);
  if (changed && reason) log(`检测到${reason}，已切换到「${deviceLabel(next)}」布局`, 'dim');
  firstApply = false;
}

// 用户动过的选项不再被自动覆盖
$('wantImages').addEventListener('change', () => {
  userTouchedImages = true;
});
document.querySelectorAll('.target').forEach((el) => {
  el.addEventListener('click', () => {
    userTouchedTarget = true;
  });
});

logEl.textContent = '';
log('就绪。把一个 deepseek_data-*.zip 拖进上面的区域开始。', 'dim');
refreshDevice();
let resizeTimer = null;
const scheduleRefresh = (reason) => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => refreshDevice(reason), 160);
};
window.addEventListener('resize', () => scheduleRefresh('窗口尺寸变化'), { passive: true });
window.addEventListener('orientationchange', () => scheduleRefresh('屏幕旋转'), { passive: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => scheduleRefresh('可视区域变化'), { passive: true });
}
try {
  const mqList = [matchMedia('(pointer: coarse)'), matchMedia('(hover: none)'), matchMedia('(max-width: 600px)')];
  for (const mq of mqList) {
    if (mq.addEventListener) mq.addEventListener('change', () => scheduleRefresh('输入方式变化'));
  }
} catch {}

/* 供自动化测试/调试使用（不影响正常使用） */
globalThis.__DS2CB__ = {
  sourceFromZip,
  sourceFromFiles,
  loadSessions,
  handleSource,
  getSessions: () => SESSIONS,
  getSource: () => SOURCE,
  getDevice: () => DEVICE,
  isBusy: () => busy,
  exportChatbox,
  exportDsh,
  exportChatboxV1: (sel, opts = {}) => exportChatboxV1(sel, opts),
  workspaceKey,
  log,
};
