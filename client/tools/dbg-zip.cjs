// 调试: v1.1.11 zip 是 node 自制 store 型 zip, 检查中央目录解析
const fs = require('fs');
const buf = fs.readFileSync('D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip');
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
console.log('EOCD @', eocd, '总长', buf.length);
if (eocd < 0) process.exit(1);
const cnt = buf.readUInt16LE(eocd, 10);
const cdSize = buf.readUInt32LE(eocd, 12);
const cdOfs = buf.readUInt32LE(eocd, 16);
console.log('条目数:', cnt, '| 中央目录大小:', cdSize, '| 偏移:', cdOfs);
let p = cdOfs;
for (let i = 0; i < Math.min(cnt, 3); i++) {
  const sig = buf.readUInt32LE(p).toString(16);
  console.log('entry', i, 'sig:', sig, '(02014b50?)');
  if (sig !== '2014b50') { console.log('非中央目录签名, 停'); break; }
  const nl = buf.readUInt16LE(p, 28), el = buf.readUInt16LE(p, 30), cl = buf.readUInt16LE(p, 32);
  console.log('  name:', buf.slice(p + 46, p + 46 + nl).toString().slice(0, 60));
  p += 46 + nl + el + cl;
}
