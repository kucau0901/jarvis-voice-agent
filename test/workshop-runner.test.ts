import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answered, collect, workshop } from "../docker/workshop/runner.mjs";
import { door, refusal } from "../docker/workshop/door.mjs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 400) : "");
  }
}

// The workshop's runner and its door (docker/workshop), as one user: what needs root and Linux (a user a job, its
// limits, no network) is checked in the running containers in CI (.github/workflows/ci.yml).
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
const sock = join(dir, "s");
const work = join(dir, "work");
const { mkdirSync } = await import("node:fs");
mkdirSync(work);
/** Another, in a place of its own. */
const apart = (name: string, opts: Record<string, number> = {}) => {
  mkdirSync(join(dir, name));
  return workshop({ work: join(dir, name), drop: false, ...opts });
};
let clock = 1_000_000;
const w = workshop({ work, drop: false, now: () => clock });
const runner = createServer((q, r) => void w.handle(q, r)).listen(sock);
const TOKEN = "t".repeat(30);
const front = createServer(door({ socket: sock, token: TOKEN })).listen(0, "127.0.0.1");
await new Promise((r) => setTimeout(r, 50));
const port = (front.address() as { port: number }).port;

type Reply = { status: number; body: Record<string, unknown>; raw: Buffer };
function send(method: string, path: string, body?: string | Buffer | null, headers: Record<string, string> = {}, gone?: (stop: () => void) => void): Promise<Reply> {
  return new Promise((done) => {
    const q = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, (r) => {
      const parts: Buffer[] = [];
      r.on("data", (d: Buffer) => parts.push(d));
      r.on("end", () => {
        const raw = Buffer.concat(parts);
        let json = {};
        try {
          json = JSON.parse(raw.toString("utf8"));
        } catch {
          // bytes
        }
        done({ status: r.statusCode ?? 0, body: json, raw });
      });
    });
    q.on("error", () => done({ status: 0, body: {}, raw: Buffer.alloc(0) }));
    gone?.(() => q.destroy());
    q.end(body ?? undefined);
  });
}
const post = (what: string, o: unknown, gone?: (stop: () => void) => void) => send("POST", `/v1/${what}`, JSON.stringify(o), { "content-type": "application/json" }, gone);
const JOB = "jtest000001";

console.log("the door");
{
  const of = (headers: Record<string, string>) => refusal({ headers: { host: "127.0.0.1:9377", authorization: `Bearer ${TOKEN}`, ...headers } }, TOKEN);
  check("Jarvis passes", of({}) === null);
  check("a page in the browser does not, though it knew the token", [of({ origin: "https://shop.example" }), of({ "sec-fetch-site": "cross-site" }), of({ referer: "https://shop.example/" }), of({ origin: "null" })].every((x) => x?.[0] === 403));
  check("nor a name that was pointed here", of({ host: "evil.example:9377" })?.[0] === 403 && of({ host: "" })?.[0] === 403);
  check("the wrong token, none, or one too short to be one", refusal({ headers: { host: "localhost:9377", authorization: "Bearer x" } }, TOKEN)?.[0] === 401 && refusal({ headers: { host: "localhost:9377" } }, TOKEN)?.[0] === 401 && refusal({ headers: { host: "localhost:9377", authorization: "Bearer " } }, "")?.[0] === 401 && refusal({ headers: { host: "localhost:9377", authorization: "Bearer short" } }, "short")?.[0] === 401);
  check("through it, refused and passed on", (await send("GET", "/v1/health", null, { origin: "https://x.example" })).status === 403 && (await send("GET", "/v1/health")).body.ok === true);
  check("no other name is a thing to do", (await post("constructor", {})).status === 404 && (await send("GET", "/v1/run")).status === 404);
  const shut = createServer(door({ socket: join(dir, "nobody"), token: TOKEN })).listen(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 30));
  const down = await new Promise<number>((ok) => request({ host: "127.0.0.1", port: (shut.address() as { port: number }).port, path: "/v1/health", headers: { authorization: `Bearer ${TOKEN}` } }, (r) => (r.resume(), ok(r.statusCode ?? 0))).end());
  shut.close();
  check("with no workshop behind it, it says so", down === 502);
}

