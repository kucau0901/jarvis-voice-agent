import {
  DEFAULT_ROUTER_MODEL,
  EFFORTS,
  INTERACTIVE_EFFORT,
  builtinTools,
  effortFor,
  effortRefused,
  explicitCache,
  isRouterCandidate,
  orderCandidates,
  pick,
  readFallback,
  recordFallback,
  resolveRouterModel,
  saneModelId,
  shouldFallBack,
  storeRouterModel,
} from "../src/worker/lib/router-model.ts";
import { Collector } from "../src/worker/lib/collector.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

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

/** A KV double, as in memory.test.ts. `broken` makes every call throw. */
function fakeEnv(extra: Record<string, unknown> = {}, broken = false) {
  const kv = new Map<string, string>();
  const boom = async () => {
    throw new Error("KV unavailable");
  };
  return {
    CONFIG: broken
      ? { get: boom, put: boom, delete: boom }
      : {
          get: async (k: string) => {
            const v = kv.get(k);
            return v ? JSON.parse(v) : null;
          },
          put: async (k: string, v: string) => void kv.set(k, v),
          delete: async (k: string) => void kv.delete(k),
        },
    _kv: kv,
    ...extra,
  } as never;
}

console.log("saneModelId");
{
  check("accepts the new model", saneModelId("gpt-6-sol") === "gpt-6-sol");
  check("accepts the current default", saneModelId("gpt-5.6-terra") === "gpt-5.6-terra");
  check("accepts an o-series id", saneModelId("o4-mini") === "o4-mini");
  check("accepts a fine-tune id with colons", saneModelId("ft:gpt-4.1:acme:router:abc123") !== null);
  check("trims whitespace", saneModelId("  gpt-6-sol ") === "gpt-6-sol");
  check("rejects empty", saneModelId("") === null && saneModelId("   ") === null);
  check("rejects a space inside", saneModelId("gpt 6") === null);
  check("rejects markup", saneModelId("<b>gpt</b>") === null);
  check("rejects absurd length", saneModelId("g".repeat(81)) === null);
  check("rejects non-strings", saneModelId(6) === null && saneModelId(null) === null && saneModelId({}) === null);
}

console.log("\nprecedence: settings panel, then the secret, then the default");
{
  check("nothing set is the default",
    JSON.stringify(pick(null, undefined)) === JSON.stringify({ model: DEFAULT_ROUTER_MODEL, source: "default" }));
  check("the secret beats the default", pick(null, "gpt-5").model === "gpt-5" && pick(null, "gpt-5").source === "env");
  // The panel must win, or choosing a model on the phone would appear to work
  // and silently change nothing whenever the secret happened to be set.
  const both = pick({ model: "gpt-6-sol" }, "gpt-5");
  check("the panel beats the secret", both.model === "gpt-6-sol" && both.source === "ui", both);
  check("an empty secret is unset", pick(null, "").source === "default");
  check("a malformed stored value falls through to the secret",
    pick({ model: "not a model" }, "gpt-5").source === "env");
  check("a stored value of the wrong shape falls through", pick("gpt-6-sol", undefined).source === "default");
  check("the default is gpt-6-luna", DEFAULT_ROUTER_MODEL === "gpt-6-luna");
}

console.log("\nstorage");
{
  const env = fakeEnv();
  check("unset resolves to the default", (await resolveRouterModel(env)).source === "default");

  await recordFallback(env, { model: "old", fellBackTo: DEFAULT_ROUTER_MODEL, at: 1, message: "x" });
  check("a fallback can be recorded", (await readFallback(env))?.model === "old");

  await storeRouterModel(env, "gpt-6-sol");
  const r = await resolveRouterModel(env);
  check("a stored choice is used", r.model === "gpt-6-sol" && r.source === "ui", r);
  check("a new choice clears the old fallback record", (await readFallback(env)) === null);

  await storeRouterModel(env, null);
  check("clearing returns to the default", (await resolveRouterModel(env)).source === "default");

  const withSecret = fakeEnv({ ROUTER_MODEL: "gpt-5" });
  await storeRouterModel(withSecret, "gpt-6-sol");
  await storeRouterModel(withSecret, null);
  check("clearing with a secret set returns to the secret",
    (await resolveRouterModel(withSecret)).model === "gpt-5");

  // A KV outage must cost the choice, never the question.
  let threw = false;
  let got;
  try {
    got = await resolveRouterModel(fakeEnv({ ROUTER_MODEL: "gpt-5" }, true));
  } catch {
    threw = true;
  }
  check("KV failing does not throw", !threw);
  check("KV failing still honours the secret", got?.model === "gpt-5", got);
  check("KV failing reads no fallback record", (await readFallback(fakeEnv({}, true))) === null);
}

console.log("\nshouldFallBack — only when retrying cannot repeat a side effect");
{
  const e400 = { status: 400, message: "The model `gpt-6-sol` does not exist" };
  const e404 = { status: 404 };
  check("400 on the first hop falls back", shouldFallBack(e400, "gpt-6-sol", 0, false));
  check("404 on the first hop falls back", shouldFallBack(e404, "gpt-6-sol", 0, false));
  // By hop 1 a tool may have run. Retrying there could unlock the car twice.
  check("never after the first hop", !shouldFallBack(e400, "gpt-6-sol", 1, false));
  check("never once aborted", !shouldFallBack(e400, "gpt-6-sol", 0, true));
  check("never from the default to itself", !shouldFallBack(e400, DEFAULT_ROUTER_MODEL, 0, false));
  check("not on 401 — the key is the same for every model", !shouldFallBack({ status: 401 }, "gpt-6-sol", 0, false));
  check("not on 429 — nor is the quota", !shouldFallBack({ status: 429 }, "gpt-6-sol", 0, false));
  check("not on 500 — that is weather", !shouldFallBack({ status: 500 }, "gpt-6-sol", 0, false));
  check("not on a network error with no status", !shouldFallBack(new Error("fetch failed"), "gpt-6-sol", 0, false));
  check("not on a thrown non-object", !shouldFallBack("boom", "gpt-6-sol", 0, false) && !shouldFallBack(null, "x", 0, false));
}

