import { OWNER, bookOf, carsOf, familyBook, isTheirs, personOfWho, voiceWho, withPerson } from "../src/worker/lib/context.ts";
import { carCommand, pickCar } from "../src/worker/tools/tessie.ts";
import { personOf, whoOf, type Principal } from "../src/worker/lib/auth.ts";
import { MemoryStore, memoryFor } from "../src/worker/lib/memory.ts";
import { forget, recall, remember } from "../src/worker/tools/memory.ts";
import { beginAuth, consumeState, isLinked } from "../src/worker/lib/google.ts";
import { deliver, makeAlert, type Alert, type AlertState } from "../src/worker/lib/alerts.ts";
import { LiveHub, type LiveClient, type LiveSocket } from "../src/worker/lib/live.ts";
import { addToDay, emptyDay, report, type UsageEntry } from "../src/worker/lib/usage.ts";
import { jarvisPrompt } from "../src/worker/lib/prompt.ts";
import type { Space } from "../src/worker/lib/hub.ts";

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

/** KV that answers the way Workers KV does: text, or JSON when asked. */
function fakeEnv(extra: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  return {
    CONFIG: {
      get: async (k: string, t?: unknown) => {
        const v = kv.get(k);
        if (v === undefined) return null;
        const json = t === "json" || (typeof t === "object" && t !== null && (t as { type?: string }).type === "json");
        return json ? JSON.parse(v) : v;
      },
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    _kv: kv,
    ...extra,
  } as never as Record<string, unknown> & { _kv: Map<string, string> };
}

const SPACE: Space = { id: "s_fam", name: "The Rahmans", agentName: "Friday", createdAt: 1 };

console.log("whose");
{
  check("a member's id is theirs", personOfWho("u_abc123") === "u_abc123");
  check("the owner key and devices are the first person's", personOfWho("owner") === OWNER && personOfWho("d_85cca711") === OWNER && personOfWho("voice") === OWNER);
  check("the first person keeps the names things always had", bookOf(OWNER) === "" && bookOf(undefined) === "" && bookOf("u_x") === "u_x");
  const first: Principal = { kind: "member", id: "u_first", name: "Adam", scopes: ["*"], role: "admin", space: "s_fam", session: "x", place: { space: SPACE, first: true, prefs: {} } };
  const sara: Principal = { kind: "member", id: "u_sara", name: "Sara", scopes: ["ask"], role: "adult", space: "s_fam", session: "y", place: { space: SPACE, first: false, prefs: {} } };
  const dev: Principal = { kind: "device", id: "d_1", name: "G2", scopes: ["ask"] };
  check("the first person is the owner", personOf(first) === OWNER && whoOf(first) === OWNER);
  check("another member, even an admin, is themselves", personOf({ ...sara, role: "admin" }) === "u_sara");
  check("a device uses the owner's things, but its threads are its own", personOf(dev) === OWNER && whoOf(dev) === "d_1");
}

console.log("\nwhat is whose");
{
  check("a job asked for by a member is theirs", voiceWho({ JARVIS_PERSON: "u_sara" }) === "u_sara");
  check("the first person's stay \"voice\", as they always were", voiceWho({ JARVIS_PERSON: OWNER }) === "voice" && voiceWho({}) === "voice");
  check("the first person owns the voice's, the owner key's and the devices'", isTheirs("voice", OWNER) && isTheirs("owner", undefined) && isTheirs("d_1", OWNER));
  check("a member owns only theirs", isTheirs("u_sara", "u_sara") && !isTheirs("voice", "u_sara") && !isTheirs("u_sara", OWNER));
}

console.log("\nthe environment, per person");
{
  const base = fakeEnv({ TELEGRAM_CHAT_ID: "999", LOCALE: "en", VOICE_TTS_VOICE: "cedar" }) as never;
  const e = withPerson(base, { person: "u_sara", name: "Sara", space: SPACE, prefs: { voice: "marin", language: "ms" } });
  check("who, their name, the assistant's name and the family's book", e.JARVIS_PERSON === "u_sara" && e.JARVIS_PERSON_NAME === "Sara" && e.JARVIS_AGENT_NAME === "Friday" && e.JARVIS_FAMILY === familyBook(SPACE));
  check("their own voice and language", e.VOICE_TTS_VOICE === "marin" && e.LOCALE === "ms");
  check("never the first person's Telegram chat", e.TELEGRAM_CHAT_ID === "");
  const own = withPerson(base, { person: "u_sara", prefs: { telegram: "12345" } });
  check("their own, if they gave one", own.TELEGRAM_CHAT_ID === "12345");
  const owner = withPerson(base, { person: OWNER });
  check("the first person keeps the family's", owner.TELEGRAM_CHAT_ID === "999" && owner.VOICE_TTS_VOICE === "cedar");
}

console.log("\ncars: only those shared, as far as they are shared");
{
  const base = fakeEnv({ TESSIE_TOKEN: "family-token", TESSIE_VIN: "VINFAMILY" }) as never;
  const none = withPerson(base, { person: "u_sara", cars: [] });
  check("someone with no car shared has none, not the family's", none.TESSIE_TOKEN === "" && carsOf(none).length === 0);
  check("and the tools say so", typeof pickCar(none) === "string");
  const shared = withPerson(base, {
    person: "u_sara",
    cars: [
      { id: "family", name: "Adam's Model Y", owner: OWNER, level: "see" },
      { id: "c_1", name: "Sara's car", owner: "u_sara", level: "own", vin: "VINSARA", token: "sara-token" },
    ],
  });
  const keys = carsOf(shared);
  check("her own car is her usual one", shared.TESSIE_TOKEN === "sara-token" && keys[0]!.name === "Sara's car");
  check("the family car's key comes from the settings", keys.find((c) => c.id === "family")?.token === "family-token");
  const picked = pickCar(shared, "adam's model y");
  check("a car is picked by its name", typeof picked !== "string" && picked.cfg.vin === "VINFAMILY" && picked.car?.level === "see");
  check("an unknown name says which there are", String(pickCar(shared, "the boat")).includes("Sara's car"));
  const refused = await carCommand.run({ command: "unlock", value: null, temperature: null, percent: null, car: "Adam's Model Y" }, { env: shared, signal: AbortSignal.timeout(1000), progress() {} } as never);
  check("a car shared to see is not operated", String(refused).includes("to see, not to operate"), refused);
  const before = withPerson(base, { person: OWNER });
  check("without a family, the settings car is the owner's, as before", before.TESSIE_TOKEN === "family-token" && !before.JARVIS_CARS);
}

console.log("\nmemory: each their own, and the family's");
{
  const env = fakeEnv();
  const adam = { ...env, JARVIS_PERSON: OWNER, JARVIS_FAMILY: familyBook(SPACE) } as never;
  const sara = { ...env, JARVIS_PERSON: "u_sara", JARVIS_FAMILY: familyBook(SPACE) } as never;

  const a = new MemoryStore(adam);
  await a.load();
  a.add({ text: "Adam's dentist is Dr Tan", kind: "note" });
  await a.save();
  const s = new MemoryStore(sara);
  await s.load();
  check("Sara's memory does not have Adam's", s.facts.length === 0);
  s.add({ text: "Sara likes oat milk", kind: "preference" });
  await s.save();
  check("each is kept apart; the first person's where it always was", env._kv.has("mem:v1") && env._kv.has("mem:v1:u_sara") && !JSON.stringify(JSON.parse(env._kv.get("mem:v1")!)).includes("oat milk"));

  const grants = ["memory.read", "memory.write", "family"] as const;
  const mem = memoryFor(sara, grants as never);
  await mem.load();
  const ctx = { env: sara, signal: AbortSignal.timeout(5000), progress() {}, display() {}, memory: mem, grants: grants as never };
  const saved = await remember.run({ text: "The Wi-Fi password is on the fridge", kind: "note", place: null, replaces: null, pin: null, more: null, for_family: true }, ctx as never);
  check("remembered for the whole family", String(saved).includes("for the whole family"), saved);
  // Words that are in every fact score nothing, so the family needs more than one.
  mem.family!.add({ text: "The family doctor is Dr Lim", kind: "note" });
  await mem.save();
  const adamsView = memoryFor(adam, ["memory.read"] as never);
  await adamsView.load();
  check("Adam sees it too, in the family part of his profile", adamsView.buildProfile().includes("WHAT THE WHOLE FAMILY SHARES") && adamsView.buildProfile().includes("Wi-Fi"));
  check("but not Sara's own", !adamsView.buildProfile().includes("oat milk"));
  const found = String(await recall.run({ query: "wifi password", limit: 5 }, { ...ctx, memory: adamsView } as never));
  check("recall finds it, marked as the family's", found.includes("(family)"), found);

  const child = memoryFor(sara, ["memory.read", "memory.write"] as never);
  await child.load();
  const refused = await remember.run({ text: "Bedtime is midnight", kind: "note", place: null, replaces: null, pin: null, more: null, for_family: true }, { ...ctx, memory: child } as never);
  check("without `family`, the family's memory cannot be changed", String(refused).includes("may not change what the family shares"), refused);
  const famId = child.family!.facts[0]!.id;
  const kept = await forget.run({ id: famId }, { ...ctx, memory: child } as never);
  check("nor forgotten", String(kept).includes("belongs to the whole family"), kept);
  check("someone who may not read memory does not get the family's either", memoryFor(sara, ["ask"] as never).family === null);
}

console.log("\neach person's own Google");
{
  const env = fakeEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
  const sara = { ...env, JARVIS_PERSON: "u_sara" } as never;
  const url = await beginAuth(sara, { clientId: "id", clientSecret: "secret", redirectUri: "https://x/api/google/callback" });
  const state = new URL(url).searchParams.get("state")!;
  check("the link remembers who started it", (await consumeState(env as never, state)) === "u_sara");
  check("and works once", (await consumeState(env as never, state)) === null);
  env._kv.set("google:state:old", "1");
  check("a link started before families is the first person's", (await consumeState(env as never, "old")) === OWNER);
  env._kv.set("google:refresh:u_sara", "tok");
  check("Sara's link is hers", (await isLinked(sara)) === true);
  check("not the first person's", (await isLinked({ ...env, JARVIS_PERSON: OWNER } as never)) === false);
}

console.log("\nalerts go to whoever they are for");
{
  const sent: string[] = [];
  const tried: string[] = [];
  const state: AlertState = {
    async broadcast() {
      return { open: 0, visible: 0, acked: null };
    },
    async pushTargets(person) {
      tried.push(`push:${person}`);
      return { vapid: { publicKey: "", privateJwk: {} }, subs: [] };
    },
    async pushResults() {},
    async logDelivery() {},
    async chatFor(person) {
      return person === "u_sara" ? "5551" : null;
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push(`${url.includes("telegram") ? "telegram" : url.includes("ntfy") ? "ntfy" : "other"}:${init?.body ?? ""}`);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const env = { TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "999", NTFY_URL: "https://ntfy.example/topic", ALERT_ORDER: "live,push,telegram,ntfy" } as never;
  const forSara = makeAlert({ text: "Buy ice cream on the way home" }, "routine", Date.now(), "u_sara")!;
  check("an alert knows whose it is", forSara.for === "u_sara");
  const d = await deliver(env, state, forSara, { every: true });
  check("her phones are looked for, not the owner's", tried.includes("push:u_sara") && !tried.includes("push:owner"));
  check("it goes to her own Telegram chat", sent.some((s) => s.startsWith("telegram") && s.includes("5551")) && !sent.some((s) => s.includes("\"999\"")));
  check("never to the household's channels", !sent.some((s) => s.startsWith("ntfy")) && !d.attempts.some((a) => a.channel === "ntfy"));
  sent.length = 0;
  const owners: Alert = makeAlert({ text: "The gate is open" }, "routine")!;
  await deliver(env, state, owners, { every: true });
  check("the first person's alert still goes everywhere it did", owners.for === undefined && sent.some((s) => s.includes("999")) && sent.some((s) => s.startsWith("ntfy")));
  globalThis.fetch = realFetch;

  const hub = new LiveHub();
  const got: string[] = [];
  const sock = (who: string): LiveSocket => {
    const c: LiveClient = { who, label: who, visible: false, since: 0 };
    return { send: () => void got.push(who), client: () => c, update: () => {} };
  };
  await hub.broadcast([sock("owner"), sock("u_sara"), sock("d_glasses")], forSara, 0);
  check("only her open screens hear hers", got.join() === "u_sara", got);
  got.length = 0;
  await hub.broadcast([sock("owner"), sock("u_sara"), sock("d_glasses")], owners, 0);
  check("the first person's reach the owner key's screens and the devices", got.join() === "owner,d_glasses", got);
}

console.log("\nusage, per person");
{
  const e = (who: string | undefined, input: number): UsageEntry => ({ at: 1, surface: "voice", by: "gpt-6-luna", ok: true, ms: 1000, input, cached: 0, written: 0, output: 0, searches: 0, tools: [], ask: "x", ...(who ? { who } : {}) });
  let d = emptyDay("2026-09-27");
  d = addToDay(d, e(undefined, 1_000_000));
  d = addToDay(d, e("u_sara", 2_000_000));
  check("each person's part of the day", d.questions === 2 && d.people?.owner?.questions === 1 && d.people?.u_sara?.questions === 1);
  const all = report([d], [e(undefined, 1), e("u_sara", 2)], "2026-09-27");
  check("the admins see everyone's, and each person's part", all.total.questions === 2 && all.byPerson?.u_sara?.questions === 1);
  const hers = report([d], [e(undefined, 1), e("u_sara", 2)], "2026-09-27", "u_sara");
  check("a member sees only their own", hers.total.questions === 1 && hers.recent.length === 1 && hers.recent[0]!.who === "u_sara" && !hers.byPerson);
  const old = { ...emptyDay("2026-09-26"), questions: 5 };
  check("a day from before families is the first person's", report([old], [], "2026-09-27", OWNER).total.questions === 5 && report([old], [], "2026-09-27", "u_sara").total.questions === 0);
}

console.log("\nthe assistant's name, and who it is talking to");
{
  const p = jarvisPrompt("car", { agentName: "Friday", personName: "Sara" });
  check("it goes by the family's name for it", p.startsWith("You are Friday,") && !p.startsWith("You are Jarvis"));
  check("and knows who it is talking to", p.includes("This is Sara."));
  check("with nothing said, it is Jarvis, as before", jarvisPrompt("car").startsWith("You are Jarvis,") && !jarvisPrompt("car").includes("TALKING TO"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
