/**
 * zipkit.test.mjs — zipkit.js 的验证脚本（Node 24 运行）
 *
 * 覆盖：
 *   1) CRC32 已知向量 + 增量一致性
 *   2) sha256Hex（纯 JS）对照 node:crypto
 *   3) writeZip → openZip 往返（中文路径、二进制、>64KB、空文件、空目录、store/deflate）
 *   4) 产出 zip 的独立验证：fflate（Chatbox 用的库）+ Python zipfile.testzip()
 *   5) 读 fflate / Python 生成的 zip（含 force_zip64）
 *   6) 写 ZIP64（zip64:'always'）→ 自己读回来 + Python 校验
 *   7) 真实 80MB DeepSeek 导出 zip：索引、按需解压、只读 json 的字节量、纯 JS inflate 与 zlib 全量对照
 *   8) 错误路径：截断、CRC 损坏、非 zip
 *
 * 运行：
 *   node zipkit.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
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
  sha256Hex,
  sourceFromBytes,
  listZip,
  VERSION,
} from '../src/zipkit.js';

/* ==========================================================================
 * 测试框架（极简）
 * ========================================================================== */

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[36m── ${name} ─────────────────────────────────────────────\x1b[0m`);
}

async function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try {
    const note = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    results.push({ group: currentGroup, name, ok: true, ms });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${ms.toFixed(1)} ms)\x1b[0m${note ? ` \x1b[90m— ${note}\x1b[0m` : ''}`);
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    results.push({ group: currentGroup, name, ok: false, ms, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m \x1b[90m(${ms.toFixed(1)} ms)\x1b[0m`);
    console.log(`    \x1b[31m${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err}\x1b[0m`);
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const eqBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/* ==========================================================================
 * 环境探测
 * ========================================================================== */

const WORKDIR = process.env.DS2CB_SAMPLE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ZIP =
  process.env.DS2CB_REAL_ZIP ||
  (fs.existsSync(WORKDIR)
    ? (fs
        .readdirSync(WORKDIR)
        .filter((f) => /^deepseek_data-.*\.zip$/i.test(f))
        .map((f) => path.join(WORKDIR, f))[0] ?? null)
    : null);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zipkit-test-'));

const FFLATE_CANDIDATES = [
  process.env.FFLATE_PATH,
  path.join(WORKDIR, 'node_modules', 'fflate', 'esm', 'index.mjs'),
  'node_modules/fflate/esm/index.mjs',
].filter(Boolean);

const PYTHON_CANDIDATES = [process.env.PYTHON, 'python', 'python3'].filter(Boolean);

let fflate = null;
let fflatePath = null;
for (const p of FFLATE_CANDIDATES) {
  try {
    if (!fs.existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    // 校验这份副本没被解包过程写坏（曾遇到内容被替换成 package.json 的副本）
    if (typeof mod.unzipSync !== 'function' || typeof mod.zipSync !== 'function') continue;
    fflate = mod;
    fflatePath = p;
    break;
  } catch (err) {
    console.log(`  (fflate 加载失败 ${p}: ${err.message})`);
  }
}

let python = null;
for (const p of PYTHON_CANDIDATES) {
  try {
    const out = execFileSync(p, ['-X', 'utf8', '-c', 'import sys, zipfile; print(sys.version.split()[0])'], { encoding: 'utf8' });
    python = { bin: p, version: out.trim() };
    break;
  } catch {
    /* 下一个 */
  }
}

console.log(`zipkit.js v${VERSION}  |  node ${process.version}`);
console.log(`fflate: ${fflate ? `${fflatePath} (v${fflate.zipSync ? '0.8.2' : '?'})` : '（未找到，相关用例跳过）'}`);
console.log(`python: ${python ? `${python.bin} (${python.version})` : '（未找到，相关用例跳过）'}`);
console.log(`临时目录: ${TMP}`);

/* ==========================================================================
 * 工具
 * ========================================================================== */

function randomBytes(n) {
  const b = Buffer.allocUnsafe(n);
  crypto.randomFillSync(b);
  return new Uint8Array(b.buffer, b.byteOffset, n);
}

function repeatBytes(pattern, times) {
  const unit = Buffer.from(pattern);
  return new Uint8Array(Buffer.concat(Array.from({ length: times }, () => unit)));
}

function fileSource(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  const size = fs.fstatSync(fd).size;
  const counters = { readCalls: 0, bytesRead: 0, maxRead: 0 };
  return {
    size,
    counters,
    readSync(offset, length) {
      counters.readCalls++;
      counters.bytesRead += length;
      counters.maxRead = Math.max(counters.maxRead, length);
      const buf = Buffer.allocUnsafe(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    },
    async read(offset, length) {
      return this.readSync(offset, length);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/** 用 Python 独立读一遍 zip，返回 {testzip, names, sizes, crcs, methods} */
function pythonInspectZip(zipPath) {
  if (!python) return null;
  const script = path.join(TMP, 'inspect_zip.py');
  if (!fs.existsSync(script)) {
    fs.writeFileSync(
      script,
      `import sys, json, zipfile, base64
p = sys.argv[1]
z = zipfile.ZipFile(p)
info = {}
bad = z.testzip()
for i in z.infolist():
    info[i.filename] = {"size": i.file_size, "csize": i.compress_size,
                        "crc": i.CRC, "method": i.compress_type, "flag_bits": i.flag_bits}
print(json.dumps({"testzip": bad, "count": len(info), "entries": info,
                  "comment": z.comment.decode('utf-8', 'replace')}, ensure_ascii=True))
`,
    );
  }
  const out = execFileSync(python.bin, ['-X', 'utf8', script, zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

/** 用 Python 生成一个 zip（可强制 zip64），返回路径 */
function pythonMakeZip(zipPath, files, { forceZip64 = false, method = 'stored' } = {}) {
  const script = path.join(TMP, 'make_zip.py');
  const specPath = path.join(TMP, 'make_zip_spec.json');
  fs.writeFileSync(
    script,
    `import sys, json, zipfile
spec = json.load(open(sys.argv[1], encoding='utf-8'))
method = zipfile.ZIP_DEFLATED if spec.get('deflate') else zipfile.ZIP_STORED
with zipfile.ZipFile(spec['out'], 'w', method) as z:
    for name, text, ascii_stored in spec['files']:
        data = bytes.fromhex(text)
        if spec.get('force_zip64'):
            with z.open(name, 'w', force_zip64=True) as f:
                f.write(data)
        else:
            z.writestr(name, data)
`,
  );
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      out: zipPath,
      force_zip64: forceZip64,
      deflate: method === 'deflated',
      files: files.map(({ name, data }) => [name, Buffer.from(data).toString('hex'), false]),
    }),
  );
  execFileSync(python.bin, ['-X', 'utf8', script, specPath], { encoding: 'utf8' });
  return zipPath;
}

/* ==========================================================================
 * 1. CRC32
 * ========================================================================== */

group('1. CRC32');

await test('已知向量 crc32("123456789") === 0xCBF43926', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

await test('空输入 === 0', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

await test('增量 Crc32 与一次性 crc32(concat) 一致（随机 5 段）', () => {
  const parts = Array.from({ length: 5 }, () => randomBytes(1000 + Math.floor(Math.random() * 5000)));
  const all = new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
  const inc = new Crc32();
  for (const p of parts) inc.update(p);
  assert.equal(inc.digest(), crc32(all));
  assert.equal(inc.length, all.length);
  assert.equal(crc32(parts[0], 0) === crc32(all), false);
});

await test('crc32 与 zlib.crc32（Node 22+）一致', () => {
  if (typeof zlib.crc32 !== 'function') return 'node zlib.crc32 不存在，跳过';
  const b = randomBytes(4096);
  assert.equal(crc32(b), zlib.crc32(b));
  return 'zlib.crc32 对照通过';
});

/* ==========================================================================
 * 2. SHA-256
 * ========================================================================== */

group('2. sha256Hex（纯 JS，给 Chatbox manifest 用）');

await test('多长度对照 node:crypto', () => {
  const sizes = [0, 1, 3, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 100003];
  for (const n of sizes) {
    const b = randomBytes(n);
    const expect = crypto.createHash('sha256').update(b).digest('hex');
    assert.equal(sha256Hex(b), expect, `size ${n} 不一致`);
  }
  return `${sizes.length} 个长度全部一致`;
});

await test('对照一段中文 UTF-8 文本', () => {
  const text = '会话标题：雅迪方向不好控制排查 — DeepSeek 导出 ✅';
  const bytes = new TextEncoder().encode(text);
  assert.equal(sha256Hex(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
});

/* ==========================================================================
 * 3. writeZip → openZip 往返
 * ========================================================================== */

group('3. 往返：writeZip → openZip');

const ROUNDTRIP = (() => {
  const json = new TextEncoder().encode(JSON.stringify({ hello: '世界', n: 42 }, null, 2));
  return [
    { path: 'manifest.json', data: json },
    { path: '会话/中文 名称.json', data: new TextEncoder().encode('{"中文":true}') },
    { path: 'sessions/0122a8cc-0000/resources/图片.webp', data: randomBytes(1024) },
    { path: 'big-random.bin', data: randomBytes(120 * 1024) },
    { path: 'big-repeat.bin', data: repeatBytes('ABCDEFGH', 40 * 1024) }, // 320KB 可压
    { path: 'empty.txt', data: new Uint8Array(0) },
    { path: 'nested/dir/', data: new Uint8Array(0), isDirectory: true },
    { path: 'binary-all-bytes.bin', data: new Uint8Array(Array.from({ length: 256 }, (_, i) => i)) },
  ];
})();

const roundtripZip = await writeZip(ROUNDTRIP);

await test('writeZip 返回 Uint8Array 且以 PK\\x03\\x04 开头、EOCD 结尾', () => {
  assert.ok(roundtripZip instanceof Uint8Array);
  assert.equal(roundtripZip[0], 0x50);
  assert.equal(roundtripZip[1], 0x4b);
  assert.equal(roundtripZip[2], 0x03);
  assert.equal(roundtripZip[3], 0x04);
  const n = roundtripZip.length;
  assert.equal(roundtripZip[n - 22], 0x50);
  assert.equal(roundtripZip[n - 21], 0x4b);
  assert.equal(roundtripZip[n - 20], 0x05);
  assert.equal(roundtripZip[n - 19], 0x06);
  return `共 ${roundtripZip.length} 字节`;
});

await test('条目顺序与传入顺序一致（8 条）', async () => {
  const zip = await openZip(roundtripZip);
  const paths = zip.entries.map((e) => e.path);
  assert.deepEqual(paths, [
    'manifest.json',
    '会话/中文 名称.json',
    'sessions/0122a8cc-0000/resources/图片.webp',
    'big-random.bin',
    'big-repeat.bin',
    'empty.txt',
    'nested/dir/',
    'binary-all-bytes.bin',
  ]);
  assert.equal(zip.entries.length, 8);
  return paths.join(' | ');
});

await test('全部条目 UTF-8 文件名 flag(bit 11) 置位', async () => {
  const zip = await openZip(roundtripZip);
  for (const e of zip.entries) assert.ok((e.flags & 0x0800) !== 0, `${e.path} 缺少 bit 11`);
  return '8/8 均置位';
});

await test('往返字节完全一致（含中文路径 / 二进制 / 空文件 / 空目录）', async () => {
  const zip = await openZip(roundtripZip);
  for (const item of ROUNDTRIP) {
    const p = item.isDirectory && !item.path.endsWith('/') ? `${item.path}/` : item.path;
    assert.ok(zip.has(p), `缺少条目 ${p}`);
    const back = await zip.read(p);
    assert.ok(eqBytes(back, item.data), `${p} 内容不一致`);
  }
  return '8/8 一致';
});

await test('deflate 选择正确：可压的用 method 8，随机的退回 method 0', async () => {
  const zip = await openZip(roundtripZip);
  const bigRepeat = zip.get('big-repeat.bin');
  const bigRandom = zip.get('big-random.bin');
  assert.equal(bigRepeat.method, 8, '可压数据应为 deflate');
  assert.ok(bigRepeat.compressedSize < bigRepeat.uncompressedSize / 10, '压缩率应 < 10%');
  assert.equal(bigRandom.method, 0, '随机数据应退回 store');
  assert.equal(bigRandom.compressedSize, bigRandom.uncompressedSize);
  return `repeat ${bigRepeat.uncompressedSize}→${bigRepeat.compressedSize}，random store ${bigRandom.uncompressedSize}`;
});

await test('crc32 / uncompressedSize / compressedSize 与实际数据吻合', async () => {
  const zip = await openZip(roundtripZip);
  for (const item of ROUNDTRIP) {
    const p = item.isDirectory && !item.path.endsWith('/') ? `${item.path}/` : item.path;
    const e = zip.get(p);
    assert.equal(e.crc32, crc32(item.data), `${p} crc 不符`);
    assert.equal(e.uncompressedSize, item.data.length);
    assert.equal(e.size, item.data.length);
  }
  return 'crc/size 全部吻合';
});

await test('central directory 偏移与本地头一一对应（PK\\x03\\x04）', async () => {
  const zip = await openZip(sourceFromBytes(roundtripZip));
  for (const e of zip.entries) {
    const lh = roundtripZip.subarray(e.localHeaderOffset, e.localHeaderOffset + 4);
    assert.equal(Buffer.from(lh).toString('hex'), '504b0304', `${e.path} 本地头签名错误`);
  }
  return `${zip.entries.length} 个本地头签名正确`;
});

await test('deflate:false 时全部 store（method 0）', async () => {
  const z = await writeZip(ROUNDTRIP, { deflate: false });
  const zip = await openZip(z);
  for (const e of zip.entries) assert.equal(e.method, 0, `${e.path} 应为 store`);
  const back = await zip.read('big-repeat.bin');
  assert.ok(eqBytes(back, ROUNDTRIP[4].data));
  return '全部 method 0，数据可还原';
});

await test('注入 compressor（zlib.deflateRawSync）走 method 8，且能被自己读回', async () => {
  const z = await writeZip(ROUNDTRIP, {
    compressor: (bytes) => new Uint8Array(zlib.deflateRawSync(bytes)),
  });
  const zip = await openZip(z);
  const e = zip.get('big-repeat.bin');
  assert.equal(e.method, 8);
  // 确认本地数据确实是 zlib raw deflate 流
  const raw = await zip.readRaw(e);
  const direct = new Uint8Array(zlib.inflateRawSync(raw));
  assert.ok(eqBytes(direct, ROUNDTRIP[4].data), 'zlib 直接解压应与原文一致');
  const back = await zip.readEntry(e, { inflate: 'js' });
  assert.ok(eqBytes(back, ROUNDTRIP[4].data), '纯 JS inflate 应与原文一致');
  return 'zlib 压缩 + 纯 JS 解压 一致';
});

await test('纯 JS inflateRaw 与 zlib.inflateRawSync 在多份样本上一致', () => {
  const samples = [
    repeatBytes('hello世界', 1000),
    randomBytes(200),
    new Uint8Array(0),
    new TextEncoder().encode('a'.repeat(100000)),
    repeatBytes('0123456789abcdef', 8192),
  ];
  let total = 0;
  for (const s of samples) {
    const packed = new Uint8Array(zlib.deflateRawSync(s, { level: 9 }));
    const back = inflateRaw(packed, s.length);
    assert.ok(eqBytes(back, s), 'inflateRaw 结果不一致');
    total += s.length;
  }
  return `${samples.length} 份样本，共 ${kb(total)}`;
});

await test('deflateRaw() 自身可被 zlib 解开', async () => {
  const s = repeatBytes('zipkit 压缩测试', 5000);
  const packed = await deflateRaw(s);
  assert.ok(packed && packed.length, 'deflateRaw 应返回压缩数据');
  assert.ok(eqBytes(new Uint8Array(zlib.inflateRawSync(packed)), s));
  return `${kb(s.length)} → ${kb(packed.length)}`;
});

/* ==========================================================================
 * 4. 独立库交叉验证（fflate + Python）
 * ========================================================================== */

group('4. 交叉验证：fflate（Chatbox 用的库）与 Python zipfile');

const roundtripZipPath = path.join(TMP, 'roundtrip.zip');
fs.writeFileSync(roundtripZipPath, roundtripZip);

await test('fflate.unzipSync 能读我们写的 zip，且内容一致', async () => {
  if (!fflate) return 'fflate 不在，跳过';
  const out = fflate.unzipSync(roundtripZip);
  const names = Object.keys(out).sort();
  assert.equal(names.length, ROUNDTRIP.length);
  for (const item of ROUNDTRIP) {
    if (item.isDirectory) continue;
    assert.ok(out[item.path], `fflate 缺少 ${item.path}`);
    assert.ok(eqBytes(out[item.path], item.data), `fflate ${item.path} 内容不一致`);
  }
  // 中文文件名（fflate 默认按 UTF-8 解）
  assert.ok(out['会话/中文 名称.json'], 'fflate 应正确解出中文路径');
  return `fflate 读出 ${names.length} 条，中文路径 OK`;
});

await test('fflate 异步 unzip 同样 OK（Chatbox import 走这条）', async () => {
  if (!fflate) return 'fflate 不在，跳过';
  const out = await new Promise((resolve, reject) => {
    fflate.unzip(roundtripZip, (err, data) => (err ? reject(err) : resolve(data)));
  });
  assert.ok(eqBytes(out['manifest.json'], ROUNDTRIP[0].data));
  return 'fflate.unzip 回调式读取通过';
});

await test('Python zipfile.testzip() 返回 None（CRC/结构全通过）', async () => {
  if (!python) return 'python 不在，跳过';
  const info = pythonInspectZip(roundtripZipPath);
  assert.equal(info.testzip, null, `testzip 报告损坏: ${info.testzip}`);
  assert.equal(info.count, ROUNDTRIP.length);
  for (const item of ROUNDTRIP) {
    const p = item.isDirectory && !item.path.endsWith('/') ? `${item.path}/` : item.path;
    const meta = info.entries[p];
    assert.ok(meta, `python 缺少 ${p}`);
    assert.equal(meta.size, item.data.length, `${p} size`);
    assert.equal(meta.crc, crc32(item.data), `${p} crc`);
    assert.ok(meta.flag_bits & 0x800, `${p} 缺少 UTF-8 flag`);
  }
  return `python testzip=OK，${info.count} 条目 crc/size/flag 全部吻合`;
});

await test('读 fflate 生成的 zip（level 6 与 level 0）', async () => {
  if (!fflate) return 'fflate 不在，跳过';
  const payload = { a: randomBytes(5000), b: new TextEncoder().encode('中文内容 ×'.repeat(500)) };
  for (const level of [6, 0]) {
    const z = fflate.zipSync(
      { 'x/a.bin': payload.a, '中文/b.txt': payload.b, 'empty.txt': new Uint8Array(0) },
      { level },
    );
    const zip = await openZip(z);
    assert.equal(zip.entries.length, 3);
    assert.ok(eqBytes(await zip.read('x/a.bin'), payload.a), `level ${level} a.bin 不一致`);
    assert.ok(eqBytes(await zip.read('中文/b.txt'), payload.b), `level ${level} 中文不一致`);
    assert.equal((await zip.read('empty.txt')).length, 0);
  }
  return 'level 0 / 6 都能读';
});

await test('读 Python 生成的 zip（deflate + store）', async () => {
  if (!python) return 'python 不在，跳过';
  const files = [
    { name: 'a.txt', data: new TextEncoder().encode('hello python zip\n'.repeat(100)) },
    { name: '中文/名称.json', data: new TextEncoder().encode('{"ok":1}') },
    { name: 'bin.dat', data: randomBytes(3000) },
  ];
  for (const method of ['stored', 'deflated']) {
    const p = pythonMakeZip(path.join(TMP, `py-${method}.zip`), files, { method });
    const zip = await openZip(new Uint8Array(fs.readFileSync(p)));
    assert.equal(zip.entries.length, 3, `${method} 条目数`);
    for (const f of files) assert.ok(eqBytes(await zip.read(f.name), f.data), `${method} ${f.name}`);
  }
  return 'store / deflate 均正确解出（含中文名）';
});

await test('读 Python 生成的 force_zip64 zip', async () => {
  if (!python) return 'python 不在，跳过';
  const files = [
    { name: 'big.bin', data: repeatBytes('zip64-test-', 20000) },
    { name: 's.json', data: new TextEncoder().encode('{"v":64}') },
  ];
  const p = pythonMakeZip(path.join(TMP, 'py-zip64.zip'), files, { forceZip64: true });
  const zip = await openZip(new Uint8Array(fs.readFileSync(p)));
  assert.equal(zip.entries.length, 2);
  for (const f of files) assert.ok(eqBytes(await zip.read(f.name), f.data), `zip64 ${f.name}`);
  return 'force_zip64 条目可读';
});

await test('写 ZIP64（zip64:"always"）→ 自己读回 + Python 校验', async () => {
  const z = await writeZip(ROUNDTRIP, { zip64: 'always' });
  const zip = await openZip(z);
  assert.equal(zip.entries.length, ROUNDTRIP.length);
  assert.equal(zip.zip64, true, '应识别为 ZIP64');
  for (const item of ROUNDTRIP) {
    if (item.isDirectory) continue;
    assert.ok(eqBytes(await zip.read(item.path), item.data), `zip64 ${item.path}`);
  }
  if (python) {
    const p = path.join(TMP, 'ours-zip64.zip');
    fs.writeFileSync(p, z);
    const info = pythonInspectZip(p);
    assert.equal(info.testzip, null, 'python 报告损坏');
    assert.equal(info.count, ROUNDTRIP.length);
    for (const item of ROUNDTRIP) {
      if (item.isDirectory) continue;
      assert.equal(info.entries[item.path].size, item.data.length, `${item.path} size`);
    }
    return `ZIP64 结构 python testzip=OK（${z.length} 字节）`;
  }
  return 'ZIP64 自读通过（python 不在，未做外部校验）';
});

/* ==========================================================================
 * 5. 过滤 / 批量 API
 * ========================================================================== */

group('5. makeFilter / readZip / iterateZip / unzip');

await test('makeFilter: 正则 / 前缀 / 谓词 / 数组 / include-exclude', () => {
  const entries = [
    { path: 'chat_sessions/a.json' },
    { path: 'chat_sessions/a_files/1.webp' },
    { path: 'manifest.json' },
  ];
  assert.deepEqual(entries.filter(makeFilter(/\.json$/)).map((x) => x.path), ['chat_sessions/a.json', 'manifest.json']);
  assert.deepEqual(entries.filter(makeFilter('chat_sessions/')).map((x) => x.path), ['chat_sessions/a.json', 'chat_sessions/a_files/1.webp']);
  assert.deepEqual(entries.filter(makeFilter((x) => x.path.includes('_files'))).map((x) => x.path), ['chat_sessions/a_files/1.webp']);
  assert.deepEqual(entries.filter(makeFilter(['manifest.json', /_files/])).map((x) => x.path), ['chat_sessions/a_files/1.webp', 'manifest.json']);
  assert.deepEqual(
    entries.filter(makeFilter({ include: /^chat_sessions\//, exclude: /_files/ })).map((x) => x.path),
    ['chat_sessions/a.json'],
  );
  assert.deepEqual(entries.filter(makeFilter('/_files/')).map((x) => x.path), ['chat_sessions/a_files/1.webp']);
});

await test('readZip 逐个 onEntry 回调，顺序与 zip 内一致', async () => {
  const seen = [];
  const res = await readZip(roundtripZip, {
    filter: /\.(json|bin)$/,
    onEntry: ({ path: p, data, index }) => {
      seen.push([index, p, data.length]);
    },
  });
  assert.equal(res.extracted, 5); // manifest.json, 中文 json, big-random.bin, big-repeat.bin, binary-all-bytes.bin
  assert.equal(res.files, null, '未 collect 时不应保留全量数据');
  assert.deepEqual(seen.map((s) => s[0]), [0, 1, 2, 3, 4]);
  return seen.map((s) => s[1]).join(' | ');
});

await test('unzip() 返回 Map，collect 模式可用', async () => {
  const map = await unzip(roundtripZip, /manifest\.json|empty\.txt/);
  assert.ok(map instanceof Map);
  assert.equal(map.size, 2);
  assert.ok(eqBytes(map.get('manifest.json'), ROUNDTRIP[0].data));
});

await test('iterateZip 异步生成器逐条产出', async () => {
  const out = [];
  for await (const { path: p, data } of iterateZip(roundtripZip, { filter: (e) => e.method === 8 })) {
    out.push(`${p}:${data.length}`);
  }
  assert.ok(out.length >= 1, '应至少有一条 deflate 条目');
  assert.ok(out.some((s) => s.startsWith('big-repeat.bin:')), '应包含 big-repeat.bin');
  return out.join(' | ');
});

await test('zip.text / zip.json / zip.find / zip.stats', async () => {
  const zip = await openZip(roundtripZip);
  const json = await zip.json('manifest.json');
  assert.equal(json.hello, '世界');
  assert.equal(await zip.text('empty.txt'), '');
  assert.equal(zip.find(/\.bin$/).length, 3); // big-random / big-repeat / binary-all-bytes
  assert.equal(zip.stats.files, 7);
  assert.equal(zip.stats.directories, 1);
  return `stats=${JSON.stringify({ files: zip.stats.files, dirs: zip.stats.directories, size: zip.stats.uncompressedSize })}`;
});

/* ==========================================================================
 * 6. 真实 80MB DeepSeek 导出
 * ========================================================================== */

group('6. 真实导出包（环境变量 DS2CB_REAL_ZIP / DS2CB_SAMPLE_DIR）');

if (!REAL_ZIP || !fs.existsSync(REAL_ZIP)) {
  console.log(`  \x1b[33m! 找不到 ${REAL_ZIP}，6/7 组跳过\x1b[0m`);
} else {
  const realSize = fs.statSync(REAL_ZIP).size;
  let realZip = null;
  const realSource = fileSource(REAL_ZIP);

  await test('openZip(文件源) 只读索引：不读整包数据', async () => {
    const t0 = Date.now();
    realZip = await openZip(realSource);
    const ms = Date.now() - t0;
    assert.ok(realZip.entries.length > 10, "条目数应大于 10");
    assert.ok(realSource.counters.bytesRead < 1024 * 1024, `建索引读了 ${realSource.counters.bytesRead} 字节，应 < 1MB`);
    return `${ms} ms 建好 ${realZip.entries.length} 条索引，仅读 ${kb(realSource.counters.bytesRead)}`;
  });

  await test('条目统计自洽（json 数 + 附件数 = 总条目数）', () => {
    const jsonCount = realZip.entries.filter((e) => e.path.endsWith('.json')).length;
    const filesCount = realZip.entries.filter((e) => e.path.includes('_files/')).length;
    const sessionCount = realZip.entries.filter((e) => /^chat_sessions\/[^/]+\.json$/.test(e.path)).length;
    assert.equal(jsonCount, 247);
    assert.ok(filesCount > 0, "应存在附件条目");
    assert.equal(sessionCount, realZip.entries.filter((e) => /^chat_sessions\/[^/]+\.json$/.test(e.path)).length);
    assert.deepEqual(
      [...new Set(realZip.entries.filter((e) => e.path.includes('_files/')).map((e) => path.posix.extname(e.path)))].sort(),
      ['.jpg', '.png', '.webp'],
    );
    return `json=${jsonCount} 附件=${filesCount} 会话=${sessionCount}`;
  });

  await test('has() / 读取 manifest.json、user.json', async () => {
    assert.ok(realZip.has('manifest.json'));
    assert.ok(realZip.has('user.json'));
    assert.ok(!realZip.has('nope.json'));
    const manifest = await realZip.json('manifest.json');
    assert.equal(manifest.export_format_version, 3);
    const user = await realZip.json('user.json');
    assert.ok(user.user_id);
    return `manifest=${JSON.stringify(manifest)} user_id=${String(user.user_id).slice(0, 8)}…`;
  });

  await test('读 chat_session_index.json', async () => {
    const idx = await realZip.json('chat_session_index.json');
    assert.ok(Array.isArray(idx));
    assert.ok(Array.isArray(idx) && idx.length > 0, "会话索引应为非空数组");
    for (const s of idx.slice(0, 3)) {
      assert.ok(typeof s.id === 'string' && s.id.length > 10);
      assert.ok(typeof s.title === 'string');
    }
    return `${idx.length} 条，首条：${idx[0].id.slice(0, 8)}… "${idx[0].title}"`;
  });

  await test('读至少一个 chat_sessions/*.json 并校验结构', async () => {
    const entry = realZip.entries.find((e) => /^chat_sessions\/[^/]+\.json$/.test(e.path));
    const session = await realZip.json(entry.path);
    assert.ok(Array.isArray(session.messages) && session.messages.length > 0);
    assert.equal(`chat_sessions/${session.id}.json`, entry.path);
    const fragTypes = new Set();
    for (const m of session.messages) for (const f of m.fragments || []) fragTypes.add(f.type);
    return `${entry.path.split('/')[1]} | ${session.messages.length} 条消息，fragment: ${[...fragTypes].join(',')}`;
  });

  await test('随机 5 个会话 JSON 全部可解析', async () => {
    const sessions = realZip.entries.filter((e) => /^chat_sessions\/[^/]+\.json$/.test(e.path));
    const picks = Array.from({ length: 5 }, () => sessions[Math.floor(Math.random() * sessions.length)]);
    for (const e of picks) {
      const s = await realZip.json(e.path);
      assert.equal(s.id, path.posix.basename(e.path, '.json'));
      assert.ok(s.messages.length > 0);
    }
    return picks.map((e) => e.path.split('/')[1].slice(0, 8)).join(', ');
  });

  await test('只读 json（跳过 *_files 图片）时读盘量极小', async () => {
    const before = { ...realSource.counters };
    const res = await readZip(realSource, { filter: /\.json$/ });
    const used = realSource.counters.bytesRead - before.bytesRead;
    const expectJsonBytes = realZip.entries.filter((e) => e.path.endsWith('.json')).reduce((a, e) => a + e.uncompressedSize, 0);
    assert.equal(res.extracted, 247);
    assert.equal(res.bytes, expectJsonBytes, '解出的字节数应等于 json 未压缩总量');
    assert.ok(used < expectJsonBytes, `读盘 ${used} 应小于 json 未压缩总量 ${expectJsonBytes}（证明没碰图片）`);
    assert.ok(used < realSize * 0.2, `读盘 ${used} 应远小于整包 ${realSize}`);
    assert.ok(res.skipped.filter((p) => p.includes('_files/')).length > 0);
    return `解出 ${mb(res.bytes)} json，只从磁盘读 ${kb(used)}（整包 ${mb(realSize)}）`;
  });

  await test('onEntry 回调不驻留：峰值内存未随图片膨胀', async () => {
    const before = process.memoryUsage().heapUsed;
    let peak = 0;
    const seen = [];
    await readZip(realSource, {
      filter: /\.json$/,
      onEntry: ({ path: p, data }) => {
        seen.push(p);
        const now = process.memoryUsage().heapUsed;
        if (now > peak) peak = now;
      },
    });
    const grow = (peak - before) / 1048576;
    assert.equal(seen.length, 247);
    assert.ok(grow < 100, `回调期间堆增长 ${grow.toFixed(1)}MB 过大`);
    return `回调 ${seen.length} 次，堆峰值增长约 ${grow.toFixed(1)} MB`;
  });

  await test('纯 JS inflate 与 zlib 全量对照（逐条全解）', async () => {
    const t0 = Date.now();
    let compared = 0;
    let total = 0;
    for (const e of realZip.entries) {
      if (e.isDirectory) continue;
      if (e.method === 0) {
        const raw = await realZip.readRaw(e);
        assert.equal(raw.length, e.uncompressedSize);
        compared++;
        continue;
      }
      const raw = await realZip.readRaw(e);
      const ours = await realZip.readEntry(e, { inflate: 'js' }); // 强制纯 JS
      const theirs = new Uint8Array(zlib.inflateRawSync(raw));
      assert.equal(ours.length, theirs.length, `${e.path} 长度不一致`);
      assert.equal(crc32(ours), crc32(theirs), `${e.path} 内容不一致`);
      compared++;
      total += ours.length;
    }
    const ms = Date.now() - t0;
    assert.equal(compared, realZip.entries.length);
    return `${compared} 条全解并逐条对照 zlib 通过，共 ${mb(total)}，${ms} ms（${(total / 1048576 / (ms / 1000)).toFixed(1)} MB/s）`;
  });

  await test('native(DecompressionStream) 与纯 JS 结果一致', async () => {
    const e = realZip.entries.find((x) => x.method === 8 && x.uncompressedSize > 20000);
    const js = await realZip.readEntry(e, { inflate: 'js' });
    const native = await realZip.readEntry(e, { inflate: 'native' });
    assert.equal(crc32(js), crc32(native));
    return `${e.path}（${kb(e.uncompressedSize)}）两后端 crc 一致`;
  });

  await test('按需读单个附件（图片）也正常', async () => {
    const img = realZip.entries.find((e) => e.path.includes('_files/') && e.uncompressedSize > 1000);
    const data = await realZip.read(img.path);
    assert.equal(data.length, img.uncompressedSize);
    // 检查图片魔数
    const isWebp = Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF';
    const isJpg = data[0] === 0xff && data[1] === 0xd8;
    const isPng = data[0] === 0x89 && data[1] === 0x50;
    assert.ok(isWebp || isJpg || isPng, '图片魔数不认识');
    return `${img.path.split('/').pop()} ${kb(data.length)} ${isWebp ? 'webp' : isJpg ? 'jpg' : 'png'}`;
  });

  await test('整包一次性 openZip(Uint8Array) 也能工作（对照文件源）', async () => {
    const bytes = new Uint8Array(fs.readFileSync(REAL_ZIP));
    const zip = await openZip(bytes);
    assert.equal(zip.entries.length, realZip.entries.length);
    const a = await zip.read('chat_session_index.json');
    const b = await realZip.read('chat_session_index.json');
    assert.ok(eqBytes(a, b));
    return `80MB 全驻留模式下索引与内容一致（${mb(bytes.length)}）`;
  });

  await test('源探测：readZip(File-like Blob) 路径可用', async () => {
    const buf = fs.readFileSync(REAL_ZIP);
    const blob = new Blob([buf]);
    const zip = await openZip(blob);
    assert.equal(zip.entries.length, realZip.entries.length);
    const idx = await zip.json('chat_session_index.json');
    assert.ok(idx.length > 0);
    return 'Blob/File 源（浏览器路径）索引 + json 读取通过';
  });

  await test('与 Python zipfile 对照整包的 name/size/csize/crc/method', async () => {
    if (!python) return 'python 不在，跳过';
    const info = pythonInspectZip(REAL_ZIP);
    assert.equal(info.testzip, null, `python 认为整包损坏: ${info.testzip}`);
    assert.equal(info.count, realZip.entries.length);
    for (const e of realZip.entries) {
      const meta = info.entries[e.path];
      assert.ok(meta, `python 里没有 ${e.path}`);
      assert.equal(meta.size, e.uncompressedSize, `${e.path} size`);
      assert.equal(meta.csize, e.compressedSize, `${e.path} csize`);
      assert.equal(meta.crc >>> 0, e.crc32 >>> 0, `${e.path} crc`);
      assert.equal(meta.method, e.method, `${e.path} method`);
    }
    return `${realZip.entries.length} 条全部与 python 一致（python testzip=OK）`;
  });

  realSource.close();
}

/* ==========================================================================
 * 7. 错误路径
 * ========================================================================== */

group('7. 错误路径');

await test('非 zip 数据抛 ZipError', async () => {
  await assert.rejects(() => openZip(randomBytes(4096)), /zipkit:/);
  await assert.rejects(() => openZip(new Uint8Array(10)), /太小/);
});

await test('截断的 zip 抛错', async () => {
  const cut = roundtripZip.subarray(0, roundtripZip.length - 500);
  await assert.rejects(async () => {
    const zip = await openZip(cut);
    for (const e of zip.entries) await zip.readEntry(e);
  }, /zipkit:/);
});

await test('数据被篡改 → CRC32 校验失败', async () => {
  const z = await writeZip([{ path: 'a.txt', data: new Uint8Array(200).fill(65) }], { deflate: false });
  const zip0 = await openZip(z);
  const e = zip0.get('a.txt');
  const dataOffset = e.localHeaderOffset + 30 + 'a.txt'.length;
  z[dataOffset + 10] ^= 0xff;
  const zip = await openZip(z);
  await assert.rejects(() => zip.read('a.txt'), /CRC32/);
});

await test('verifyCrc:false 时不校验（用于抢救坏包）', async () => {
  const z = await writeZip([{ path: 'a.txt', data: new Uint8Array(200).fill(65) }], { deflate: false });
  const zip0 = await openZip(z);
  const e = zip0.get('a.txt');
  z[e.localHeaderOffset + 30 + 'a.txt'.length + 10] ^= 0xff;
  const zip = await openZip(z, { verifyCrc: false });
  const data = await zip.read('a.txt', {});
  assert.equal(data.length, 200);
  return '坏包在关闭校验后可读出原始字节';
});

await test('不存在的条目给出明确错误', async () => {
  const zip = await openZip(roundtripZip);
  await assert.rejects(() => zip.read('no-such-file.json'), /没有这个条目/);
  assert.equal(zip.get('no-such-file.json'), null);
});

await test('AbortSignal 取消长任务', async () => {
  const ctrl = new AbortController();
  const zip = await openZip(roundtripZip);
  ctrl.abort();
  await assert.rejects(
    () => readZip(zip.source ?? roundtripZip, { signal: ctrl.signal, filter: /(.*)/ }),
    (err) => err.name === 'AbortError',
  );
});

/* ==========================================================================
 * 8. 浏览器安全性 / 兜底后端
 * ========================================================================== */

group('8. 浏览器安全性（静态检查 + 后端兜底）');

await test('zipkit.js 里没有任何静态 import / require（浏览器可直接 script type=module 加载）', () => {
  const src = fs.readFileSync(new URL('../src/zipkit.js', import.meta.url), 'utf8');
  const codeLines = [];
  let inBlockComment = false;
  src.split('\n').forEach((line, i) => {
    let l = line;
    if (inBlockComment) {
      const end = l.indexOf('*/');
      if (end < 0) return;
      l = l.slice(end + 2);
      inBlockComment = false;
    }
    const open = l.indexOf('/*');
    if (open >= 0) {
      const close = l.indexOf('*/', open + 2);
      if (close < 0) {
        l = l.slice(0, open);
        inBlockComment = true;
      } else {
        l = l.slice(0, open) + l.slice(close + 2);
      }
    }
    l = l.replace(/\/\/.*$/, '');
    codeLines.push([i + 1, l]);
  });
  const code = codeLines.map(([, l]) => l).join('\n');
  const bad = [];
  for (const [n, l] of codeLines) {
    if (/^\s*import\s/.test(l)) bad.push(`L${n}: 静态 import`);
    if (/(^|[^.\w])require\s*\(/.test(l)) bad.push(`L${n}: require()`);
    if (/(^|[^.\w])new Buffer\b|(^|[^.\w])Buffer\./.test(l)) bad.push(`L${n}: Buffer`);
  }
  assert.deepEqual(bad, []);
  const nodeImports = [...code.matchAll(/import\(\s*['"]node:([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(nodeImports, ['zlib', 'zlib'], '只允许动态 import node:zlib');
  return '仅 2 处动态 import("node:zlib")，无静态依赖、无 Buffer、无 require';
});

await test('删掉 Compression/DecompressionStream 后仍能写和读（纯 JS + 后端兜底）', async () => {
  const savedDS = globalThis.DecompressionStream;
  const savedCS = globalThis.CompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    globalThis.CompressionStream = undefined;
    const z = await writeZip(ROUNDTRIP);
    const zip = await openZip(z);
    for (const item of ROUNDTRIP) {
      if (item.isDirectory) continue;
      assert.ok(eqBytes(await zip.read(item.path), item.data), `${item.path} 不一致`);
    }
    return `${z.length} 字节读写正常（deflate 走 Node zlib 兜底 / inflate 走纯 JS）`;
  } finally {
    globalThis.DecompressionStream = savedDS;
    globalThis.CompressionStream = savedCS;
  }
});

await test('压缩后端完全不可用（compressor 返回 null）时退化为 store，zip 依然合法', async () => {
  const z = await writeZip(ROUNDTRIP, { compressor: () => null });
  const zip = await openZip(z);
  for (const e of zip.entries) assert.equal(e.method, 0, `${e.path} 应退化为 store`);
  assert.ok(eqBytes(await zip.read('big-repeat.bin'), ROUNDTRIP[4].data));
  if (python) {
    const p = path.join(TMP, 'store-only.zip');
    fs.writeFileSync(p, z);
    assert.equal(pythonInspectZip(p).testzip, null);
  }
  return '全 store 的 zip 自读 + 外部校验均通过';
});

/* ==========================================================================
 * 9. Chatbox 备份（.cbx）契约冒烟
 * ========================================================================== */

group('9. Chatbox .cbx 契约冒烟（manifest ↔ 条目 sha256/大小 自洽）');

await test('写出的 .cbx 用 fflate 读回后，manifest 的 size/sha256 全部对得上', async () => {
  if (!fflate) return 'fflate 不在，跳过';
  const sessions = [
    { id: '0122a8cc-1111-2222-3333-444455556666', name: '雅迪方向不好控制排查' },
    { id: 'abc-123', name: 'second session' },
  ].map((s) => ({
    ...s,
    payload: new TextEncoder().encode(
      JSON.stringify({
        id: s.id,
        name: s.name,
        type: 'chat',
        starred: false,
        messages: [
          { id: `${s.id}-m1`, role: 'user', contentParts: [{ type: 'text', text: '你好' }], timestamp: 1791518801245 },
          { id: `${s.id}-m2`, role: 'assistant', contentParts: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '回答' }], timestamp: 1791518802245 },
        ],
      }),
    ),
  }));

  const entries = sessions.map((s) => ({
    path: `sessions/${encodeURIComponent(s.id)}/session.json`,
    data: s.payload,
    deflate: true,
  }));
  const manifest = {
    format: 'chatbox-backup',
    formatVersion: 2,
    exportedAt: '2026-11-16T10:00:00.000Z',
    application: { name: 'Chatbox', version: '1.17.0', platform: 'win32' },
    exportItems: ['conversations'],
    data: {},
    sessions: sessions.map((s, i) => ({
      path: entries[i].path,
      size: s.payload.length,
      checksum: { algorithm: 'sha256', value: sha256Hex(s.payload) },
      id: s.id,
      meta: { id: s.id, name: s.name, sortOrder: i, createdAt: 1791518801245 },
      resourceIds: [],
    })),
    resources: [],
    warnings: [],
    stats: { sessionCount: sessions.length, resourceCount: 0, deduplicatedResourceCount: 0, warningCount: 0 },
  };
  const all = [{ path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) }, ...entries];
  const cbx = await writeZip(all);

  // 1) 用 Chatbox 同款库 fflate 读
  const files = fflate.unzipSync(cbx);
  const manifestPath = 'manifest.json';
  const readManifest = JSON.parse(new TextDecoder().decode(files[manifestPath]));
  assert.equal(readManifest.format, 'chatbox-backup');

  // 2) Chatbox 的校验点：每个 zip 条目都要在 manifest 里，且 size/checksum 对得上
  const listed = new Set([manifestPath, ...readManifest.sessions.map((s) => s.path)]);
  for (const name of Object.keys(files)) assert.ok(listed.has(name), `${name} 未在 manifest 中列出`);
  for (const desc of readManifest.sessions) {
    assert.ok(files[desc.path], `manifest 里的 ${desc.path} 不在 zip 中`);
    assert.equal(files[desc.path].length, desc.size, `${desc.path} size`);
    assert.equal(sha256Hex(files[desc.path]), desc.checksum.value, `${desc.path} sha256`);
  }
  assert.equal(readManifest.stats.sessionCount, readManifest.sessions.length);

  // 3) 我们自己读回来再验一遍（网页里两条路都会用）
  const zip = await openZip(cbx);
  for (const desc of readManifest.sessions) {
    const data = await zip.read(desc.path);
    assert.equal(sha256Hex(data), desc.checksum.value);
  }
  return `${sessions.length} 个会话，${cbx.length} 字节，fflate 与自读校验均通过`;
});

/* ==========================================================================
 * 汇总
 * ========================================================================== */

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const totalMs = results.reduce((a, r) => a + r.ms, 0);

console.log('\n' + '='.repeat(70));
console.log(`结果：\x1b[32m${passed} 通过\x1b[0m${failed.length ? `，\x1b[31m${failed.length} 失败\x1b[0m` : ''}，共 ${results.length} 项，耗时 ${(totalMs / 1000).toFixed(2)} s`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}\n    ${f.err && f.err.message}`);
}
const byGroup = new Map();
for (const r of results) {
  const g = byGroup.get(r.group) || { pass: 0, fail: 0 };
  r.ok ? g.pass++ : g.fail++;
  byGroup.set(r.group, g);
}
console.log('\n分组：');
for (const [g, s] of byGroup) console.log(`  ${s.fail ? '✗' : '✓'} ${g}  (${s.pass}/${s.pass + s.fail})`);
console.log(`\n临时产物: ${TMP}`);

process.exitCode = failed.length ? 1 : 0;
