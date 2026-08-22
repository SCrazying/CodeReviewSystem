const fs = require('fs');
const buf = fs.readFileSync('D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip');
// 全文扫前3个中央目录签名位置
let found = 0, first = -1, last = -1;
for (let i = 0; i < buf.length - 4; i++) {
  if (buf.readUInt32LE(i) === 0x02014b50) { found++; if (first < 0) first = i; last = i; }
}
console.log('中央目录签名总数:', found);
console.log('首个 @', first, ' 末个 @', last);
console.log('EOCD 记录的 CD 偏移: 101010256');
console.log('推断: make-zip 写 EOCD 时 cdSize/offset 字段可能写反了?');