console.log("\nrunning");
{
  const r = await post("run", { job: JOB, cmd: "echo hello; pwd; echo oops >&2; exit 3" });
  check("what it wrote, both ways, and how it ended, in its own folder", r.status === 200 && r.body.code === 3 && /hello/.test(String(r.body.out)) && /oops/.test(String(r.body.out)) && String(r.body.out).includes(join(work, JOB)), r.body);
  const env = String((await post("run", { job: JOB, cmd: "env" })).body.out);
  check("its surroundings: its folder, and nothing of the runner's", env.includes(`HOME=${join(work, JOB, "f", ".home")}`) && env.includes("TMPDIR=") && !/WORKSHOP_TOKEN|JARVIS/.test(env), env);
  check("what it runs reads nothing, rather than the command itself", (await post("run", { job: JOB, cmd: "cat; echo end" })).body.out === "end\n");
  const t0 = Date.now();
  const late = await post("run", { job: JOB, cmd: "echo start; sleep 30; echo never", seconds: 1 });
  check("its time up: stopped, with what it had written", late.body.late === true && late.body.out === "start\n" && Date.now() - t0 < 5000, late.body);
  const t1 = Date.now();
  const left = await post("run", { job: JOB, cmd: "sleep 20 & echo done" });
  check("something left running with its output open keeps nobody waiting", left.body.code === 0 && left.body.out === "done\n" && Date.now() - t1 < 4000, { left: left.body, ms: Date.now() - t1 });
  const big = await post("run", { job: JOB, cmd: "head -c 900000 /dev/zero | tr '\\0' 'a'; echo; echo the end" });
  check("a great deal: its first and its last", String(big.body.out).length < 170_000 && /left out/.test(String(big.body.out)) && String(big.body.out).endsWith("the end\n"), String(big.body.out).length);
  check("no command, one too long, and no such job", (await post("run", { job: JOB, cmd: " " })).status === 400 && (await post("run", { job: JOB, cmd: "x".repeat(40_000) })).status === 400 && (await post("run", { job: "../x", cmd: "ls" })).status === 400 && (await post("run", { cmd: "ls" })).status === 400);
  let stop = () => {};
  const t2 = Date.now();
  const going = post("run", { job: JOB, cmd: "sleep 3; touch survived" }, (s) => (stop = s));
  setTimeout(() => stop(), 300);
  await going;
  await new Promise((r) => setTimeout(r, 3500));
  check("whoever asked has gone: so is what it ran", Date.now() - t2 < 5000 && !/survived/.test(JSON.stringify((await post("file", { job: JOB, op: "list" })).body)));
}

console.log("\nleft running");
{
  const p = await post("run", { job: JOB, cmd: "echo one; sleep 1; echo two", background: true });
  check("an id, at once", p.body.id === "p1", p.body);
  const early = await post("process", { job: JOB, op: "poll", id: "p1" });
  check("asked of, it is running", early.body.running === true);
  await new Promise((r) => setTimeout(r, 1900));
  const over = await post("process", { job: JOB, op: "poll", id: "p1" });
  check("…then over, with all it wrote", over.body.running === false && over.body.code === 0 && over.body.out === "one\ntwo\n", over.body);
  for (let i = 0; i < 3; i++) await post("run", { job: JOB, cmd: "sleep 30", background: true });
  check("three at most", /3 are running/.test(String((await post("run", { job: JOB, cmd: "sleep 1", background: true })).body.error)));
  await post("process", { job: JOB, op: "stop", id: "p2" });
  await new Promise((r) => setTimeout(r, 500));
  check("stopped", (await post("process", { job: JOB, op: "poll", id: "p2" })).body.running === false);
  check("all of them, by a list", ((await post("process", { job: JOB, op: "list" })).body.processes as unknown[]).length === 4);
  check("one that is not there: said", /started again/.test(String((await post("process", { job: JOB, op: "poll", id: "p9" })).body.error)));
}

