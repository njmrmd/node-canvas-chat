/**
 * Writes `public/canvas-grain.png` — the cyanotype canvas's grain layer
 * (TES-108 §5.8). A tiled 96×96 grayscale-plus-alpha PNG with an independent
 * random value per pixel in both channels.
 *
 * TES-108's rendered reference sheet found `feTurbulence` unusable for this:
 * its noise is smooth and low-frequency at any tile size a browser renders
 * cheaply, so raising its opacity tints the sheet instead of adding texture.
 * Real grain needs per-pixel-independent values, which a procedural filter
 * doesn't give you — a static raster does. This is a build-time asset rather
 * than a runtime filter for exactly that reason.
 *
 * No image library in this repo (no `sharp`/`canvas`/`pngjs`), and one isn't
 * worth adding for a 96×96 image generated once and committed — this writes
 * the PNG chunks by hand using only Node's built-in `zlib`.
 *
 *   node scripts/generate-canvas-grain.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 96;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 4; // colour type 4 = grayscale + alpha
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return chunk("IHDR", data);
}

/** One filter-type byte (0 = None) per scanline, then 2 bytes/pixel
 * (gray, alpha), each drawn independently so no two adjacent pixels are
 * correlated — that independence is the whole point (see file header). */
function rawImageData(width, height) {
  const stride = 1 + width * 2;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const pixelStart = rowStart + 1 + x * 2;
      raw[pixelStart] = Math.floor(Math.random() * 256);
      raw[pixelStart + 1] = Math.floor(Math.random() * 256);
    }
  }
  return raw;
}

function encodePng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idatData = deflateSync(rawImageData(width, height));
  return Buffer.concat([
    signature,
    ihdr(width, height),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "public", "canvas-grain.png");
writeFileSync(outPath, encodePng(SIZE, SIZE));
console.log(`Wrote ${SIZE}x${SIZE} grain tile to ${outPath}`);
