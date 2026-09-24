import { allows, requiredScope, saneGrants, WILDCARD, type Grant } from "../src/worker/lib/scopes.ts";
import {
  create,
  list,
  looksLikeToken,
  lookup,
  mintToken,
  remove,
  touch,
  update,
  TOKEN_PREFIX,
} from "../src/worker/lib/devices.ts";
import { originAllowed, corsHeaders } from "../src/worker/lib/cors.ts";
import { Collector } from "../src/worker/lib/collector.ts";
import { authorize } from "../src/worker/lib/auth.ts";
import { normalise } from "../src/app/key.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 220) : "");
  }
}

/** A KV double that honours the option shapes devices.ts actually passes. */
function fakeEnv(secret = "NOTAREALKEY12345") {
  const kv = new Map<string, string>();
  return {
    JARVIS_SHARED_SECRET: secret,
    CONFIG: {
      get: async (k: string, t?: unknown) => {
        const v = kv.get(k);
        if (v === undefined) return null;
        const wantsJson =
          t === "json" || (typeof t === "object" && t !== null && (t as any).type === "json");
        return wantsJson ? JSON.parse(v) : v;
      },
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    _kv: kv,
  } as never;
}

const req = (headers: Record<string, string> = {}) =>
  new Request("https://jarvis.test/api/health", { headers });

console.log("token format — the decision everything else rests on");
{
  const t = mintToken();
  check("has the version prefix", t.startsWith(TOKEN_PREFIX), t);
  check("matches the declared shape", looksLikeToken(t), t);
  check("is 160 bits of body", t.length === TOKEN_PREFIX.length + 32, t.length);

  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(mintToken());
  check("2000 mints are all distinct", seen.size === 2000, seen.size);

  // The whole reason for the prefix: the client normaliser must leave it alone.
  // If this breaks, every device token silently collapses to "JDV1" and nothing
  // authenticates — the exact failure the format was chosen to avoid.
  let mangled = 0;
  for (const t2 of seen) if (normalise(t2) !== t2) mangled++;
  check("client normalise() passes device tokens through untouched", mangled === 0, mangled);

  check("rejects a mangled token", !looksLikeToken("JDV1_ABC"), true);
  check("rejects the owner's key shape", !looksLikeToken("NOTAREALKEY12345"));
  check("rejects empty", !looksLikeToken(""));
}

console.log("\nowner regression — the car must not notice any of this");
{
  const env = fakeEnv("NOTAREALKEY12345");
  for (const typed of [
    "NOTAREALKEY12345",
    "notarealkey12345",
    "NOTA-REAL-KEY1-2345",
    "  nota real key1 2345  ",
  ]) {
    const r = await authorize(req({ "x-jarvis-key": typed }), env);
    check(`owner key still accepted: "${typed}"`, r.ok === true && r.principal.kind === "owner", r);
  }
  const bad = await authorize(req({ "x-jarvis-key": "WRONGKEY" }), env);
  check("a wrong key is still 401", bad.ok === false && bad.response.status === 401);

  const none = await authorize(req(), env);
  check("no credential is 401", none.ok === false && none.response.status === 401);

  const unset = await authorize(req({ "x-jarvis-key": "ANY" }), fakeEnv(""));
  check("unset secret still fails closed with 503", unset.ok === false && unset.response.status === 503);
}

console.log("\ndevice tokens end to end");
{
  const env = fakeEnv();
  const { device, token } = await create(env, "garage esp32", ["*"]);
  check("create returns a usable token", looksLikeToken(token));
  check("the raw token is never stored", ![...(env as any)._kv.values()].some((v: string) => v.includes(token)), token);
  check("the hint is safe to show", device.hint.includes("…") && !device.hint.includes(token.slice(10, 20)));

  const found = await lookup(env, token);
  check("lookup finds it", found.ok === true && found.ok && found.device.id === device.id);

  const viaAuth = await authorize(req({ authorization: `Bearer ${token}` }), env);
  check("authenticates as a device via Bearer", viaAuth.ok === true && viaAuth.principal.kind === "device");

  const viaHeader = await authorize(req({ "x-jarvis-key": token }), env);
  check("authenticates via X-Jarvis-Key too", viaHeader.ok === true && viaHeader.principal.kind === "device");

  const other = await lookup(env, mintToken());
  check("a different token does not match", other.ok === false);

  const listed = await list(env);
  check("listing never leaks a digest", !JSON.stringify(listed).includes("digest"), listed);

  await update(env, device.id, { revoked: true });
  const afterRevoke = await lookup(env, token);
  check("revocation kills the token", afterRevoke.ok === false, afterRevoke);
  const stillListed = await list(env);
  check("a revoked device is still visible to the owner", stillListed.some((d) => d.id === device.id && d.revokedAt));

  const b = await create(env, "scope probe", ["ask"]);
  await remove(env, b.device.id);
  check("delete removes it entirely", (await lookup(env, b.token)).ok === false);
  check("and drops it from the list", !(await list(env)).some((d) => d.id === b.device.id));

  const expired = await create(env, "stale", ["ask"], Date.now() - 1000);
  check("an expired token is refused", (await lookup(env, expired.token)).ok === false);
}

console.log("\nscopes");
{
  check("wildcard covers everything", allows(["*"], "car.control"));
  check("a named grant covers itself", allows(["ask", "car.read"], "car.read"));
  check("a named grant does not cover others", !allows(["ask"], "car.control"));
  check("an empty grant covers nothing", !allows([], "ask"));
  check("unknown grants are dropped", saneGrants(["ask", "nonsense", 42]).length === 1);
  check("non-array grants are dropped", saneGrants("ask" as unknown).length === 0);
  check("duplicates collapse", saneGrants(["ask", "ask"]).length === 1);
}

console.log("\nroute requirements — fail closed is the whole point");
{
  check("unknown route defaults to owner", requiredScope("/api/something-new", "GET") === "owner");
  check("health is reachable by anything authenticated", requiredScope("/api/health", "GET") === "any");
  check("delegate needs ask", requiredScope("/api/delegate", "POST") === "ask");
  check("v1 ask needs ask", requiredScope("/api/v1/ask", "POST") === "ask");
  check("the glasses route needs ask", requiredScope("/api/v1/chat/completions", "POST") === "ask");

  // The router matches these by PREFIX before its exact switch, so a table of
  // exact paths would let /api/mcpanything through to the broadest handler.
  check("mcp is owner-only", requiredScope("/api/mcp", "GET") === "owner");
  check("/api/mcp/call is owner-only", requiredScope("/api/mcp/call", "POST") === "owner");
  check("the prefix gap is closed", requiredScope("/api/mcpanything", "POST") === "owner");
  check("spotify is owner-only", requiredScope("/api/spotify/status", "GET") === "owner");
  check("device management is owner-only", requiredScope("/api/v1/devices", "POST") === "owner");

  check("memory read is readable", requiredScope("/api/memory", "GET") === "memory.read");
  check("memory write is owner-only", requiredScope("/api/memory", "PUT") === "owner");
  check("memory search needs memory.read", requiredScope("/api/memory/search", "POST") === "memory.read");
  check("camera needs home", requiredScope("/api/camera", "GET") === "home");
  check("map needs screen", requiredScope("/api/map", "GET") === "screen");
  check("session needs voice", requiredScope("/api/session", "POST") === "voice");
  check("diag is owner-only", requiredScope("/api/diag", "GET") === "owner");
}

console.log("\ncollector — what a device gets back instead of a stream");
{
  const c = new Collector();
  c.send({ type: "tool", name: "car_state", phase: "start" });
  c.send({ type: "used", tools: ["car_state"] });
  c.send({ type: "result", text: "Seventy-one percent." });
  const r = c.finish();
  check("captures the answer", r.ok === true && r.text === "Seventy-one percent.", r);
  check("captures which tools ran", r.tools.join() === "car_state", r.tools);
  check("closes after a terminal event", c.isClosed === true);

  // isClosed going true is what stops the waiting ladder queueing progress notes
  // after an answer has already landed.
  c.send({ type: "result", text: "later, ignored" });
  check("ignores anything after the terminal event", c.finish().text === "Seventy-one percent.");

  const e = new Collector();
  e.send({ type: "error", text: "I got stuck working that one out." });
  const er = e.finish();
  check("an error is not ok", er.ok === false && er.error === "failed", er);
  check("an error still carries something speakable", er.text.length > 0);

  const ab = new Collector();
  ab.send({ type: "error", text: "cut off", aborted: true });
  check("an aborted error is labelled as such", ab.finish().error === "aborted");

  // The one path through run() that returns having sent nothing.
  const silent = new Collector();
  const sr = silent.finish();
  check("silence becomes a speakable failure", sr.ok === false && sr.error === "aborted" && sr.text.length > 0, sr);

  const flood = new Collector();
  for (let i = 0; i < 5000; i++) flood.send({ type: "progress", text: `n${i}` });
  check("a runaway loop cannot balloon memory", flood.finish().ok === false);
}

console.log("\nCORS");
{
  const list = "https://glasses.example, https://jarvis.example.com";
  check("an allowed origin matches exactly", originAllowed("https://glasses.example", list));
  check("a missing origin is not allowed", !originAllowed(null, list));
  check("no allowlist means nothing is allowed", !originAllowed("https://glasses.example", undefined));
  // Suffix matching is exactly how evil.com gets itself allowed.
  check("a suffix impostor is rejected", !originAllowed("https://jarvis.example.com.evil.net", list));
  check("a prefix impostor is rejected", !originAllowed("https://evil.net/https://glasses.example", list));

  const h = corsHeaders("https://glasses.example", list);
  check("echoes the matched origin", h["access-control-allow-origin"] === "https://glasses.example");
  check("never emits a wildcard", h["access-control-allow-origin"] !== "*");
  check("varies on Origin so caches cannot cross-contaminate", h["vary"] === "Origin");
  check("exposes Retry-After so a 429 is readable", (h["access-control-expose-headers"] ?? "").includes("retry-after"));
  check("never allows credentials", !("access-control-allow-credentials" in h));
  check("a disallowed origin gets no headers at all", Object.keys(corsHeaders("https://evil.net", list)).length === 0);
}

console.log("\ntouch() cannot undo what the owner just did");
{
  /*
   * touch() used to read the whole index and write it and the token record
   * back. Racing the owner, that dropped a just-minted device from the list
   * and wrote a just-revoked token back as live. Simulated here by handing
   * touch() the device as it looked BEFORE the owner acted.
   */
  const env = fakeEnv();
  const kv = (env as unknown as { _kv: Map<string, string> })._kv;
  const esp = await create(env, "esp32", ["*"]);
  const staleView = (await lookup(env, esp.token)) as { ok: true; device: Parameters<typeof touch>[1] };

  const indexBefore = kv.get("dev:index")!;
  const glasses = await create(env, "glasses", ["ask"]);   // minted meanwhile
  await update(env, esp.device.id, { revoked: true });      // and the esp32 revoked

  // touch()'s own read of the index lands just BEFORE those writes (or reads a
  // copy KV has not caught up on), so any index it reads is the old one.
  const cfg = (env as unknown as { CONFIG: { get: (k: string, t?: unknown) => Promise<unknown> } }).CONFIG;
  const realGet = cfg.get;
  cfg.get = async (k: string, t?: unknown) => (k === "dev:index" ? JSON.parse(indexBefore) : realGet(k, t));
  await touch(env, staleView.device);
  cfg.get = realGet;

  const names = (await list(env)).map((d) => d.name);
  check("a device minted meanwhile is still in the list", names.includes("glasses"), names);
  check("a revoked token stays revoked", !(await lookup(env, esp.token)).ok);
  check("the other token still works", (await lookup(env, glasses.token)).ok);

  const g = (await lookup(env, glasses.token)) as { ok: true; device: Parameters<typeof touch>[1] };
  await touch(env, g.device);
  check("last-seen is still recorded", typeof (await list(env)).find((d) => d.name === "glasses")!.lastSeenAt === "number");
  const writes = [...kv.keys()].filter((k) => k.startsWith("dev:seen:")).length;
  await touch(env, g.device);
  check("and at most hourly — a second touch writes nothing new",
    [...kv.keys()].filter((k) => k.startsWith("dev:seen:")).length === writes);

  await remove(env, glasses.device.id);
  check("removing a device removes its last-seen record", ![...kv.keys()].some((k) => k === `dev:seen:${glasses.device.id}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
