// Jarvis's workshop: runs a background job's commands and keeps its files. Inside a container with no network
// (docker-compose.yml), it listens on a Unix socket that only its door reaches (door.mjs).
//
// Each job has a user of its own, never given twice, and a folder only that user can reach. The runner is root with
// four powers (become another user, give a file away, send a signal) and not the one to open other people's files: it
// cannot look into a job's folder either, so everything done there is done as the job's user, and a link or a name a
// job leaves there reaches only what that job can.
//
// Whatever runs as the job's user is the job's to change, these included: what they answer is taken as numbers and
// text of no more than so much (collect, SHAPE, WHY), and never waited on for long.
//
// One job at a time runs anything, and when its last command ends, so does everything it started, however it left it.
import { spawn } from "node:child_process";
import { existsSync, promises as fs, readFileSync, readdirSync, statfsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const JOB = /^[a-z0-9]{4,40}$/;
const SUM = /^[0-9a-f]{64}$/;
const MAX_BODY = 4_000_000;
const MAX_CMD = 30_000;
/** Of what a command writes, the first and the last of it are given back. */
const HEAD = 60_000;
const TAIL = 100_000;
/** A command in the foreground, and one left running. */
export const MAX_SECONDS = 120;
export const MAX_LONG_SECONDS = 900;
const MAX_LONG = 3;
/** The longest anyone waits at once for one left running. */
const MAX_WAIT = 60;
/** One thing done to a file; and how many at once. */
const FILE_SECONDS = 60;
const MAX_FILING = 4;
/** Of one file brought in or given out; of all a job gave. */
const MAX_FILE = 20_000_000;
const MAX_GIVEN = 200_000_000;
/** Of what something done to a file answers: the text of one, or a list of them. */
const MAX_ANSWER = 3_000_000;
/** Of all jobs' files; and left free on the disk. */
const MAX_ALL_KB = 5_000_000;
const MIN_FREE = 3_000_000_000;
/** A job that was not heard of for this long is over, whatever was said. */
const KEEP_MS = 14 * 86_400_000;
const FIRST_UID = 20_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = join(HERE, "files.mjs");

class Refused extends Error {}
const refuse = (why) => {
  throw new Refused(why);
};
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Its own folder entered as itself, by a shell that reads no file of the job's on the way; and the first to be ended if memory runs out. */
const ENTER = ["/bin/sh", "-c", '{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null; umask 077; chmod u+rwx "$WORK" 2>/dev/null; cd "$WORK" || exit 97; mkdir -p .tmp .home 2>/dev/null; exec "$@"', "-"];
/** Told on its input, so that what it runs is in nobody's list of processes. */
const SHELL = ["bash", "--norc", "--noprofile", "-c", 'script=$(cat); exec </dev/null; eval "$script"'];

/** What files.mjs answers, as what it must be: it runs as the job. */
const SHAPE = {
  list: (o) => ({ files: (Array.isArray(o.files) ? o.files : []).slice(0, 300).map((f) => ({ path: String(f?.path).slice(0, 4096), size: num(f?.size) })), more: num(o.more) }),
  read: (o) => ({ text: String(o.text ?? "").slice(0, 60_000), from: num(o.from), to: num(o.to), of: num(o.of), ...(o.cut === true ? { cut: true } : {}) }),
  write: (o) => ({ size: num(o.size) }),
  edit: (o) => ({ changed: num(o.changed) }),
  stat: (o) => ({ size: num(o.size) }),
};
/** And why it would not, in these words and no others. */
const WHY = {
  path: () => "no path given",
  outside: () => "that path is outside the job's folder",
  folder: () => "that is a folder",
  notfile: () => "that is not a plain file",
  nofile: () => "there is no such file",
  denied: () => "not allowed",
  full: () => "there is no room for it",
  binary: () => "that is not a text file: open it with a program, by run",
  long: (o) => `it is more than ${num(o.most)} MB: open it with a program, by run`,
  much: (o) => `that is more than ${num(o.most)} MB`,
  big: (o) => `it is ${num(o.mb)} MB, more than ${num(o.most)} MB`,
  words: () => "those words are not in the file: read it again and copy them exactly",
  many: (o) => `those words are in the file ${num(o.n)} times: give more of what is around them, or set all`,
};

const signal = (pid, s) => {
  try {
    process.kill(pid, s);
  } catch {
    // gone already
  }
};
/** It and what is in its group; only while it is there, since its number may be another's after. */
const kill = (c) => c.pid && c.exitCode === null && c.signalCode === null && signal(-c.pid, "SIGKILL");

/** Everything a program wrote, to its end or its time, and no more than `most` of it. */
export function collect(child, most, seconds) {
  return new Promise((done) => {
    const parts = [];
    let n = 0;
    let code = null;
    let over = false;
    const end = (ok) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      for (const s of child.stdio) s?.destroy();
      kill(child);
      done(ok && code === 0 ? Buffer.concat(parts) : null);
    };
    const timer = setTimeout(() => end(false), seconds * 1000);
    child.stdout.on("data", (d) => {
      n += d.length;
      if (n > most) end(false);
      else parts.push(d);
    });
    child.on("error", () => end(false));
    // Its own end, then its output's; and not for long after the first, if something holds the second open.
    child.on("exit", (c) => {
      code = c;
      setTimeout(() => end(false), 5000);
    });
    child.on("close", (c) => {
      code = c;
      end(true);
    });
  });
}

