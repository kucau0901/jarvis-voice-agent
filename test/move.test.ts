// Moving a whole Jarvis to another place (lib/move.ts): what the old one gives
// out and to whom, and how the new one takes it in.
import { asMovePage, deployed, Move, MOVE_KEY_MIN, moveCheck, moveKeyOk, movePage, moveStep, type KvEntry, type MoveInDeps, type MoveKv, type MovePage } from "../src/worker/lib/move.ts";
import { applyChanges, guarded, type SavedSettings } from "../src/worker/lib/settings.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

/** The state object's storage: ordered by key, as the real one lists. */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    list: async ({ startAfter, limit }: { startAfter?: string; limit?: number }) =>
      new Map([...m].sort(([a], [b]) => (a < b ? -1 : 1)).filter(([k]) => startAfter === undefined || k > startAfter).slice(0, limit ?? Infinity)),
    get: async (keys: string[]) => new Map(keys.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))])),
    put: async (entries: Record<string, unknown>) => void Object.entries(entries).forEach(([k, v]) => m.set(k, structuredClone(v))),
    deleteAll: async () => m.clear(),
    _m: m,
  };
}

/** KV, listing `per` keys at a time. */
function fakeKv(seed: KvEntry[] = [], per = 1000): MoveKv & { _m: Map<string, KvEntry>; gone: Set<string> } {
  const m = new Map(seed.map((e) => [e.key, e]));
  const gone = new Set<string>();
  return {
    list: async ({ cursor, limit }) => {
      const names = [...m.keys()].sort();
      const from = cursor ? Number(cursor) : 0;
      const to = from + Math.min(limit ?? per, per);
      return {
        keys: names.slice(from, to).map((name) => ({ name, ...(m.get(name)!.expiration ? { expiration: m.get(name)!.expiration } : {}), ...(m.get(name)!.metadata !== undefined ? { metadata: m.get(name)!.metadata } : {}) })),
        list_complete: to >= names.length,
        ...(to < names.length ? { cursor: String(to) } : {}),
      };
    },
    get: async (key) => (gone.has(key) ? null : (m.get(key)?.value ?? null)),
    put: async (key, value, options) => void m.set(key, { key, value, ...options }),
    delete: async (key) => void m.delete(key),
    _m: m,
    gone,
  };
}

const KEY = "MOVEKEY-0123456789-ABCDEFGH";
const NOW = 1_790_000_000_000;

console.log("who is given a page");
{
  check("the move key", await moveKeyOk({ MOVE_KEY: KEY }, KEY));
  check("not another", !(await moveKeyOk({ MOVE_KEY: KEY }, KEY + "x")));
  check("not nothing", !(await moveKeyOk({ MOVE_KEY: KEY }, null)) && !(await moveKeyOk({ MOVE_KEY: KEY }, "")));
  check("nobody, where no move key is set", !(await moveKeyOk({}, "")) && !(await moveKeyOk({}, "anything")));
  const short = "x".repeat(MOVE_KEY_MIN - 1);
  check("nor under a key too short to guard every secret", !(await moveKeyOk({ MOVE_KEY: short }, short)));
  check("taking a move in is the owner's alone", requiredScope("/api/move/import", "POST") === "owner");
}