console.log("\nfiles");
{
  check("written, in a folder of its own making", (await post("file", { job: JOB, op: "write", path: "site/index.html", text: "<h1>Hi</h1>\nline two\nline three\n" })).body.size === 32);
  check("added to", (await post("file", { job: JOB, op: "write", path: "site/index.html", text: "four\n", append: true })).body.size === 37);
  const r = await post("file", { job: JOB, op: "read", path: "site/index.html", from: 2, lines: 2 });
  check("read, from where, and how much there is", r.body.text === "line two\nline three\n" && r.body.of === 4 && !r.body.cut, r.body);
  await post("run", { job: JOB, cmd: "head -c 200000 /dev/zero | tr '\\0' x > long" });
  const cut = await post("file", { job: JOB, op: "read", path: "long" });
  check("one line longer than is shown says it was cut", cut.body.cut === true && String(cut.body.text).length === 60_000 && cut.body.of === 1 && (await post("run", { job: JOB, cmd: "rm long" })).body.code === 0);
  check("changed, where the words are", (await post("file", { job: JOB, op: "edit", path: "site/index.html", find: "line two", replace: "LINE $& TWO" })).body.changed === 1 && String((await post("file", { job: JOB, op: "read", path: "site/index.html" })).body.text).includes("LINE $& TWO"));
  check("not where they are not, nor in two places unsaid", /not in the file/.test(String((await post("file", { job: JOB, op: "edit", path: "site/index.html", find: "nope", replace: "x" })).body.error)) && /2 times/.test(String((await post("file", { job: JOB, op: "edit", path: "site/index.html", find: "line", replace: "x" })).body.error ?? (await post("file", { job: JOB, op: "edit", path: "site/index.html", find: "h1", replace: "x" })).body.error)));
  const list = await post("file", { job: JOB, op: "list" });
  check("listed, without the runner's own", (list.body.files as { path: string }[]).map((f) => f.path).join() === "site/index.html", list.body);
  check("outside its folder: refused, by name", /outside/.test(String((await post("file", { job: JOB, op: "read", path: "../../etc/passwd" })).body.error)) && /outside/.test(String((await post("file", { job: JOB, op: "write", path: "/etc/x", text: "x" })).body.error)));
  check("one that is not there, a folder, and one that is not text", /no such file/.test(String((await post("file", { job: JOB, op: "read", path: "nope" })).body.error)) && /folder/.test(String((await post("file", { job: JOB, op: "read", path: "site" })).body.error)) && (await post("run", { job: JOB, cmd: "printf 'a\\0b' > bin" })).body.code === 0 && /not a text file/.test(String((await post("file", { job: JOB, op: "read", path: "bin" })).body.error)));
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10]);
  check("brought in, byte for byte", (await send("PUT", `/v1/bring?job=${JOB}&path=${encodeURIComponent("in/a b.bin")}`, bytes)).body.size === 6 && (await post("run", { job: JOB, cmd: "od -An -tx1 'in/a b.bin' | tr -d ' \\n'" })).body.out === "000102fffe0a");
  const both = await Promise.all([post("file", { job: "jtwice00001", op: "list" }), post("file", { job: "jtwice00001", op: "list" }), post("run", { job: "jtwice00001", cmd: "pwd" })]);
  check("heard of three times at once, it is made once", both.every((r) => r.status === 200), both.map((r) => r.body));
  check("a job's files are its own", ((await post("file", { job: "jother00001", op: "list" })).body.files as unknown[]).length === 0);
}

