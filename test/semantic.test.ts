import {
  DUPLICATE_MIN,
  EMBED_DIMS,
  EMBED_MODEL,
  SEM_MIN,
  cosine,
  embedText,
  factHash,
  fromB64,
  fuse,
  toB64,
} from "../src/worker/lib/embeddings.ts";
import { MemoryStore, search as wordSearch, type Fact } from "../src/worker/lib/memory.ts";
import { StateHost } from "../src/worker/lib/state-host.ts";

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

const fact = (id: string, text: string, kind: Fact["kind"] = "note", extra: Partial<Fact> = {}): Fact => ({
  id, text, kind, keys: text.toLowerCase().split(/\W+/).filter(Boolean), createdAt: 1, updatedAt: 1, useCount: 0, source: "voice", ...extra,
});

/* ---------- a fake embedding service where meaning is known --------------------- */

/**
 * Each concept is one direction; a text points along every concept it
 * mentions, in either language. Anything else points somewhere of its own.
 */
const CONCEPTS: [number, RegExp][] = [
  [0, /dentist|doktor gigi|gigi/i],
  [1, /insurance|insurans|policy|polisi/i],
  [2, /sister|kakak|adik perempuan/i],
  [3, /physio|back pain|sakit belakang/i],
];
function vecFor(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIMS);
  let any = false;
  for (const [i, re] of CONCEPTS) if (re.test(text)) (v[i] = 1), (any = true);
  if (!any) {
    let h = 7;
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 400;
    v[100 + h] = 1;
  }
  // A small shared component, as real embeddings have: unrelated texts are not exactly orthogonal.
  v[EMBED_DIMS - 1] = 0.2;
  let n = 0;
  for (const x of v) n += x * x;
  return v.map((x) => x / Math.sqrt(n));
}

let embedCalls: string[][] = [];
let embedDown = false;
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url !== "https://api.openai.com/v1/embeddings") throw new Error(`unexpected fetch ${url}`);
  if (embedDown) return new Response("down", { status: 503 });
  const body = JSON.parse(String(init.body));
  embedCalls.push(body.input);
  return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: toB64(vecFor(t)) })) });
}) as typeof fetch;

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

/** A MemoryStore talking to a real StateHost, as it talks to the Durable Object. */
async function world(hot: Fact[], cold: Fact[] = [], key = "sk-test") {
  const storage = fakeStorage();
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
  const host = new StateHost(storage, { CONFIG: kv } as never);
  await host.ready();
  await storage.put("mem", { rev: 1, facts: hot, trash: [] });
  await storage.put("ref", { rev: 1, facts: cold });
  const ns = { idFromName: () => ({}), get: () => host };
  const env = { OPENAI_API_KEY: key, STATE: ns, CONFIG: kv } as never;
  const store = () => new MemoryStore(env);
  return { host, storage, store };
}

/* ---------- pieces ------------------------------------------------------------ */

console.log("vectors");
{
  const v = vecFor("dentist");
  check("round trip through base64", cosine(v, fromB64(toB64(v))) > 0.9999);
  check("cosine: same 1, unrelated low", Math.abs(cosine(v, v) - 1) < 1e-6 && cosine(v, vecFor("insurance")) < 0.1);
  check("cosine of mismatched lengths is 0", cosine(v, new Float32Array(3)) === 0);
}

console.log("\nwhat is embedded, and when again");
{
  const f = fact("m1", "Home is 12 High Street", "place", { slug: "home", address: "12 High Street, Springfield" });
  check("words, name and address", embedText(f) === "Home is 12 High Street (home) — 12 High Street, Springfield");
  check("the same fact, the same hash", factHash(f) === factHash({ ...f }));
  check("edited text, a new hash", factHash(f) !== factHash({ ...f, text: "Home is 14 High Street" }));
  check("the model is part of it", factHash(f).startsWith(`${EMBED_MODEL}/${EMBED_DIMS}/`));
}

console.log("\nwords: a short name fragment is not a match");
{
  const naim = fact("r1", "Ma'ruf bin So'od, extension 1234", "reference");
  const other = fact("r2", "Siti Aminah, nurse, extension 5678", "reference");
  check("'play some jazz' does not find So'od", wordSearch([naim, other], "play some jazz").length === 0);
  check("'anak saya nama apa' does not find Ma'ruf", wordSearch([naim, other], "anak saya nama apa").length === 0);
  check("a real partial word still does: 'nurses'", wordSearch([naim, other], "nurses")[0]?.fact.id === "r2");
}

console.log("\nmerging words and meaning");
{
  const a = fact("a", "Dr Lim is my dentist");
  const b = fact("b", "Aisyah renews the car insurance");
  const c = fact("c", "Farid, lab tech, ext 2231");
  const facts = new Map([a, b, c].map((f) => [f.id, f]));
  const both = fuse([{ fact: c, score: 5 }, { fact: a, score: 1 }], [{ id: a.id, score: 0.7 }, { id: b.id, score: 0.5 }], facts, 6);
  check("found both ways ranks first", both[0]!.fact.id === "a" && both[0]!.via === "both", both.map((h) => [h.fact.id, h.via]));
  check("each way alone still counts", both.some((h) => h.fact.id === "c" && h.via === "words") && both.some((h) => h.fact.id === "b" && h.via === "meaning"));
  const weak = fuse([], [{ id: a.id, score: SEM_MIN - 0.01 }], facts, 6);
  check("too distant in meaning: not offered", weak.length === 0);
  check("an unknown id is ignored", fuse([], [{ id: "gone", score: 0.9 }], facts, 6).length === 0);
  check("limited", fuse([], [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }, { id: "c", score: 0.7 }], facts, 2).length === 2);
}

