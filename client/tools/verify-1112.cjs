// v1.1.12 三层无 Key 验证(全量+增量两包)
const fs = require('fs');
const path = require('path');

function zipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const cnt = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < cnt; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    names.push(buf.slice(p + 46, p + 46 + nl).toString('utf8'));
    p += 46 + nl + el + cl;
  }
  return { names, buf };
}

const badPatterns = [/\.opencodereview/, /gate\.json/, /reviews-history/, /\.env$/i];
for (const zp of [
  'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.12.zip',
  'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.12-incremental-from-v1.1.11.zip',
]) {
  const { names, buf } = zipEntries(zp);
  const hit = names.filter((n) => badPatterns.some((re) => re.test(n)));
  console.log(path.basename(zp));
  console.log('  第1层 条目:', names.length, hit.length ? '❌ ' + hit : '✅ CLEAN');
  // 第2/3层: asar + exe 内容
  const ASAR = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar';
  const EXE = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar.unpacked/node_modules/@alibaba-group/ocr-win32-x64/bin/opencodereview.exe';
  // 凭据源
  const secrets = new Set();
  for (const cf of [process.env.APPDATA + '\\CodeReviewTool\\config.json', process.env.USERPROFILE + '\\.opencodereview\\config.json']) {
    if (!fs.existsSync(cf)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
      for (const t of [c.token, c.clientToken]) if (typeof t === 'string' && t.length >= 12) secrets.add(t);
      for (const r of c.repos || []) if (typeof r.token === 'string' && r.token.length >= 12) secrets.add(r.token);
      const dig = (o) => { for (const [k, v] of Object.entries(o || {})) {
        if (typeof v === 'string' && v.length >= 12 && /key|token|secret/i.test(k)) secrets.add(v);
        else if (typeof v === 'object' && v) dig(v); } };
      dig(c);
    } catch {}
  }
  let dirty = 0;
  const a = fs.readFileSync(ASAR), x = fs.readFileSync(EXE);
  for (const s of secrets) {
    if (a.includes(Buffer.from(s))) { console.log('  ❌ asar 泄漏'); dirty++; }
    if (x.includes(Buffer.from(s))) { console.log('  ❌ ocr exe 泄漏'); dirty++; }
    if (buf.includes(Buffer.from(s))) { console.log('  ❌ zip 原文命中'); dirty++; }
  }
  console.log('  第3层 凭据比对:', secrets.size, '个 →', dirty ? '❌' : '✅ CLEAN');
  // 新功能入包确认
  console.log('  runNative修复(无this.config):', !a.includes(Buffer.from('this.config.llmTimeout')) && a.includes(Buffer.from('buildNativeEnv')) ? '✅' : '⚠ 检查');
}
