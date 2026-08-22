// 第3层补强: 凭据源扩展(便携 .opencodereview 在 USERPROFILE 重定向目录) + 新功能入包字节确认
const fs = require('fs');
const path = require('path');
const home = process.env.USERPROFILE;

// 递归找 .opencodereview 目录(可能在 USERPROFILE 或项目内)
const candDirs = [home + '\\.opencodereview'];
const secrets = new Set();
for (const d of candDirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of ['config.json', 'gate.json', 'credentials.json']) {
    const p = path.join(d, f);
    if (!fs.existsSync(p)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      const dig = (o) => {
        for (const [k, v] of Object.entries(o || {})) {
          if (typeof v === 'string' && v.length >= 12 && /key|token|secret|password/i.test(k)) secrets.add(v);
          else if (typeof v === 'object') dig(v);
        }
      };
      dig(c);
    } catch {}
  }
}
// 客户端自己的 config(APPDATA)
const cc = process.env.APPDATA + '\\CodeReviewTool\\config.json';
if (fs.existsSync(cc)) {
  const c = JSON.parse(fs.readFileSync(cc, 'utf8'));
  for (const t of [c.token, c.clientToken]) if (typeof t === 'string' && t.length >= 12) secrets.add(t);
  for (const r of c.repos || []) if (typeof r.token === 'string' && r.token.length >= 12) secrets.add(r.token);
}
const all = [...secrets];
console.log('对照凭据总数:', all.length);

const ASAR = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar';
const EXE = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar.unpacked/node_modules/@alibaba-group/ocr-win32-x64/bin/opencodereview.exe';
let dirty = 0;
for (const t of [ASAR, EXE]) {
  if (!fs.existsSync(t)) { console.log('(跳过不存在:', t.split('\\').pop(), ')'); continue; }
  const b = fs.readFileSync(t);
  for (const s of all) if (b.includes(Buffer.from(s, 'utf8'))) { console.log('❌ 泄漏:', path.basename(t)); dirty++; }
}
console.log(dirty ? '❌ 有泄漏!' : '✅ 第3层 CLEAN(asar+ocr exe 零凭据命中)');

// 新功能入包字节级确认: asar 内 main.js / renderer/index.html
const a = fs.readFileSync(ASAR);
console.log('定时审查动作(runSchedAction):', a.includes(Buffer.from('runSchedAction')) ? '✅ 已入包' : '❌ 缺失');
console.log('任务动作下拉(sched-action):', a.includes(Buffer.from('sched-action')) ? '✅ 已入包' : '❌ 缺失');
console.log('每文件提示词上限(maxFileTokens):', a.includes(Buffer.from('maxFileTokens')) ? '✅ 已入包' : '❌ 缺失');
console.log('关于引擎面板(getOcrInfo):', a.includes(Buffer.from('getOcrInfo')) ? '✅ 已入包' : '❌ 缺失');
console.log('按选中修复(selIdx):', a.includes(Buffer.from('selIdx')) ? '✅ 已入包' : '❌ 缺失');

// ocr 版本确认
const { execFileSync } = require('child_process');
const ver = execFileSync(EXE, ['version'], { encoding: 'utf8', timeout: 10000 }).trim().split('\n')[0];
console.log('打包内 ocr 引擎:', ver);
