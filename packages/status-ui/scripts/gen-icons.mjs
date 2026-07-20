// Generates the tray PNGs with zero image dependencies: raw RGBA pixel
// buffers + a minimal PNG encoder (zlib deflate + hand-rolled CRC32).
// "Template" names are monochrome-from-alpha (macOS auto-inverts them);
// Rec/Busy are colored (visible on light AND dark menu bars).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const canvas = (size) => ({ size, px: new Uint8Array(size * size * 4) });

// Coverage-blended primitives (1px smoothstep anti-aliasing).
function paint(c, coverageAt, [r, g, b, a]) {
  for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) {
    const cov = coverageAt(x + 0.5, y + 0.5);
    if (cov <= 0) continue;
    const i = (y * c.size + x) * 4, na = Math.min(1, cov) * (a / 255);
    c.px[i] = r; c.px[i + 1] = g; c.px[i + 2] = b;
    c.px[i + 3] = Math.max(c.px[i + 3], Math.round(na * 255));
  }
}
const disc = (c, cx, cy, rad, color, clipRightOfCx = false) =>
  paint(c, (x, y) => {
    if (clipRightOfCx && x > cx) return 0;
    return Math.max(0, Math.min(1, rad - Math.hypot(x - cx, y - cy) + 0.5));
  }, color);
const ring = (c, cx, cy, rad, w, color) =>
  paint(c, (x, y) =>
    Math.max(0, Math.min(1, w / 2 - Math.abs(Math.hypot(x - cx, y - cy) - rad) + 0.5)), color);
// Segment (capsule) primitive: coverage from distance to the closest point on [a,b].
const seg = (c, x1, y1, x2, y2, w, color) =>
  paint(c, (x, y) => {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((x - x1) * dx + (y - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy;
    const dist = Math.hypot(x - px, y - py);
    return Math.max(0, Math.min(1, w / 2 - dist + 0.5));
  }, color);

const BLACK = [0, 0, 0, 255];       // template: only alpha matters
const RED = [255, 95, 87, 255];

// 8 rays at 45° increments, with a gap between core and rays. Skips index 1
// (45° in screen coords = down-right, pointing at the bottom-right corner
// badge) when a badge is present so the ray doesn't visually fuse with it.
function sun(c, cx, cy, size, color, { skipBadgeRay = false } = {}) {
  const coreR = size * 0.18;
  const r1 = size * 0.28, r2 = size * 0.40;
  const rayW = Math.max(1.5, size / 11);
  disc(c, cx, cy, coreR, color);
  for (let k = 0; k < 8; k++) {
    if (skipBadgeRay && k === 1) continue; // 45°: toward bottom-right badge
    const a = (k * Math.PI) / 4;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    seg(c, cx + cosA * r1, cy + sinA * r1, cx + cosA * r2, cy + sinA * r2, rayW, color);
  }
}

function makeIcon(kind, size) {
  const c = canvas(size);
  const mid = size / 2;
  if (kind === "idle") sun(c, mid, mid, size, BLACK);
  if (kind === "warn") {
    sun(c, mid, mid, size, BLACK, { skipBadgeRay: true });
    disc(c, size * 0.78, size * 0.78, size * 0.16, BLACK);
  }
  if (kind === "rec") disc(c, mid, mid, size * 0.32 + Math.max(1.5, size / 12) / 2, RED);
  if (kind === "busy") {
    const coreR = size * 0.18;
    const r1 = size * 0.28, r2 = size * 0.40;
    const rayW = Math.max(1.5, size / 11);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const cosA = Math.cos(a), sinA = Math.sin(a);
      seg(c, mid + cosA * r1, mid + sinA * r1, mid + cosA * r2, mid + sinA * r2, rayW, RED);
    }
    disc(c, mid, mid, coreR, RED, true);
  }
  return png(size, c.px);
}

const outDir = process.argv[2];
if (!outDir) { console.error("usage: gen-icons.mjs <outdir>"); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const FILES = { idle: "iconIdleTemplate", warn: "iconWarnTemplate", rec: "iconRec", busy: "iconBusy" };
for (const [kind, base] of Object.entries(FILES)) {
  writeFileSync(join(outDir, `${base}.png`), makeIcon(kind, 18));
  writeFileSync(join(outDir, `${base}@2x.png`), makeIcon(kind, 36));
}
console.log(`icons → ${outDir}`);
