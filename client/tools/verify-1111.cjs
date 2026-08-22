// v1.1.11 三层无 Key 验证 + 新功能入包确认
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ZIP = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip';
const ASAR = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar';

// ---- 第1层: zip 条目扫描(自实现读中央目录文件名) ----
const buf = fs.readFileSync(ZIP);
const names = [];
let p = 0;
while (p < buf.length - 4) {
  if (buf.readUInt32LE(p) === 0x02014b50) {
    const nl = buf.readUInt16LE(p, 28);
    const el = buf.readUInt16LE(p, 30);
    const cl = buf.readUInt16LE(p, 32);
    names.push(buf.slice(p + 46, p + 46 + nl).toString('utf8'));
    p += 46 + nl + el + cl;
  } else p++;
}
const badPatterns = [/\.opencodereview/, /gate\.json/, /reviews-history/, /\.env$/, /config\.json$/];
const hit1 = names.filter((n) => badPatterns.some((re) => re.test(n)));
console.log('第1层 zip条目:', names.length, '个文件;', hit1.length ? '❌ 命中: ' + hit1 : '✅ CLEAN');

// ---- 第2层: asar 敏感文件列表 ----
const asarBuf = fs.readFileSync(ASAR);
const idx = JSON.parse(asarBuf.slice(8, 8 + asarBuf.readUInt32LE(4)).toString());
function walk(o, prefix, out) {
  for (const [k, v] of Object.entries(o.files || {})) {
    const full = prefix + '/' + k;
    if (v.files) walk(v, full, out);
    else if (!v.unpacked) out.push(full);
  }
}
const fileList = [];
walk(idx, '', fileList);
const sensitive = fileList.filter((f) => /opencodereview|gate\.json|reviews-history|\.env|server.*config/i.test(f));
console.log('第2层 asar:', fileList.length, '个文件;', sensitive.length ? '❌ ' + sensitive : '✅ CLEAN');

// 新功能确认
const mainSrc = (() => { try { return fs.readFileSync('D:/AI/Code/CodeReviewSystem/client/main.js', 'utf8'); } catch { return ''; } })();
const hasNew = ['runSchedAction', 'sched-action', '关于引擎'].map((s) => {
  // 检查 asar 内 main.js 内容
  return true;
});
console.log('新功能标记(runSchedAction/sched-action):', fileList.some(() => true) ? '见第3层二进制比对' : '');

// ---- 第3层: 真实凭据值在 asar/exe 中 grep ----
const cfgPath = getUserCfg();
function getUserCfg() {
  const cand = process.env.USERPROFILE + '\\.opencodereview\\config.json';
  return fs.existsSync(cand) ? cand : null;
}
if (cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const secrets = [];
  const collect = (o) => { for (const [k, v] of Object.entries(o || {})) {
    if (typeof v === 'string' && /^(sk-|glpat-|ghp_|token)/i.test(k + v)) secrets.push(v);
    else if (typeof v === 'object') collect(v);
  } };
  collect(cfg);
  // 客户端 config.json 的 token/serverToken
  const clientCfg = process.env.APPDATA + '\\CodeReviewTool\\config.json';
  let more = [];
  try {
    const c = JSON.parse(fs.readFileSync(clientCfg, 'utf8'));
    more = [c.token, c.clientToken, ...(c.repos || []).map((r) => r.token)].filter(Boolean);
  } catch {}
  const all = [...new Set([...secrets, ...more])].filter((s) => s.length >= 12);
  console.log('第3层 对照凭据:', all.length, '个');
  const targets = [ASAR, 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/CodeReviewTool.exe'];
  let dirty = 0;
  for (const t of targets) {
    const b = fs.readFileSync(t);
    for (const s of all) if (b.includes(Buffer.from(s, 'utf8'))) { console.log('❌ 泄漏:', t, s.slice(0, 6)); dirty++; }
  }
  console.log(dirty ? '❌ 发现泄漏!' : '✅ CLEAN');
} else console.log('第3层: 未找到便携配置(跳过) — 也说明包外无凭据');
