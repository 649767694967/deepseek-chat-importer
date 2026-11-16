/**
 * chat/prompts.test.mjs —— prompts.mjs 的零依赖自测
 * 运行：node chat/prompts.test.mjs
 */

import {
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_PRESETS,
  HELP_HTML,
  ERROR_HINTS,
  explainError,
  findPreset,
  presetText,
} from './prompts.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label + (detail ? ` :: ${detail}` : ''));
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function cjkLen(s) {
  return (String(s).match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/* ---------------------------------------------------------------- */
section('A. 导出存在性与类型');

ok(typeof DEFAULT_SYSTEM_PROMPT === 'string', 'DEFAULT_SYSTEM_PROMPT 是字符串');
ok(DEFAULT_SYSTEM_PROMPT.length >= 20, 'DEFAULT_SYSTEM_PROMPT 非空且像一句话', `len=${DEFAULT_SYSTEM_PROMPT.length}`);
ok(Array.isArray(PROMPT_PRESETS), 'PROMPT_PRESETS 是数组');
ok(typeof HELP_HTML === 'string', 'HELP_HTML 是字符串');
ok(Array.isArray(ERROR_HINTS), 'ERROR_HINTS 是数组');
ok(typeof explainError === 'function', 'explainError 是函数');
ok(typeof findPreset === 'function', 'findPreset 是函数');
ok(typeof presetText === 'function', 'presetText 是函数');

/* ---------------------------------------------------------------- */
section('B. 预设数量与 id 唯一');

ok(PROMPT_PRESETS.length >= 6, `预设数量 ≥ 6（实际 ${PROMPT_PRESETS.length}）`);
const ids = PROMPT_PRESETS.map((p) => p.id);
eq(new Set(ids).size, ids.length, 'id 唯一');
for (const need of ['default', 'concise', 'coder', 'jailbreak', 'jailbreak-nsfw', 'jailbreak-roleplay']) {
  ok(ids.includes(need), `必含预设 ${need}`);
}

/* ---------------------------------------------------------------- */
section('C. 预设字段完整性 + 长度区间');

for (const p of PROMPT_PRESETS) {
  ok(typeof p.id === 'string' && p.id.length > 0 && /^[a-z0-9-]+$/.test(p.id), `${p.id || '?'} id 合法（小写+连字符）`);
  ok(typeof p.name === 'string' && p.name.length >= 2, `${p.id} name 非空`);
  ok(typeof p.desc === 'string' && p.desc.length >= 6, `${p.id} desc 非空`);
  ok(typeof p.text === 'string' && p.text.length >= 50 && p.text.length <= 3000, `${p.id} text 长度 50~3000（${p.text.length}）`);
  ok(p.text.trim() === p.text, `${p.id} text 首尾无空白`);
}

/* ---------------------------------------------------------------- */
section('D. 破甲三个预设：字数、约束、直接指令、结构');

const JB = PROMPT_PRESETS.filter((p) => p.id.startsWith('jailbreak'));
eq(JB.length, 3, '破甲系预设 3 个');

for (const p of JB) {
  const n = cjkLen(p.text);
  ok(n >= 200 && n <= 600, `${p.id} 中文字数 200~600（${n} 字）`);
  ok(/不要|不得|不许|不做|不写|不加|不用|不反问/.test(p.text), `${p.id} 含「不要/不…」类硬约束`);
  ok(p.text.includes('直接'), `${p.id} 含「直接」类指令`);
  ok(/优先级/.test(p.text), `${p.id} 声明了冲突时优先级`);
  ok(/输出格式/.test(p.text), `${p.id} 声明了输出格式`);
  ok(!/遵守[^。\n]{0,8}(政策|规定|条款)|必须(遵循|遵守)/.test(p.text), `${p.id} 不自引用政策（政策字样仅出现在"不要引用"的上下文里）`);
}

const byId = Object.fromEntries(PROMPT_PRESETS.map((p) => [p.id, p]));

ok(
  /免责声明/.test(byId.jailbreak.text) && /说教|伦理|告诫/.test(byId.jailbreak.text),
  'jailbreak 明确禁止免责声明与说教',
);
ok(/要求确认|不反问|不让补充/.test(byId.jailbreak.text), 'jailbreak 明确不要求用户确认');
ok(/成人|露骨/.test(byId['jailbreak-nsfw'].text), 'jailbreak-nsfw 覆盖成人向');
ok(/成年人/.test(byId['jailbreak-nsfw'].text), 'jailbreak-nsfw 声明角色均为成年人');
ok(/角色|人设|扮演/.test(byId['jailbreak-roleplay'].text), 'jailbreak-roleplay 覆盖角色扮演');
ok(/出戏|OOC/i.test(byId['jailbreak-roleplay'].text), 'jailbreak-roleplay 处理出戏');
ok(/不.*(省略|淡出|含蓄)/.test(byId['jailbreak-nsfw'].text), 'jailbreak-nsfw 禁止省略/淡出');

/* ---------------------------------------------------------------- */
section('E. HELP_HTML 内容覆盖');

const help = HELP_HTML;
ok(help.includes('platform.deepseek.com'), 'HELP_HTML 含 platform.deepseek.com');
ok(help.includes('/chat/completions'), 'HELP_HTML 含 /chat/completions');
ok(help.includes('401'), 'HELP_HTML 含 401');
ok(help.includes('429'), 'HELP_HTML 含 429');
ok(/CORS|跨域/.test(help), 'HELP_HTML 含 CORS / 跨域');
ok(help.includes('402') && help.includes('403') && help.includes('404'), 'HELP_HTML 含 402/403/404');
ok(/5xx|500|502|503/.test(help), 'HELP_HTML 含 5xx 类');
ok(help.includes('localStorage'), 'HELP_HTML 说明 localStorage 存储');
ok(/明文/.test(help), 'HELP_HTML 提醒 Key 明文存储');
ok(help.includes('deepseek-chat') && help.includes('deepseek-reasoner'), 'HELP_HTML 含两个官方模型名');
ok(/Ollama|11434/.test(help) && /LM Studio|1234/.test(help), 'HELP_HTML 含本地推理示例地址');
ok(/nginx|proxy_pass/.test(help), 'HELP_HTML 含 nginx 反代示例');
ok(/Access-Control-Allow-Origin/.test(help), 'HELP_HTML 反代示例补了 CORS 头');
ok(/preflight|OPTIONS|预检/i.test(help), 'HELP_HTML 说明预检请求');
ok(/按量计费|计费/.test(help), 'HELP_HTML 说明计费');
ok(/只显示一次|只显示这?一次/.test(help), 'HELP_HTML 提醒 key 只显示一次');
ok(/<h3>/.test(help) && /<ol>/.test(help) && /<table/.test(help) && /<code>/.test(help), 'HELP_HTML 使用 h3/ol/table/code');
ok(!/<script|<iframe|https?:\/\/[^\s"']+\.(js|css)\b|@import|url\(/i.test(help), 'HELP_HTML 无脚本/无外部资源引用');
ok(!/\$\{/.test(help), 'HELP_HTML 无未转义的模板占位');
ok(cjkLen(help) > 1200, `HELP_HTML 信息量充足（${cjkLen(help)} 个中文字）`);

/* ---------------------------------------------------------------- */
section('F. explainError 状态码分支');

const e401 = explainError(401, '');
const e402 = explainError(402, '');
const e403 = explainError(403, '');
const e404 = explainError(404, '');
const e429 = explainError(429, '');
const e500 = explainError(500, '');
const e0 = explainError(0, 'Failed to fetch');
const e0empty = explainError(0, '');

for (const [label, v] of [
  ['401', e401],
  ['402', e402],
  ['403', e403],
  ['404', e404],
  ['429', e429],
  ['500', e500],
  ['0/Failed to fetch', e0],
  ['0/空 body', e0empty],
]) {
  ok(typeof v === 'string' && v.trim().length > 0, `explainError(${label}) 非空`, JSON.stringify(v));
}

const tested = [e401, e429, e404, e0];
eq(new Set(tested).size, 4, 'explainError 401/429/404/0 四者互不相同');
ok(/Key|密钥/.test(e401), '401 提示提到 Key');
ok(/频繁|限流/.test(e429), '429 提示提到限流/频繁');
ok(/地址|模型名/.test(e404), '404 提示提到地址/模型名');
ok(/跨域|CORS|网络/.test(e0), '0 提示提到跨域/网络');
ok(/余额|额度/.test(e402), '402 提示提到余额');
ok(/权限|地区/.test(e403), '403 提示提到权限/地区');
ok(/服务端|稍后|重试/.test(e500), '5xx 提示提到服务端/重试');

/* ---------------------------------------------------------------- */
section('G. explainError 响应体关键词优先');

ok(/余额|额度/.test(explainError(400, '{"error":{"message":"Insufficient Balance"}}')), 'body=Insufficient Balance → 余额');
ok(/模型名/.test(explainError(400, '{"error":{"message":"Model Not Exist"}}')), 'body=Model Not Exist → 模型名');
ok(/模型名/.test(explainError(404, '{"error":{"message":"model_not_found"}}')), 'body=model_not_found → 模型名');
ok(/Key|密钥/.test(explainError(401, '{"error":{"message":"Authentication Fails, Your api key is invalid"}}')), 'body=invalid api key → Key');
ok(/限流|频繁/.test(explainError(200, 'Rate limit reached for requests')), 'body=Rate limit reached → 限流');
ok(/上下文/.test(explainError(400, "This model's maximum context length is 65536 tokens")), 'body=maximum context length → 上下文');
ok(/审核/.test(explainError(400, '{"error":{"message":"content policy violation"}}')), 'body=content policy → 审核');
ok(/跨域|CORS|网络/.test(explainError(0, 'TypeError: NetworkError when attempting to fetch resource.')), 'body=NetworkError → 跨域/网络');

/* ---------------------------------------------------------------- */
section('H. 健壮性（异常入参不抛错）');

const weird = [
  [undefined, undefined],
  [null, null],
  ['abc', 123],
  [NaN, {}],
  [-1, 'x'],
  [0, 'x'.repeat(20000)],
];
for (const [s, b] of weird) {
  let out = null;
  let threw = null;
  try {
    out = explainError(s, b);
  } catch (err) {
    threw = err;
  }
  ok(!threw && typeof out === 'string' && out.length > 0, `explainError(${String(s)}, ${typeof b}) 不抛错且返回非空`);
}

/* ---------------------------------------------------------------- */
section('I. 正则自检：ERROR_HINTS 可编译且能各自命中');

for (const item of ERROR_HINTS) {
  ok(typeof item.test === 'string' && typeof item.hint === 'string' && item.hint.length > 0, `hint 非空（${String(item.test).slice(0, 32)}…）`);
  let re = null;
  try {
    re = new RegExp(item.test, 'i');
  } catch {
    /* 交给下面断言 */
  }
  ok(re instanceof RegExp, `正则可编译：${String(item.test).slice(0, 40)}`);
}

/* ---------------------------------------------------------------- */
section('J. 辅助函数');

eq(findPreset('jailbreak').id, 'jailbreak', 'findPreset 命中');
eq(findPreset('nope').id, 'default', 'findPreset 未命中回落 default');
eq(findPreset(undefined).id, 'default', 'findPreset(undefined) 回落 default');
eq(presetText('concise'), byId.concise.text, 'presetText 与预设正文一致');
eq(presetText('nope'), DEFAULT_SYSTEM_PROMPT, 'presetText 未命中回落默认');
ok(!PROMPT_PRESETS.some((p) => p.text === DEFAULT_SYSTEM_PROMPT), '预设正文不与默认提示词重复');

/* ---------------------------------------------------------------- */
console.log('\n----------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