console.log("the state object's entries, a page at a time");
{
  const seed: Record<string, unknown> = {};
  for (let i = 0; i < 150; i++) seed[`k${String(i).padStart(3, "0")}`] = { n: i, tags: ["a", null], nested: { ok: true } };
  const move = new Move(fakeStorage(seed));
  const seen: [string, unknown][] = [];
  let pages = 0;
  for (let after: string | undefined; ; ) {
    const p = await move.page(after);
    seen.push(...p.entries);
    pages++;
    if (p.next === null) break;
    after = p.next;
  }
  check("every entry once, in order", seen.length === 150 && seen.every(([k], i) => k === `k${String(i).padStart(3, "0")}`), seen.length);
  check("over more than one page", pages === 3, pages);
  check("as they were", JSON.stringify(seen[7]![1]) === JSON.stringify(seed.k007));

  const big = new Move(fakeStorage({ a: "x".repeat(600_000), b: "y".repeat(600_000), c: "z" }));
  const first = await big.page();
  check("a page stops once it is large", first.entries.length === 2 && first.next === "b", first.entries.length);
  const rest = await big.page(first.next!);
  check("and the next goes on from there", rest.entries.length === 1 && rest.entries[0]![0] === "c" && rest.next === null);

  check("nothing kept: one empty page", JSON.stringify(await new Move(fakeStorage()).page()) === JSON.stringify({ entries: [], next: null }));
  check("which holds nothing", !(await new Move(fakeStorage()).holdsAnything()) && (await move.holdsAnything()));

  for (const [name, bad] of [["a date", new Date(NOW)], ["a map", new Map([["a", 1]])], ["bytes", new Uint8Array(3)], ["not a number", { n: NaN }]] as const) {
    let said = "";
    try {
      await new Move(fakeStorage({ fine: 1, odd: bad })).page();
    } catch (e) {
      said = e instanceof Error ? e.message : String(e);
    }
    check(`${name} stops the move, named, where JSON would have changed it`, /"odd"/.test(said), said);
  }
  check("an undefined property is what JSON leaves out anyway", (await new Move(fakeStorage({ a: { x: undefined, y: 1 } })).page()).entries.length === 1);
}

console.log("a page out: the state first, then the settings store");
{
  const storage = fakeStorage({ mem: { facts: ["likes tea"] }, "settings:v1": { HA_TOKEN: { v: "secret-token" } } });
  const kv = fakeKv(
    [
      { key: "dev:tok:abc", value: '{"id":"d1"}' },
      { key: "google:refresh:ann", value: "refresh-token" },
      { key: "mcp:catalog:x", value: "[]", expiration: NOW / 1000 + 3600, metadata: { at: 5 } },
      { key: "oauth:state:y", value: "s" },
    ],
    3,
  );
  const deps = { version: "9.9.9", statePage: (after?: string) => new Move(storage).page(after), kv, deployed: async () => ({ HA_TOKEN: "from-the-deployment" }) };
  const one = await movePage(deps, null);
  check("the state's entries, secrets among them", one.state.length === 2 && one.kv.length === 0 && JSON.stringify(one.state).includes("secret-token"), one);
  check("then on to the store", one.next === "k:" && one.version === "9.9.9", one.next);
  kv.gone.add("oauth:state:y");
  const two = await movePage(deps, one.next);
  check("its first keys, with when they run out and what is noted on them", two.kv.length === 3 && two.kv[2]!.expiration === NOW / 1000 + 3600 && JSON.stringify(two.kv[2]!.metadata) === '{"at":5}', two.kv);
  check("and a place to go on from", two.next === "k:3", two.next);
  check("no page before the last carries the deployment's settings", one.settings === undefined && two.settings === undefined);
  const three = await movePage(deps, two.next);
  check("one that ran out since it was listed is left behind, and that is the end", three.kv.length === 0 && three.next === null, three);
  check("the last page carries them", three.settings?.HA_TOKEN === "from-the-deployment", three.settings);
  let said = "";
  try {
    await movePage(deps, "elsewhere");
  } catch (e) {
    said = e instanceof Error ? e.message : String(e);
  }
  check("a place that is no place in a move is refused", /not a place/.test(said), said);
}

