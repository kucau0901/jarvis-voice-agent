import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withRetry } from "../docker/proxy-retry.mjs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 260) : "");
  }
}

// The proxy of the wrangler the lockfile pins: what the Docker image patches.
const source = readFileSync("node_modules/wrangler/wrangler-dist/ProxyWorker.js", "utf8");
const patched = withRetry(source);

console.log("the patch fits the installed wrangler");
check("it changes the proxy", patched !== source);
let twice = "";
try {
  withRetry(patched);
} catch (e) {
  twice = String(e);
}
check("it refuses a proxy it does not recognise", twice.includes("wrangler's proxy has changed"), twice);

// The patched proxy itself, run in Node, with Jarvis behind it played by `behind`.
// workerd's Headers has getAll; Node's has the same thing under another name.
Object.assign(Headers.prototype, {
  getAll(this: Headers) {
    return this.getSetCookie();
  },
});
const file = join(mkdtempSync(join(tmpdir(), "proxy-retry-")), "ProxyWorker.mjs");
writeFileSync(file, patched);
const { ProxyWorker } = await import(pathToFileURL(file).href);

type Behind = (req: Request, n: number) => Promise<Response>;
const realFetch = globalThis.fetch;
const realNow = Date.now;
const lost = () => Promise.reject(new Error("Network connection lost."));

/** One request through the proxy: what came back, and what Jarvis was sent each time. */
async function through(method: string, behind: Behind, body?: string) {
  const got: string[] = [];
  const notes: string[] = [];
  let n = 0;
  globalThis.fetch = (async (_url: unknown, req: Request) => {
    got.push(`${req.method} ${await req.clone().text()}`);
    return behind(req, n++);
  }) as typeof fetch;
  const env = {
    PROXY_CONTROLLER_AUTH_SECRET: "controller",
    PROXY_CONTROLLER: { fetch: async (_u: string, init: { body: string }) => (notes.push(init.body), new Response(null)) },
  };
  const proxy = new ProxyWorker({ getWebSockets: () => [] }, env);
  const play = new Request("http://proxy.example/", { headers: { Authorization: "controller" } });
  Object.assign(play, { cf: { hostMetadata: { type: "play", proxyData: { userWorkerUrl: { protocol: "http:", hostname: "127.0.0.1", port: "9000" }, headers: {} } } } });
  proxy.fetch(play);
  let status = 0;
  let text = "";
  try {
    const res: Response = await proxy.fetch(new Request("http://jarvis.example/api/thing", { method, body }));
    status = res.status;
    text = await res.text();
  } catch (e) {
    text = String(e);
  }
  globalThis.fetch = realFetch;
  Date.now = realNow;
  return { status, text, got, notes };
}

console.log("\na request lost at once is sent again");
{
  const r = await through("POST", (_req, n) => (n === 0 ? lost() : Promise.resolve(new Response("done"))), '{"text":"hello"}');
  check("the answer comes back", r.status === 200 && r.text === "done", r);
  check("it was sent twice, with what was sent the first time", r.got.length === 2 && r.got[1] === 'POST {"text":"hello"}', r.got);
}
{
  const r = await through("DELETE", (_req, n) => (n === 0 ? lost() : Promise.resolve(new Response("gone"))));
  check("a request with nothing in it too", r.status === 200 && r.got.length === 2, r);
}

console.log("\nbut only once, and only that");
{
  const r = await through("POST", () => lost(), "{}");
  check("lost twice: it fails, after two tries", r.status === 0 && r.got.length === 2 && r.text.includes("connection lost"), r);
  check("and wrangler is told", r.notes.length === 1 && r.notes[0]!.includes("failed after 2 attempts"), r.notes);
}
{
  // A busy Jarvis closes the quiet connection seconds after the request was put on it: lost all the same, and not acted on.
  const r = await through("POST", (_req, n) => {
    if (n > 0) return Promise.resolve(new Response("done"));
    const sent = realNow();
    Date.now = () => sent + 20_000;
    return lost();
  }, "{}");
  check("noticed only seconds later: still sent again", r.status === 200 && r.got.length === 2, r);
}
{
  const r = await through("POST", () => Promise.reject(new Error("internal error")), "{}");
  check("another failure: not sent again", r.status === 0 && r.got.length === 1, r);
}
{
  const r = await through("POST", () => Promise.resolve(new Response("no", { status: 500 })), "{}");
  check("an answer that is an error is passed on, not tried again", r.status === 500 && r.got.length === 1, r);
}

console.log("\na read is tried as before");
{
  const r = await through("GET", (_req, n) => (n < 2 ? lost() : Promise.resolve(new Response("page"))));
  check("up to three times", r.status === 200 && r.got.length === 3, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
