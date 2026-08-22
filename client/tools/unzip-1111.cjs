// 从 v1.1.11 zip 解出 win-unpacked 作为增量基线(自实现 unzip: 只解 deflate/store)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZIP = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip';
const OUT = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked-v1.1.11';

const buf = fs.readFileSync(ZIP);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('EOCD');
const cnt = buf.readUInt16LE(eocd, 10);
let p = buf.readUInt32LE(eocd, 16);
let n = 0;
for (let i = 0; i < cnt; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const method = buf.readUInt16LE(p, 10);
  const csize = buf.readUInt32LE(p, 20);
  const nl = buf.readUInt16LE(p, 28), el = buf.readUInt16LE(p, 30), cl = buf.readUInt16LE(p, 32);
  const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
  const lho = buf.readUInt32LE(p, 42);
  // local header: 名字长度在 26, 额外长度在 28
  const lnl = buf.readUInt16LE(lho, 26), lel = buf.readUInt16LE(lho, 28);
  const dataStart = lho + 30 + lnl + lel;
  const raw = buf.slice(dataStart, dataStart + csize);
  const rel = name.replace(/\\/g, '/');
  if (rel.endsWith('/')) { p += 46 + nl + el + cl; continue; }
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  let data;
  if (method === 0) data = raw;
  else if (method === 8) data = zlib.inflateRawSync(raw);
  else { console.log('跳过不支持压缩方式', method, rel); p += 46 + nl + el + cl; continue; }
  fs.writeFileSync(full, data);
  n++;
  p += 46 + nl + el + cl;
}
console.log('解压完成:', n, '个文件 →', OUT);
