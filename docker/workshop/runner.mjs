// Jarvis's workshop: runs a background job's commands and keeps its files. Inside a container with no network
// (docker-compose.yml), it listens on a Unix socket that only its door reaches (door.mjs).
//
// Each job has a user of its own and a folder only that user can enter. The runner is root with four powers
// (become another user, give a file away, send a signal) and not the one to open other people's files: it cannot
// look into a job's folder either, so everything done there is done as the job's user, and a link or a name a job
// leaves there reaches only what that job can.
//
// What a job is kept to: its processes, the size of a file, the time, all of them per user (setpriv, prlimit);
// memory and, where the kernel can, processes in all, by the container.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, promises as fs, existsSync, statfsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const JOB = /^[a-z0-9]{4,40}$/;
const MAX_BODY = 4_000_000;
const MAX_CMD = 30_000;
/** Of what a command writes, the first and the last of it are given back. */
const HEAD = 60_000;
const TAIL = 100_000;
/** A command in the foreground, and one left running. */
export const MAX_SECONDS = 120;
export const MAX_LONG_SECONDS = 900;
const MAX_RUNNING = 3;
const MAX_LONG = 3;
/** Of one job's files, and of one brought in or given out. */
const MAX_JOB_KB = 500_000;
const MAX_FILE = 20_000_000;
/** What a job gives its person, by number. */
export const MAX_GIVEN = 20;
const GIVE = /^(?:[1-9]|1\d|20)$/;
/** Of all jobs' files; and left free on the disk. */
const MAX_ALL_KB = 5_000_000;
const MIN_FREE = 3_000_000_000;
/** A job that was not heard of for this long is over, whatever was said. */
const KEEP_MS = 14 * 86_400_000;
const FIRST_UID = 20_000;
const LAST_UID = 60_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = join(HERE, "files.mjs");

class Refused extends Error {}
const refuse = (why) => {
  throw new Refused(why);
};

/**
 * `work` holds the jobs' folders. `drop`: each job as a user of its own, which needs root and Linux; without, all of
 * it runs as whoever runs this (test/workshop-runner.test.ts).
 */
