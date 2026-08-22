#!/usr/bin/env node
/**
 * 提交前预检(preflight)— 规避「Cannot read properties of undefined」类低级错误
 *
 * 检查①: 静态扫雷 — 所有 function 声明的函数体内禁止 this.xxx
 *   背景: runNative(独立函数)里误写 this.config.llmTimeout 导致审查必崩(v1.1.11 事故)。
 *   原理: 独立函数的 this 在严格模式下是 undefined, 访问属性必然 TypeError。
 *   局限: 只扫 function 声明(class 方法/对象方法/箭头函数不在此列, 它们的 this 是合法的)。
 *
 * 检查②: buildNativeEnv 行为单测 — ocr 环境变量注入的关键路径用纯函数锁死,
 *   llmTimeout 注入逻辑回归即报错(不再依赖"真跑一次审查"才能发现)。
 *
 * 用法: node client/tools/preflight.cjs   (exit 0 = 通过, exit 1 = 有问题)
 */
const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..');
const TARGETS = [
  path.join(CLIENT, 'main.js'),
  path.join(CLIENT, 'preload.js'),
  path.join(CLIENT, 'backend', 'review-backend.js'),
  path.join(CLIENT, 'backend', 'fix-engine.js'),
  path.join(CLIENT, 'backend', 'auth-gate.js'),
  path.join(CLIENT, 'backend', 'report-queue.js'),
];

let problems = 0;

// ---- 检查①: 独立函数体内的 this. 引用 ----
for (const file of TARGETS) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let depth = 0;
  const stack = [];   // { name, startIdx, baseDepth }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\/\/.*$/, '');   // 去行尾注释(粗粒度, 足够本用途)
    // 函数声明开始(允许缩进/async 前缀)
    const m = code.match(/^\s*(?:async\s+)?function\s+(\w+)/);
    if (m) stack.push({ name: m[1], startIdx: i, baseDepth: depth });
    depth += (code.match(/{/g) || []).length - (code.match(/}/g) || []).length;
    // 栈顶函数体结束(depth 回到声明前的水平)
    while (stack.length && depth <= stack[stack.length - 1].baseDepth && i >= stack[stack.length - 1].startIdx) {
      const fn = stack.pop();
      for (let j = fn.startIdx; j <= i; j++) {
        const t = lines[j];
        if (/^\s*\/\//.test(t)) continue;                       // 整行注释跳过
        const hit = t.match(/\bthis\.(\w+)/g);
        if (hit) {
          problems++;
          console.log(`❌ ${path.basename(file)}:${j + 1} 独立函数 ${fn.name}() 内使用 ${hit.join(',')} — 改为显式入参!`);
        }
      }
    }
  }
}
if (!problems) console.log('✅ 检查① 通过: 所有 function 声明内无 this. 引用');

// ---- 检查②: buildNativeEnv 单测 ----
let rb;
try {
  rb = require(path.join(CLIENT, 'backend', 'review-backend.js'));
} catch (e) {
  console.log('⚠️ 检查② 跳过(review-backend 加载失败:', e.message.slice(0, 60) + ')');
  rb = null;
}
if (rb && typeof rb.buildNativeEnv === 'function') {
  const assert = (cond, msg) => { if (!cond) { problems++; console.log('❌ 单测失败:', msg); } };
  const base = { llmBaseUrl: 'https://x.example/v1', llmApiKey: 'sk-test-123456', model: 'test-model' };

  const e1 = rb.buildNativeEnv({ ...base, llmTimeout: 300 }).env;
  assert(e1.OCR_LLM_TIMEOUT === '300', '300 应注入为 "300", 实际=' + e1.OCR_LLM_TIMEOUT);

  const e2 = rb.buildNativeEnv(base).env;
  assert(!('OCR_LLM_TIMEOUT' in e2), '未设置 llmTimeout 不应注入');

  const e3 = rb.buildNativeEnv({ ...base, llmTimeout: 0 }).env;
  assert(!('OCR_LLM_TIMEOUT' in e3), 'llmTimeout=0 表示用引擎默认, 不应注入');

  const e4 = rb.buildNativeEnv({ ...base, llmTimeout: -5 }).env;
  assert(!('OCR_LLM_TIMEOUT' in e4), '负数不应注入');

  const e5 = rb.buildNativeEnv({ ...base, llmTimeout: 45.7 }).env;
  assert(e5.OCR_LLM_TIMEOUT === '46', '小数应四舍五入, 实际=' + e5.OCR_LLM_TIMEOUT);

  const e6 = rb.buildNativeEnv({ llmBaseUrl: '', llmApiKey: '' }, {}).env;   // 第二参传空 baseEnv 隔离本机环境
  assert(!('OCR_LLM_URL' in e6), '空地址不应注入 URL(防空串误导引擎)');
  assert(e6.OCR_LLM_MODEL === 'deepseek-v4-flash', '空配置 model 应回退默认值');

  if (!problems) console.log('✅ 检查② 通过: buildNativeEnv 六项断言全过(llmTimeout 注入口径锁死)');
} else if (rb) {
  problems++;
  console.log('❌ review-backend 未导出 buildNativeEnv — 回归防护被拆除!');
}

console.log(problems ? `\n🛑 preflight 失败: ${problems} 个问题, 禁止提交` : '\n🎉 preflight 全部通过');
process.exit(problems ? 1 : 0);
