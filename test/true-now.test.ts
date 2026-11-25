// Memory → Which is true now? (src/worker/lib/true-now.ts): which saved facts may no longer be true, found by code,
// and what their person's choice does. Invented throughout.
import { MAX_PAIRS, TrueNow, closeInWords, dayPassed, daysIn, doubts, oneKey, pairKey, type Pair } from "../src/worker/lib/true-now.ts";
import { factHash, toB64 } from "../src/worker/lib/embeddings.ts";
import { handleMemory } from "../src/worker/routes/memory.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import type { Fact } from "../src/worker/lib/memory.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 500) : "");
  }
}
function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 4);
const fact = (id: string, text: string, over: Partial<Fact> = {}): Fact => ({ id, text, kind: "note", keys: [], createdAt: NOW - 90 * DAY, updatedAt: NOW - 90 * DAY, useCount: 0, source: "ui", ...over });
const TZ = "Asia/Kuala_Lumpur";
const pairsOf = (facts: Fact[], names: string[] = [], kept: string[] = []) => doubts(facts, closeInWords(facts), names, kept, NOW, TZ).pairs.map((p) => `${p.older.id}<${p.newer.id}`);

console.log("which are asked about");
{
  const gate = [fact("a", "The side gate code is 1234", { updatedAt: NOW - 10 * DAY }), fact("b", "The side gate code is 9876", { updatedAt: NOW - 40 * DAY }), fact("c", "The dentist is on the second floor")];
  check("two that say it differently, the one changed longer ago first", pairsOf(gate).join() === "b<a", pairsOf(gate));
  check("not two that share a word or two", pairsOf([fact("a", "Sara's birthday is 3 May"), fact("b", "Adam's birthday is 9 June")]).length === 0);
  const peanuts = [fact("a", "Sara is allergic to peanuts and prawns"), fact("b", "Adam is allergic to peanuts and prawns")];
  check("nor two about different people, however alike they read", pairsOf(peanuts).length === 1 && pairsOf(peanuts, ["Sara", "Adam"]).length === 0);
  check("…but two about the same one, or where only one is named", pairsOf([fact("a", "Sara goes to the lake school"), fact("b", "Sara goes to the hill school")], ["Sara", "Adam"]).length === 1 && pairsOf([fact("a", "Sara is allergic to peanuts and prawns"), fact("b", "She is allergic to peanuts and prawns")], ["Sara", "Adam"]).length === 1);
  check("a name is a name, not part of a word", pairsOf([fact("a", "Aidan pays the lake boat fee"), fact("b", "Aidan pays the lake boat rent")], ["Aida", "Dan"]).length === 1);
  const k = pairKey(gate[0]!, gate[1]!);
  check("not again once both are said to be true, whichever way round", pairsOf(gate, [], [k]).length === 0 && pairKey(gate[1]!, gate[0]!) === k);
  check("again once one of them changes", pairsOf([{ ...gate[0]!, text: "The side gate code is 5555" }, gate[1]!], [], [k]).length === 1);
  const many = Array.from({ length: 40 }, (_, i) => fact(`m${i}`, `The spare key number ${i} hangs in the hall cupboard`));
  check(`at most ${MAX_PAIRS} at a time`, pairsOf(many).length === MAX_PAIRS);
  // Left out before that: six people's sizes are not thirty questions that hide the one there is.
  const people = ["Sara", "Adam", "Aisyah", "Nenek", "Siti", "Ben", "Ana", "Sam", "Lina", "Omar", "Zara", "Imran", "Hana", "Yusuf", "Mei"];
  const sizes = people.map((n, i) => fact(`s${i}`, `${n} wears a size seven school shoe`));
  const hidden = pairsOf([...sizes, ...gate], people);
  check("those left out do not count towards that", hidden.join() === "b<a", hidden);
  const first = many.slice(0, 12);
  const all = pairsOf(first).length;
  const answered = doubts(many, closeInWords(many), [], [], NOW, TZ).pairs.map((p) => pairKey(p.older, p.newer));
  check("nor those answered: the next come up", all === MAX_PAIRS && pairsOf(many, [], answered).length === MAX_PAIRS && !pairsOf(many, [], answered).some((x) => answered.includes(x)));
}

