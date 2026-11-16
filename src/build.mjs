import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认以脚本上一级目录为工作根，可用 argv[2] 覆盖。
// 支持两种布局：仓库布局（template/app 与 build.mjs 同目录）与本地布局（../_build）。
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] || path.resolve(here, '..');
const buildDir = fs.existsSync(path.join(here, 'template.html')) ? here : path.join(root, '_build');
const isRepoLayout = path.basename(here) === 'src';

/**
 * 构建目标。each 目标 = 一个模板 + 一组内联模块 + 输出文件名。
 * - 直接内联：顶层声明进入同一个 <script> 作用域
 * - wrap：包进 IIFE，只把导出的名字挂到指定全局对象上，避免与其它模块撞名
 * - slots：自定义占位标记（默认 <!--INLINE:file-->）
 */
const targets = [
  {
    name: 'import-tool',
    template: 'template.html',
    outName: isRepoLayout ? 'index.html' : 'deepseek-import.html',
    modules: [
      { file: 'device.js', slots: ['/*__INLINE_DEVICE__*/'] },
      { file: 'zipkit.js' },
      { file: 'core.mjs' },
      { file: 'dsh_session_writer.js', wrap: 'DshWriter' },
      { file: 'app.js' },
    ],
  },
  {
    name: 'chat',
    template: 'chat.template.html',
    outName: 'chat.html',
    modules: [
      { file: 'device.js', slots: ['/*__INLINE_DEVICE__*/'] },
      { file: 'chat.js' },
    ],
  },
];

function stripModuleSyntax(name, code) {
  if (/^\s*import\s/m.test(code)) throw new Error(`${name} 含 import 语句，不能内联`);
  let out = code;
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  out = out.replace(/^(\s*)export\s+default\s+/gm, '$1const __defaultExport = ');
  out = out.replace(/^(\s*)export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '$1');
  return out;
}

function exportNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const exported = (bits[1] || bits[0]).trim();
      if (exported && exported !== 'default') names.add(exported);
    }
  }
  return [...names];
}

function buildTarget(target) {
  const templateFile = path.join(buildDir, target.template);
  if (!fs.existsSync(templateFile)) {
    throw new Error(`找不到模板 ${templateFile}`);
  }
  let html = fs.readFileSync(templateFile, 'utf8');

  for (const mod of target.modules) {
    const candidates = [path.join(root, mod.file), path.join(buildDir, mod.file)];
    const file = candidates.find((p) => fs.existsSync(p));
    const markers = mod.slots || [`<!--INLINE:${mod.file}-->`];
    if (!file) {
      for (const marker of markers) html = html.replace(marker, `/* [missing] ${mod.file} —— 该模块尚未生成 */`);
      console.log(`  missing: ${mod.file}`);
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    const names = exportNames(src);
    const code = stripModuleSyntax(mod.file, src);
    let block;
    if (mod.wrap) {
      const returned = names.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ');
      block = `/* ===== ${mod.file}（隔离作用域） ===== */\nconst ${mod.wrap} = (function () {\n${code}\nreturn { ${returned} };\n})();`;
    } else {
      block = `/* ===== ${mod.file} ===== */\n${code}`;
    }
    let replaced = false;
    for (const marker of markers) {
      if (html.includes(marker)) {
        html = html.replace(marker, block);
        replaced = true;
      }
    }
    console.log(`  inlined: ${mod.file} (${code.length} bytes${mod.wrap ? ', wrapped as ' + mod.wrap : ''})${replaced ? '' : ' [未被模板引用]'}`);
  }

  const out = path.join(root, process.env.OUT && target.name === 'import-tool' ? process.env.OUT : target.outName);
  fs.writeFileSync(out, html, 'utf8');
  console.log(`→ ${target.name}: ${out} (${html.length} bytes)`);
  return out;
}

for (const target of targets) {
  console.log(`[${target.name}]`);
  buildTarget(target);
}