/* ---------- through the store ---------------------------------------------------------- */

const hot = [
  fact("m_dent", "Dr Lim is my dentist, at Klinik Pergigian Bukit"),
  fact("m_ins", "Aisyah at Etiqa renews the Tesla policy every March"),
  fact("m_home", "Home is 12 High Street", "place", { slug: "home", address: "12 High Street" }),
];
const cold = [fact("r_ext", "Farid, laboratory technician, ext 2231", "reference")];

console.log("\nrecall by meaning, across languages");
{
  const w = await world(hot, cold);
  embedCalls = [];
  const hits = await w.store().search("siapa doktor gigi saya?");
  check("a Malay question finds the English fact", hits[0]?.fact.id === "m_dent", hits.map((h) => [h.fact.id, h.via]));
  check("the first search embeds every fact, with the question, in one call", embedCalls.length === 1 && embedCalls[0]!.length === 1 + hot.length + cold.length, embedCalls.map((c) => c.length));
  const my = await w.store().search("siapa uruskan insurans kereta saya?");
  check("…and with not even part of a word in common, by meaning alone", my[0]?.fact.id === "m_ins" && my[0].via === "meaning", my.map((h) => [h.fact.id, h.via]));
  embedCalls = embedCalls.slice(0, 1);
  const ins = await w.store().search("who handles my car insurance?");
  check("no shared words, found anyway", ins[0]?.fact.id === "m_ins", ins.map((h) => h.fact.id));
  check("later searches embed only the question", embedCalls.length === 2 && embedCalls[1]!.length === 1);
  const ext = await w.store().search("ext 2231");
  check("an exact number is still found by its words", ext[0]?.fact.id === "r_ext" && ext[0].via !== "meaning", ext.map((h) => [h.fact.id, h.via]));
  check("vectors are kept beside memory", [...w.storage._m.keys()].filter((k) => k.startsWith("vec:")).length === 4);
}

console.log("\nkept up to date");
{
  const w = await world(hot, cold);
  await w.store().search("dentist");
  const s = w.store();
  await s.load();
  s.add({ text: "Aina, my sister, lives in Shah Alam", kind: "person" });
  await s.save();
  embedCalls = [];
  await w.store().search("where does my sister live");
  check("a new fact is embedded on the next search, alone with the question", embedCalls[0]!.length === 2, embedCalls[0]);
  const edited = hot.map((f) => (f.id === "m_home" ? { ...f, text: "Home is 14 High Street" } : f));
  await w.storage.put("mem", { rev: 2, facts: [...edited, fact("m_sis", "Aina, my sister, lives in Shah Alam", "person")], trash: [] });
  embedCalls = [];
  await w.store().search("dentist");
  check("an edited fact is embedded again", embedCalls[0]!.some((t) => t.includes("14 High Street")), embedCalls[0]);
}

console.log("\nforgotten facts lose their vectors — but only after a complete read");
{
  const w = await world(hot, cold);
  await w.store().search("dentist");
  await w.storage.put("mem", { rev: 2, facts: hot.filter((f) => f.id !== "m_ins"), trash: [] });
  await w.store().search("dentist");
  check("gone with the fact", !w.storage._m.has("vec:m_ins") && w.storage._m.has("vec:m_dent"));
  // The reference store fails to load: its facts are unknown, not deleted.
  const flaky = await world(hot, cold);
  await flaky.store().search("dentist");
  const real = flaky.host.loadReference.bind(flaky.host);
  flaky.host.loadReference = async () => {
    throw new Error("storage blip");
  };
  await flaky.store().search("dentist");
  flaky.host.loadReference = real;
  check("a failed read deletes nothing", flaky.storage._m.has("vec:r_ext"));
}

console.log("\nwhen meaning is unavailable, words still work");
{
  const w = await world(hot, cold);
  embedDown = true;
  const hits = await w.store().search("dentist");
  embedDown = false;
  check("OpenAI down: found by words", hits[0]?.fact.id === "m_dent" && hits[0].via === "words");
  check("…and nothing learned from a failure", ![...w.storage._m.keys()].some((k) => k.startsWith("vec:")));
  const nokey = await world(hot, cold, "");
  embedCalls = [];
  const h2 = await nokey.store().search("dentist");
  check("no key: words, and no call at all", h2[0]?.via === "words" && embedCalls.length === 0);
  const kvOnly = new MemoryStore({ OPENAI_API_KEY: "sk", CONFIG: { get: async () => null, put: async () => {} } } as never);
  await kvOnly.load();
  check("no Durable Object (KV only): words, no crash", Array.isArray(await kvOnly.search("dentist")));
}

console.log("\nnoticing a restatement");
{
  const w = await world(hot, cold);
  const s = w.store();
  await s.load();
  const { fact: f } = s.add({ text: "My dentist is Dr Lim", kind: "note" });
  const close = await s.closest(f.text, "note", f.id);
  check("very close in meaning, same kind: pointed out", close?.fact.id === "m_dent" && close.score >= DUPLICATE_MIN, close);
  check("not itself", (await s.closest("Dr Lim is my dentist, at Klinik Pergigian Bukit", "note", "m_dent"))?.fact.id !== "m_dent");
  check("a different kind is not a duplicate", (await s.closest("My dentist is Dr Lim", "person", f.id)) === null);
  check("something new: nothing", (await s.closest("The gate code is 4471", "note", "x")) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
