import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 支持两种布局：
//   工作目录：root/{zipkit.js,core.mjs,device.js,_build/{template,app,...},chat/{template,app,core,prompts}}
//   仓库：    root/{index.html,chat.html,src/{zipkit.js,core.mjs,device.js,build-client.mjs,chat/{template,app,core,prompts}}}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] || path.resolve(here, '..');

function find(relCandidates) {
  for (const rel of relCandidates) {
    const p = path.isAbsolute(rel) ? rel : path.join(rel.startsWith('.') ? here : root, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const templatePath = find(['chat/template.html', './chat/template.html']);
if (!templatePath) {
  console.error('找不到 chat/template.html');
  process.exit(1);
}

const MODULES = [
  { file: 'zipkit.js', slot: '<!--INLINE:zipkit.js-->', path: find(['zipkit.js', './zipkit.js']) },
  { file: 'core-lib.mjs', slot: '<!--INLINE:core-lib.mjs-->', path: find(['core.mjs', './core.mjs']) },
  { file: 'prompts.mjs', slot: '<!--INLINE:prompts.mjs-->', path: find(['chat/prompts.mjs', './chat/prompts.mjs']) },
  { file: 'chat-core.mjs', slot: '<!--INLINE:chat-core.mjs-->', path: find(['chat/core.mjs', './chat/core.mjs']) },
  { file: 'chat-app.mjs', slot: '<!--INLINE:chat-app.mjs-->', path: find(['chat/app.mjs', './chat/app.mjs']) },
];

const DEVICE_SLOT = '/*__INLINE_DEVICE__*/';

function stripModuleSyntax(name, code) {
  if (/^\s*import\s/m.test(code)) throw new Error(`${name} 含 import，不能内联`);
  let out = code;
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  out = out.replace(/^(\s*)export\s+default\s+/gm, '$1const __defaultExport = ');
  out = out.replace(/^(\s*)export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '$1');
  return out;
}

function topLevelNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return [...names];
}

let html = fs.readFileSync(templatePath, 'utf8');
const seen = new Map();
const report = [];

for (const mod of MODULES) {
  if (!mod.path) {
    console.log('missing:', mod.file, '(跳过，功能不完整)');
    html = html.replace(mod.slot, `/* [missing] ${mod.file} */`);
    continue;
  }
  const src = fs.readFileSync(mod.path, 'utf8');
  const names = topLevelNames(src);
  const clash = names.filter((n) => seen.has(n));
  if (clash.length) {
    throw new Error(`${mod.file} 与 ${[...new Set(clash.map((c) => seen.get(c)))].join(',')} 重名: ${clash.slice(0, 8).join(', ')}`);
  }
  for (const n of names) seen.set(n, mod.file);
  const code = stripModuleSyntax(mod.file, src);
  html = html.replace(mod.slot, `/* ===== ${mod.file} ===== */\n${code}`);
  report.push(`${mod.file} (${code.length} bytes)`);
}

const devicePath = find(['device.js', './device.js']);
if (devicePath) {
  const dev = fs.readFileSync(devicePath, 'utf8');
  html = html.replace(DEVICE_SLOT, dev);
  report.unshift(`device.js (${dev.length} bytes)`);
} else {
  html = html.replace(DEVICE_SLOT, '/* device.js missing */');
  console.log('warning: 找不到 device.js，设备档位不会自动切换');
}

const out = path.join(root, 'chat.html');
fs.writeFileSync(out, html, 'utf8');
console.log('inlined: ' + report.join('\n         '));
console.log('wrote', out, html.length, 'bytes');
