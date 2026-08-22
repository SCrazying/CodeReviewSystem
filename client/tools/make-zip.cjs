// 用 node 原生打 zip(绕过 PowerShell Compress-Archive 对被锁文件的失败)
// 简单 zip(store/deflate)实现, 足够分发用
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = 'D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked';
const OUT = 'D:/AI/Code/CodeReviewSystem/client/dist/CodeReviewTool-win-x64-v1.1.11.zip';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

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

const files = listFiles(SRC, '');
const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const comp = zlib.deflateRawSync(data, { level: 6 });
  const useDeflate = comp.length < data.length;
  const payload = useDeflate ? comp : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const name = Buffer.from(f.rel.replace(/\\/g, '/'), 'utf8');
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (8 << 5) | 21;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, name, payload);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);

  offset += 30 + name.length + payload.length;
}

const cdBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...locals, cdBuf, end]));
console.log('zip 完成:', (fs.statSync(OUT).size / 1048576).toFixed(1), 'MB,', files.length, '个文件');
