/**
 * zipkit.js — 零依赖 ZIP 读写工具（浏览器 / Node 通用 ESM）
 * ============================================================================
 * 设计目标
 *   · 纯 JS，无任何第三方依赖，也不静态 import 任何 Node 内置模块（浏览器可直接加载）
 *   · 读侧两段式：openZip() 只解析 EOCD + central directory 建索引（不解压任何数据），
 *     之后按需 read()/readEntry() 单独解一个条目 —— 80MB 的 DeepSeek 导出 zip 里
 *     77MB 是图片，网页可以只解 json、图片以后再说，内存不会爆
 *   · 写入侧：本地文件头直接写 crc/size（不写数据描述符），UTF-8 文件名 flag(bit 11)
 *     始终置位，central directory + EOCD(+ZIP64) 按规范输出，fflate / JSZip 可直接读
 *
 * 解压后端（method 8 deflate）
 *   1) DecompressionStream('deflate-raw')（浏览器原生，Chromium 103+/Safari 16.4+）
 *   2) 本文件内置的纯 JS raw-inflate（同步、任何环境可用）
 *   3) Node 环境下才走 `await import('node:zlib')`（动态引入，浏览器端永远不会执行到）
 *   每一步都用 CRC32 校验，native 结果不对会自动回退到纯 JS。
 *
 * 压缩后端（写入 method 8）
 *   1) 调用方注入的 options.compressor（测试里用 zlib.deflateRawSync 验证兼容性）
 *   2) CompressionStream('deflate-raw')
 *   3) Node：动态 import('node:zlib').deflateRawSync（仅 Node，浏览器不进入该分支）
 *   4) 全不可用 → 退化为 store（method 0），产出的 zip 依然合法
 *
 * 快速上手
 *   const zip = await openZip(bytesOrFile);
 *   zip.entries;                                  // [{ path, method, compressedSize, uncompressedSize, crc32, ... }]
 *   zip.has('chat_session_index.json');
 *   const data = await zip.read('chat_session_index.json');   // Uint8Array，只解这一个
 *   const idx  = await zip.json('chat_session_index.json');
 *
 *   await readZip(file, { filter: '/\.json$/'.replace... }); // 见 makeFilter
 *   await readZip(file, { filter: (e) => e.path.endsWith('.json'),
 *                         onEntry({ path, data }) { ... } });  // 逐个回调，不留全量内存
 *
 *   const out = await writeZip([
 *     { path: 'manifest.json', data: JSON.stringify(m) },
 *     { path: 'sessions/中文/session.json', data: jsonBytes, deflate: true },
 *   ]);                                            // → Uint8Array(.cbx 内容)
 *
 * @version 1.0.0
 */

export const VERSION = '1.0.0';

/* ==========================================================================
 * 0. 基础工具
 * ========================================================================== */

const EMPTY = new Uint8Array(0);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;

const FLAG_UTF8 = 0x0800; // general purpose bit 11
const FLAG_DESCRIPTOR = 0x0008; // general purpose bit 3（尺寸写在数据描述符里）

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function u64(b, o) {
  return u32(b, o) + u32(b, o + 4) * 4294967296;
}
function has(haystack, needle, at) {
  for (let i = 0; i < needle.length; i++) if (haystack[at + i] !== needle[i]) return false;
  return true;
}

const textDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