/** What files.mjs answered, as what it must be, or refused in our own words: the job may have made it anything. */
export function answered(op, bytes) {
  let said = null;
  try {
    said = JSON.parse(bytes.toString("utf8"));
  } catch {
    // nothing, or not what it should be
  }
  if (!said || typeof said !== "object") refuse("that could not be done to the file");
  if (said.error !== undefined) refuse(Object.hasOwn(WHY, String(said.error)) ? WHY[said.error](said) : "that could not be done to the file");
  return SHAPE[op](said);
}

/**
 * `work` holds the jobs' folders. `drop`: each job as a user of its own, which needs root and Linux; without, all of
 * it runs as whoever runs this (test/workshop-runner.test.ts). The rest, for that test: what a job's files may come to,
 * how long a job waits for another's command, and how often a folder is looked at while something runs.
 */
export function workshop({ work, drop = true, now = () => Date.now(), jobKb = 500_000, turnMs = 60_000, watchMs = 4000 }) {
  const GIVEN = join(work, ".given");
  const NEXT = join(work, ".next");
  const outer = (job) => join(work, job);
  const inner = (job) => join(work, job, "f");
  let loading = null;
  let next = FIRST_UID;
  let saving = Promise.resolve();
  /** What is running for each job, and the commands it left running, by their ids; and each command, until all that follows its end is done. */
  const live = new Map();
  const long = new Map();
  const going = new Map();
  /** Things being done to each job's files; and whose processes are being ended. */
  const filing = new Map();
  const clearing = new Set();
  /** Whose turn it is to run things, and how many it has running. */
  let holder = null;
  let holding = 0;

  /* ---------- the jobs there are -------------------------------------------------------------------------------- */

  /** Their folders say which, and whose each is: its group. */
  function load() {
    loading ??= (async () => {
      const jobs = new Map();
      for (const e of await fs.readdir(work, { withFileTypes: true })) {
        if (!e.isDirectory() || !JOB.test(e.name)) continue;
        const s = await fs.stat(outer(e.name));
        let given = 0;
        for (const f of await fs.readdir(join(GIVEN, e.name)).catch(() => [])) given += (await fs.stat(join(GIVEN, e.name, f))).size;
        // One cut short before it was given to its user is given to a new one.
        jobs.set(e.name, { uid: s.gid >= FIRST_UID ? s.gid : null, at: s.mtimeMs, touched: 0, kb: null, given });
      }
      const kept = Number.parseInt(await fs.readFile(NEXT, "utf8").catch(() => ""), 10);
      next = Math.max(FIRST_UID, num(kept), ...[...jobs.values()].map((j) => (j.uid ?? 0) + 1));
      return jobs;
    })().catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  }

  /** Written beside, then put in its place: what is there is whole. */
  async function put(path, data) {
    const f = await fs.open(`${path}.new`, "w", 0o600);
    try {
      await f.writeFile(data);
      await f.sync();
    } finally {
      await f.close();
    }
    await fs.rename(`${path}.new`, path);
  }

  /** A user nobody had before: a job's leftovers, could there be any, are never another's. */
  async function newUid() {
    const uid = next++;
    saving = saving.catch(() => {}).then(() => put(NEXT, String(next)));
    await saving;
    return uid;
  }

  const free = () => {
    const f = statfsSync(work);
    return f.bavail * f.bsize;
  };
  function space(all) {
    if ([...all.values()].reduce((n, x) => n + (x.kb ?? 0) + x.given / 1000, 0) > MAX_ALL_KB) refuse("the workshop is full: remove old jobs in Jobs");
    if (free() < MIN_FREE) refuse("the disk the workshop is on is nearly full");
  }
  async function room(j) {
    if ((j.kb ?? 0) > jobKb) refuse(`this job's files are over ${jobKb / 1000} MB: remove some first, by run`);
    space(await load());
  }

  /** The job's folder: the runner's own, which its user may only pass through, and in it the user's. */
  async function prepare(job, j) {
    const make = (p, mode) => fs.mkdir(p, { mode }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    j.uid ??= await newUid();
    await make(outer(job), 0o710);
    if (drop) await fs.chown(outer(job), 0, j.uid);
    await fs.chmod(outer(job), 0o710);
    await make(inner(job), 0o700);
    // Closed to others when made, and after this no longer the runner's to change.
    if (drop && (await fs.stat(inner(job))).uid !== j.uid) await fs.chown(inner(job), j.uid, j.uid);
  }

  /** The job's own user and folder, made the first time it is heard of. */
  async function known(job) {
    if (typeof job !== "string" || !JOB.test(job)) refuse("no such job");
    const all = await load();
    let j = all.get(job);
    if (!j) {
      space(all);
      j = { uid: null, at: now(), touched: now(), kb: 0, given: 0 };
      all.set(job, j);
    }
    j.ready ??= prepare(job, j).catch((e) => {
      j.ready = undefined;
      throw e;
    });
    await j.ready;
    j.at = now();
    if (now() - j.touched > 60_000) {
      j.touched = now();
      await fs.utimes(outer(job), now() / 1000, now() / 1000);
    }
    if (j.kb === null) await measure(job, j);
    return j;
  }

  /* ---------- what runs ----------------------------------------------------------------------------------------- */

  /** A program run as the job's user, in its folder: how to start it. */
  function start(job, j, argv, { seconds, env = {}, stdio = ["pipe", "pipe", "pipe"] }) {
    if (drop && !(j.uid >= FIRST_UID)) throw new Error("a job without a user of its own");
    const full = drop
      ? ["setpriv", `--reuid=${j.uid}`, `--regid=${j.uid}`, "--clear-groups", "--no-new-privs", "--",
         "prlimit", "--nproc=300", "--nofile=1024", "--core=0", "--msgqueue=0", `--fsize=${200_000_000}`, `--cpu=${Math.ceil(seconds * 3)}`, "--", ...ENTER, ...argv]
      : [...ENTER, ...argv];
    const child = spawn(full[0], full.slice(1), {
      cwd: "/",
      detached: true,
      stdio,
      env: {
        PATH: process.env.PATH, WORK: inner(job), HOME: join(inner(job), ".home"), TMPDIR: join(inner(job), ".tmp"), USER: "job", LOGNAME: "job",
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", MPLBACKEND: "Agg", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", ...env,
      },
    });
    if (!live.has(job)) live.set(job, new Set());
    live.get(job).add(child);
    for (const e of ["exit", "error"]) child.on(e, () => live.get(job)?.delete(child));
    for (const s of child.stdio) s?.on("error", () => {});
    return child;
  }

  /** A user's processes, whatever group they put themselves in. One that has ended, and whose end nobody has read, is over. */
  function pidsOf(uid) {
    const out = [];
    for (const p of readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      try {
        const s = readFileSync(`/proc/${p}/status`, "utf8");
        if (!/^State:\s+[ZX]/m.test(s) && /^Uid:\s+(.*)$/m.exec(s)?.[1].split(/\s+/).includes(String(uid))) out.push(Number(p));
      } catch {
        // gone already
      }
    }
    return out;
  }

  /** Everything of a job's, ended by the runner and looked for again until there is none: not asked of the job's own user, which it could prevent. */
  async function clear(job, j) {
    while (clearing.has(job)) await sleep(20);
    clearing.add(job);
    try {
      for (let i = 0; ; i++) {
        // Those it started, by their groups, one not yet its user's included; and all that are its user's.
        for (const c of live.get(job) ?? []) kill(c);
        const left = drop && j.uid !== null ? pidsOf(j.uid) : [];
        if (!left.length && !live.get(job)?.size) break;
        if (i >= 400) {
          // In some forty seconds it would not end. The container ends, and everything in it, and starts again.
          console.error("workshop: a job's processes would not end");
          process.exit(1);
        }
        // Held first, so that none makes another while the rest are ended.
        for (const p of left) signal(p, "SIGSTOP");
        for (const p of left) signal(p, "SIGKILL");
        await sleep(Math.min(10 + i, 120));
      }
      if (!drop || j.uid === null) return;
      // Nor what outlives a process: the old kind of shared memory, which other users could be let read.
      const c = start(job, j, ["ipcrm", "--all"], { seconds: 10, stdio: "ignore" });
      await finish(c, 10);
    } catch (e) {
      // It cannot be told what is left running: the same.
      console.error("workshop:", e?.stack ?? e);
      process.exit(1);
    } finally {
      clearing.delete(job);
    }
  }

  /** What a command wrote: its first and its last. */
  function tap(child) {
    let head = "";
    let tail = "";
    let chars = 0;
    const on = (s) => {
      chars += s.length;
      if (head.length < HEAD) {
        head += s;
        if (head.length > HEAD) {
          tail = head.slice(HEAD).slice(-TAIL);
          head = head.slice(0, HEAD);
        }
      } else tail = (tail + s).slice(-TAIL);
    };
    for (const o of [child.stdout, child.stderr]) o.setEncoding("utf8").on("data", on);
    return () => {
      const more = chars - head.length - tail.length;
      return { out: more > 0 ? `${head}\n… (${more} characters left out) …\n${tail}` : head + tail };
    };
  }

  /** To its end, or its time, or until whoever asked has gone. A process it left with its output open does not keep the rest waiting. */
  function finish(child, seconds, gone) {
    return new Promise((done) => {
      let late = false;
      let over = false;
      const stop = () => kill(child);
      const end = (code, sig) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        gone?.removeEventListener("abort", stop);
        for (const s of child.stdio) s?.destroy();
        done({ code, signal: sig ?? undefined, ...(late ? { late: true } : {}) });
      };
      const timer = setTimeout(() => {
        late = true;
        stop();
      }, seconds * 1000);
      gone?.addEventListener("abort", stop);
      if (gone?.aborted) stop();
      child.on("error", (e) => end(127, e.code));
      child.on("exit", (code, sig) => setTimeout(() => end(code, sig), 300));
      child.on("close", (code, sig) => end(code, sig));
    });
  }

  /** One thing done to its files, as its user (files.mjs). `body`: bytes in. */
  async function program(job, j, what, body, most) {
    while (clearing.has(job) || [...filing.values()].reduce((a, b) => a + b, 0) >= MAX_FILING) await sleep(20);
    filing.set(job, (filing.get(job) ?? 0) + 1);
    try {
      const c = start(job, j, [process.execPath, FILES], { seconds: FILE_SECONDS, env: { WORKSHOP_DO: JSON.stringify(what) }, stdio: ["pipe", "pipe", "ignore"] });
      if (body && typeof body.pipe === "function") body.pipe(c.stdin);
      else c.stdin.end(body ?? "");
      return await collect(c, most, FILE_SECONDS);
    } finally {
      filing.set(job, filing.get(job) - 1);
      if (!filing.get(job)) filing.delete(job);
    }
  }
  const file = async (job, j, what, body) => answered(what.op, await program(job, j, what, body, MAX_ANSWER));

  /** How much it holds now; null when it cannot be told. */
  async function du(job, j) {
    const b = await collect(start(job, j, ["du", "-sk", "."], { seconds: 30, stdio: ["ignore", "pipe", "ignore"] }), 10_000, 30);
    const kb = Number.parseInt(b?.toString("utf8") ?? "", 10);
    return Number.isFinite(kb) ? kb : null;
  }
  async function measure(job, j) {
    j.kb = (await du(job, j)) ?? j.kb;
    return j.kb ?? 0;
  }

  /** While something of it runs: its folder is looked at, and the disk, and it is ended past what it may hold, or when it will not be looked at. */
  function watch(job, j, over) {
    const began = j.kb ?? 0;
    let looking = false;
    let missed = 0;
    const t = setInterval(async () => {
      if (looking) return;
      looking = true;
      try {
        const kb = await du(job, j);
        missed = kb === null ? missed + 1 : 0;
        if (kb !== null) j.kb = kb;
        if (free() < MIN_FREE || missed >= 3 || (kb !== null && kb > jobKb && kb > began + 20_000)) {
          over();
          await clear(job, j);
        }
      } catch (e) {
        console.error("workshop:", e?.stack ?? e);
      } finally {
        looking = false;
      }
    }, watchMs);
    return () => clearInterval(t);
  }

  /* ---------- whose turn it is ---------------------------------------------------------------------------------- */

  async function turn(job, gone) {
    const until = Date.now() + turnMs;
    while (clearing.has(job) || (holder !== null && holder !== job)) {
      if (gone?.aborted) refuse("nobody is waiting for it");
      if (Date.now() > until) refuse("another job is using the workshop: try again in a minute or two");
      await sleep(50);
    }
    if (gone?.aborted) refuse("nobody is waiting for it");
    holder = job;
    holding += 1;
  }
  /** Its last command over, everything it left is ended before anyone else's begins. */
  async function leave(job, j) {
    while (holding === 1 && filing.get(job)) await sleep(20);
    if (holding === 1) await clear(job, j);
    holding -= 1;
    if (!holding) holder = null;
  }

  const longOf = (job) => {
    if (!long.has(job)) long.set(job, new Map());
    return long.get(job);
  };
  const seconds = (v, most) => Math.min(most, Math.max(1, Number(v) || most));

  const api = {
    async run({ job, cmd, seconds: s, background }, gone) {
      const j = await known(job);
      if (typeof cmd !== "string" || !cmd.trim()) refuse("no command given");
      if (cmd.length > MAX_CMD) refuse("that command is too long: write it to a file first, and run that");
      if (free() < MIN_FREE) refuse("the disk the workshop is on is nearly full");
      const all = longOf(job);
      if (background && [...all.values()].filter((p) => p.code === undefined).length >= MAX_LONG) refuse(`${MAX_LONG} are running already: stop one first`);
      await turn(job, gone);
      const at = now();
      const t = seconds(s, background ? MAX_LONG_SECONDS : MAX_SECONDS);
      let full = false;
      let p = null;
      let child;
      try {
        child = start(job, j, SHELL, { seconds: t });
      } catch (e) {
        await leave(job, j);
        throw e;
      }
      child.stdin.end(cmd);
      const read = tap(child);
      const unwatch = watch(job, j, () => (full = true));
      const ended = finish(child, t, background ? undefined : gone)
        .finally(unwatch)
        .then(async (r) => {
          const said = { ...r, ...(full ? { full: true } : {}), over: now() };
          if (p) Object.assign(p, said, { code: r.code ?? r.signal ?? null });
          await leave(job, j);
          await measure(job, j);
          return said;
        });
      if (!going.has(job)) going.set(job, new Set());
      going.get(job).add(ended);
      ended.catch(() => {}).finally(() => going.get(job)?.delete(ended));
      if (background) {
        const id = `p${all.size + 1}`;
        p = { child, read, since: at, code: undefined };
        ended.catch((e) => console.error("workshop:", e?.stack ?? e));
        all.set(id, p);
        return { id, seconds: t };
      }
      const { over, ...r } = await ended;
      return { ...r, ...read(), ms: over - at, kb: j.kb ?? 0 };
    },
    async process({ job, op, id, wait }, gone) {
      await known(job);
      const all = longOf(job);
      const said = (k, p) => ({ id: k, running: p.code === undefined, ...(p.code === undefined ? {} : { code: p.code, ...(p.late ? { late: true } : {}), ...(p.full ? { full: true } : {}) }), ms: (p.over ?? now()) - p.since });
      if (op === "list") return { processes: [...all].map(([k, p]) => said(k, p)) };
      const p = all.get(String(id));
      if (!p) refuse("no process by that id is known: the workshop may have been started again");
      if (op === "stop") kill(p.child);
      const until = Date.now() + (op === "stop" ? 3 : Math.min(MAX_WAIT, Math.max(0, num(wait)))) * 1000;
      while (p.code === undefined && Date.now() < until && !gone?.aborted) await sleep(50);
      return { ...said(String(id), p), ...p.read() };
    },
    async file({ job, op, path, from, lines, text, append, find, replace, all }) {
      const j = await known(job);
      if (op === "list") return file(job, j, { op });
      if (op === "read") return file(job, j, { op, path, from, lines });
      if (op !== "write" && op !== "edit") refuse("no such thing to do");
      await room(j);
      const t = op === "write" ? String(text ?? "") : JSON.stringify({ find, replace: String(replace ?? ""), all: all === true });
      const r = await file(job, j, op === "write" ? { op, path, append: append === true, max: MAX_BODY } : { op, path }, t);
      j.kb = (j.kb ?? 0) + Math.ceil(t.length / 1000);
      return r;
    },
    /** A copy of a file as it is now, kept by its sum: what its person will have, whatever the job does after. */
    async give({ job, path }) {
      const j = await known(job);
      await file(job, j, { op: "stat", path, max: MAX_FILE });
      const bytes = await program(job, j, { op: "cat", path }, "", MAX_FILE);
      if (!bytes) refuse("the file could not be read whole: try again");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const to = join(GIVEN, job, sha256);
      if (!existsSync(to)) {
        if (j.given + bytes.length > MAX_GIVEN) refuse(`a job gives ${MAX_GIVEN / 1_000_000} MB at most, all its versions counted`);
        space(await load());
        await fs.mkdir(join(GIVEN, job), { recursive: true, mode: 0o700 });
        await put(to, bytes);
        j.given += bytes.length;
      }
      return { size: bytes.length, sha256 };
    },
    /** The job has finished: nothing of it is left running. What it made is kept (tidy). */
    async rest({ job }) {
      const j = (await load()).get(job);
      if (!j) return { rests: false };
      await clear(job, j);
      long.delete(job);
      return { rests: true };
    },
    /** The job is gone: nothing of it is left running, or kept. */
    async end({ job }) {
      if (typeof job !== "string" || !JOB.test(job)) refuse("no such job");
      const all = await load();
      const j = all.get(job);
      if (!j) return { ended: false };
      await j.ready?.catch(() => {});
      await clear(job, j);
      // What follows a command's end looks at its folder once more, and would make part of it again.
      await Promise.allSettled([...(going.get(job) ?? [])]);
      long.delete(job);
      if (j.uid !== null && existsSync(inner(job))) {
        // A folder it closed to itself is opened first.
        const c = start(job, j, ["/bin/sh", "-c", "find . -type d ! -perm -u=rwx -exec chmod u+rwx {} \\; ; find . -mindepth 1 -delete"], { seconds: 300, stdio: "ignore" });
        await finish(c, 300);
      }
      await fs.rm(join(GIVEN, job), { recursive: true, force: true });
      await fs.rmdir(inner(job)).catch(() => {});
      const left = await fs.rmdir(outer(job)).then(() => false, (e) => e.code !== "ENOENT");
      if (left) {
        // Not forgotten, nor its user another's: tried again by tidy.
        console.error(`workshop: ${job} is not all gone`);
        j.at = 0;
        j.touched = 0;
        await fs.utimes(outer(job), 0, 0).catch(() => {});
        return { ended: false };
      }
      all.delete(job);
      return { ended: true };
    },
  };

  /** What its person is given, as it was when it was given. */
  async function given(job, sum) {
    if (!JOB.test(job ?? "") || !SUM.test(sum ?? "")) refuse("no such file");
    return fs.readFile(join(GIVEN, job, sum)).catch(() => refuse("no such file"));
  }

  /** Bytes brought in: an attachment, put in the job's folder. */
  async function bring(job, path, req) {
    const j = await known(job);
    await room(j);
    const r = await file(job, j, { op: "write", path, max: MAX_FILE }, req);
    j.kb = (j.kb ?? 0) + Math.ceil(r.size / 1000);
    return r;
  }

  async function tidy() {
    const all = await load();
    for (const [job, j] of [...all]) {
      if (now() - j.at > KEEP_MS) await api.end({ job });
      else if (j.kb === null && j.uid !== null) await measure(job, j);
    }
    for (const e of await fs.readdir(GIVEN).catch(() => [])) if (!all.has(e)) await fs.rm(join(GIVEN, e), { recursive: true, force: true });
  }

  async function body(req) {
    let t = "";
    for await (const d of req.setEncoding("utf8")) {
      t += d;
      if (t.length > MAX_BODY) refuse("too much at once");
    }
    let o;
    try {
      o = JSON.parse(t || "{}");
    } catch {
      refuse("not JSON");
    }
    return o && typeof o === "object" ? o : {};
  }

  async function handle(req, res) {
    // Whoever asked has gone (the job was stopped): so is what it ran, or waits to.
    const gone = new AbortController();
    res.on("close", () => !res.writableEnded && gone.abort());
    res.on("error", () => {});
    const json = (status, o) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    try {
      const url = new URL(req.url, "http://workshop");
      const path = url.pathname.replace(/^\/v1\//, "");
      if (req.method === "GET" && path === "health") return json(200, { ok: true, v: 1, jobs: (await load()).size });
      if (req.method === "GET" && path === "given") {
        const b = await given(url.searchParams.get("job"), url.searchParams.get("sum"));
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": b.length });
        return void res.end(b);
      }
      if (req.method === "PUT" && path === "bring") return json(200, await bring(url.searchParams.get("job"), url.searchParams.get("path"), req));
      if (req.method === "POST" && Object.hasOwn(api, path)) return json(200, await api[path](await body(req), gone.signal));
      json(404, { error: "no such thing here" });
    } catch (e) {
      if (!(e instanceof Refused)) console.error("workshop:", e?.stack ?? e);
      json(e instanceof Refused ? 400 : 500, { error: e instanceof Refused ? e.message : "the workshop could not do that" });
    }
  }

  return { handle, tidy, api };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const work = "/work";
  const socket = "/run/workshop/sock";
  // Entered by every job's user, listed by none of them.
  await fs.chmod(work, 0o711);
  const w = workshop({ work });
  await w.tidy().catch((e) => console.error("workshop:", e));
  setInterval(() => void w.tidy().catch((e) => console.error("workshop:", e)), 6 * 3_600_000);
  try {
    unlinkSync(socket);
  } catch {
    // none left from before
  }
  // The door's group (door.mjs runs as 1000): no job's user is in it, nor can enter the folder.
  await fs.chmod(dirname(socket), 0o750);
  await fs.chown(dirname(socket), 0, 1000);
  const server = createServer((q, r) => void w.handle(q, r));
  server.requestTimeout = 0;
  server.listen(socket, async () => {
    await fs.chmod(socket, 0o660);
    await fs.chown(socket, 0, 1000);
    console.log("workshop: ready");
  });
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => process.exit(0));
}
