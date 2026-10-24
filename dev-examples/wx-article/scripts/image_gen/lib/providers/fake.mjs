// Fake Provider（D8）：纯 Node 内置 zlib 手写 PNG 编码，零第三方依赖、零费用。
// cover 缺省 900×383（微信封面真实尺寸教训：1px 图会被微信 53402 拒绝）；body 1024×576。
// 像素由 prompt 哈希决定 → 同一 prompt 输出字节级确定（A02 二次运行断言文件未变可依赖 mtime/hash）。
import zlib from "node:zlib";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { dirname } from "node:path";

export const providerId = "fake";
export const defaultModel = "fake-1";

// ── PNG 编码（IHDR/IDAT/IEND + crc32）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成 PNG：RGB 8bit，filter 0；渐变基色由 seed 决定 */
export function encodePng(width, height, seed) {
  const h = crypto.createHash("sha256").update(String(seed)).digest();
  const r0 = h[0];
  const g0 = h[1];
  const b0 = h[2];
  const r1 = h[3];
  const g1 = h[4];
  const b1 = h[5];
  const raw = Buffer.alloc(height * (1 + width * 3));
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const t = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;
      raw[off++] = Math.round(r0 + (r1 - r0) * t);
      raw[off++] = Math.round(g0 + (g1 - g0) * t);
      raw[off++] = Math.round(b0 + (b1 - b0) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const FAKE_SIZES = { cover: { width: 900, height: 383 }, body: { width: 1024, height: 576 } };

/**
 * 统一 Provider 接口：generate({ id, kind, prompt, outPath, model, signal, context })
 * → { path, mime, bytes, format, width, height, model, provider, durationMs }
 * 失败抛 GenError { code, recoverable, message }。
 */
export class GenError extends Error {
  constructor(code, message, { recoverable = false } = {}) {
    super(message);
    this.name = "GenError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export async function generate({ kind, prompt, outPath, signal }) {
  const started = Date.now();
  if (signal?.aborted) throw new GenError("E_ABORTED", "aborted before start", { recoverable: true });
  const size = FAKE_SIZES[kind === "cover" ? "cover" : "body"];
  // 编码耗时模拟毫秒级即可；prompt 参与种子保证不同 prompt 不同图、同 prompt 确定性
  const png = encodePng(size.width, size.height, prompt);
  await fsp.mkdir(dirname(outPath), { recursive: true }).catch(() => {});
  await fsp.writeFile(outPath, png);
  return {
    path: outPath,
    mime: "image/png",
    bytes: png.length,
    format: "png",
    width: size.width,
    height: size.height,
    model: defaultModel,
    provider: providerId,
    durationMs: Date.now() - started,
  };
}
