import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Draws the app icons.
 *
 * Kept as a script rather than a build step because these change roughly never,
 * and a dependency-free 80-line PNG writer is a better trade than adding an
 * image library to a project that otherwise has three runtime dependencies.
 *
 *   node scripts/make-icons.mjs
 */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // Each scanline is prefixed with its filter type; 0 means none, which costs a
  // little size and saves implementing five filters nobody will read.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

/**
 * The orb, roughly as the shader draws it: a cyan sphere lit from the upper
 * left, sitting on the app's own background.
 *
 * `inset` keeps the orb inside the maskable safe zone — Android crops a maskable
 * icon to whatever shape the launcher likes, and anything past 80% of the width
 * can be cut off entirely.
 */
function drawOrb(size, inset) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = (size / 2) * inset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);

      // Background, with a faint glow so the orb is not a sticker on a square.
      const glow = Math.max(0, 1 - d / (r * 1.9)) ** 3;
      let R = mix(5, 24, glow);
      let G = mix(7, 74, glow);
      let B = mix(11, 88, glow);

      if (d < r) {
        // Lambert-ish shading from a light up and to the left.
        const nx = dx / r;
        const ny = dy / r;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lit = Math.max(0, nx * -0.45 + ny * -0.55 + nz * 0.7);
        const body = 0.22 + 0.78 * lit;

        R = mix(12, 79, body * 0.9);
        G = mix(40, 209, body);
        B = mix(52, 224, body);

        // A tighter specular, so it reads as a sphere at 48 pixels.
        const spec = Math.max(0, lit) ** 14;
        R = Math.min(255, R + spec * 150);
        G = Math.min(255, G + spec * 120);
        B = Math.min(255, B + spec * 110);

        // Feather the edge, or it aliases badly at small sizes.
        const edge = Math.min(1, (r - d) / 1.5);
        R = mix(mix(5, 24, glow), R, edge);
        G = mix(mix(7, 74, glow), G, edge);
        B = mix(mix(11, 88, glow), B, edge);
      }

      buf[i] = R;
      buf[i + 1] = G;
      buf[i + 2] = B;
      buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

mkdirSync("public/icons", { recursive: true });

const out = [
  // Plain icons: the orb fills most of the square.
  ["public/icons/icon-192.png", 192, 0.78],
  ["public/icons/icon-512.png", 512, 0.78],
  // iOS does not honour `purpose`, and puts its own rounded corners on top.
  ["public/icons/apple-touch-icon.png", 180, 0.74],
  // Maskable: smaller, so a circular or squircle crop cannot clip the orb.
  ["public/icons/maskable-512.png", 512, 0.56],
];

for (const [path, size, inset] of out) {
  writeFileSync(path, drawOrb(size, inset));
  console.log(`${path}  ${size}x${size}`);
}
