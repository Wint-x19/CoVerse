import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function renderPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const samples = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = ((x + (sx + 0.5) / samples) / size) * 512;
          const py = ((y + (sy + 0.5) / samples) / size) * 512;
          const cx = Math.abs(px - 256) - (232 - 112);
          const cy = Math.abs(py - 256) - (232 - 112);
          const dRect = Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) + Math.min(Math.max(cx, cy), 0) - 112;
          if (dRect > 0) continue;
          let r = 8, g = 9, b = 10;
          if (dRect > -14) {
            r = 38; g = 40; b = 46;
          }
          const d2 = Math.abs(Math.hypot(px - 308, py - 256) - 108);
          if (d2 <= 13) {
            const alpha = 0.48;
            r = r * (1 - alpha) + 247 * alpha;
            g = g * (1 - alpha) + 248 * alpha;
            b = b * (1 - alpha) + 248 * alpha;
          }
          const d1 = Math.abs(Math.hypot(px - 204, py - 256) - 108);
          if (d1 <= 13) {
            r = 247; g = 248; b = 248;
          }
          rAcc += r; gAcc += g; bAcc += b; aAcc += 1;
        }
      }
      const n = samples * samples;
      const idx = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = aAcc / n;
      if (alpha > 0) {
        raw[idx] = Math.round(rAcc / aAcc);
        raw[idx + 1] = Math.round(gAcc / aAcc);
        raw[idx + 2] = Math.round(bAcc / aAcc);
        raw[idx + 3] = Math.round(alpha * 255);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.resolve(import.meta.dirname, "../resources");
fs.mkdirSync(outDir, { recursive: true });

const png512 = renderPng(512);
const png256 = renderPng(256);
fs.writeFileSync(path.join(outDir, "icon.png"), png512);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0;
entry[1] = 0;
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12);
fs.writeFileSync(path.join(outDir, "icon.ico"), Buffer.concat([header, entry, png256]));
process.stdout.write("Generated packages/ui/resources/icon.png and icon.ico\n");
