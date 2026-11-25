/**
 * Zip files, as far as a specialty needs them (lib/specialty-more.ts): read
 * with bounds, since one is a stranger's, and written without squeezing. No
 * dependency: the runtime squeezes and unsqueezes (DecompressionStream).
 */

export interface ZipFile {
  name: string;
  bytes: Uint8Array;
}

export interface ZipLimits {
  files: number;
  each: number;
  total: number;
}

export class ZipError extends Error {}
const no = (why: string): never => {
  throw new ZipError(why);
};

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Unsqueezed, and no more than `most` of it: a small file may say it is, and be endless. */
async function inflated(bytes: Uint8Array, most: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => no("a file in it could not be read"));
    if (done) break;
    n += value.length;
    if (n > most) {
      await reader.cancel().catch(() => {});
      no(`a file in it is over ${Math.round(most / 1000)} KB`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A path inside it, as it is kept: from its root, no way out, nothing a disk would stumble on. */
function pathOf(raw: string): string {
  const path = raw.replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0") || path.split("/").some((p) => p === "..")) no("it holds a name that leads outside it");
  return path.split("/").filter((p) => p && p !== ".").join("/");
}

/** Every file in a zip. Refused in words (ZipError): what is not a zip, is locked, is damaged, or is more than `limits`. */
export async function readZip(zip: Uint8Array, limits: ZipLimits): Promise<ZipFile[]> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) no("that is not a zip file");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) no("that zip is too large");
  const out: ZipFile[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || v.getUint32(at, true) !== 0x02014b50) no("that zip is damaged");
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const packed = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const mode = v.getUint32(at + 38, true) >>> 16;
    const local = v.getUint32(at + 42, true);
    const raw = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
    // Folders, and what computers leave in one: not files of anyone's.
    if (raw.endsWith("/") || /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/.test(raw)) continue;
    const name = pathOf(raw);
    if (!name) continue;
    if ((mode & 0xf000) === 0xa000) no("it holds a link, not only files");
    if (flags & 1) no("it is locked with a password");
    if (method !== 0 && method !== 8) no("it is squeezed in a way that is not read here");
    if (out.length >= limits.files) no(`it holds more than ${limits.files} files`);
    if (size > limits.each) no(`a file in it is over ${Math.round(limits.each / 1000)} KB`);
    if (local + 30 > zip.length || v.getUint32(local, true) !== 0x04034b50) no("that zip is damaged");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + packed > zip.length) no("that zip is damaged");
    const squeezed = zip.subarray(start, start + packed);
    const bytes = method === 0 ? squeezed.slice() : await inflated(squeezed, limits.each);
    total += bytes.length;
    if (bytes.length > limits.each || total > limits.total) no(`it holds more than ${Math.round(limits.total / 1000)} KB in all`);
    if (bytes.length !== size || crc32(bytes) !== crc) no("a file in it is damaged");
    out.push({ name, bytes });
  }
  return out;
}

/** The files as a zip, as they are. */
export function writeZip(files: readonly ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const heads: Uint8Array[] = [];
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const fill = (head: Uint8Array, from: number) => {
      const v = new DataView(head.buffer);
      v.setUint16(from, 20, true);
      v.setUint16(from + 2, 0x0800, true);
      // 1 January 1980, the first day a zip knows: when a file was made is nobody's business.
      v.setUint16(from + 8, 0x21, true);
      v.setUint32(from + 10, crc, true);
      v.setUint32(from + 14, f.bytes.length, true);
      v.setUint32(from + 18, f.bytes.length, true);
      v.setUint16(from + 22, name.length, true);
      return v;
    };
    const local = new Uint8Array(30 + name.length);
    fill(local, 4).setUint32(0, 0x04034b50, true);
    local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const v = fill(head, 6);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(42, at, true);
    head.set(name, 46);
    heads.push(head);
    parts.push(local, f.bytes);
    at += local.length + f.bytes.length;
  }
  const size = heads.reduce((n, h) => n + h.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, at, true);
  const out = new Uint8Array(at + size + 22);
  let to = 0;
  for (const p of [...parts, ...heads, end]) {
    out.set(p, to);
    to += p.length;
  }
  return out;
}
