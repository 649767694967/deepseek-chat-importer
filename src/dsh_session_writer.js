/**
 * dsh_session_writer.js — 把「标题 + 一组 user/assistant 消息」编码成 DeepSeek Harness
 * 能直接读取的 `session.v4.jsonl.zstd`。
 *
 * 纯 ESM、零依赖、浏览器可直接用（只用 TextEncoder / Uint8Array / crypto.randomUUID(可选)）。
 *
 * 输出物理格式（与真实 DSH 日志同构）：
 *   frame #0 : {"type":"session","version":4,...} + "\n"      ← 一个独立 zstd frame，只含 header 行
 *   frame #n : 若干行 JSON，每行一条事件                          ← 每个 append 批次一个 zstd frame
 * 所有 frame 都是「未压缩 raw block」的 zstd frame，带/不带 content checksum 均可（默认带）。
 *
 * 关键约束（均为实测/读源码得出，见 NOTES.md「实测结论」）：
 *   - header.type === 'session'，version === 4，必含 isSeeded / delegationDepth，不允许多余键
 *   - header 必须是独立的第一个 frame，且内容恰好是一行（以 \n 结尾）
 *   - 事件 seq 从 0 连续、无空洞；每个 frame 的明文必须整行结束
 *   - surface 事件（user/message 等）必须带 surfaceOp:'append'
 *   - assistant/message 必须带 stream 数组，message.source.kind === 'model' 且含 provider/model
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. zstd：未压缩 raw block 编码
// ─────────────────────────────────────────────────────────────────────────────

/** zstd 帧魔数（小端写入为 28 B5 2F FD）。 */
export const ZSTD_MAGIC = 0xfd2fb528;

const BLOCK_MAX = 128 * 1024; // 规范：Block_Maximum_Size = min(128 KiB, Window_Size)
const XXH64_P1 = [0x85ebca87, 0x9e3779b1]; // 0x9E3779B185EBCA87
const XXH64_P2 = [0x27d4eb4f, 0xc2b2ae3d]; // 0xC2B2AE3D27D4EB4F
const XXH64_P3 = [0x9e3779f9, 0x165667b1]; // 0x165667B19E3779F9
const XXH64_P4 = [0xc2b2ae63, 0x85ebca77]; // 0x85EBCA77C2B2AE63
const XXH64_P5 = [0x165667c5, 0x27d4eb2f]; // 0x27D4EB2F165667C5

/** 64 位加法（lo/hi 各 32 位无符号）→ [lo, hi]。 */
function add64(alo, ahi, blo, bhi) {
  let lo = alo + blo;
  let carry = 0;
  if (lo > 0xffffffff) {
    lo -= 0x100000000;
    carry = 1;
  }
  return [lo >>> 0, (ahi + bhi + carry) >>> 0];
}

/** 64 位减法（mod 2^64）→ [lo, hi]。 */
function sub64(alo, ahi, blo, bhi) {
  let lo = alo - blo;
  let borrow = 0;
  if (lo < 0) {
    lo += 0x100000000;
    borrow = 1;
  }
  return [lo >>> 0, (ahi - bhi - borrow) >>> 0];
}

/** 64 位低 64 位乘法（lo/hi 各 32 位无符号）→ [lo, hi]。 */
function mul64(alo, ahi, blo, bhi) {
  const a0 = alo & 0xffff;
  const a1 = alo >>> 16;
  const a2 = ahi & 0xffff;
  const a3 = ahi >>> 16;
  const b0 = blo & 0xffff;
  const b1 = blo >>> 16;
  const b2 = bhi & 0xffff;
  const b3 = bhi >>> 16;
  // 16 位肢的教科书式相乘，进位一律用除法取，避免 JS 位运算把 >2^32 的中间值截断
  let w0 = a0 * b0;
  let c = Math.floor(w0 / 65536);
  w0 -= c * 65536;
  let w1 = a0 * b1 + a1 * b0 + c;
  c = Math.floor(w1 / 65536);
  w1 -= c * 65536;
  let w2 = a0 * b2 + a1 * b1 + a2 * b0 + c;
  c = Math.floor(w2 / 65536);
  w2 -= c * 65536;
  let w3 = a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0 + c;
  w3 %= 65536; // ≥2^64 的高位按 mod 2^64 丢弃
  return [((w0 | (w1 << 16)) >>> 0), ((w2 | (w3 << 16)) >>> 0)];
}

