import { StateHost, THREAD_IDLE_MS, THREAD_MAX_TURNS } from "../src/worker/lib/state-host.ts";
import { MemoryStore, type Fact } from "../src/worker/lib/memory.ts";
import { check as limitCheck } from "../src/worker/lib/limits.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 240) : "");
  }
}

/** Durable Object storage, as a Map. Values are cloned, as the real one does. */
function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    _m: m,
  };
}

/** KV as it holds memory today. `down` makes every read throw. */
function fakeKv(init: Record<string, unknown> = {}) {
  const kv = new Map<string, string>(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  const state = { down: false, reads: 0 };
  return {
    CONFIG: {
      get: async (k: string) => {
        state.reads++;
        if (state.down) throw new Error("KV unavailable");
        const v = kv.get(k);
        return v ? JSON.parse(v) : null;
      },
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    _kv: kv,
    _state: state,
  };
}

const fact = (id: string, text: string, kind: Fact["kind"] = "note"): Fact => ({
  id, text, kind, keys: [], createdAt: 1, updatedAt: 1, useCount: 0, source: "voice",
});

/**
 * A Durable Object delivers one call at a time while the call is only waiting
 * on its own storage — Cloudflare's input gate. A Map-backed fake yields on
 * every await, so without this it would let calls interleave in a way the real
 * object never does, and the concurrency tests would be testing the fake.
 */
function oneAtATime<T extends object>(host: T): T {
  let tail: Promise<unknown> = Promise.resolve();
  return new Proxy(host, {
    get(target, key) {
      const v = (target as Record<PropertyKey, unknown>)[key];
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const run = tail.then(() => (v as (...a: unknown[]) => unknown).apply(target, args));
        tail = run.catch(() => {});
        return run;
      };
    },
  });
}

/** An env whose STATE namespace always reaches the same host, as idFromName("jarvis") does. */
function withObject(kv: ReturnType<typeof fakeKv>) {
  const storage = fakeStorage();
  const host = new StateHost(storage, kv as never);
  const object = oneAtATime(host);
  const env = { ...kv, STATE: { idFromName: () => "jarvis", get: () => object } } as never;
  return { env, host, storage };
}

const LIVE_HOT = { rev: 41, facts: [fact("m_home", "Home is in Taman Melati", "place"), fact("m_wife", "Sam is my wife", "person")], trash: [] };
const LIVE_REF = { rev: 3, facts: [fact("m_priya", "Priya — ext 1101", "reference")] };

console.log("migration out of KV");
{
  const kv = fakeKv({ "mem:v1": LIVE_HOT, "mem:ref:v1": LIVE_REF });
  const { host } = withObject(kv);
  const hot = await host.loadMemory();
  const ref = await host.loadReference();
  check("every hot fact arrives", JSON.stringify(hot.facts.map((f) => f.id)) === '["m_home","m_wife"]', hot.facts);
  check("its text arrives untouched", hot.facts[0]!.text === "Home is in Taman Melati");
  check("the revision carries over", hot.rev === 41);
  check("the reference store arrives", ref.facts.length === 1 && ref.facts[0]!.text === "Priya — ext 1101");
  check("KV is left alone as a backup", kv._kv.get("mem:v1") === JSON.stringify(LIVE_HOT));

  // Once migrated, a later change in KV must not be pulled in again.
  kv._kv.set("mem:v1", JSON.stringify({ rev: 99, facts: [], trash: [] }));
  const again = new StateHost((host as unknown as { storage: never }).storage, kv as never);
  check("migration happens once, never over newer data", (await again.loadMemory()).facts.length === 2);
}

console.log("\nKV unreadable during migration");
{
  const kv = fakeKv({ "mem:v1": LIVE_HOT, "mem:ref:v1": LIVE_REF });
  const { host, storage } = withObject(kv);
  kv._state.down = true;
  let threw = false;
  try {
    await host.loadMemory();
  } catch {
    threw = true;
  }
  // Starting empty would make the object authoritative with nothing in it.
  check("it refuses to start empty", threw);
  check("and wrote nothing", !storage._m.has("mem") && !storage._m.has("migrated:v1"));

  kv._state.down = false;
  check("the next request retries and succeeds", (await host.loadMemory()).facts.length === 2);
}

console.log("\nmemory through the object");
{
  const kv = fakeKv({ "mem:v1": LIVE_HOT, "mem:ref:v1": LIVE_REF });
  const { env } = withObject(kv);

  const a = new MemoryStore(env);
  await a.load();
  check("a store loads through the object", a.facts.length === 2);
  a.add({ text: "Parking is in bay 7", kind: "note" });
  a.add({ text: "Ravi — ext 1101", kind: "reference" });
  await a.save();

  const b = new MemoryStore(env);
  await b.load();
  const all = (await b.allFacts()).map((f) => f.text);
  check("a save is visible to the next session", all.includes("Parking is in bay 7") && all.includes("Ravi — ext 1101"), all);
  check("and nothing is written to KV any more", kv._kv.get("mem:v1") === JSON.stringify(LIVE_HOT));

  // The finding that started this, now with the object in the middle.
  const slow = new MemoryStore(env);
  await slow.load();
  await slow.search("Sam wife");
  slow.add({ text: "The gate code is kept by the guard", kind: "note" });

  const quick = new MemoryStore(env);
  await quick.load();
  quick.remove("m_home");
  quick.add({ text: "Sam is my wife, number 012-999 9999", kind: "person", slug: "sam", replaces: "m_wife" });
  await quick.save();
  await slow.save();

  const after = new MemoryStore(env);
  await after.load();
  const t = after.facts.map((f) => f.text);
  check("a fact forgotten meanwhile stays forgotten", !t.includes("Home is in Taman Melati"), t);
  check("a correction made meanwhile stands", t.includes("Sam is my wife, number 012-999 9999"), t);
  check("the slow session's own addition lands", t.includes("The gate code is kept by the guard"), t);

  // Genuinely concurrent: both saves in flight at once.
  const c1 = new MemoryStore(env); await c1.load();
  const c2 = new MemoryStore(env); await c2.load();
  c1.add({ text: "The pond pump runs at six", kind: "routine" });
  c2.add({ text: "Bin day is Thursday", kind: "routine" });
  await Promise.all([c1.save(), c2.save()]);
  const both = new MemoryStore(env); await both.load();
  const bt = both.facts.map((f) => f.text);
  check("two saves in flight at once both land", bt.includes("The pond pump runs at six") && bt.includes("Bin day is Thursday"), bt);

  // The owner's PUT is still a wholesale replacement.
  const owner = new MemoryStore(env);
  await owner.load();
  await owner.replaceAll(owner.facts.filter((f) => !/Bin day/.test(f.text)));
  await owner.save();
  const r = new MemoryStore(env); await r.load();
  check("replaceAll still removes what it leaves out", !r.facts.some((f) => /Bin day/.test(f.text)));
  check("and leaves the rest", r.facts.some((f) => /pond pump/.test(f.text)));
}

console.log("\nthe daily device counter");
{
  const { host } = withObject(fakeKv());
  const today = "2026-09-23";
  const seen: boolean[] = [];
  for (let i = 0; i < 4; i++) seen.push((await host.consume("d_esp", 3, today)).ok);
  check("counts up to the cap, then refuses", JSON.stringify(seen) === "[true,true,true,false]", seen);
  check("a refused request is not counted", (await host.consume("d_esp", 3, today)).n === 3);
  check("devices are counted separately", (await host.consume("d_glasses", 3, today)).n === 1);
  check("a new day starts from zero", (await host.consume("d_esp", 3, "2026-09-24")).n === 1);
}

console.log("\nlimits.check uses the object and writes nothing to KV");
{
  const kv = fakeKv();
  const { env } = withObject(kv);
  const e = { ...(env as object), DEVICE_DAILY_LIMIT: "2" } as never;
  const v1 = await limitCheck(e, "d_esp");
  const v2 = await limitCheck(e, "d_esp");
  const v3 = await limitCheck(e, "d_esp");
  check("allowed, and marked counted so it is not charged twice", v1.ok && v1.counted === true);
  check("over the cap is the daily budget", v2.ok && !v3.ok && v3.reason === "daily_budget", v3);
  check("not a single KV write for counting", ![...kv._kv.keys()].some((k) => k.startsWith("dev:spend")));

  const broken = { ...(env as object), STATE: { idFromName: () => "x", get: () => ({ consume: async () => { throw new Error("down"); } }) } } as never;
  const v = await limitCheck(broken, "d_esp");
  check("a broken counter lets the request through rather than taking the API down", v.ok);
}

console.log("\nthe follow-up thread for one-message devices");
{
  const storage = fakeStorage();
  const host = oneAtATime(new StateHost(storage, {} as never));
  const t = 1_000_000;
  const ex = (q: string, a: string) => [
    { role: "user" as const, text: q },
    { role: "assistant" as const, text: a },
  ];

  check("a new device starts with nothing", (await host.loadThread("d_g2", t)).length === 0);

  await host.appendThread("d_g2", ex("turn on the study light", "Turned on the lights"), t);
  const one = await host.loadThread("d_g2", t + 1000);
  check("an exchange is there for the follow-up", one.length === 2 && one[0]!.text === "turn on the study light", one);

  for (let i = 0; i < 4; i++) await host.appendThread("d_g2", ex(`q${i}`, `a${i}`), t + 2000 + i);
  const capped = await host.loadThread("d_g2", t + 3000);
  check(`kept to the newest ${THREAD_MAX_TURNS} turns`, capped.length === THREAD_MAX_TURNS && capped.at(-1)!.text === "a3", capped);

  check("gone once idle too long", (await host.loadThread("d_g2", t + 2003 + THREAD_IDLE_MS + 1)).length === 0);

  const fresh = await host.appendThread("d_g2", ex("hello again", "Hi"), t + 2003 + THREAD_IDLE_MS + 1);
  check("an idle thread is replaced, not extended", fresh.length === 2 && fresh[0]!.text === "hello again", fresh);

  check("devices do not share a thread", (await host.loadThread("d_other", t + 3000)).length === 0);
  check("one record per device, overwritten in place",
    [...storage._m.keys()].filter((k) => k.startsWith("thread:")).length === 1);

  // Two answers landing at once must not drop each other's turns.
  const both = await Promise.all([
    host.appendThread("d_race", ex("a", "1"), t),
    host.appendThread("d_race", ex("b", "2"), t),
  ]);
  check("concurrent appends keep both exchanges", (await host.loadThread("d_race", t)).length === 4, both);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