console.log("a move in, a step at a time");
{
  // The old Jarvis, behind its export.
  const oldSeed: Record<string, unknown> = {};
  for (let i = 0; i < 70; i++) oldSeed[`e${String(i).padStart(2, "0")}`] = { i };
  const oldStorage = fakeStorage(oldSeed);
  const oldKv = fakeKv([
    { key: "dev:tok:abc", value: "device" },
    { key: "soon", value: "nearly gone", expiration: NOW / 1000 + 30 },
    { key: "later", value: "kept a while", expiration: NOW / 1000 + 3600, metadata: { at: 1 } },
  ]);
  const asked: (string | null)[] = [];
  const page = async (after: string | null): Promise<MovePage> => {
    asked.push(after);
    return movePage({ version: "2.9.0", statePage: (a) => new Move(oldStorage).page(a), kv: oldKv, deployed: async () => ({ TESSIE_TOKEN: "car-token" }) }, after);
  };
  const run = async (deps: MoveInDeps, replace: boolean) => {
    const steps = [];
    for (let after: string | null = null; ; ) {
      const s = await moveStep(deps, after, replace);
      steps.push(s);
      if (typeof s === "string" || s.next === null) return steps;
      after = s.next;
    }
  };
  const fresh = (storage = fakeStorage(), kv = fakeKv()) => {
    const move = new Move(storage);
    const settled: number[] = [];
    const kept: string[] = [];
    const deps: MoveInDeps = {
      page,
      holdsAnything: () => move.holdsAnything(),
      clear: () => move.clear(),
      put: (e) => move.put(e),
      keep: async (s) => void kept.push(`${JSON.stringify(s)} with ${storage._m.size} in, ${settled.length} settled`),
      settle: async () => void settled.push(storage._m.size),
      kv,
      now: NOW,
    };
    return { storage, kv, deps, settled, kept };
  };

  const a = fresh();
  const steps = await run(a.deps, false);
  check("into an empty Jarvis: every step a page", steps.every((s) => typeof s !== "string") && steps.length === 3, steps);
  check("everything the old one kept is here", a.storage._m.size === 70 && JSON.stringify(a.storage._m.get("e42")) === '{"i":42}', a.storage._m.size);
  check("and its store, but for what was about to run out", a.kv._m.size === 2 && !a.kv._m.has("soon") && a.kv._m.get("dev:tok:abc")!.value === "device", [...a.kv._m.keys()]);
  check("expiry and what was noted come too", a.kv._m.get("later")!.expiration === NOW / 1000 + 3600 && JSON.stringify(a.kv._m.get("later")!.metadata) === '{"at":1}', a.kv._m.get("later"));
  check("settled once, at the end, with everything in", a.settled.length === 1 && a.settled[0] === 70, a.settled);
  check("the deployment's settings kept once, after every entry and before settling", a.kept.length === 1 && a.kept[0] === '{"TESSIE_TOKEN":"car-token"} with 70 in, 0 settled', a.kept);
  const last = steps[steps.length - 1];
  check("each step says what it took and from which version", typeof last !== "string" && last!.kv === 2 && last!.version === "2.9.0" && last!.next === null, last);

  const b = fresh(fakeStorage({ mine: "kept" }), fakeKv([{ key: "mine", value: "kept" }]));
  const refused = await moveStep(b.deps, null, false);
  check("a Jarvis that holds something refuses", typeof refused === "string" && /already holds data/.test(refused), refused);
  check("and keeps it", b.storage._m.get("mine") === "kept" && b.kv._m.has("mine") && b.settled.length === 0);
  await run(b.deps, true);
  check("told to replace, it is emptied first: nothing of before is left", !b.storage._m.has("mine") && !b.kv._m.has("mine") && b.storage._m.size === 70 && b.kv._m.size === 2, [...b.kv._m.keys()]);

  const c = fresh(fakeStorage({ mine: "kept" }));
  c.deps.page = async () => {
    throw new Error("the other Jarvis has no move open under that key");
  };
  let said = "";
  try {
    await moveStep(c.deps, null, true);
  } catch (e) {
    said = e instanceof Error ? e.message : String(e);
  }
  check("a wrong key or address fails before anything here is erased", /no move open/.test(said) && c.storage._m.get("mine") === "kept", said);
}

