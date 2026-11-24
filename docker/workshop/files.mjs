// One thing done to a job's files, run as the job's own user (runner.mjs), never as root: whatever a job puts in its
// folder (a link to elsewhere, a name with .. in it), this can reach only what the job itself can.
//
// What to do comes as one JSON argument in WORKSHOP_DO; bytes come on stdin and go on stdout.
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_LISTED = 300;
const MAX_TEXT = 60_000;
/** The runner's own, in each folder: not the job's files. */
const OWN = new Set([".tmp"]);

const home = process.cwd();
const what = JSON.parse(process.env.WORKSHOP_DO ?? "{}");
const say = (o) => process.stdout.write(JSON.stringify(o));
const fail = (why) => say({ error: why });

/** Inside the job's folder, said plainly rather than by an error of the system's. */
function inside(path) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) throw new Error("no path given");
  const at = resolve(home, path);
  const rel = relative(home, at);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("that path is outside the job's folder");
  return at;
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
    if (n > max) throw new Error(`more than ${Math.round(max / 1e6)} MB`);
    parts.push(c);
  }
  return Buffer.concat(parts);
}

async function text(at) {
  const b = await fs.readFile(at);
  if (b.subarray(0, 8000).includes(0)) throw new Error("that is not a text file: open it with a program, by run");
  return b.toString("utf8");
}

const sum = (b) => createHash("sha256").update(b).digest("hex");

const DO = {
  async list() {
    const files = [];
    let more = 0;
    for await (const at of walk(home)) {
      if (files.length >= MAX_LISTED) more += 1;
      else {
        const s = await fs.stat(at);
        files.push({ path: relative(home, at), size: s.size, at: Math.round(s.mtimeMs) });
      }
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
    await (what.append ? fs.appendFile(at, b) : fs.writeFile(at, b));
    say({ size: (await fs.stat(at)).size });
  },
  async edit() {
    const at = inside(what.path);
    const { find, replace, all } = JSON.parse((await stdin(1_000_000)).toString("utf8"));
    const was = await text(at);
    const n = typeof find === "string" && find ? was.split(find).length - 1 : 0;
    if (!n) return fail("those words are not in the file: read it again and copy them exactly");
    if (n > 1 && !all) return fail(`those words are in the file ${n} times: give more of what is around them, or set all`);
    await fs.writeFile(at, all ? was.split(find).join(replace) : was.replace(find, () => replace));
    say({ changed: all ? n : 1 });
  },
  async stat() {
    const at = inside(what.path);
    const s = await fs.stat(at);
    if (!s.isFile()) throw new Error("that is not a file");
    if (s.size > (Number(what.max) || Infinity)) throw new Error(`it is ${(s.size / 1e6).toFixed(1)} MB, more than ${Math.round(what.max / 1e6)} MB`);
    say({ size: s.size, sha256: sum(await fs.readFile(at)) });
  },
  /** Its bytes, and nothing else, on stdout. */
  async cat() {
    const at = inside(what.path);
    const s = await fs.stat(at);
    if (!s.isFile() || s.size > (Number(what.max) || Infinity)) process.exit(3);
    await new Promise((ok, no) => createReadStream(at).on("error", no).on("end", ok).pipe(process.stdout));
  },
};

try {
  await (DO[what.op] ?? (() => fail("no such thing to do")))();
} catch (e) {
  const said = e?.code === "ENOENT" ? "there is no such file" : e?.code === "EACCES" || e?.code === "EPERM" ? "not allowed" : e?.code === "EISDIR" ? "that is a folder" : String(e?.message ?? e);
  if (what.op === "cat") process.exit(2);
  fail(said);
}