console.log("\ndays");
{
  const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
  const on = (text: string) => daysIn(text).map((d) => (d.first === d.last ? iso(d.last) : `${iso(d.first)}..${iso(d.last)}`)).join();
  const cases: [string, string][] = [
    ["Passport expires 2026-08-14", "2026-08-14"], ["Road tax until 14/8/2026.", "2026-08-14"], ["The villa is booked for 14 August 2026", "2026-08-14"], ["14th of Aug 2026", "2026-08-14"],
    ["Cuti sekolah sampai 14hb Ogos 2026", "2026-08-14"], ["August 14, 2026", "2026-08-14"], ["The lease ends in August 2026", "2026-08-01..2026-08-31"], ["Mac 2026", "2026-03-01..2026-03-31"], ["14 haribulan Ogos 2026", "2026-08-14"],
    ["31 February 2026", ""], ["2026-13-01", ""], ["model 2026", ""], ["12026-08-14", ""], ["summarch 2026", ""],
  ];
  for (const [text, want] of cases) check(`${text}: ${want || "none"}`, on(text) === want, on(text));
  const saved = (text: string, ago: number, kind: Fact["kind"] = "note") => dayPassed({ text, kind, createdAt: NOW - ago * DAY, updatedAt: NOW - ago * DAY }, NOW, TZ);
  check("a day that was to come when it was saved, and has passed", saved("The villa is booked for 14 August 2026", 200) === "2026-08-14");
  check("not one that is still to come, nor today", saved("The villa is booked for 14 August 2027", 200) === null && saved("The dentist is on 25 November 2026", 5) === null && saved("The dentist is on 24 November 2026", 5) === "2026-11-24");
  check("not what had been already: a birthday, a day something was bought", saved("Sara was born on 3 May 2016", 200) === null && saved("The car was bought on 2 January 2026", 200) === null);
  check("nor what was said of its own day, or of the month it was", saved("The washing machine was bought on 18 November 2026", 7) === null && saved("The car was bought in November 2026", 7) === null && saved("The car was bought in October 2026", 46) === null && saved("The lease ends in October 2026", 60) === "2026-10-31" && saved("Aina's brother was born on 24 November 2026", 1) === null);
  const at = (iso: string) => Date.parse(iso);
  check("days are the family's, not London's", dayPassed({ text: "Bought on 25 November 2026", kind: "note", createdAt: at("2026-11-24T23:30:00Z"), updatedAt: at("2026-11-24T23:30:00Z") }, at("2026-12-01T00:00:00Z"), TZ) === null && dayPassed({ text: "Dentist on 25 November 2026", kind: "note", createdAt: at("2026-11-01T00:00:00Z"), updatedAt: at("2026-11-01T00:00:00Z") }, at("2026-11-25T17:00:00Z"), TZ) === "2026-11-25" && dayPassed({ text: "Dentist on 25 November 2026", kind: "note", createdAt: at("2026-11-01T00:00:00Z"), updatedAt: at("2026-11-01T00:00:00Z") }, at("2026-11-25T15:00:00Z"), TZ) === null);
  check("of several, the last", saved("Away from 1 August 2026 until 14 December 2026", 200) === null);
  check("what was said of its own day: for as long as that holds, and the day is said as it was", saved("We are at the lake this week", 8) === "2026-11-24" && saved("We are at the lake this week", 3) === null && saved("Nenek datang esok", 3) === "2026-11-23" && saved("Dentist tomorrow", 2) === "2026-11-24" && saved("Dentist tomorrow", 1) === null && saved("Tonight we are out", 1) === "2026-11-24");
  check("not what goes on, nor a name with such a word in it", saved("The bins go out every week", 300) === null && saved("Wants tomorrow's weather every evening", 300) === null && saved("Reads Berita Hari Ini", 300) === null && saved("Todayish", 300) === null && saved("Likes the window seat today", 300, "preference") === null && saved("Setiap malam ini dia baca", 300) === null);
  check("changed since, its days count from then", dayPassed({ text: "The villa is booked for 14 August 2026", kind: "note", createdAt: NOW - 200 * DAY, updatedAt: NOW - 2 * DAY }, NOW, TZ) === null);
  const f = fact("p", "The villa is booked for 14 August 2026", { createdAt: NOW - 200 * DAY, updatedAt: NOW - 200 * DAY });
  const asked = doubts([f], [], [], [], NOW, TZ).passed;
  check("asked about with its day; not again once it is still true", asked[0]?.day === "2026-08-14" && doubts([f], [], [], [oneKey(f)], NOW, TZ).passed.length === 0, asked);
}