console.log("checking a move, nothing written");
{
  const oldStorage = fakeStorage({ a: { n: 1 }, b: ["x"], c: "since changed there", d: "never arrived" });
  const oldKv = fakeKv([
    { key: "dev:tok:abc", value: "device" },
    { key: "gone", value: "not here" },
    { key: "soon", value: "nearly gone", expiration: NOW / 1000 + 30 },
  ]);
  const page = (after: string | null) => movePage({ version: "2.9.0", statePage: (x) => new Move(oldStorage).page(x), kv: oldKv, deployed: async () => ({ HA_TOKEN: "house-token", TESSIE_TOKEN: "car-token", TIMEZONE: "Asia/Kuala_Lumpur" }) }, after);
  const here = fakeStorage({ a: { n: 1 }, b: ["x"], c: "as it was when moved", extra: "only here" });
  const hereKv = fakeKv([{ key: "dev:tok:abc", value: "device" }]);
  const before = JSON.stringify([[...here._m], [...hereKv._m]]);
  const saved: SavedSettings = { HA_TOKEN: { v: "house-token", at: 0 }, TESSIE_TOKEN: { v: "another", at: 0 } };
  const deps = { page, read: (keys: string[]) => new Move(here).read(keys), saved: async () => saved, kv: hereKv, now: NOW };
  let same = 0;
  const missing: string[] = [];
  const differ: string[] = [];
  for (let after: string | null = null; ; ) {
    const s = await moveCheck(deps, after);
    same += s.same;
    missing.push(...s.missing);
    differ.push(...s.differ);
    if (s.next === null) break;
    after = s.next;
  }
  check("what is here as the old one has it is counted", same === 4, same);
  check("what never arrived is named: an entry, one of the store's, a setting", JSON.stringify(missing) === '["d","store: gone","setting: TIMEZONE"]', missing);
  check("what differs is named, not shown", JSON.stringify(differ) === '["c","setting: TESSIE_TOKEN"]', differ);
  check("what a move leaves behind is not called missing", !missing.includes("store: soon"));
  check("and nothing here was written", JSON.stringify([[...here._m], [...hereKv._m]]) === before);
}

console.log("what the old Jarvis had from its deployment");
{
  const saved: SavedSettings = { HA_BASE_URL: { v: "https://ha.example.com", at: 5 } };
  const env = { HA_BASE_URL: "https://old-ha.example.com", HA_TOKEN: "house-token", TESSIE_TOKEN: "car-token", TIMEZONE: "", JARVIS_SHARED_SECRET: "OWNERKEY", MOVE_KEY: KEY, CONFIG: {}, NOT_A_SETTING: "x" };
  const d = deployed(env, saved);
  check("its settings, set at deploy time and never saved", JSON.stringify(d) === '{"TESSIE_TOKEN":"car-token","HA_TOKEN":"house-token"}' || JSON.stringify(Object.keys(d).sort()) === '["HA_TOKEN","TESSIE_TOKEN"]', d);
  check("never the owner key, the move key, a binding, or what is no setting", !("JARVIS_SHARED_SECRET" in d) && !("MOVE_KEY" in d) && !("CONFIG" in d) && !("NOT_A_SETTING" in d));
  check("nor one saved in the panel, which an entry already holds, nor an empty one", !("HA_BASE_URL" in d) && !("TIMEZONE" in d));

  // On the new Jarvis nothing comes from its deployment; what was kept is saved as old as can be.
  const arrive = (moved: SavedSettings, kept: Record<string, string>) => guarded({}, applyChanges(moved, kept, 0));
  check("a house address and token both from the deployment: the token still goes there", !arrive({}, { HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "house-token" }).has("HA_TOKEN"));
  check("a token saved in the panel for the deployment's address: still goes there", !arrive({ HA_TOKEN: { v: "house-token", at: 9 } }, { HA_BASE_URL: "https://ha.example.com" }).has("HA_TOKEN"));
  check("an address changed in the panel, its token only the deployment's: withheld, as it was on the old one", guarded(env, saved).has("HA_TOKEN") && arrive(saved, { HA_TOKEN: "house-token" }).has("HA_TOKEN"));
}

console.log("what counts as a page");
{
  const ok = { version: "2.9.0", state: [["a", 1]], kv: [{ key: "k", value: "v" }], next: null };
  check("a page", asMovePage(ok) !== null);
  check("with more to come", asMovePage({ ...ok, next: "s:a" })?.next === "s:a");
  check("with the deployment's settings", asMovePage({ ...ok, settings: { HA_TOKEN: "t" } })?.settings?.HA_TOKEN === "t");
  for (const [name, bad] of [
    ["nothing", null],
    ["an error", { error: "not found" }],
    ["entries that are not pairs", { ...ok, state: [["a"]] }],
    ["a key that is not text", { ...ok, state: [[1, 2]] }],
    ["a stored value that is not text", { ...ok, kv: [{ key: "k", value: 1 }] }],
    ["no place to go on from", { ...ok, next: 3 }],
    ["settings that are not text", { ...ok, settings: { HA_TOKEN: 1 } }],
  ] as const) {
    check(`not ${name}`, asMovePage(bad) === null);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
