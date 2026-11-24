// One thing done to a job's files, run as the job's own user (runner.mjs), never as root: whatever a job puts in its
// folder (a link to elsewhere, a name with .. in it), this can reach only what the job itself can.
//
// What to do comes as one JSON argument in WORKSHOP_DO; bytes come on stdin and go on stdout. What it answers is the
// job's to make anything (it runs as the job), so the runner takes it as numbers and text, and a failure as one of
// its own words (runner.mjs WHY).
import { createReadStream, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_LISTED = 300;
const MAX_TEXT = 60_000;
/** What is read whole, or changed: more than that is a program's to open. */
const MAX_WHOLE = 20_000_000;
/** The runner's own, in each folder: not the job's files. */
const OWN = new Set([".tmp", ".home"]);

const home = process.cwd();
const what = JSON.parse(process.env.WORKSHOP_DO ?? "{}");
const say = (o) => process.stdout.write(JSON.stringify(o));

class No extends Error {
  constructor(why, more = {}) {
    super(why);
    this.more = more;
  }
}

/** Inside the job's folder, said plainly rather than by an error of the system's. */
function inside(path) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) throw new No("path");
  const at = resolve(home, path);
  const rel = relative(home, at);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new No("outside");
  return at;
}

/** A plain file: not a pipe, which nobody may ever write to, nor a device, which never ends. */
async function plain(at) {
  const s = await fs.stat(at);
  if (s.isDirectory()) throw new No("folder");
  if (!s.isFile()) throw new No("notfile");
  return s;
}

async function* walk(dir) {
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (dir === home && OWN.has(e.name)) continue;
    const at = join(dir, e.name);
    if (e.isDirectory()) yield* walk(at);
    else if (e.isFile()) yield at;
  }
}

async function stdin(max) {
  const parts = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += c.length;
    if (n > max) throw new No("much", { most: Math.round(max / 1e6) });
    parts.push(c);
  }
  return Buffer.concat(parts);
}

async function text(at) {
  if ((await plain(at)).size > MAX_WHOLE) throw new No("long", { most: MAX_WHOLE / 1e6 });
  const b = await fs.readFile(at);
  if (b.subarray(0, 8000).includes(0)) throw new No("binary");
  return b.toString("utf8");
}

const DO = {
  async list() {
    const files = [];
    let more = 0;
    for await (const at of walk(home)) {
      if (files.length >= MAX_LISTED) more += 1;
      else files.push({ path: relative(home, at), size: (await fs.lstat(at)).size });
    }
    say({ files, more });
  },
  async read() {
    const at = inside(what.path);
    const lines = (await text(at)).split("\n");
    // A last line's own ending is not another line.
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const from = Math.max(1, Number(what.from) || 1);
    let out = "";
    let n = from - 1;
    for (; n < lines.length && out.length < MAX_TEXT && (!what.lines || n < from - 1 + what.lines); n++) out += `${lines[n]}\n`;
    say({ text: out.slice(0, MAX_TEXT), from, to: n, of: lines.length, ...(out.length > MAX_TEXT + 1 ? { cut: true } : {}) });
  },
  async write() {
    const at = inside(what.path);
    const b = await stdin(Number(what.max) || 2_000_000);
    await fs.mkdir(dirname(at), { recursive: true });
    await plain(at).catch((e) => {
      if (e?.code !== "ENOENT") throw e;
    });
    await (what.append ? fs.appendFile(at, b) : fs.writeFile(at, b));
    say({ size: (await fs.stat(at)).size });
  },
  async edit() {
    const at = inside(what.path);
    const { find, replace, all } = JSON.parse((await stdin(4_000_000)).toString("utf8"));
    const was = await text(at);
    const n = typeof find === "string" && find ? was.split(find).length - 1 : 0;
    if (!n) throw new No("words");
    if (n > 1 && !all) throw new No("many", { n });
    await fs.writeFile(at, all ? was.split(find).join(replace) : was.replace(find, () => replace));
    say({ changed: all ? n : 1 });
  },
  async stat() {
    const { size } = await plain(inside(what.path));
    if (size > (Number(what.max) || Infinity)) throw new No("big", { mb: Math.round(size / 1e5) / 10, most: Math.round(what.max / 1e6) });
    say({ size });
  },
  /** Its bytes, and nothing else, on stdout. */
  async cat() {
    const at = inside(what.path);
    await plain(at);
    await new Promise((ok, no) => createReadStream(at).on("error", no).on("end", ok).pipe(process.stdout));
  },
};

try {
  await DO[what.op]();
} catch (e) {
  if (what.op === "cat") process.exit(2);
  const why = e instanceof No ? e.message : { ENOENT: "nofile", ENOTDIR: "nofile", EISDIR: "folder", EACCES: "denied", EPERM: "denied", ENOSPC: "full", EDQUOT: "full", EFBIG: "full" }[e?.code];
  say({ error: why ?? "unknown", ...(e instanceof No ? e.more : {}) });
}