console.log("\nby meaning, in the object");
{
  const st = fakeStorage();
  const t = new TrueNow(st as never);
  const vec = (...x: number[]) => toB64(Float32Array.from(x));
  await st.put("vec:old", { h: "h", v: vec(1, 0, 0) });
  await st.put("vec:gone", { h: "h", v: vec(1, 0, 0) });
  await st.put("vec2:u_sara:hers", { h: "h", v: vec(1, 0, 0) });
  const got = await t.pairs([{ id: "new", hash: "h2", v: vec(0.9, 0.1, 0) }, { id: "far", hash: "h3", v: vec(0, 1, 0) }], ["old", "new", "far"], "");
  check("close ones, the new vectors kept; not one that is gone, nor another's", got.length === 1 && [got[0]!.a, got[0]!.b].sort().join() === "new,old" && st._m.has("vec:new") && (await t.pairs([], ["hers"], "u_sara")).length === 0, got);
  check("a vector kept here is one a search finds again (its text's own mark)", (st._m.get("vec:new") as { h: string }).h === "h2");
  await t.keep("", "x~y");
  await t.keep("", "x~y");
  await t.keep("u_sara", "z");
  check("what was said is each book's own, kept once, and gone with them", JSON.stringify([await t.kept(""), await t.kept("u_sara")]) === '[["x~y"],["z"]]' && (await t.clear("u_sara"), (await t.kept("u_sara")).length === 0) && (await t.kept("")).length === 1);
}

