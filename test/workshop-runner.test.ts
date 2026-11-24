import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workshop } from "../docker/workshop/runner.mjs";
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
  check("its surroundings: its folder, and nothing of the runner's", env.includes(`HOME=${join(work, JOB)}`) && env.includes("TMPDIR=") && !/WORKSHOP_TOKEN|JARVIS/.test(env), env);
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

console.log("\ngiven");
{
  await post("file", { job: JOB, op: "write", path: "report.csv", text: "a,b\n1,2\n" });
  const g = await post("give", { job: JOB, path: "report.csv", n: 1 });
  const want = createHash("sha256").update("a,b\n1,2\n").digest("hex");
  check("its size and its sum", g.body.size === 8 && g.body.sha256 === want, g.body);
  await post("file", { job: JOB, op: "write", path: "report.csv", text: "changed" });
  const got = await send("GET", `/v1/given?job=${JOB}&n=1`);
  check("what is had is what was given, though it changed it since", got.status === 200 && got.raw.toString("utf8") === "a,b\n1,2\n");
  symlinkSync(join(dir, "elsewhere"), join(work, JOB, "link"));
  writeFileSync(join(dir, "elsewhere"), "x");
  check("no such file, no such number, another's", (await send("GET", `/v1/given?job=${JOB}&n=9`)).status === 400 && (await send("GET", `/v1/given?job=${JOB}&n=..`)).status === 400 && (await send("GET", `/v1/given?job=../x&n=1`)).status === 400 && (await post("give", { job: JOB, path: "nope", n: 2 })).status === 400);
}

console.log("\nover");
{
  await post("run", { job: JOB, cmd: "sleep 60", background: true });
  check("at rest: nothing of it left running, its files kept", (await post("rest", { job: JOB })).body.rests === true && (await new Promise((r) => setTimeout(r, 700)), ((await post("process", { job: JOB, op: "list" })).body.processes as { running: boolean }[]).every((p) => !p.running)) && (await send("GET", `/v1/given?job=${JOB}&n=1`)).status === 200 && (await post("rest", { job: "jnever00001" })).body.rests === false);
  const kept = JSON.parse(readFileSync(join(work, ".jobs.json"), "utf8"));
  check("each job's user is its own", kept[JOB].uid !== kept.jother00001.uid && kept[JOB].uid >= 20_000, kept);
  check("ended: its files and what it was given are gone", (await post("end", { job: JOB })).body.ended === true && (await send("GET", `/v1/given?job=${JOB}&n=1`)).status === 400 && ((await post("file", { job: JOB, op: "list" })).body.files as unknown[]).length === 0);
  check("…once", (await post("end", { job: "jnever00001" })).body.ended === false);
  clock += 15 * 86_400_000;
  await w.tidy();
  check("one nobody asked about for two weeks is over", Object.keys(JSON.parse(readFileSync(join(work, ".jobs.json"), "utf8"))).length === 0);
}

runner.close();
front.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