function decodeUtf8(bytes) {
  if (textDecoder) return textDecoder.decode(bytes);
  // 极端退化环境
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += '%' + bytes[i].toString(16).padStart(2, '0');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function encodeUtf8(str) {
  if (textEncoder) return textEncoder.encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/** 统一的错误前缀，便于页面区分「zip 坏了」和别的错误 */
function zipError(message) {
  const err = new Error(`zipkit: ${message}`);
  err.name = 'ZipError';
  return err;
}

function isNode() {
  try {
    return !!(globalThis.process && globalThis.process.versions && globalThis.process.versions.node);
  } catch {
    return false;
  }
}

function concatBytes(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  let len = total;
  if (len === undefined) {
    len = 0;
    for (const c of chunks) len += c.length;
  }
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function toBytes(data) {
  if (data == null) return EMPTY;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return encodeUtf8(data);
  if (typeof data.arrayBuffer === 'function') {
    throw zipError('writeZip 需要已读好的字节，请先 await blob.arrayBuffer() 再传入');
  }
  throw zipError(`无法识别的 data 类型: ${Object.prototype.toString.call(data)}`);
}

/* ==========================================================================
 * 1. CRC32
 * ========================================================================== */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

/**
 * 计算 CRC32（IEEE 802.3，zip 用的那个）。
 * @param {Uint8Array|ArrayBuffer|string} bytes
 * @param {number} [previous] 上一次 crc32 的返回值，用于分块累加
 * @returns {number} 无符号 32 位
 */
export function crc32(bytes, previous = 0) {
  const buf = typeof bytes === 'string' ? encodeUtf8(bytes) : toBytes(bytes);
  const t = crcTable();
  let c = (previous ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 增量 CRC32：new Crc32().update(a).update(b).digest() === crc32(concat(a,b)) */
export class Crc32 {
  constructor() {
    this.crc = 0;
    this.length = 0;
  }
  update(bytes) {
    const buf = typeof bytes === 'string' ? encodeUtf8(bytes) : toBytes(bytes);
    this.crc = crc32(buf, this.crc);
    this.length += buf.length;
    return this;
  }
  digest() {
    return this.crc;
  }
  reset() {
    this.crc = 0;
    this.length = 0;
    return this;
  }
  /** 8 位小写 hex，顺带方便调试 */
  hex() {
    return this.crc.toString(16).padStart(8, '0');
  }
}

/* ==========================================================================
 * 2. 纯 JS raw inflate（RFC 1951）
 * ========================================================================== */

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const FAST_BITS = 10;

/** LSB-first 位读取器 */
class BitReader {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  ensure(n) {
    while (this.bitcnt < n) {
      const byte = this.pos < this.src.length ? this.src[this.pos++] : 0;
      this.bitbuf |= byte << this.bitcnt;
      this.bitcnt += 8;
    }
  }
  peek(n) {
    this.ensure(n);
    return this.bitbuf & ((1 << n) - 1);
  }
  drop(n) {
    this.bitbuf >>>= n;
    this.bitcnt -= n;
  }
  take(n) {
    if (n === 0) return 0;
    this.ensure(n);
    const v = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return v;
  }
  align() {
    const r = this.bitcnt & 7;
    if (r) this.drop(r);
  }
  /** 调用前必须 align()；把 len 个整字节写进 dest[off..] */
  readBytes(dest, off, len) {
    while (len > 0 && this.bitcnt >= 8) {
      dest[off++] = this.bitbuf & 0xff;
      this.drop(8);
      len--;
    }
    if (len > 0) {
      dest.set(this.src.subarray(this.pos, this.pos + len), off);
      this.pos += len;
    }
  }
}

/**
 * 构建 canonical Huffman 解码表。
 * fast 表项 = (symbol << 5) | codeLength，0 表示需要走慢路径。
 */
function buildHuffman(lengths, n) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  let total = 0;
  for (let len = 1; len < 16; len++) {
    offsets[len] = total;
    total += counts[len];
  }
  const symbols = new Uint16Array(total);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l) symbols[offsets[l]++] = i;
  }
  const fast = new Int32Array(1 << FAST_BITS);
  let code = 0;
  let k = 0;
  for (let len = 1; len < 16; len++) {
    for (let i = 0; i < counts[len]; i++) {
      const sym = symbols[k++];
      if (len <= FAST_BITS) {
        let rev = 0;
        for (let b = 0; b < len; b++) rev |= ((code >> b) & 1) << (len - 1 - b);
        const entry = (sym << 5) | len;
        const stride = 1 << len;
        for (let j = rev; j < 1 << FAST_BITS; j += stride) fast[j] = entry;
      }
      code++;
    }
    code <<= 1;
  }
  return { counts, symbols, fast };
}

function decodeSlow(h, br) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.take(1);
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw zipError('deflate 数据损坏（非法 Huffman 编码）');
}

function decodeSym(h, br) {
  const entry = h.fast[br.peek(FAST_BITS)];
  if (entry !== 0) {
    const len = entry & 31;
    if (len <= br.bitcnt) {
      br.drop(len);
      return entry >>> 5;
    }
  }
  return decodeSlow(h, br);
}

let FIXED_LIT = null;
let FIXED_DIST = null;
function fixedTables() {
  if (!FIXED_LIT) {
    const lit = new Uint8Array(288);
    for (let i = 0; i < 144; i++) lit[i] = 8;
    for (let i = 144; i < 256; i++) lit[i] = 9;
    for (let i = 256; i < 280; i++) lit[i] = 7;
    for (let i = 280; i < 288; i++) lit[i] = 8;
    const dist = new Uint8Array(32).fill(5);
    FIXED_LIT = buildHuffman(lit, 288);
    FIXED_DIST = buildHuffman(dist, 32);
  }
  return { lit: FIXED_LIT, dist: FIXED_DIST };
}

/**
 * 纯 JS raw deflate 解压（RFC 1951，不含 zlib 头）。
 * @param {Uint8Array} src
 * @param {number} [sizeHint] 已知解压后大小（来自 central directory），可省去扩容拷贝
 * @returns {Uint8Array}
 */
export function inflateRaw(src, sizeHint = 0) {
  const input = toBytes(src);
  const br = new BitReader(input);
  let out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(1024, input.length * 4));
  let op = 0;

  const reserve = (need) => {
    if (op + need <= out.length) return;
    let cap = out.length || 1024;
    while (cap < op + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, op));
    out = next;
  };

  let last = 0;
  while (!last) {
    last = br.take(1);
    const type = br.take(2);
    if (type === 0) {
      // stored block
      br.align();
      const len = br.take(16);
      const nlen = br.take(16);
      if ((len ^ 0xffff) !== nlen) throw zipError('deflate 数据损坏（stored block 长度不匹配）');
      reserve(len);
      br.readBytes(out, op, len);
      op += len;
    } else if (type === 3) {
      throw zipError('deflate 数据损坏（非法 block type）');
    } else {
      let lit;
      let dist;
      if (type === 1) {
        const t = fixedTables();
        lit = t.lit;
        dist = t.dist;
      } else {
        const hlit = br.take(5) + 257;
        const hdist = br.take(5) + 1;
        const hclen = br.take(4) + 4;
        const clLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = br.take(3);
        const clh = buildHuffman(clLengths, 19);
        const lengths = new Uint8Array(hlit + hdist);
        let i = 0;
        const totalCodes = hlit + hdist;
        while (i < totalCodes) {
          const sym = decodeSym(clh, br);
          if (sym < 16) lengths[i++] = sym;
          else {
            let repeat;
            let value = 0;
            if (sym === 16) {
              if (i === 0) throw zipError('deflate 数据损坏（重复码长度但无前值）');
              value = lengths[i - 1];
              repeat = 3 + br.take(2);
            } else if (sym === 17) repeat = 3 + br.take(3);
            else repeat = 11 + br.take(7);
            if (i + repeat > totalCodes) throw zipError('deflate 数据损坏（码长度重复越界）');
            while (repeat--) lengths[i++] = value;
          }
        }
        lit = buildHuffman(lengths.subarray(0, hlit), hlit);
        dist = buildHuffman(lengths.subarray(hlit), hdist);
      }
      for (;;) {
        const sym = decodeSym(lit, br);
        if (sym < 256) {
          reserve(1);
          out[op++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw zipError('deflate 数据损坏（非法长度符号）');
          const len = LEN_BASE[li] + br.take(LEN_EXTRA[li]);
          const dsym = decodeSym(dist, br);
          if (dsym >= 30) throw zipError('deflate 数据损坏（非法距离符号）');
          const d = DIST_BASE[dsym] + br.take(DIST_EXTRA[dsym]);
          if (d > op) throw zipError('deflate 数据损坏（距离超出已解压长度）');
          reserve(len);
          let from = op - d;
          for (let k = 0; k < len; k++) out[op++] = out[from++];
        }
      }
    }
  }
  return op === out.length ? out : out.subarray(0, op);
}