console.log("\nasked and answered (routes/memory.ts)");
{
  const book: Record<string, { rev: number; facts: Fact[]; trash: Fact[] }> = {
    "": { rev: 1, facts: [fact("a", "The side gate code is 1234", { updatedAt: NOW - 10 * DAY }), fact("b", "The side gate code is 9876"), fact("v", "The villa is booked for 14 August 2020", { createdAt: Date.UTC(2020, 1, 1), updatedAt: Date.UTC(2020, 1, 1) }), fact("k", "Kettle descaled monthly")], trash: [] },
    "fam:s1": { rev: 1, facts: [fact("fa", "The house wifi password hint is blue boat"), fact("fb", "The house wifi password hint is red boat")], trash: [] },
  };
  const kept: Record<string, string[]> = {};
  const put: string[] = [];
  const stub = new Proxy({}, {
    get: (_t, m) => (m === "then" ? undefined : async (...a: unknown[]) => {
      if (m === "loadMemory") return structuredClone(book[(a[0] as string) ?? ""]);
      if (m === "applyMemory") {
        const cs = a[0] as { removed: string[] };
        const b = book[(a[2] as string) ?? ""]!;
        b.trash.push(...b.facts.filter((f) => cs.removed.includes(f.id)));
        b.facts = b.facts.filter((f) => !cs.removed.includes(f.id));
        return { doc: structuredClone(b) };
      }
      if (m === "loadReference") return { rev: 1, facts: [fact("r1", "Roster line one two three"), fact("r2", "Roster line one two four")] };
      if (m === "familyPeople") return [{ person: "u_sara", name: "Sara" }];
      if (m === "trueKept") return kept[a[0] as string] ?? [];
      if (m === "trueKeep") return void ((kept[a[0] as string] ??= []).push(a[1] as string));
      if (m === "vectorsNeeded") return ["a", "b", "v", "k"];
      if (m === "memoryPairs") return (put.push(...(a[0] as { id: string; hash: string }[]).map((x) => `${x.id} ${x.hash}`)), [{ a: "k", b: "v", score: 0.9 }] satisfies Pair[]);
      return undefined;
    }),
  });
  const env = { CONFIG: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) }, STATE: { idFromName: () => "j", get: () => stub }, JARVIS_FAMILY: "fam:s1" };
  const at = (ids: unknown[]) => Object.fromEntries(Object.values(book).flatMap((b) => b.facts).filter((f) => ids.includes(f.id)).map((f) => [f.id, f.updatedAt]));
  const call = async (method: string, given?: Record<string, unknown>, q = "", grants: string[] = ["memory.read", "memory.write"], device = false, over: object = {}) => {
    const body = given && !("seen" in given) ? { ...given, seen: at([given.id, ...((given.pair as unknown[]) ?? [])]) } : given;
    const r = await handleMemory(new Request(`https://j.test/api/memory/true${q}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), { ...env, ...over } as never, grants as never, device);
    return { status: r.status, body: (await r.json()) as { pairs: { older: Fact; newer: Fact }[]; passed: { fact: Fact; day: string }[]; byMeaning: boolean; forgotten: string[] } };
  };
  const first = await call("GET");
  check("by words, with no key: what may disagree, and what has passed; not the reference shelf", first.status === 200 && first.body.pairs.length === 1 && first.body.pairs[0]!.older.id === "b" && first.body.passed[0]?.fact.id === "v" && first.body.byMeaning === false, first.body);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: ["a", "b", "v", "k"].map((_, index) => ({ index, embedding: [1, 0] })) })) as typeof fetch;
  try {
    const near = await call("GET", undefined, "", ["memory.read"], false, { OPENAI_API_KEY: "sk-test" });
    check("by meaning, with one: what had no vector is given one first", near.body.byMeaning === true && near.body.pairs.length === 1 && near.body.pairs[0]!.older.id === "v" && put.length === 4 && put[0] === `a ${factHash(book[""]!.facts[0]!)}`, [near.body.pairs, put]);
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    check("…and by words where that fails", (await call("GET", undefined, "", ["memory.read"], false, { OPENAI_API_KEY: "sk-test" })).body.byMeaning === false);
  } finally {
    globalThis.fetch = real;
  }
  check("both true: nothing forgotten, not asked again", (await call("POST", { pair: ["a", "b"], keep: ["a", "b"] })).body.forgotten.length === 0 && kept[""]!.length === 1 && (await call("GET")).body.pairs.length === 0);
  kept[""] = [];
  const older = await call("POST", { pair: ["b", "a"], keep: ["b"] });
  check("one kept: the other forgotten, to where forgetting puts it", older.body.forgotten.join() === "a" && book[""]!.facts.every((f) => f.id !== "a") && book[""]!.trash.some((f) => f.id === "a"), older.body);
  check("still true, then", (await call("POST", { id: "v", keep: true })).body.forgotten.length === 0 && (await call("GET")).body.passed.length === 0);
  check("a fact not chosen to keep is forgotten", (await call("POST", { id: "v", keep: false })).body.forgotten.join() === "v");
  check("neither", (await call("POST", { pair: ["fa", "fb"], keep: [] }, "?book=family", ["memory.write", "family"])).body.forgotten.join() === "fa,fb" && book["fam:s1"]!.facts.length === 0 && book[""]!.facts.length > 0);
  check("one that is not kept any more, one of them twice, or nothing chosen: refused, and nothing is forgotten", (await call("POST", { pair: ["a", "b"], keep: ["b"] })).status === 404 && (await call("POST", { pair: ["b", "b"], keep: [] })).status === 404 && (await call("POST", { pair: ["b", "k"] })).status === 400 && (await call("POST", { id: "b", keep: "no" })).status === 400 && (await call("POST", {})).status === 404 && book[""]!.facts.length === 2, book[""]!.facts.map((f) => f.id));
  check("one changed since it was shown is not chosen about", (await call("POST", { pair: ["b", "k"], keep: ["b"], seen: { b: 1, k: at(["k"]).k } })).status === 409 && (await call("POST", { pair: ["b", "k"], keep: ["b"], seen: {} })).status === 409 && book[""]!.facts.length === 2);
  check("keeping a third changes nothing but the two", (await call("POST", { pair: ["b", "k"], keep: ["b", "x"] })).body.forgotten.join() === "k");
  check("a device is shown it and changes nothing; the family's needs `family`", (await call("POST", { id: "b", keep: false }, "", ["*"], true)).status === 403 && (await call("GET", undefined, "", ["*"], true)).status === 200 && (await call("POST", { id: "fa", keep: false }, "?book=family")).status === 403);
  check("GET memory.read, POST memory.write", requiredScope("/api/memory/true", "GET") === "memory.read" && requiredScope("/api/memory/true", "POST") === "memory.write" && requiredScope("/api/memory/truex", "GET") === "owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