/** 64 位循环左移。 */
function rotl64(lo, hi, n) {
  const r = n & 63;
  if (r === 0) return [lo, hi];
  if (r < 32) return [((lo << r) | (hi >>> (32 - r))) >>> 0, ((hi << r) | (lo >>> (32 - r))) >>> 0];
  if (r === 32) return [hi, lo];
  const m = r - 32;
  return [((hi << m) | (lo >>> (32 - m))) >>> 0, ((lo << m) | (hi >>> (32 - m))) >>> 0];
}

const xor64 = (a, b) => [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];

/** XXH64 的 round：acc += input*P2; acc = rotl(acc,31); acc *= P1。 */
function xxh64Round(accLo, accHi, inLo, inHi) {
  const product = mul64(inLo, inHi, XXH64_P2[0], XXH64_P2[1]);
  let acc = add64(accLo, accHi, product[0], product[1]);
  acc = rotl64(acc[0], acc[1], 31);
  return mul64(acc[0], acc[1], XXH64_P1[0], XXH64_P1[1]);
}

function read32(bytes, i) {
  return (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
}

function read64(bytes, i) {
  return [read32(bytes, i), read32(bytes, i + 4)];
}

/**
 * XXH64（seed = 0），返回 [lo, hi] 两个 32 位无符号数。
 * zstd 帧的 content checksum 取低 32 位。
 * @param {Uint8Array} bytes
 * @param {number} [seed]
 * @returns {[number, number]}
 */
export function xxhash64(bytes, seed = 0) {
  const len = bytes.length;
  let lo;
  let hi;
  let i = 0;
  if (len >= 32) {
    let v1 = add64(seed >>> 0, 0, XXH64_P1[0], XXH64_P1[1]);
    v1 = add64(v1[0], v1[1], XXH64_P2[0], XXH64_P2[1]);
    let v2 = add64(seed >>> 0, 0, XXH64_P2[0], XXH64_P2[1]);
    let v3 = [seed >>> 0, 0];
    let v4 = sub64(seed >>> 0, 0, XXH64_P1[0], XXH64_P1[1]);
    const limit = len - 32;
    while (i <= limit) {
      const k = read64(bytes, i);
      v1 = xxh64Round(v1[0], v1[1], k[0], k[1]);
      const k2 = read64(bytes, i + 8);
      v2 = xxh64Round(v2[0], v2[1], k2[0], k2[1]);
      const k3 = read64(bytes, i + 16);
      v3 = xxh64Round(v3[0], v3[1], k3[0], k3[1]);
      const k4 = read64(bytes, i + 24);
      v4 = xxh64Round(v4[0], v4[1], k4[0], k4[1]);
      i += 32;
    }
    const r1 = rotl64(v1[0], v1[1], 1);
    const r2 = rotl64(v2[0], v2[1], 7);
    const r3 = rotl64(v3[0], v3[1], 12);
    const r4 = rotl64(v4[0], v4[1], 18);
    let acc = add64(r1[0], r1[1], r2[0], r2[1]);
    acc = add64(acc[0], acc[1], r3[0], r3[1]);
    acc = add64(acc[0], acc[1], r4[0], r4[1]);
    lo = acc[0];
    hi = acc[1];
    for (const v of [v1, v2, v3, v4]) {
      const r = xxh64Round(0, 0, v[0], v[1]);
      lo = (lo ^ r[0]) >>> 0;
      hi = (hi ^ r[1]) >>> 0;
      const m = mul64(lo, hi, XXH64_P1[0], XXH64_P1[1]);
      const a = add64(m[0], m[1], XXH64_P4[0], XXH64_P4[1]);
      lo = a[0];
      hi = a[1];
    }
  } else {
    const base = add64(seed >>> 0, 0, XXH64_P5[0], XXH64_P5[1]);
    lo = base[0];
    hi = base[1];
  }
  const total = add64(lo, hi, len >>> 0, 0);
  lo = total[0];
  hi = total[1];

  while (i + 8 <= len) {
    const k = read64(bytes, i);
    const r = xxh64Round(0, 0, k[0], k[1]);
    lo = (lo ^ r[0]) >>> 0;
    hi = (hi ^ r[1]) >>> 0;
    const spin = rotl64(lo, hi, 27);
    const m = mul64(spin[0], spin[1], XXH64_P1[0], XXH64_P1[1]);
    const a = add64(m[0], m[1], XXH64_P4[0], XXH64_P4[1]);
    lo = a[0];
    hi = a[1];
    i += 8;
  }
  if (i + 4 <= len) {
    const v = read32(bytes, i);
    const m = mul64(v, 0, XXH64_P1[0], XXH64_P1[1]);
    lo = (lo ^ m[0]) >>> 0;
    hi = (hi ^ m[1]) >>> 0;
    const spin = rotl64(lo, hi, 23);
    const m2 = mul64(spin[0], spin[1], XXH64_P2[0], XXH64_P2[1]);
    const a = add64(m2[0], m2[1], XXH64_P3[0], XXH64_P3[1]);
    lo = a[0];
    hi = a[1];
    i += 4;
  }
  while (i < len) {
    const m = mul64(bytes[i], 0, XXH64_P5[0], XXH64_P5[1]);
    lo = (lo ^ m[0]) >>> 0;
    hi = (hi ^ m[1]) >>> 0;
    const spin = rotl64(lo, hi, 11);
    const p = mul64(spin[0], spin[1], XXH64_P1[0], XXH64_P1[1]);
    lo = p[0];
    hi = p[1];
    i += 1;
  }
  // avalanche
  return finalizeXXH64(lo, hi);
}

function finalizeXXH64(loIn, hiIn) {
  // 重新做真实的 avalanche（保证 h ^= h >>> 33 等位移正确）
  let h = [loIn >>> 0, hiIn >>> 0];
  const shiftRight = (v, n) => (n >= 32 ? [v[1] >>> (n - 32), 0] : [((v[0] >>> n) | (v[1] << (32 - n))) >>> 0, v[1] >>> n]);
  h = xor64(h, shiftRight(h, 33));
  let m = mul64(h[0], h[1], XXH64_P2[0], XXH64_P2[1]);
  h = xor64(m, shiftRight(m, 29));
  m = mul64(h[0], h[1], XXH64_P3[0], XXH64_P3[1]);
  h = xor64(m, shiftRight(m, 32));
  return h;
}

/**
 * zstd 帧 content checksum：XXH64(明文) 的低 32 位。
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function zstdContentChecksum(bytes) {
  return xxhash64(bytes)[0];
}

/**
 * 编码一个「未压缩 raw block」zstd frame。
 *
 * 帧结构：魔数 | FHD | Window_Descriptor | (raw block)* | [checksum]
 *  - FHD = 0x04 → 无 content size 字段、非 single-segment、带 content checksum、无字典
 *  - 窗口大小取 ≥ 数据长度且 ≥1 KiB 的 2 的幂（上限 128 KiB），因此单个 raw block 可到 128 KiB
 *
 * @param {Uint8Array|ArrayBuffer|string} input 帧明文（字符串按 UTF-8 编码）
 * @param {{checksum?: boolean}} [options] checksum 默认 true
 * @returns {Uint8Array} 完整帧字节
 */
export function encodeZstdFrame(input, options = {}) {
  const data = toBytes(input);
  const checksum = options.checksum !== false;
  const windowLog = Math.min(17, Math.max(10, ceilLog2(Math.max(data.length, 1))));
  const windowSize = 1 << windowLog;
  const blockPayload = Math.min(BLOCK_MAX, windowSize);
  const blockCount = Math.max(1, Math.ceil(data.length / blockPayload));
  const headerSize = 4 + 1 + 1;
  const blocksSize = data.length + blockCount * 3;
  const out = new Uint8Array(headerSize + blocksSize + (checksum ? 4 : 0));
  let p = 0;
  // magic
  out[p++] = ZSTD_MAGIC & 0xff;
  out[p++] = (ZSTD_MAGIC >>> 8) & 0xff;
  out[p++] = (ZSTD_MAGIC >>> 16) & 0xff;
  out[p++] = (ZSTD_MAGIC >>> 24) & 0xff;
  // frame header descriptor
  out[p++] = checksum ? 0x04 : 0x00;
  // window descriptor: Exponent = windowLog - 10, Mantissa = 0
  out[p++] = ((windowLog - 10) << 3) & 0xff;
  // blocks
  for (let b = 0; b < blockCount; b += 1) {
    const start = b * blockPayload;
    const end = Math.min(data.length, start + blockPayload);
    const size = end - start;
    const last = b === blockCount - 1 ? 1 : 0;
    const blockHeader = (size << 3) | 0 | last; // type 0 = Raw_Block
    out[p++] = blockHeader & 0xff;
    out[p++] = (blockHeader >>> 8) & 0xff;
    out[p++] = (blockHeader >>> 16) & 0xff;
    out.set(data.subarray(start, end), p);
    p += size;
  }
  if (checksum) {
    const sum = zstdContentChecksum(data);
    new DataView(out.buffer).setUint32(p, sum >>> 0, true);
    p += 4;
  }
  return out.subarray(0, p);
}

function ceilLog2(n) {
  let log = 0;
  while (1 << log < n) log += 1;
  return log;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new TextEncoder().encode(String(input));
}

/** 把多个 Uint8Array 顺序拼成一个。 */
export function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 磁盘布局（与 dsh-session-persistence-jsonl 的 format.ts 一一对应）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * cwd → 项目目录名。规则：`/` `\` `:` 的连续段折叠成单个 `-`；`[A-Za-z0-9._-]` 原样保留；
 * 其余（含 `~`）写成 `~XXXX`（UTF-16 码元大写十六进制）；最后包成 `--…--`，最多 251 字符。
 * @param {string} cwd
 * @returns {string}
 */
export function workspaceKey(cwd) {
  if (!cwd) throw new Error('cwd 不能为空');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * 会话 id → 单个安全路径段（`~XXXX` 转义，`.` / `..` 特判）。
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  if (!raw) throw new Error('session id 不能为空');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** 当前会话日志文件名（v4 + zstd）。 */
export const SESSION_LOG_FILENAME = 'session.v4.jsonl.zstd';

/**
 * 是否绝对路径（POSIX `/…`、Windows 盘符 `X:\` / `X:/`、UNC `\\server\share`）。
 * DSH 的 header 校验要求 `cwd` 必须是绝对路径，否则日志会被拒绝读取。
 * @param {string} value
 * @returns {boolean}
 */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\')) return true;
  return false;
}

/**
 * 相对会话根目录的落盘路径：`<workspace-key>/<encoded-id>/session.v4.jsonl.zstd`。
 * @param {{cwd: string, id: string}} params
 * @returns {string} 用 `/` 分隔的相对路径
 */
export function sessionRelativePath({ cwd, id }) {
  return `${workspaceKey(cwd)}/${encodeSegment(id)}/${SESSION_LOG_FILENAME}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 事件流构造
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = 'deepseek-account';
const DEFAULT_MODEL = 'deepseek-v4-pro';

function randomIdFactory(deterministic) {
  let counter = 0;
  if (!deterministic && typeof globalThis.crypto?.randomUUID === 'function') {
    return () => globalThis.crypto.randomUUID();
  }
  return () => {
    counter += 1;
    const hex = counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  };
}

function approxTokens(text) {
  if (!text) return 0;
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 0x2e80 ? 0.6 : 0.3;
  return Math.max(1, Math.round(n));
}

/**
 * 由「会话标题 + 消息列表」构造完整事件数组（含 header）。
 *
 * messages 支持两种形状：
 *   { role:'user'|'assistant', text, reasoning?, time? }
 *   或 { role, content:[{type,text}], time? }
 *
 * @param {object} params
 * @param {string} params.id 会话 id（形如 `session-<uuid>`；不含则以 uuid 生成）
 * @param {string} params.cwd 项目目录绝对路径
 * @param {number} [params.createdAt] 会话创建时间（ms）
 * @param {string} [params.title] 会话标题（写入 session/title）
 * @param {Array<object>} [params.messages]
 * @param {string} [params.provider]
 * @param {string} [params.model]
 * @param {string} [params.reasoningEffort] 'low' | 'medium' | 'high' | 'max'
 * @param {string} [params.preset] permission preset，默认 'danger-full-access'
 * @param {string} [params.sandboxMode] 默认与 preset 相同
 * @param {string} [params.approvalPolicy] 默认 'never'
 * @param {boolean} [params.withModelSelection] 是否写 model/selection（默认 true）
 * @param {boolean} [params.withRequestContext] 是否写 request/context（默认 true）
 * @param {boolean} [params.withSessionTitle] 是否写 session/title（默认 true）
 * @param {boolean} [params.deterministic] 用可复现的 id 生成器（测试用）
 * @returns {{header: object, events: Array<object>}}
 */
export function buildSessionEvents(params) {
  const {
    id,
    cwd,
    createdAt = Date.now(),
    title = '',
    messages = [],
    provider = DEFAULT_PROVIDER,
    model = DEFAULT_MODEL,
    reasoningEffort = 'high',
    preset = 'danger-full-access',
    sandboxMode = preset,
    approvalPolicy = 'never',
    withModelSelection = true,
    withRequestContext = true,
    withSessionTitle = true,
    deterministic = true,
  } = params;

  if (!id) throw new Error('buildSessionEvents 需要 id');
  if (!cwd) throw new Error('buildSessionEvents 需要 cwd（且必须是绝对路径）');
  if (!isAbsolutePath(cwd)) throw new Error(`cwd 必须是绝对路径（DSH header 会拒绝非绝对路径）：${cwd}`);

  const newId = randomIdFactory(deterministic);
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  };

  /** @type {Array<object>} */
  const events = [];
  let clock = createdAt;
  const tick = (delta = 1) => {
    clock += delta;
    return clock;
  };
  const push = (type, data, extra) => {
    events.push({ type, seq: events.length, time: tick(), data, ...extra });
  };

  push('permission/preset', { preset });
  push('sandbox/mode', { mode: sandboxMode });
  push('approval/policy', { policy: approvalPolicy });
  push('session/end-seed', {});
  if (withModelSelection) push('model/selection', { provider, model, reasoningEffort });

  const normalised = messages.map((message) => normaliseMessage(message));
  const userEvents = [];
  let turn = 0;
  for (let i = 0; i < normalised.length; i += 1) {
    const message = normalised[i];
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      turn += 1;
      push('turn/start', { turn });
      push('step/start', { turn, step: 1 });
      const userId = newId();
      push(
        'user/message',
        {
          content: message.content,
          source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
          role: 'user',
          id: userId,
        },
        { surfaceOp: 'append' },
      );
      const userSeq = events.length - 1;
      userEvents.push(userSeq);
      if (withSessionTitle && title && userEvents.length === 1) {
        push('session/title', { title, messageSeqs: [userSeq], source: { kind: 'fallback' } });
      }
      if (withRequestContext) {
        push('request/context', { provider, model, contextWindow: 1048576 });
      }
      continue;
    }
    // assistant：必须落在已开 turn 的 step 内
    if (turn === 0) {
      turn += 1;
      push('turn/start', { turn });
      push('step/start', { turn, step: 1 });
    }
    const input = message.inputTokens ?? 0;
    const output = approxTokens(jsonText(message.content));
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        content: message.content,
        source: { kind: 'model', provider, model },
        id: newId(),
      },
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: input + output,
      },
      stream: [],
    }, { surfaceOp: 'append' });
    const last = normalised[i + 1];
    if (!last || last.role === 'user') {
      push('step/end', { turn, step: 1 });
      push('turn/end', { turn, reason: { kind: 'completed' } });
    }
  }
  return { header, events };
}

