// v1.1.12 双包: 全量 zip + 增量 zip(相对 v1.1.11 变化的文件)
// 增量原理: 客户端是 win-unpacked 目录分发, Electron 应用大部分 = Electron 运行时(不变) + app 代码(app.asar + 少量 native exe)
// 真正会变的只有: resources/app.asar, resources/app.asar.unpacked/(ocr exe), 可能的 locale/版本文件
// 增量包 = 从 v1.1.11 的 win-unpacked 与本次对比, 只打包内容不同的文件 + 一个 update.bat(解压覆盖到安装目录)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OLD = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked-v1.1.11';
const NEW = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked';
const OUT_FULL = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.12.zip';
const OUT_INCR = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.12-incremental-from-v1.1.11.zip';

if (!fs.existsSync(OLD)) { console.log('NEED_OLD_SNAPSHOT'); process.exit(2); }

function listFiles(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

// ---- crc32 + zip writer(复用 make-zip 实现) ----
function crc32(buf) {
  if (!crc32.t) { crc32.t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = crc32.t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function writeZip(files, out) {
  const locals = [], centrals = []; let offset = 0;
  for (const f of files) {
    const data = f.data || fs.readFileSync(f.full);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const useD = comp.length < data.length;
    const payload = useD ? comp : data, method = useD ? 8 : 0, crc = crc32(data);
    const name = Buffer.from(f.rel.replace(/\\/g, '/'), 'utf8');
    const dosDate = ((2026 - 1980) << 9) | (8 << 5) | 22;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, payload);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosDate, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return fs.statSync(out).size;
}

const newFiles = listFiles(NEW, '');
console.log('新版本文件数:', newFiles.length);

// ---- 全量 zip ----
const szF = writeZip(newFiles.map((f) => ({ full: f.full, rel: f.rel })), OUT_FULL);
console.log('全量:', (szF / 1048576).toFixed(1), 'MB');

// ---- 差异计算 ----
const oldMap = new Map();
for (const f of listFiles(OLD, '')) oldMap.set(f.rel, fs.readFileSync(f.full));
const changed = [], added = [];
for (const f of newFiles) {
  const nb = fs.readFileSync(f.full);
  const ob = oldMap.get(f.rel);
  if (!ob) { added.push(f.rel); changed.push({ ...f, data: nb }); }
  else if (!ob.equals(nb)) { changed.push({ ...f, data: nb }); }
}
const removed = [...oldMap.keys()].filter((k) => !newFiles.some((f) => f.rel === k));
console.log('变化文件:', changed.length, '(新增', added.length, '/ 修改', changed.length - added.length, ') 删除:', removed.length);
changed.slice(0, 15).forEach((f) => console.log('  Δ', f.rel));

// ---- 增量 zip: 变化文件 + update.bat ----
const bat = [
  '@echo off',
  'chcp 65001 >nul',
  'echo CodeReviewTool v1.1.12 增量更新',
  'echo 将把本目录内文件覆盖到安装目录(不删除你自己的文件)',
  'set /p TARGET=请输入当前 CodeReviewTool 安装目录(回车默认 %CD%): ',
  'if "%TARGET%"=="" set TARGET=%CD%',
  'xcopy /y /e /i "%~dp0app" "%TARGET%"',
  'echo.',
  'echo ✅ 更新完成, 可直接启动 CodeReviewTool.exe',
  'pause',
].join('\r\n');
const incrEntries = changed.map((f) => ({ rel: 'app/' + f.rel, data: f.data }));
incrEntries.push({ rel: 'update.bat', data: Buffer.from(bat, 'utf8') });
incrEntries.push({ rel: 'README-增量更新.txt', data: Buffer.from(
  'CodeReviewTool v1.1.12 增量包(基于 v1.1.11)\r\n\r\n' +
  '使用方法:\r\n' +
  '  1. 关闭正在运行的 CodeReviewTool\r\n' +
  '  2. 双击 update.bat, 输入安装目录(或把本压缩包内 app 文件夹的内容手动覆盖到安装目录)\r\n' +
  '  3. 完成。配置/历史不受影响(存于用户目录, 不在程序目录)\r\n\r\n' +
  '本包含 ' + changed.length + ' 个变化文件; 全量包请用 CodeReviewTool-win-x64-v1.1.12.zip\r\n', 'utf8') });
const szI = writeZip(incrEntries, OUT_INCR);
console.log('增量:', (szI / 1048576).toFixed(1), 'MB (' + (100 - Math.round(szI / szF * 100)) + '% 小于全量)');
