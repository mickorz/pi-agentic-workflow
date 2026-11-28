#!/usr/bin/env node
// 实测 PNG 画板边缘留白：解码扫描线，找上下左右最近"非背景"像素行/列。
// 用法: node margin-probe.mjs <img.png>
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
const buf = fs.readFileSync(file);
if (buf.readUInt32BE(0) !== 0x89504e47) { console.error("not png"); process.exit(2); }

let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString("ascii", pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
  if (type === "IDAT") idat.push(data);
  pos += 12 + len;
  if (type === "IEND") break;
}
if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) { console.error(`unsupported bitDepth=${bitDepth} colorType=${colorType}`); process.exit(2); }
const bpp = colorType === 6 ? 4 : 3;
const stride = w * bpp;
const raw = zlib.inflateSync(Buffer.concat(idat));

// unfilter
const out = Buffer.alloc(h * stride);
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)];
  const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
  const cur = out.subarray(y * stride, (y + 1) * stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = x >= bpp && prev ? prev[x - bpp] : 0;
    let v = row[x];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[x] = v & 0xff;
  }
}

const px = (x, y) => { const o = y * stride + x * bpp; return [out[o], out[o + 1], out[o + 2]]; };
const bg = px(2, 2);
const diff = (x, y) => { const p = px(x, y); return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 24; };

function scanRow(y) { let l = -1, r = -1; for (let x = 0; x < w; x++) if (diff(x, y)) { l = x; break; } for (let x = w - 1; x >= 0; x--) if (diff(x, y)) { r = x; break; } return [l, r]; }
function scanCol(x) { let t = -1, b = -1; for (let y = 0; y < h; y++) if (diff(x, y)) { t = y; break; } for (let y = h - 1; y >= 0; y--) if (diff(x, y)) { b = y; break; } return [t, b]; }

let top = -1, bottom = -1;
for (let y = 0; y < h && top < 0; y++) { const [l, r] = scanRow(y); if (l >= 0) top = y; }
for (let y = h - 1; y >= 0 && bottom < 0; y--) { const [l, r] = scanRow(y); if (l >= 0) bottom = y; }
let left = -1, right = -1;
for (let x = 0; x < w && left < 0; x++) { const [t, b] = scanCol(x); if (t >= 0) left = x; }
for (let x = w - 1; x >= 0 && right < 0; x--) { const [t, b] = scanCol(x); if (t >= 0) right = x; }

console.log(`${file}`);
console.log(`尺寸 ${w}x${h}  背景rgb(${bg.join(",")})`);
console.log(`上留白 ${top}px (${(top / h * 100).toFixed(1)}%)  下留白 ${h - 1 - bottom}px (${((h - 1 - bottom) / h * 100).toFixed(1)}%)`);
console.log(`左留白 ${left}px  右留白 ${w - 1 - right}px`);
