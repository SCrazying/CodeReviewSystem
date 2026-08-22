// v1.1.11 验证 v2: 修 asar 头解析(前16字节是 pickle 头) + zip 条目解析修正
const fs = require('fs');

const ZIP = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip';
const ASAR = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar';

// ---- 第1层: zip 中央目录条目扫描(从 EOCD 反查, 更稳) ----
const buf = fs.readFileSync(ZIP);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('EOCD 未找到');
const cnt = buf.readUInt16LE(eocd, 10);
let p = buf.readUInt32LE(eocd, 16);
const names = [];
for (let i = 0; i < cnt; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const nl = buf.readUInt16LE(p, 28), el = buf.readUInt16LE(p, 30), cl = buf.readUInt16LE(p, 32);
  names.push(buf.slice(p + 46, p + 46 + nl).toString('utf8'));
  p += 46 + nl + el + cl;
}
const badPatterns = [/\.opencodereview/, /gate\.json/, /reviews-history/, /\.env$/i];
const hit1 = names.filter((n) => badPatterns.some((re) => re.test(n)));
console.log('第1层 zip条目:', cnt, '个;', hit1.length ? '❌ ' + hit1 : '✅ CLEAN(无配置/凭据文件)');

// ---- 第2层: asar 文件列表(头 = 前 8 字节 pickle, JSON 从 offset 8 起 readUInt32LE(4) 是长度但含 padding) ----
// asar 格式: [4B uint=8][4B uint=headerSize][4B uint=?][4B uint=jsonLen][JSON...]
// 实测: 直接找第一个 '{' 开始解析到合法 JSON 为止
const a = fs.readFileSync(ASAR);
let start = a.indexOf(Buffer.from('{"files"'));
if (start < 0) throw new Error('asar header 未找到');
// 找到匹配的 JSON 结束: 用逐字节尝试 parse 太慢 → 用括号计数
let depth = 0, end = start, inStr = false, esc = false;
for (let i = start; i < a.length && i < start + 500000; i++) {
  const c = a[i];
  if (esc) { esc = false; continue; }
  if (c === 0x5c && inStr) { esc = true; continue; }
  if (c === 0x22) { inStr = !inStr; continue; }
  if (inStr) continue;
  if (c === 0x7b) depth++;
  else if (c === 0x7d) { depth--; if (!depth) { end = i + 1; break; } }
}
const idx = JSON.parse(a.slice(start, end).toString('utf8'));
function walk(o, prefix, out) {
  for (const [k, v] of Object.entries(o.files || {})) {
    const full = prefix ? prefix + '/' + k : k;
    if (v.files) walk(v, full, out);
    else out.push({ f: full, unpacked: !!v.unpacked });
  }
}
const fileList = [];
walk(idx, '', fileList);
const sensitive = fileList.filter((x) => /opencodereview|gate\.json|reviews-history|\.env$|server.*config/i.test(x.f) && !x.unpacked);
console.log('第2层 asar:', fileList.length, '个文件;', sensitive.length ? '❌ ' + sensitive.map(s=>s.f) : '✅ CLEAN');
// 新功能入包确认(asar 内 main.js 含标记)
console.log('新功能(runSchedAction 定时审查):', idx.files['main.js'] ? '(在 main.js 内, 见二进制比对)' : '?');

// ---- 第3层: 真实凭据值 grep(zip 全量 + asar + exe) ----
const home = process.env.USERPROFILE;
const candCfg = [
  process.env.APPDATA + '\\CodeReviewTool\\config.json',
  home + '\\.opencodereview\\config.json',
].filter((f2) => fs.existsSync(f2));
const secrets = new Set();
for (const cf of candCfg) {
  try {
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
    for (const t of [c.token, c.clientToken]) if (typeof t === 'string' && t.length >= 12) secrets.add(t);
    for (const r of c.repos || []) if (typeof r.token === 'string' && r.token.length >= 12) secrets.add(r.token);
  } catch {}
}
const all = [...secrets];
console.log('第3层 对照凭据:', all.length, '个(', candCfg.map(x=>x.split('\\').pop()).join(','), ')');
let dirty = 0;
const targets = [ASAR, 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar.unpacked/node_modules/@alibaba-group/ocr-win32-x64/bin/opencodereview.exe'];
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  const b = fs.readFileSync(t);
  for (const s of all) if (b.includes(Buffer.from(s, 'utf8'))) { console.log('❌ 泄漏于', t.split('\\').pop()); dirty++; }
}
// zip 内嵌 payload 抽查: 对每个 secret 在整个 zip buffer 里搜(压缩后可能搜不到, 但 store 模式的能搜到)
for (const s of all) if (buf.includes(Buffer.from(s, 'utf8'))) { console.log('❌ zip 原文命中'); dirty++; }
console.log(dirty ? ('❌ 发现 ' + dirty + ' 处泄漏!') : '✅ CLEAN — 包内零凭据');