/**
 * 把宽松的输入（`text` / `content:[...]`）规整成 DSH 的 content block 数组。
 * @param {object} message
 * @returns {{role: string, content: Array<object>}}
 */
function normaliseMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('消息必须是对象');
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
  const blocks = [];
  const pushBlock = (type, text) => {
    if (typeof text !== 'string' || text === '') return;
    blocks.push({ type, text });
  };
  if (message.reasoning) pushBlock('reasoning', String(message.reasoning));
  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (typeof item === 'string') pushBlock('text', item);
      else if (item && typeof item === 'object') pushBlock(item.type === 'reasoning' ? 'reasoning' : 'text', item.text);
    }
  }
  if (typeof message.text === 'string') pushBlock('text', message.text);
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return { role, content: blocks };
}

function jsonText(value) {
  return JSON.stringify(value ?? '');
}

/**
 * 构造可直接落盘的字节：header 单独一帧，事件按批次分帧。
 * 每个 frame 的明文都以 `\n` 结尾，这是 DSH 扫描器的硬要求。
 *
 * @param {{header: object, events: Array<object>}} built
 * @param {{checksum?: boolean, batchSize?: number}} [options]
 * @returns {Uint8Array}
 */
export function encodeSessionLog(built, options = {}) {
  const checksum = options.checksum !== false;
  const batchSize = options.batchSize ?? 1; // 真实 DSH 每个 append 批次一帧；1 = 每事件一帧
  const frames = [];
  frames.push(encodeZstdFrame(`${JSON.stringify(built.header)}\n`, { checksum }));
  let buffer = '';
  let pending = 0;
  for (const event of built.events) {
    buffer += `${JSON.stringify(event)}\n`;
    pending += 1;
    if (pending >= batchSize) {
      frames.push(encodeZstdFrame(buffer, { checksum }));
      buffer = '';
      pending = 0;
    }
  }
  if (buffer) frames.push(encodeZstdFrame(buffer, { checksum }));
  return concatBytes(frames);
}

/**
 * 一步到位：标题 + 消息 → `session.v4.jsonl.zstd` 字节 + 落盘位置。
 *
 * @param {object} params 见 {@link buildSessionEvents}，另支持 checksum / batchSize
 * @returns {{bytes: Uint8Array, header: object, events: Array<object>, id: string,
 *            relativePath: string, fileName: string, eventCount: number}}
 */
export function buildSessionLog(params) {
  const built = buildSessionEvents(params);
  const bytes = encodeSessionLog(built, { checksum: params.checksum, batchSize: params.batchSize });
  return {
    bytes,
    header: built.header,
    events: built.events,
    id: built.header.id,
    relativePath: sessionRelativePath({ cwd: built.header.cwd, id: built.header.id }),
    fileName: SESSION_LOG_FILENAME,
    eventCount: built.events.length,
  };
}

/** 生成一个新会话 id（`session-<uuid>`）。 */
export function newSessionId() {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
  return `session-${uuid}`;
}

export const __internal = { add64, mul64, rotl64, finalizeXXH64, toBytes, ceilLog2 };