console.log("\nwhich models are offered");
{
  // The filter this replaced, /^gpt-5|terra|^gpt-4\.1/, could not see gpt-6 at all.
  check("gpt-6-sol is offered", isRouterCandidate("gpt-6-sol"));
  check("the current default is offered", isRouterCandidate("gpt-5.6-terra"));
  check("gpt-4.1 is offered", isRouterCandidate("gpt-4.1"));
  check("o-series is offered", isRouterCandidate("o4-mini"));
  for (const id of [
    "gpt-4o-realtime-preview", "gpt-4o-mini-tts", "gpt-4o-transcribe", "gpt-4o-audio-preview",
    "gpt-image-1", "gpt-4o-search-preview", "gpt-3.5-turbo-instruct", "gpt-5-codex",
    "o3-deep-research", "text-embedding-3-large", "whisper-1", "dall-e-3", "gpt-live-1",
    "omni-moderation-latest",
  ]) {
    check(`${id} is not offered`, !isRouterCandidate(id));
  }
  check("dated snapshots are hidden", !isRouterCandidate("gpt-5-2025-08-07"));
  // Segments, not substrings: "live" must not catch a name that merely contains it.
  check("a name containing 'live' as a substring is kept", isRouterCandidate("gpt-6-deliver"));

  const ordered = orderCandidates([
    "o3", "gpt-4.1", "gpt-6-sol", "gpt-5.6-terra", "gpt-5", "gpt-4o-mini-tts", "gpt-6-sol", "o4-mini",
  ]);
  check("newest family first, o-series last, duplicates and non-routers gone",
    JSON.stringify(ordered) === JSON.stringify(["gpt-6-sol", "gpt-5.6-terra", "gpt-5", "gpt-4.1", "o4-mini", "o3"]),
    ordered);
}

console.log("\nthe probe and the router offer the same built-in tools");
{
  check("web search by default", JSON.stringify(builtinTools(fakeEnv())) === '[{"type":"web_search"}]');
  check("none when disabled", builtinTools(fakeEnv({ DISABLE_WEB_SEARCH: "1" })).length === 0);
}

console.log("\nthe answering model reaches the device API");
{
  const ok = new Collector();
  ok.send({ type: "result", text: "Seventy-one percent.", model: "gpt-6-sol" });
  check("a result carries its model", ok.finish().model === "gpt-6-sol");

  const bad = new Collector();
  bad.send({ type: "error", text: "No.", model: DEFAULT_ROUTER_MODEL });
  check("so does an error — that is when it matters most", bad.finish().model === DEFAULT_ROUTER_MODEL);

  const none = new Collector();
  none.send({ type: "result", text: "x" });
  check("no model means no key, not an undefined one", !("model" in none.finish()));
}

console.log("\nonly the owner chooses the model");
{
  for (const m of ["GET", "PUT", "DELETE"]) {
    check(`/api/router ${m} is owner-only`, requiredScope("/api/router", m) === "owner");
  }
  check("/api/router/test is owner-only", requiredScope("/api/router/test", "POST") === "owner");
}

console.log("\nexplicit prompt caching only where the model takes it");
{
  for (const m of ["gpt-6-luna", "gpt-6-sol", "gpt-5.6", "gpt-5.6-mini", "gpt-5.12", "gpt-7", "gpt-10"]) {
    check(`${m} takes cache breakpoints`, explicitCache(m));
  }
  for (const m of ["gpt-5.5", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o3", "gpt-5.5-pro", "chatgpt-6"]) {
    check(`${m} does not`, !explicitCache(m));
  }
}

console.log("\nhow long to think");
{
  check("auto is the tested default for someone waiting", effortFor("voice", "auto") === INTERACTIVE_EFFORT && effortFor(undefined, undefined) === INTERACTIVE_EFFORT);
  check("a chosen effort applies to the car, glasses and typing",
    effortFor("voice", "low") === "low" && effortFor("glasses", "minimal") === "minimal" && effortFor("chat", "none") === "none" && effortFor(undefined, "high") === "high");
  check("case and spaces do not matter", effortFor("voice", " LOW ") === "low");
  check("jobs and routines keep the model's own default", effortFor("job", "low") === null && effortFor("routine", "none") === null);
  check("nonsense is auto", effortFor("voice", "turbo") === INTERACTIVE_EFFORT);
  check("every choice is offered in settings", EFFORTS.join() === "auto,none,minimal,low,medium,high");
  const e400 = (m: string) => Object.assign(new Error(m), { status: 400 });
  check("a 400 about reasoning is the effort refused", effortRefused(e400("Unsupported value: 'reasoning.effort' does not support 'none'")));
  check("any other 400 is not", !effortRefused(e400("model not found")));
  check("nor a 429 that mentions it", !effortRefused(Object.assign(new Error("reasoning rate"), { status: 429 })));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
