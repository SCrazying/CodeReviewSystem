// 修正版解压: Node Buffer API 是单参 offset 形式 buf.readUInt16LE(off)
// (此前 unzip-1111.cjs 误写成 readUInt16LE(buf?, off) 的两参形式 → 全部解析错位)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZIP = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip';
const OUT = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked-v1.1.11';

const buf = fs.readFileSync(ZIP);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('EOCD 未找到');
const cnt = buf.readUInt16LE(eocd + 10);
const cdOfs = buf.readUInt32LE(eocd + 16);
console.log('EOCD@', eocd, '条目:', cnt, 'CD@', cdOfs);

let p = cdOfs, n = 0;
for (let i = 0; i < cnt; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) { console.log('签名错 @条目', i); break; }
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
  const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
  const lho = buf.readUInt32LE(p + 42);
  const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + lnl + lel;
  const rel = name.replace(/\\/g, '/');
  if (!rel.endsWith('/')) {
    const raw = buf.slice(dataStart, dataStart + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (data) {
      const full = path.join(OUT, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, data);
      n++;
    }
  }
  p += 46 + nl + el + cl;
}
console.log('解压完成:', n, '个文件');