/* ==========================================================================
 * 3. 压缩（写入用，异步）
 * ========================================================================== */

async function streamThrough(transform, bytes) {
  const writePromise = (async () => {
    const writer = transform.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
  })();
  const chunks = [];
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writePromise;
  return concatBytes(chunks);
}

async function nativeDeflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  return streamThrough(new CompressionStream('deflate-raw'), bytes);
}

async function nativeInflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') return null;
  return streamThrough(new DecompressionStream('deflate-raw'), bytes);
}

/**
 * 尽力做 raw deflate 压缩。
 * @returns {Promise<Uint8Array|null>} 环境不支持时返回 null（调用方应退化为 store）
 */
export async function deflateRaw(bytes) {
  const buf = toBytes(bytes);
  try {
    const native = await nativeDeflateRaw(buf);
    if (native && native.length) return native;
  } catch {
    /* 继续尝试下一种后端 */
  }
  if (isNode()) {
    try {
      // 仅在 Node 下动态引入，浏览器打包/运行都不会碰到这行
      const zlib = await import('node:zlib');
      const raw = zlib.deflateRawSync ? zlib.deflateRawSync(buf) : null;
      if (raw && raw.length) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

async function inflateEntryData(method, raw, sizeHint, options) {
  if (method === 0) return raw;
  if (method !== 8) throw zipError(`不支持的压缩方法 ${method}（本工具只支持 0 = store / 8 = deflate）`);
  const mode = options.inflate || 'auto';
  let nativeError = null;
  if (mode !== 'js') {
    try {
      const native = await nativeInflateRaw(raw);
      if (native) return native;
    } catch (err) {
      nativeError = err;
    }
  }
  let jsError = null;
  try {
    return inflateRaw(raw, sizeHint);
  } catch (err) {
    jsError = err;
  }
  if (isNode()) {
    try {
      const zlib = await import('node:zlib');
      if (zlib.inflateRawSync) {
        const buf = zlib.inflateRawSync(raw);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
    } catch {
      /* 忽略，抛下面的错 */
    }
  }
  throw zipError(`解压失败（method 8）：${(jsError || nativeError || new Error('unknown')).message}`);
}

/* ==========================================================================
 * 4. 输入源：Uint8Array / ArrayBuffer / Blob / File / 自定义 {size, read}
 * ========================================================================== */

/**
 * 把一个随机可读的字节源包装成 openZip 接受的 source。
 * 网页里直接传 File 也行（内部按需 slice，不会一次性读 80MB）。
 */
export function sourceFromBytes(bytes) {
  const buf = toBytes(bytes);
  return {
    size: buf.length,
    readSync: (offset, length) => buf.subarray(offset, Math.min(buf.length, offset + length)),
    read: async (offset, length) => buf.subarray(offset, Math.min(buf.length, offset + length)),
    buffer: buf,
  };
}

export function sourceFromBlob(blob) {
  if (!blob || typeof blob.slice !== 'function') throw zipError('sourceFromBlob 需要一个 Blob/File');
  return {
    size: blob.size,
    read: async (offset, length) => {
      const end = Math.min(blob.size, offset + length);
      const slice = blob.slice(offset, end);
      const ab = await slice.arrayBuffer();
      return new Uint8Array(ab);
    },
  };
}

function normalizeSource(src) {
  if (src == null) throw zipError('openZip 需要 zip 字节或字节源');
  if (typeof src === 'string') {
    throw zipError('不接受字符串路径，请先读成 Uint8Array / ArrayBuffer，或传 File/Blob');
  }
  if (src instanceof Uint8Array || src instanceof ArrayBuffer || ArrayBuffer.isView(src)) {
    return sourceFromBytes(src);
  }
  if (typeof src.read === 'function' && typeof src.size === 'number') return src;
  if (typeof src.arrayBuffer === 'function' || typeof src.slice === 'function') return sourceFromBlob(src);
  throw zipError('无法识别的输入源（需要 Uint8Array / ArrayBuffer / Blob / File / {size, read}）');
}

async function readAt(src, offset, length) {
  if (offset < 0 || length < 0) throw zipError(`越界读取 offset=${offset} length=${length}`);
  if (offset + length > src.size) {
    length = Math.max(0, src.size - offset);
  }
  if (typeof src.readSync === 'function') return src.readSync(offset, length);
  return src.read(offset, length);
}

function readAtSync(src, offset, length) {
  if (typeof src.readSync !== 'function') throw zipError('该字节源不支持同步读取');
  return src.readSync(offset, Math.min(length, src.size - offset));
}

/* ==========================================================================
 * 5. EOCD / central directory 解析
 * ========================================================================== */

async function findEocd(src) {
  const size = src.size;
  if (size < 22) throw zipError('文件太小，不是 zip');
  const tailLen = Math.min(size, 22 + MAX16);
  const base = size - tailLen;
  const tail = await readAt(src, base, tailLen);
  const sig = [0x50, 0x4b, 0x05, 0x06];
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b) continue;
    if (!has(tail, sig, i)) continue;
    const commentLen = u16(tail, i + 20);
    if (i + 22 + commentLen > tailLen) continue;
    return { eocdOffset: base + i, tail, at: i };
  }
  throw zipError('找不到 EOCD 记录（可能不是 zip，或文件被截断）');
}

async function readZip64Eocd(src, eocdOffset) {
  if (eocdOffset < 20) throw zipError('ZIP64 locator 位置非法');
  const locator = await readAt(src, eocdOffset - 20, 20);
  if (u32(locator, 0) !== SIG_EOCD64_LOCATOR) throw zipError('ZIP64 EOCD locator 缺失');
  const eocd64Offset = u64(locator, 8);
  const rec = await readAt(src, eocd64Offset, 56);
  if (u32(rec, 0) !== SIG_EOCD64) throw zipError('ZIP64 EOCD 记录缺失');
  return {
    count: u64(rec, 32),
    cdSize: u64(rec, 40),
    cdOffset: u64(rec, 48),
  };
}

function parseExtraFields(extra) {
  const fields = [];
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = u16(extra, p);
    const size = u16(extra, p + 2);
    const end = Math.min(extra.length, p + 4 + size);
    fields.push({ id, body: extra.subarray(p + 4, end) });
    p += 4 + size;
  }
  return fields;
}

function applyZip64Extra(entry, fields) {
  for (const field of fields) {
    if (field.id !== 0x0001) continue;
    const body = field.body;
    let q = 0;
    if (entry.uncompressedSize === MAX32 && q + 8 <= body.length) {
      entry.uncompressedSize = u64(body, q);
      q += 8;
    }
    if (entry.compressedSize === MAX32 && q + 8 <= body.length) {
      entry.compressedSize = u64(body, q);
      q += 8;
    }
    if (entry.localHeaderOffset === MAX32 && q + 8 <= body.length) {
      entry.localHeaderOffset = u64(body, q);
      q += 8;
    }
    if (entry.diskStart === MAX16 && q + 4 <= body.length) entry.diskStart = u32(body, q);
    break;
  }
}

function makeEntry(raw, index) {
  const path = raw.path.replace(/\\/g, '/').replace(/^\.\//, '');
  const entry = {
    index,
    path,
    rawPath: raw.path,
    name: path,
    isDirectory: path.endsWith('/'),
    method: raw.method,
    flags: raw.flags,
    utf8: (raw.flags & FLAG_UTF8) !== 0,
    crc32: raw.crc32,
    compressedSize: raw.compressedSize,
    uncompressedSize: raw.uncompressedSize,
    /** @deprecated 兼容别名 */
    size: raw.uncompressedSize,
    localHeaderOffset: raw.localHeaderOffset,
    versionNeeded: raw.versionNeeded,
    versionMadeBy: raw.versionMadeBy,
    dosTime: raw.dosTime,
    dosDate: raw.dosDate,
    internalAttributes: raw.internalAttributes,
    externalAttributes: raw.externalAttributes,
    extra: raw.extra,
    comment: raw.comment,
    lastMod: dosToDate(raw.dosDate, raw.dosTime),
    get dataOffset() {
      return this._dataOffset;
    },
  };
  return entry;
}

function dosToDate(dosDate, dosTime) {
  if (!dosDate && !dosTime) return null;
  const day = dosDate & 31;
  const month = (dosDate >> 5) & 15;
  const year = ((dosDate >> 9) & 127) + 1980;
  const sec = (dosTime & 31) * 2;
  const min = (dosTime >> 5) & 63;
  const hour = (dosTime >> 11) & 31;
  if (month < 1 || month > 12 || day < 1) return null;
  const d = new Date(year, month - 1, day, hour, min, sec);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function readCentralDirectory(src, eocdInfo) {
  const { tail, at, eocdOffset } = eocdInfo;
  let count = u16(tail, at + 10);
  let cdSize = u32(tail, at + 12);
  let cdOffset = u32(tail, at + 16);
  const commentLen = u16(tail, at + 20);
  const diskNo = u16(tail, at + 4);
  const cdDisk = u16(tail, at + 6);
  const diskCount = u16(tail, at + 8);

  let zip64 = false;
  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32 || diskCount === MAX16) {
    const z64 = await readZip64Eocd(src, eocdOffset);
    count = z64.count;
    cdSize = z64.cdSize;
    cdOffset = z64.cdOffset;
    zip64 = true;
  }
  if (diskNo !== 0 || cdDisk !== 0) throw zipError('不支持分卷 zip');

  if (cdOffset + cdSize > src.size) throw zipError('central directory 越界（zip 被截断？）');

  const cd = await readAt(src, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length) throw zipError(`central directory 提前结束（第 ${i} 条）`);
    if (u32(cd, p) !== SIG_CENTRAL) throw zipError(`central directory 签名错误（第 ${i} 条，offset ${p}）`);
    const versionMadeBy = u16(cd, p + 4);
    const versionNeeded = u16(cd, p + 6);
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const dosTime = u16(cd, p + 12);
    const dosDate = u16(cd, p + 14);
    const crc = u32(cd, p + 16);
    const compressedSize = u32(cd, p + 20);
    const uncompressedSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen2 = u16(cd, p + 32);
    const diskStart = u16(cd, p + 34);
    const internalAttributes = u16(cd, p + 36);
    const externalAttributes = u32(cd, p + 38);
    const localHeaderOffset = u32(cd, p + 42);
    const nameStart = p + 46;
    const nameBytes = cd.subarray(nameStart, nameStart + nameLen);
    const extra = cd.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
    const comment = cd.subarray(nameStart + nameLen + extraLen, nameStart + nameLen + extraLen + commentLen2);
    p = nameStart + nameLen + extraLen + commentLen2;

    const entry = {
      path: decodeUtf8(nameBytes),
      rawPathBytes: nameBytes,
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      diskStart,
      versionNeeded,
      versionMadeBy,
      dosTime,
      dosDate,
      internalAttributes,
      externalAttributes,
      extra,
      comment: decodeUtf8(comment),
    };
    const fields = parseExtraFields(extra);
    applyZip64Extra(entry, fields);
    entry.extraFields = fields;
    if (entry.diskStart !== 0) throw zipError('不支持分卷 zip（diskStart != 0）');
    entries.push(makeEntry(entry, i));
  }

  return {
    entries,
    comment: decodeUtf8(tail.subarray(at + 22, at + 22 + commentLen)),
    zip64,
    cdOffset,
    cdSize,
    declaredCount: count,
    fieldsLoaded: entries.length,
  };
}

/* ==========================================================================
 * 6. openZip —— 两段式读取（建索引 → 按需解压）
 * ========================================================================== */

/**
 * 打开 zip，只解析索引，不解压任何数据。
 * @param {Uint8Array|ArrayBuffer|Blob|File|{size:number,read:Function}} source
 * @param {{inflate?: 'auto'|'js'|'native', verifyCrc?: boolean, encoding?: string}} [options]
 * @returns {Promise<ZipArchive>}
 */
export async function openZip(source, options = {}) {
  const src = normalizeSource(source);
  const eocdInfo = await findEocd(src);
  const dir = await readCentralDirectory(src, eocdInfo);
  const byPath = new Map();
  for (const entry of dir.entries) byPath.set(entry.path, entry);

  const stats = { count: dir.entries.length, files: 0, directories: 0, uncompressedSize: 0, compressedSize: 0 };
  for (const e of dir.entries) {
    if (e.isDirectory) stats.directories++;
    else stats.files++;
    stats.uncompressedSize += e.uncompressedSize;
    stats.compressedSize += e.compressedSize;
  }

  const opts = {
    inflate: options.inflate || 'auto',
    verifyCrc: options.verifyCrc !== false,
    encoding: options.encoding || 'utf-8',
  };

  /** 读取单条目的原始（压缩态）字节，不解压 */
  async function readRaw(entryOrPath) {
    const entry = resolveEntry(entryOrPath);
    if (entry.isDirectory) {
      entry._dataOffset = entry.localHeaderOffset + 30;
      return EMPTY;
    }
    const local = await readAt(src, entry.localHeaderOffset, 30);
    if (local.length < 30 || u32(local, 0) !== SIG_LOCAL) {
      throw zipError(`本地文件头损坏: ${entry.path}`);
    }
    const nameLen = u16(local, 26);
    const extraLen = u16(local, 28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;
    entry._dataOffset = dataOffset;

    let csize = entry.compressedSize;
    if (csize === 0 && entry.uncompressedSize === 0 && entry.flags & FLAG_DESCRIPTOR) {
      const resolved = resolveDescriptorSizes(src, entry, dataOffset);
      if (resolved) {
        entry.compressedSize = resolved.compressedSize;
        entry.uncompressedSize = resolved.uncompressedSize;
        entry.crc32 = resolved.crc32;
        entry.size = resolved.uncompressedSize;
        csize = resolved.compressedSize;
      }
    }
    if (csize === 0) return EMPTY;
    return readAt(src, dataOffset, csize);
  }

  /** 读并解压单个条目 */
  async function readEntry(entryOrPath, readOptions) {
    const entry = resolveEntry(entryOrPath);
    if (entry.isDirectory) return EMPTY;
    const raw = await readRaw(entry);
    const data = await inflateEntryData(entry.method, raw, entry.uncompressedSize, { ...opts, ...readOptions });
    if (opts.verifyCrc && entry.crc32 !== 0 && crc32(data) !== entry.crc32) {
      // native 后端可能因为环境怪异产出坏数据：auto 模式下再用纯 JS 兜一次
      if (entry.method === 8 && opts.inflate === 'auto') {
        const retry = await inflateEntryData(entry.method, raw, entry.uncompressedSize, { ...opts, inflate: 'js', ...readOptions });
        if (crc32(retry) === entry.crc32) return retry;
      }
      throw zipError(`CRC32 校验失败: ${entry.path}（zip 可能已损坏）`);
    }
    if (entry.uncompressedSize && data.length !== entry.uncompressedSize) {
      throw zipError(`解压大小不符: ${entry.path}（期望 ${entry.uncompressedSize}，实际 ${data.length}）`);
    }
    return data;
  }

  function resolveEntry(entryOrPath) {
    if (entryOrPath == null) throw zipError('entry 为空');
    if (typeof entryOrPath === 'string') {
      const norm = entryOrPath.replace(/\\/g, '/').replace(/^\.\//, '');
      const found = byPath.get(norm);
      if (!found) throw zipError(`zip 里没有这个条目: ${entryOrPath}`);
      return found;
    }
    if (typeof entryOrPath === 'object') {
      if (typeof entryOrPath.path === 'string' && entryOrPath.path && entryOrPath.method !== undefined) return entryOrPath;
      if (entryOrPath.entry) return resolveEntry(entryOrPath.entry);
      if (typeof entryOrPath.path === 'string') return resolveEntry(entryOrPath.path);
    }
    throw zipError('无法识别的 entry 参数');
  }

  const archive = {
    source: src,
    size: src.size,
    entries: dir.entries,
    comment: dir.comment,
    zip64: dir.zip64,
    centralDirectoryOffset: dir.cdOffset,
    centralDirectorySize: dir.cdSize,
    stats,
    has(path) {
      const norm = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
      return byPath.has(norm);
    },
    get(path) {
      const norm = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
      return byPath.get(norm) || null;
    },
    readEntry,
    read: (path, readOptions) => readEntry(path, readOptions),
    readRaw,
    async text(path, readOptions) {
      return decodeUtf8(await readEntry(path, readOptions));
    },
    async json(path, readOptions) {
      return JSON.parse(decodeUtf8(await readEntry(path, readOptions)));
    },
    /** 按路径前缀/正则找条目 */
    find(pattern) {
      const test =
        typeof pattern === 'function'
          ? pattern
          : pattern instanceof RegExp
            ? (e) => pattern.test(e.path)
            : (e) => e.path.startsWith(String(pattern));
      return dir.entries.filter(test);
    },
    close() {
      /* 无句柄需要释放；保留方法方便页面统一调用 */
    },
  };
  return archive;
}

/** CD 里没给尺寸（流式写入的 zip）时，用数据描述符或下一个本地头兜底 */
function resolveDescriptorSizes(src, entry, dataOffset) {
  if (typeof src.readSync !== 'function') return null;
  const window = Math.min(src.size - dataOffset, 1024 * 1024);
  if (window <= 0) return null;
  const buf = readAtSync(src, dataOffset, window);
  for (let i = 0; i + 16 <= buf.length; i++) {
    if (u32(buf, i) === SIG_DATA_DESCRIPTOR) {
      return { crc32: u32(buf, i + 4), compressedSize: u32(buf, i + 8), uncompressedSize: u32(buf, i + 12) };
    }
    if (u32(buf, i) === SIG_LOCAL) break;
  }
  return null;
}

/* ==========================================================================
 * 7. 过滤 + 批量读取
 * ========================================================================== */

/**
 * 生成 filter 函数。支持：
 *   makeFilter()                                  → 全要
 *   makeFilter('/\.json$/')                       → 字符串当正则源码
 *   makeFilter(/\.json$/)                         → 正则
 *   makeFilter('chat_sessions/')                  → 前缀
 *   makeFilter((entry) => ...)                    → 谓词
 *   makeFilter(['a/', /\.json$/])                 → 任一命中
 *   makeFilter({ include: [...], exclude: [...] })→ 先包含后排除
 */
export function makeFilter(spec) {
  if (spec == null) return () => true;
  if (typeof spec === 'function') return spec;
  if (spec instanceof RegExp) return (e) => spec.test(e.path);
  if (typeof spec === 'string') {
    if (spec.length > 2 && spec.startsWith('/') && spec.lastIndexOf('/') > 0) {
      const end = spec.lastIndexOf('/');
      const re = new RegExp(spec.slice(1, end), spec.slice(end + 1));
      return (e) => re.test(e.path);
    }
    return (e) => e.path.startsWith(spec);
  }
  if (Array.isArray(spec)) {
    const subs = spec.map(makeFilter);
    return (e) => subs.some((f) => f(e));
  }
  if (typeof spec === 'object') {
    const include = spec.include != null ? makeFilter(spec.include) : null;
    const exclude = spec.exclude != null ? makeFilter(spec.exclude) : null;
    return (e) => (!include || include(e)) && !(exclude && exclude(e));
  }
  throw zipError('无法识别的 filter');
}

/**
 * 逐条解压（异步生成器），每次只驻留一个条目的解压结果。
 * for await (const { path, data } of iterateZip(file, { filter: /\.json$/ })) { ... }
 */
export async function* iterateZip(source, options = {}) {
  const zip = await openZip(source, options);
  const filter = makeFilter(options.filter);
  let index = 0;
  for (const entry of zip.entries) {
    if (!filter(entry)) continue;
    if (options.signal && options.signal.aborted) {
      const err = new Error('zipkit: 已取消');
      err.name = 'AbortError';
      throw err;
    }
    const data = entry.isDirectory ? EMPTY : await zip.readEntry(entry, options);
    if (entry.isDirectory) {
      yield { entry, path: entry.path, data: EMPTY, index: index++, isDirectory: true };
    } else {
      yield { entry, path: entry.path, data, index: index++ };
    }
  }
}

/**
 * 批量读（可只读一部分）。默认不保留全量数据，只通过 onEntry 回调交出去。
 * @param {*} source
 * @param {{filter?: *, onEntry?: Function, collect?: boolean, signal?: AbortSignal, inflate?: string, verifyCrc?: boolean}} [options]
 * @returns {Promise<{entries: Array, extracted: number, bytes: number, files: Map|null, zip: object}>}
 */
export async function readZip(source, options = {}) {
  const zip = await openZip(source, options);
  const filter = makeFilter(options.filter);
  const collect = options.collect === true || options.keep === true || !!options.files;
  const files = collect ? new Map() : null;
  let extracted = 0;
  let bytes = 0;
  const skipped = [];
  for (const entry of zip.entries) {
    if (!filter(entry)) {
      skipped.push(entry.path);
      continue;
    }
    if (options.signal && options.signal.aborted) {
      const err = new Error('zipkit: 已取消');
      err.name = 'AbortError';
      throw err;
    }
    const data = entry.isDirectory ? EMPTY : await zip.readEntry(entry, options);
    bytes += data.length;
    if (files) files.set(entry.path, data);
    if (options.onEntry) {
      await options.onEntry({ entry, path: entry.path, data, index: extracted, isDirectory: entry.isDirectory });
    }
    extracted++;
  }
  return { entries: zip.entries, total: zip.entries.length, extracted, bytes, files, skipped, zip };
}

/** 小 zip 一把梭：返回 Map<path, Uint8Array> */
export async function unzip(source, filter) {
  const res = await readZip(source, { filter, collect: true });
  return res.files;
}

/* ==========================================================================
 * 8. writeZip
 * ========================================================================== */

class ByteWriter {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
  }
  u8(v) {
    this.buf[this.pos++] = v & 0xff;
  }
  u16(v) {
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
  }
  u32(v) {
    const n = v >>> 0;
    this.buf[this.pos++] = n & 0xff;
    this.buf[this.pos++] = (n >>> 8) & 0xff;
    this.buf[this.pos++] = (n >>> 16) & 0xff;
    this.buf[this.pos++] = (n >>> 24) & 0xff;
  }
  u64(v) {
    const lo = v % 4294967296;
    const hi = Math.floor(v / 4294967296);
    this.u32(lo >>> 0);
    this.u32(hi >>> 0);
  }
  bytes(arr) {
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
  }
  skip(n) {
    this.pos += n;
  }
}

function normalizeEntryList(entries) {
  if (entries == null) throw zipError('writeZip 需要 entries 数组');
  if (Array.isArray(entries)) return entries;
  if (entries instanceof Map) return [...entries].map(([path, data]) => ({ path, data }));
  if (typeof entries === 'object') {
    return Object.keys(entries).map((path) => ({ path, data: entries[path] }));
  }
  throw zipError('writeZip 的 entries 必须是数组 / Map / {path: data}');
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(2020, 0, 1, 0, 0, 0);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 31);
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}

/**
 * 生成 zip。
 * @param {Array<{path:string, data:*, deflate?:boolean, lastMod?:Date}>|Map|Object} entries
 *        条目顺序 = 传入顺序（写入 local header 的顺序与 central directory 一致）
 * @param {{
 *   deflate?: boolean,          // 全局默认（默认 true = auto：压得动就压）
 *   zip64?: 'auto'|'always',    // 'always' 强制 ZIP64（测试用）
 *   date?: Date,                // 默认时间戳（不传则用条目 lastMod，再退 2020-01-01）
 *   compressor?: (bytes:Uint8Array)=>Promise<Uint8Array|null>|Uint8Array|null  // 注入压缩后端（测试里用 zlib.deflateRawSync）
 * }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(entries, options = {}) {
  const list = normalizeEntryList(entries);
  const globalDeflate = options.deflate === false ? 'store' : options.deflate === true ? 'force' : 'auto';
  const forceZip64 = options.zip64 === 'always';
  const defaultDate = options.date instanceof Date ? options.date : null;
  const compressor = typeof options.compressor === 'function' ? options.compressor : null;

  /* ---- 1) 预处理：编码、CRC、压缩 ---- */
  const prepared = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') throw zipError('entries 里每项必须是对象 {path, data}');
    let path = String(item.path ?? item.name ?? '');
    if (!path) throw zipError('entries 里某项缺少 path');
    const isDirectory = item.isDirectory != null ? !!item.isDirectory : path.endsWith('/');
    if (isDirectory && !path.endsWith('/')) path += '/';
    const data = isDirectory ? EMPTY : toBytes(item.data);
    const want =
      item.deflate == null ? globalDeflate : item.deflate === false ? 'store' : item.deflate === true ? 'force' : 'auto';

    let method = 0;
    let payload = data;
    if (!isDirectory && want !== 'store' && data.length > 0) {
      let packed = null;
      try {
        packed = compressor ? await compressor(data) : await deflateRaw(data);
      } catch {
        packed = null;
      }
      if (packed && packed.length) {
        if (want === 'force' || packed.length < data.length) {
          method = 8;
          payload = packed;
        }
      }
    }

    const nameBytes = encodeUtf8(path);
    const { dosTime, dosDate } = dosDateTime(item.lastMod instanceof Date ? item.lastMod : defaultDate);
    prepared.push({
      path,
      nameBytes,
      isDirectory,
      method,
      payload,
      size: data.length,
      crc: crc32(data),
      dosTime,
      dosDate,
      commentBytes: item.comment ? encodeUtf8(String(item.comment)) : EMPTY,
    });
  }

  /* ---- 2) 计算布局（含 ZIP64 判定） ---- */
  let offset = 0;
  for (const e of prepared) {
    const bigSize = forceZip64 || e.size >= MAX32 || e.payload.length >= MAX32;
    const bigOffset = forceZip64 || offset >= MAX32;
    e.zip64Size = bigSize;
    e.zip64Offset = bigOffset;
    e.localExtraLen = bigSize ? 20 : 0;
    e.localOffset = offset;
    offset += 30 + e.nameBytes.length + e.localExtraLen + e.payload.length;
    e.cdExtraLen = bigSize || bigOffset ? 4 + (bigSize ? 16 : 0) + (bigOffset ? 8 : 0) : 0;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const e of prepared) cdSize += 46 + e.nameBytes.length + e.cdExtraLen + e.commentBytes.length;
  const count = prepared.length;
  const needEocd64 = forceZip64 || count > MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;
  const totalSize = cdOffset + cdSize + (needEocd64 ? 56 + 20 : 0) + 22;

  /* ---- 3) 写本地文件头 + 数据 ---- */
  const w = new ByteWriter(totalSize);
  const VERSION_NEEDED = 20;
  const VERSION_NEEDED_ZIP64 = 45;
  const VERSION_MADE_BY = (3 << 8) | 45; // unix / 4.5

  for (const e of prepared) {
    const versionNeeded = e.zip64Size ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED;
    w.u32(SIG_LOCAL);
    w.u16(versionNeeded);
    w.u16(FLAG_UTF8); // bit 11：文件名 UTF-8
    w.u16(e.method);
    w.u16(e.dosTime);
    w.u16(e.dosDate);
    w.u32(e.crc);
    w.u32(e.zip64Size ? MAX32 : e.payload.length);
    w.u32(e.zip64Size ? MAX32 : e.size);
    w.u16(e.nameBytes.length);
    w.u16(e.localExtraLen);
    w.bytes(e.nameBytes);
    if (e.zip64Size) {
      w.u16(0x0001);
      w.u16(16);
      w.u64(e.size);
      w.u64(e.payload.length);
    }
    w.bytes(e.payload);
  }

  /* ---- 4) central directory ---- */
  const cdStart = w.pos;
  if (cdStart !== cdOffset) throw zipError(`内部布局计算错误（期望 ${cdOffset}，实际 ${cdStart}）`);
  for (const e of prepared) {
    const versionNeeded = e.zip64Size || e.zip64Offset ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED;
    const external = e.isDirectory ? 0x41ed0010 : 0x81a40000; // 0o40755 / 0o100644 + MS-DOS 目录位
    w.u32(SIG_CENTRAL);
    w.u16(VERSION_MADE_BY);
    w.u16(versionNeeded);
    w.u16(FLAG_UTF8);
    w.u16(e.method);
    w.u16(e.dosTime);
    w.u16(e.dosDate);
    w.u32(e.crc);
    w.u32(e.zip64Size ? MAX32 : e.payload.length);
    w.u32(e.zip64Size ? MAX32 : e.size);
    w.u16(e.nameBytes.length);
    w.u16(e.cdExtraLen);
    w.u16(e.commentBytes.length);
    w.u16(0); // disk start
    w.u16(0); // internal attrs
    w.u32(external);
    w.u32(e.zip64Offset ? MAX32 : e.localOffset);
    w.bytes(e.nameBytes);
    if (e.cdExtraLen) {
      w.u16(0x0001);
      w.u16(e.cdExtraLen - 4);
      if (e.zip64Size) {
        w.u64(e.size);
        w.u64(e.payload.length);
      }
      if (e.zip64Offset) w.u64(e.localOffset);
    }
    w.bytes(e.commentBytes);
  }
  const cdEnd = w.pos;
  if (cdEnd - cdStart !== cdSize) throw zipError(`内部布局计算错误（CD 大小 ${cdEnd - cdStart} != ${cdSize}）`);

  /* ---- 5) ZIP64 EOCD + locator + EOCD ---- */
  if (needEocd64) {
    const eocd64Offset = w.pos;
    w.u32(SIG_EOCD64);
    w.u64(44); // 本记录剩余字节数
    w.u16(VERSION_MADE_BY);
    w.u16(VERSION_NEEDED_ZIP64);
    w.u32(0); // disk
    w.u32(0); // cd disk
    w.u64(count);
    w.u64(count);
    w.u64(cdSize);
    w.u64(cdOffset);
    w.u32(SIG_EOCD64_LOCATOR);
    w.u32(0);
    w.u64(eocd64Offset);
    w.u32(1);
  }
  w.u32(SIG_EOCD);
  w.u16(0);
  w.u16(0);
  w.u16(needEocd64 ? MAX16 : count);
  w.u16(needEocd64 ? MAX16 : count);
  w.u32(needEocd64 ? MAX32 : cdSize);
  w.u32(needEocd64 ? MAX32 : cdOffset);
  w.u16(0); // comment length

  if (w.pos !== totalSize) throw zipError(`内部布局计算错误（总大小 ${w.pos} != ${totalSize}）`);
  return w.buf;
}