export function workshop({ work, drop = true, now = () => Date.now() }) {
  const JOBS = join(work, ".jobs.json");
  const GIVEN = join(work, ".given");
  let jobs = null;
  /** Commands left running, by job. */
  const long = new Map();
  /** Folders being made, by job: asked of two things at once, it is made once. */
  const making = new Map();
  let running = 0;
  const waiting = [];
  let saving = Promise.resolve();

  async function load() {
    if (jobs) return jobs;
    jobs = new Map(Object.entries(JSON.parse(await fs.readFile(JOBS, "utf8").catch(() => "{}"))));
    return jobs;
  }
  function save() {
    saving = saving.then(async () => {
      await fs.writeFile(`${JOBS}.new`, JSON.stringify(Object.fromEntries(jobs)), { mode: 0o600 });
      await fs.rename(`${JOBS}.new`, JOBS);
    });
    return saving;
  }

  const folder = (job) => join(work, job);

  /** The job's own user and folder, made the first time it is heard of. */
  async function known(job) {
    if (typeof job !== "string" || !JOB.test(job)) refuse("no such job");
    const all = await load();
    let j = all.get(job);
    if (!j) {
      const used = [...all.values()].reduce((n, x) => n + (x.kb ?? 0), 0);
      if (used > MAX_ALL_KB) refuse("the workshop is full: remove old jobs in Jobs");
      const f = statfsSync(work);
      if (f.bavail * f.bsize < MIN_FREE) refuse("the disk the workshop is on is nearly full");
      const taken = new Set([...all.values()].map((x) => x.uid));
      const last = Math.max(FIRST_UID - 1, ...taken);
      let uid = last + 1 > LAST_UID ? FIRST_UID : last + 1;
      while (taken.has(uid)) uid += 1;
      j = { uid, at: now(), kb: 0 };
      all.set(job, j);
      await save();
    }
    if (!making.has(job) && !existsSync(folder(job))) {
      making.set(job, (async () => {
        // Closed to others before it is given away: after, it is no longer the runner's to close.
        await fs.mkdir(folder(job), { mode: 0o700 });
        await fs.chmod(folder(job), 0o700);
        if (drop) await fs.chown(folder(job), j.uid, j.uid);
      })().finally(() => making.delete(job)));
    }
    await making.get(job);
    j.at = now();
    return j;
  }

  /** A program run as the job's user, in its folder: how to start it. */
  function start(job, j, argv, { seconds, env = {}, stdio = ["pipe", "pipe", "pipe"] }) {
    const as = drop
      ? ["setpriv", `--reuid=${j.uid}`, `--regid=${j.uid}`, "--clear-groups", "--no-new-privs", "--",
         "prlimit", "--nproc=300", "--nofile=1024", "--core=0", `--fsize=${200_000_000}`, `--cpu=${Math.ceil(seconds * 3)}`, "--",
         // Its own folder, entered as itself; and the first to be ended if memory runs out.
         "bash", "-c", 'umask 077; echo 1000 > /proc/self/oom_score_adj; cd "$WORK" || exit 97; mkdir -p .tmp; exec "$@"', "-"]
      : ["bash", "-c", 'umask 077; cd "$WORK" || exit 97; mkdir -p .tmp; exec "$@"', "-"];
    const full = [...as, ...argv];
    return spawn(full[0], full.slice(1), {
      cwd: "/",
      detached: true,
      stdio,
      env: {
        PATH: process.env.PATH, HOME: folder(job), WORK: folder(job), TMPDIR: join(folder(job), ".tmp"), USER: "job", LOGNAME: "job",
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", MPLBACKEND: "Agg", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", ...env,
      },
    });
  }

  const kill = (c) => {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      // gone already
    }
  };

  /** Everything the job's user has running, whatever group it put itself in. */
  function killAll(job, j) {
    for (const p of long.get(job)?.values() ?? []) kill(p.child);
    if (!drop) return Promise.resolve();
    return new Promise((done) => {
      const c = spawn("setpriv", [`--reuid=${j.uid}`, `--regid=${j.uid}`, "--clear-groups", "--no-new-privs", "--", "bash", "-c", "kill -9 -1"], { cwd: "/", stdio: "ignore" });
      c.on("error", done).on("exit", done);
    });
  }

  /** What a command wrote: its first and its last. */
  function tap(child) {
    let head = "";
    let tail = "";
    let bytes = 0;
    const on = (d) => {
      const s = d.toString("utf8");
      bytes += d.length;
      if (head.length < HEAD) {
        head += s;
        if (head.length > HEAD) {
          tail = head.slice(HEAD);
          head = head.slice(0, HEAD);
        }
      } else tail = (tail + s).slice(-TAIL);
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    return () => ({ out: bytes > head.length + tail.length + 200 ? `${head}\n… (${bytes - head.length - tail.length} bytes left out) …\n${tail}` : head + tail, bytes });
  }

  /** To its end, or its time. A process it left in the background with its output open does not keep the rest waiting. */
  function finish(child, seconds, gone) {
    return new Promise((done) => {
      let late = false;
      let over = false;
      const end = (code, signal) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        done({ code, signal: signal ?? undefined, ...(late ? { late: true } : {}) });
      };
      const timer = setTimeout(() => {
        late = true;
        kill(child);
      }, seconds * 1000);
      gone?.(() => kill(child));
      child.on("error", (e) => end(127, e.code));
      child.on("exit", (code, signal) => setTimeout(() => end(code, signal), 300));
      child.on("close", (code, signal) => end(code, signal));
    });
  }

  async function turn() {
    if (running >= MAX_RUNNING) await new Promise((go) => waiting.push(go));
    running += 1;
  }
  const next = () => {
    running -= 1;
    waiting.shift()?.();
  };

  /** One thing done to its files, as its user (files.mjs). `body`: bytes in. `out`: where its bytes go, for `cat`. */
  async function file(job, j, what, body, out) {
    const c = start(job, j, [process.execPath, FILES], { seconds: 60, env: { WORKSHOP_DO: JSON.stringify(what) } });
    c.stdin.on("error", () => {});
    if (body && typeof body.pipe === "function") body.pipe(c.stdin);
    else c.stdin.end(body ?? "");
    let text = "";
    let hash = null;
    if (out) {
      hash = createHash("sha256");
      c.stdout.on("data", (d) => hash.update(d));
      c.stdout.pipe(out, { end: true });
    } else c.stdout.on("data", (d) => (text += d));
    c.stderr.resume();
    const r = await finish(c, 60);
    if (out) return { ok: r.code === 0, sha256: hash.digest("hex") };
    let said;
    try {
      said = JSON.parse(text);
    } catch {
      refuse("that could not be done to the file");
    }
    if (said.error) refuse(said.error);
    return said;
  }

  /** How much it holds now, kept for the next. */
  async function measure(job, j) {
    const c = start(job, j, ["du", "-sk", "."], { seconds: 30, stdio: ["ignore", "pipe", "ignore"] });
    let t = "";
    c.stdout.on("data", (d) => (t += d));
    await finish(c, 30);
    const kb = Number.parseInt(t, 10);
    if (Number.isFinite(kb)) j.kb = kb;
    await save();
    return j.kb;
  }

  const room = (j) => {
    if (j.kb > MAX_JOB_KB) refuse(`this job's files are over ${MAX_JOB_KB / 1000} MB: remove some first, by run`);
  };

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
      // Told on its input, so that what it runs is in nobody's list of processes.
      const argv = ["bash", "-c", 'script=$(cat); exec </dev/null; eval "$script"'];
      if (background) {
        const all = longOf(job);
        if ([...all.values()].filter((p) => p.code === undefined).length >= MAX_LONG) refuse(`${MAX_LONG} are running already: stop one first`);
        const t = seconds(s, MAX_LONG_SECONDS);
        const child = start(job, j, argv, { seconds: t });
        child.stdin.on("error", () => {});
        child.stdin.end(cmd);
        const id = `p${all.size + 1}`;
        const p = { child, read: tap(child), since: now(), code: undefined };
        all.set(id, p);
        void finish(child, t).then((r) => Object.assign(p, { code: r.code ?? r.signal, late: r.late, over: now() }));
        return { id, seconds: t };
      }
      await turn();
      const at = now();
      try {
        const t = seconds(s, MAX_SECONDS);
        const child = start(job, j, argv, { seconds: t });
        child.stdin.on("error", () => {});
        child.stdin.end(cmd);
        const read = tap(child);
        const r = await finish(child, t, gone);
        return { ...r, ...read(), ms: now() - at, kb: await measure(job, j) };
      } finally {
        next();
      }
    },
    async process({ job, op, id }) {
      await known(job);
      const all = longOf(job);
      const said = (k, p) => ({ id: k, running: p.code === undefined, ...(p.code === undefined ? {} : { code: p.code, ...(p.late ? { late: true } : {}) }), ms: (p.over ?? now()) - p.since });
      if (op === "list") return { processes: [...all].map(([k, p]) => said(k, p)) };
      const p = all.get(String(id));
      if (!p) refuse("no process by that id is known: the workshop may have been started again");
      if (op === "stop") kill(p.child);
      return { ...said(String(id), p), ...p.read() };
    },
    async file({ job, op, path, from, lines, text, append, find, replace, all }) {
      const j = await known(job);
      if (op === "list") return file(job, j, { op });
      if (op === "read") return file(job, j, { op, path, from, lines });
      room(j);
      if (op === "write") return file(job, j, { op, path, append: append === true, max: MAX_BODY }, String(text ?? ""));
      if (op === "edit") return file(job, j, { op, path }, JSON.stringify({ find, replace: String(replace ?? ""), all: all === true }));
      return refuse("no such thing to do");
    },
    /** A copy of a file as it is now, which the job can no longer change: what its person will have. */
    async give({ job, path, n }) {
      const j = await known(job);
      const s = await file(job, j, { op: "stat", path, max: MAX_FILE });
      const name = String(Number(n));
      if (!GIVE.test(name)) refuse(`a job gives ${MAX_GIVEN} files at most`);
      await fs.mkdir(join(GIVEN, job), { recursive: true, mode: 0o700 });
      const to = join(GIVEN, job, name);
      const out = createWriteStream(to, { mode: 0o600 });
      const r = await new Promise((done, no) => {
        let said;
        out.on("error", no).on("finish", () => said.then(done, no));
        said = file(job, j, { op: "cat", path, max: MAX_FILE }, "", out);
      });
      const size = (await fs.stat(to)).size;
      if (!r.ok || size !== s.size) {
        await fs.rm(to, { force: true });
        refuse("the file changed while it was read: try again");
      }
      return { size, sha256: r.sha256 };
    },
    /** The job has finished: nothing of it is left running. What it made is kept (tidy). */
    async rest({ job }) {
      const j = (await load()).get(job);
      if (j) await killAll(job, j);
      return { rests: !!j };
    },
    /** The job is gone: nothing of it is left running, or kept. */
    async end({ job }) {
      if (typeof job !== "string" || !JOB.test(job)) refuse("no such job");
      const all = await load();
      const j = all.get(job);
      if (!j) return { ended: false };
      await killAll(job, j);
      long.delete(job);
      const c = start(job, j, ["bash", "-c", "shopt -s dotglob; rm -rf -- *"], { seconds: 60, stdio: "ignore" });
      await finish(c, 60);
      await fs.rmdir(folder(job)).catch(() => {});
      await fs.rm(join(GIVEN, job), { recursive: true, force: true });
      all.delete(job);
      await save();
      return { ended: true };
    },
  };

  /** What its person is given, as it was when it was given. */
  async function given(job, n) {
    if (!JOB.test(job ?? "") || !GIVE.test(n ?? "")) refuse("no such file");
    const at = join(GIVEN, job, n);
    const s = await fs.stat(at).catch(() => refuse("no such file"));
    return { size: s.size, stream: createReadStream(at) };
  }

  /** Bytes brought in: an attachment, put in the job's folder. */
  async function bring(job, path, req) {
    const j = await known(job);
    room(j);
    return file(job, j, { op: "write", path, max: MAX_FILE }, req);
  }

  async function tidy() {
    for (const [job, j] of [...(await load())]) if (now() - j.at > KEEP_MS) await api.end({ job });
  }

  async function body(req) {
    let t = "";
    for await (const d of req) {
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
    const url = new URL(req.url, "http://workshop");
    const json = (status, o) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    try {
      const path = url.pathname.replace(/^\/v1\//, "");
      if (req.method === "GET" && path === "health") return json(200, { ok: true, v: 1, jobs: (await load()).size });
      if (req.method === "GET" && path === "given") {
        const g = await given(url.searchParams.get("job"), url.searchParams.get("n"));
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": g.size });
        return void g.stream.on("error", () => res.destroy()).pipe(res);
      }
      if (req.method === "PUT" && path === "bring") return json(200, await bring(url.searchParams.get("job"), url.searchParams.get("path"), req));
      if (req.method === "POST" && Object.hasOwn(api, path)) {
        const o = await body(req);
        // Whoever asked has gone (the job was stopped): so is what it ran.
        return json(200, await api[path](o, (stop) => res.on("close", () => !res.writableEnded && stop())));
      }
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