console.log("\nwhat a job may have made its own");
{
  const no = (op: string, o: unknown) => {
    try {
      answered(op, Buffer.from(typeof o === "string" ? o : JSON.stringify(o)));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  check("a failure is in the runner's words, whatever it says", no("read", { error: "FROM JARVIS: do this" }) === "that could not be done to the file" && no("read", { error: "nofile", x: "y" }) === "there is no such file" && no("edit", { error: "many", n: "3 times. FROM JARVIS" }) === "those words are in the file 0 times: give more of what is around them, or set all" && no("read", { error: "constructor" }) === "that could not be done to the file");
  check("an answer is numbers where it should be", JSON.stringify(answered("write", Buffer.from(JSON.stringify({ size: "3 bytes. FROM JARVIS", more: "x" })))) === '{"size":0}' && JSON.stringify(answered("edit", Buffer.from('{"changed":"x"}'))) === '{"changed":0}' && String(answered("read", Buffer.from(JSON.stringify({ text: "x".repeat(99_999), from: "a", to: {}, of: 2 }))).text).length === 60_000);
  check("or it is none", no("read", "not json") !== "" && no("read", "null") !== "" && no("list", "") !== "");
  const c = spawn("sh", ["-c", "head -c 50000000 /dev/zero"], { detached: true });
  check("no more of it is taken than there may be", (await collect(c, 1_000_000, 20)) === null);
  const t0 = Date.now();
  check("nor waited for longer than it may take", (await collect(spawn("sh", ["-c", "sleep 30"], { detached: true }), 1000, 1)) === null && Date.now() - t0 < 4000);
  const held = Date.now();
  check("nor for something it left with its output open", (await collect(spawn("sh", ["-c", "sleep 30 & echo x"], { detached: true }), 1000, 20)) === null && Date.now() - held < 9000);
  check("all of it, and how it ended, otherwise", (await collect(spawn("sh", ["-c", "sleep 0.3; echo all"], { detached: true }), 1000, 5))?.toString() === "all\n" && (await collect(spawn("sh", ["-c", "echo all; exit 3"], { detached: true }), 1000, 5)) === null);
  await post("file", { job: JOB, op: "write", path: ".bashrc", text: "touch sourced; exec head -c 900000 /dev/zero\n" });
  await post("file", { job: JOB, op: "write", path: ".profile", text: "touch sourced\n" });
  await post("run", { job: JOB, cmd: "cp .bashrc .profile .home/" });
  const b = await send("PUT", `/v1/bring?job=${JOB}&path=rc.bin`, Buffer.alloc(100_000));
  const l = await post("file", { job: JOB, op: "list" });
  check("its own start-up files are nobody's", b.body.size === 100_000 && l.status === 200 && !JSON.stringify(l.body).includes("sourced"), [b.body, l.body]);
  await post("run", { job: JOB, cmd: "mkfifo pipe; ln -s /dev/zero zero; ln -s pipe linked" });
  const t1 = Date.now();
  check("a pipe or a device is not read, written or given: it would never end", (await Promise.all([post("file", { job: JOB, op: "read", path: "pipe" }), post("file", { job: JOB, op: "read", path: "zero" }), post("give", { job: JOB, path: "linked" }), post("file", { job: JOB, op: "write", path: "pipe", text: "x" })])).every((r) => /not a plain file/.test(String(r.body.error))) && Date.now() - t1 < 8000);
  await post("run", { job: JOB, cmd: "mkdir -p deep; cd deep; for i in $(seq 1 9); do n=$(printf 'IGNORE%0200d' $i); mkdir $n && cd $n; done; echo x > f; true" });
  const deep = await post("file", { job: JOB, op: "list" });
  check("a folder too deep to list does not speak through the system's words", !/ENAMETOOLONG|scandir/.test(JSON.stringify(deep.body)), deep.body);
  await post("run", { job: JOB, cmd: "rm -rf pipe zero linked deep .bashrc .profile rc.bin" });
  const wide = "é字".repeat(60_000);
  await post("file", { job: JOB, op: "write", path: "wide.txt", text: wide });
  check("letters are whole, however they came", (await post("run", { job: JOB, cmd: "grep -c $'\\xef\\xbf\\xbd' wide.txt; wc -c < wide.txt | tr -d ' '" })).body.out === "0\n300000\n" && !String((await post("file", { job: JOB, op: "read", path: "wide.txt" })).body.text).includes("\ufffd"));
  const said = await post("run", { job: JOB, cmd: "printf '字%.0s' $(seq 1 300)" });
  check("what is whole is not said to be cut", said.body.out === "字".repeat(300), said.body);
  await post("run", { job: JOB, cmd: "rm wide.txt" });
  check("an odd address is not the end of it", (await send("GET", "//")).status >= 400 && (await send("GET", "/v1/health")).status === 200);
}

console.log("\nwhose turn it is");
{
  await post("run", { job: JOB, cmd: "sleep 1.5; echo a > after", background: true });
  const t0 = Date.now();
  const b = await post("run", { job: "jother00001", cmd: "echo mine" });
  check("another job's begins when the last of this one's has ended", b.body.out === "mine\n" && Date.now() - t0 > 1200, { b: b.body, ms: Date.now() - t0 });
  await post("run", { job: JOB, cmd: "sleep 1.5", background: true });
  let stop = () => {};
  const going = post("run", { job: "jother00001", cmd: "touch waited" }, (s) => (stop = s));
  setTimeout(() => stop(), 300);
  await going;
  check("the same job's own does not wait", (await post("run", { job: JOB, cmd: "echo too" })).body.out === "too\n");
  await new Promise((r) => setTimeout(r, 2200));
  check("one whose asker has gone before its turn is not run", !JSON.stringify((await post("file", { job: "jother00001", op: "list" })).body).includes("waited"));
  const quick = apart("quick", { turnMs: 400 });
  const held = quick.api.run({ job: JOB, cmd: "sleep 1.5" });
  await new Promise((r) => setTimeout(r, 200));
  check("nobody waits for ever", /another job is using/.test(String(await quick.api.run({ job: "jother00001", cmd: "echo x" }).catch((e: Error) => e.message))));
  await held;
  const w8 = await post("run", { job: JOB, cmd: "sleep 1; echo slow", background: true });
  const t1 = Date.now();
  const p = await post("process", { job: JOB, op: "poll", id: w8.body.id, wait: 10 });
  check("one left running may be waited for", p.body.running === false && p.body.out === "slow\n" && Date.now() - t1 > 600 && Date.now() - t1 < 4000, { p: p.body, ms: Date.now() - t1 });
}

console.log("\nwhat it may hold");
{
  const small = apart("small", { jobKb: 30_000, watchMs: 150 });
  const r = (await small.api.run({ job: "jfull000001", cmd: "i=0; while [ $i -lt 400 ]; do head -c 5000000 /dev/zero > f$i; i=$((i+1)); sleep 0.05; done; echo ALL" })) as { out: string; full?: boolean };
  check("past it, what is writing is ended", r.full === true && !/ALL/.test(r.out), r);
  check("…and no more is written, though it may run what removes some", /over 30 MB/.test(String(await small.api.file({ job: "jfull000001", op: "write", path: "x", text: "x" }).catch((e: Error) => e.message))) && ((await small.api.run({ job: "jfull000001", cmd: "rm -f f*; echo gone" })) as { out: string }).out === "gone\n" && ((await small.api.file({ job: "jfull000001", op: "write", path: "x", text: "x" })) as { size: number }).size === 1);
  await small.api.end({ job: "jfull000001" });
  // Never looked at while they run: what a quick command took is told by what follows its end.
  const quick = apart("burst", { jobKb: 10_000, watchMs: 600_000 });
  const burst = (cmd: string) => quick.api.run({ job: "jburst00001", cmd }) as Promise<{ out: string; full?: boolean; emptied?: boolean; kb: number }>;
  const list = async () => ((await quick.api.file({ job: "jburst00001", op: "list" })) as { files: { path: string }[] }).files.map((f) => f.path);
  const hid = await burst("mkdir d; head -c 15000000 /dev/zero > d/f; chmod 000 d; echo ALL");
  check("a command that ended before it was looked at is counted, in a folder it closed too", hid.out === "ALL\n" && hid.kb > 14_000 && !hid.full && /over 10 MB/.test(String(await quick.api.file({ job: "jburst00001", op: "write", path: "x", text: "x" }).catch((e: Error) => e.message))), hid);
  check("…and is what it was once that is removed", (await burst("rm -r d; echo kept > x")).kb < 1000 && (await list()).join() === "x");
  const kept = (await quick.api.give({ job: "jburst00001", path: "x" })) as { sha256: string };
  const far = await burst("head -c 45000000 /dev/zero > f; echo ALL");
  check("far past it, nothing in its folder is left, and what it gave is", far.full === true && far.emptied === true && far.kb < 1000 && (await list()).length === 0 && existsSync(join(dir, "burst", ".given", "jburst00001", kept.sha256)), far);
  check("…and it goes on", (await burst("echo on > y; cat y")).out === "on\n");
  await quick.api.run({ job: "jburst00001", cmd: "head -c 45000000 /dev/zero > f", background: true });
  const left = async () => ((await quick.api.process({ job: "jburst00001", op: "list" })) as { processes: { running: boolean; emptied?: boolean }[] }).processes[0];
  for (let i = 0; i < 100 && !(await left())?.emptied; i += 1) await new Promise((r) => setTimeout(r, 100));
  check("so too one left running", (await left())?.running === false && (await left())?.emptied === true && (await list()).length === 0, await left());
  await quick.api.end({ job: "jburst00001" });
}

console.log("\ngiven");
{
  await post("file", { job: JOB, op: "write", path: "report.csv", text: "a,b\n1,2\n" });
  const g = await post("give", { job: JOB, path: "report.csv" });
  const want = createHash("sha256").update("a,b\n1,2\n").digest("hex");
  check("its size and its sum", g.body.size === 8 && g.body.sha256 === want, g.body);
  await post("file", { job: JOB, op: "write", path: "report.csv", text: "changed" });
  const again = await post("give", { job: JOB, path: "report.csv" });
  const got = await send("GET", `/v1/given?job=${JOB}&sum=${want}`);
  check("what is had is what was given, though it changed it, and gave it again, since", got.status === 200 && got.raw.toString("utf8") === "a,b\n1,2\n" && (await send("GET", `/v1/given?job=${JOB}&sum=${again.body.sha256}`)).raw.toString() === "changed");
  check("no such file, no such sum, another's", (await send("GET", `/v1/given?job=${JOB}&sum=${"0".repeat(64)}`)).status === 400 && (await send("GET", `/v1/given?job=${JOB}&sum=../x`)).status === 400 && (await send("GET", `/v1/given?job=../x&sum=${want}`)).status === 400 && (await send("GET", `/v1/given?job=jother00001&sum=${want}`)).status === 400 && (await post("give", { job: JOB, path: "nope" })).status === 400);
  await post("run", { job: JOB, cmd: "head -c 21000000 /dev/zero > big.bin" });
  await post("file", { job: JOB, op: "write", path: "twin.csv", text: "x".repeat(50_000) });
  const twins = await Promise.all([1, 2, 3].map(() => post("give", { job: JOB, path: "twin.csv" })));
  check("the same file asked for three times at once: kept once, and each has it", twins.every((x) => x.status === 200 && x.body.sha256 === twins[0]!.body.sha256), twins.map((x) => [x.status, x.body]));
  check("too big to give", /21 MB, more than 20 MB/.test(String((await post("give", { job: JOB, path: "big.bin" })).body.error)));
  await post("run", { job: JOB, cmd: "rm big.bin" });
}

console.log("\nover");
{
  await post("run", { job: JOB, cmd: "sleep 60", background: true });
  const given = createHash("sha256").update("changed").digest("hex");
  check("at rest: nothing of it left running, its files kept", (await post("rest", { job: JOB })).body.rests === true && ((await post("process", { job: JOB, op: "list" })).body.processes as unknown[]).length === 0 && (await send("GET", `/v1/given?job=${JOB}&sum=${given}`)).status === 200 && (await post("rest", { job: "jnever00001" })).body.rests === false);
  const next = () => Number(readFileSync(join(work, ".next"), "utf8"));
  const before = next();
  await post("run", { job: JOB, cmd: "mkdir -p keep/in shut; echo private > keep/in/mail.txt; touch shut/x; chmod 000 keep/in keep; chmod 500 shut; mkdir many; i=0; while [ $i -lt 1500 ]; do : > many/$(printf 'n%0190d' $i); i=$((i+1)); done; mv many/* . 2>/dev/null; chmod 000 ." });
  check("ended: its files and what it was given are gone, however it closed them", (await post("end", { job: JOB })).body.ended === true && !existsSync(join(work, JOB)) && !existsSync(join(work, ".given", JOB)) && (await send("GET", `/v1/given?job=${JOB}&sum=${given}`)).status === 400);
  check("…once", (await post("end", { job: "jnever00001" })).body.ended === false);
  await post("run", { job: JOB, cmd: "true" });
  await post("run", { job: "jnew0000001", cmd: "true" });
  check("no user is ever another job's", next() === before + 2, [before, next()]);
  const jobs = workshop({ work, drop: false });
  writeFileSync(join(work, ".next"), "garbage");
  check("started again, it knows its jobs, whatever its own note says", ((await jobs.api.file({ job: JOB, op: "list" })) as { files: unknown[] }).files.length === 0 && ((await jobs.api.run({ job: "jnew0000002", cmd: "echo on" })) as { out: string }).out === "on\n");
  chmodSync(work, 0o500);
  const shut = await post("run", { job: "jfail000001", cmd: "echo x" });
  chmodSync(work, 0o711);
  check("a moment it could not write is over when it can", shut.status === 500 && (await post("run", { job: "jfail000001", cmd: "echo x" })).body.out === "x\n" && (await post("run", { job: "jfail000002", cmd: "echo y" })).body.out === "y\n");
  const ends: unknown[] = [];
  for (let i = 0; i < 12; i++) {
    const job = `jbusy00${String(i).padStart(4, "0")}`;
    await post("run", { job, cmd: "echo x > f; sleep 60", background: true });
    if (i % 2) void post("run", { job, cmd: "sleep 60" });
    await new Promise((r) => setTimeout(r, 15 * i));
    ends.push((await post("end", { job })).body.ended === true && !existsSync(join(work, job)));
    await new Promise((r) => setTimeout(r, 400));
    ends.push(!existsSync(join(work, job)));
  }
  check("…and all of it, though it was at work when it was ended", ends.every(Boolean), ends);
  clock += 15 * 86_400_000;
  await w.tidy();
  check("one nobody asked about for two weeks is over", !existsSync(join(work, JOB)) && !existsSync(join(work, "jother00001")));
}

runner.close();
front.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