/** 生成 Blob（直接给 <a download> 用）。浏览器与 Node 18+ 都有 Blob。 */
export async function writeZipBlob(entries, options = {}, mime = 'application/zip') {
  const data = await writeZip(entries, options);
  return new Blob([data], { type: mime });
}

/* ==========================================================================
 * 9. SHA-256（Chatbox manifest 需要每个会话文件的 checksum；crypto.subtle 不可用时兜底）
 * ========================================================================== */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** 纯 JS SHA-256 → 小写 hex，与 crypto.subtle 的 'SHA-256' 结果一致 */
export function sha256Hex(bytes) {
  const data = toBytes(bytes);
  const bitLen = data.length * 8;
  const withPad = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  withPad.set(data);
  withPad[data.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296));
  dv.setUint32(withPad.length - 4, bitLen >>> 0);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
  return hex;
}

/* ==========================================================================
 * 10. 便捷别名
 * ========================================================================== */

export const bytesSource = sourceFromBytes;
export const blobSource = sourceFromBlob;
export const listZip = async (source, options) => (await openZip(source, options)).entries;
export const readZipEntry = async (source, path, options) => {
  const zip = await openZip(source, options);
  return zip.read(path);
};

export default {
  VERSION,
  crc32,
  Crc32,
  inflateRaw,
  deflateRaw,
  openZip,
  readZip,
  iterateZip,
  unzip,
  makeFilter,
  writeZip,
  writeZipBlob,
  sourceFromBytes,
  sourceFromBlob,
  sha256Hex,
  listZip,
  readZipEntry,
};
