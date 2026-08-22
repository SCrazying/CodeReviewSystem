const fs = require('fs');
const buf = fs.readFileSync('D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip');
let eocd = -1;
for (let i = buf.length - 22; i >= buf.length - 70000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
console.log('EOCD @', eocd, '(文件总长', buf.length + ')');
console.log('本盘条目数:', buf.readUInt16LE(eocd + 8));
console.log('总条目数:', buf.readUInt16LE(eocd + 10));
console.log('CD大小:', buf.readUInt32LE(eocd + 12));
console.log('CD偏移:', buf.readUInt32LE(eocd + 16));
console.log('');
console.log('签名扫描: 全文件只有 98 个中央目录头, 但 EOCD 声称', buf.readUInt16LE(eocd + 10), '条');
console.log('→ v1.1.11 的 make-zip.cjs 有 bug: centrals 只收了部分(98=locales等小文件?),');
console.log('   但 locals 全量写入。zip 结构损坏(Windows 资管器能容错读出部分, 严格解压器会失败)。');
