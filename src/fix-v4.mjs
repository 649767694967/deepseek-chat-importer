/**
 * 修复旧版导入的 DSH 会话：补上 v4 要求的「受保护的首个 surface 头」。
 *
 * 背景：DSH 新版校验要求
 *   1) 会话里第一条 surface 事件必须是 system/message（surfaceOp: "append"）
 *   2) 这条 message 必须带 source.kind === "system-prompt"
 * 旧版导出缺少它，DSH 一旦在这个会话里继续写 system/message 就会报
 *   SessionFormatError: system/message requires a protected first surface head
 *
 * 修复会：
 *   · 在第一个 step/start 之后插入 system/message
 *   · 重排所有 seq，并同步修正 session/title 的 messageSeqs、compaction 的 shadowedSeqs、
 *     surfaceOp 的 startSeq/endSeq
 *   · 原文件备份为 *.bak-<时间戳>
 *
 * 用法（由 修复旧会话.bat 调用，也可手动）：
 *   ELECTRON_RUN_AS_NODE=1 "<DSH.exe>" fix-v4.mjs [会话根目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const SURFACE = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);
const HEAD_TEXT = '这段对话由 DeepSeek 网页端导出后导入，历史内容保持原样；请接着往下聊。';
const ROOT = process.argv[2] || path.join(os.homedir(), '.dsh', 'sessions');

const log = (s) => process.stdout.write(s + '\n');
const nextId = () => 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

/** 多 frame zstd 逐帧解压 */
function decodeFrames(buf) {
  const marks = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) marks.push(i);
  }
  const parts = [];
  for (let k = 0; k < marks.length; k++) {
    const s = marks[k];
    const e = k + 1 < marks.length ? marks[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'));
    } catch {
      /* 坏帧跳过 */
    }
  }
  return parts.join('');
}

function encodeRows(lines) {
  return Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8'))));
}

function firstSurface(events) {
  return events.find((e) => SURFACE.has(e.type));
}

function isHealthy(events) {
  const first = firstSurface(events);
  return Boolean(
    first &&
      first.type === 'system/message' &&
      first.surfaceOp === 'append' &&
      first.data &&
      first.data.message &&
      first.data.message.source &&
      first.data.message.source.kind === 'system-prompt'
  );
}

/** 把事件里引用的 seq 按映射改写 */
function remapRefs(ev, map) {
  const fix = (n) => (typeof n === 'number' && map.has(n) ? map.get(n) : n);
  if (ev.type === 'session/title' && ev.data && Array.isArray(ev.data.messageSeqs)) {
    ev.data.messageSeqs = ev.data.messageSeqs.map(fix);
  }
  if (ev.type && ev.type.startsWith('compaction/') && ev.data && Array.isArray(ev.data.shadowedSeqs)) {
    ev.data.shadowedSeqs = ev.data.shadowedSeqs.map(fix);
  }
  if (ev.surfaceOp && typeof ev.surfaceOp === 'object') {
    if ('startSeq' in ev.surfaceOp) ev.surfaceOp.startSeq = fix(ev.surfaceOp.startSeq);
    if ('endSeq' in ev.surfaceOp) ev.surfaceOp.endSeq = fix(ev.surfaceOp.endSeq);
  }
  return ev;
}

/** 插入 head，返回新事件数组（seq 从 0 重排） */
function repair(header, events) {
  const out = [];
  const map = new Map(); // 旧 seq -> 新 seq
  let inserted = false;
  let turn = 0;
  let step = 1;

  for (const ev of events) {
    if (ev.type === 'turn/start') turn = ev.data?.turn ?? turn;
    if (ev.type === 'step/start') {
      step = ev.data?.step ?? 1;
      if (!inserted) {
        map.set(ev.seq, out.length);
        out.push(ev);
        map.set(-1, out.length); // 新事件占的位置
        out.push({
          type: 'system/message',
          time: ev.time,
          data: {
            turn,
            step,
            message: {
              role: 'system',
              content: [{ type: 'text', text: HEAD_TEXT }],
              source: { kind: 'system-prompt' },
              id: nextId(),
            },
          },
          surfaceOp: 'append',
        });
        inserted = true;
        continue;
      }
    }
    map.set(ev.seq, out.length);
    out.push(ev);
  }

  if (!inserted) {
    // 没有 turn/start：直接放最前面
    out.unshift({
      type: 'system/message',
      time: header.createdAt || Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'system',
          content: [{ type: 'text', text: HEAD_TEXT }],
          source: { kind: 'system-prompt' },
          id: nextId(),
        },
      },
      surfaceOp: 'append',
    });
    // 重新算映射
    map.clear();
    events.forEach((ev, i) => map.set(ev.seq, i + 1));
  }

  // 先把引用按旧 seq 改写成新 seq，再统一重排 seq（顺序不能反，否则会二次映射）
  for (const ev of out) remapRefs(ev, map);
  out.forEach((ev, i) => {
    ev.seq = i;
  });
  return out;
}

function findLogs(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) findLogs(p, out);
    else if (ent.isFile() && /^session(\.v\d+)?\.jsonl\.zstd$/.test(ent.name)) out.push(p);
  }
  return out;
}

log('会话根目录：' + ROOT);
if (!fs.existsSync(ROOT)) {
  log('目录不存在，没有可修复的会话。');
  process.exit(0);
}
const files = findLogs(ROOT);
log('发现 ' + files.length + ' 个会话日志');

let fixed = 0;
let healthy = 0;
let failed = 0;

for (const file of files) {
  try {
    const buf = fs.readFileSync(file);
    const lines = decodeFrames(buf).split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    const header = JSON.parse(lines[0]);
    if (header.type !== 'session') continue;
    const events = lines.slice(1).map((l) => JSON.parse(l));
    if (isHealthy(events)) {
      healthy++;
      continue;
    }
    const repaired = repair(header, events);
    const backup = file + '.bak-' + Date.now();
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, encodeRows([JSON.stringify(header), ...repaired.map((e) => JSON.stringify(e))]));
    fixed++;
    log('  [已修复] ' + path.relative(ROOT, file));
  } catch (err) {
    failed++;
    log('  [失败] ' + path.relative(ROOT, file) + ' → ' + (err?.message || err));
  }
}

log('');
log('完成：修复 ' + fixed + ' 个，本来就正常 ' + healthy + ' 个，失败 ' + failed + ' 个');
if (fixed) log('请完全退出并重新打开 DeepSeek Harness。');
