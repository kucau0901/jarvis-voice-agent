import type { Env } from "../types.ts";
import type { Storage } from "./state-host.ts";
import { vecPrefix } from "./state-host.ts";
import { MAX_BACKFILL, cosine, embed, embedText, factHash, fromB64, toB64 } from "./embeddings.ts";
import { tokenise, type Fact } from "./memory.ts";
import { stateStub } from "./state-client.ts";
import { localeOf } from "./locale.ts";

/**
 * Memory → Which is true now?: saved facts that may say one thing twice, or
 * disagree, and ones whose day has passed. Found by code when their person
 * opens it, never by itself and never by a model: closeness of meaning where
 * there are vectors (lib/embeddings.ts), else words, and dates that were still
 * to come when the fact was saved.
 *
 * Nothing here writes a fact. What its person does not choose goes to Trash
 * (settle), as forgetting does; two they say are both true are not asked about
 * again until one of them changes.
 */

/** As close in meaning as two facts must be to be asked about: a restatement measures 0.8, different facts that sound alike 0.6. */
export const CLOSE_MIN = 0.7;
/** In words alone, of what two facts say between them. */
export const WORDS_MIN = 0.5;
export const MAX_PAIRS = 30;
/** Found before those answered, and those about two people, are left out (doubts). */
const MAX_FOUND = 2_000;
const MAX_KEPT = 500;

export interface Pair {
  a: string;
  b: string;
  score: number;
}

const keptKey = (book: string) => `truenow:${book || "owner"}`;

/** What is kept of it: which two were said to be both true, and which one still is. */
export class TrueNow {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  async kept(book: string): Promise<string[]> {
    return (await this.storage.get<string[]>(keptKey(book))) ?? [];
  }

  async keep(book: string, what: string): Promise<void> {
    const all = await this.kept(book);
    if (!all.includes(what)) await this.storage.put(keptKey(book), [...all, what].slice(-MAX_KEPT));
  }

  /** New vectors kept, then which of `ids` are close in meaning, the closest first. */
  async pairs(put: readonly { id: string; hash: string; v: string }[], ids: readonly string[], book: string): Promise<Pair[]> {
    const pre = vecPrefix(book);
    for (const p of put) await this.storage.put(pre + p.id, { h: p.hash, v: p.v });
    const want = new Set(ids);
    const have = [...(await this.storage.list<{ h: string; v: string }>({ prefix: pre }))].flatMap(([k, s]) => (want.has(k.slice(pre.length)) ? [{ id: k.slice(pre.length), v: fromB64(s.v) }] : []));
    const out: Pair[] = [];
    for (let i = 0; i < have.length; i++) {
      for (let j = i + 1; j < have.length; j++) {
        const score = cosine(have[i]!.v, have[j]!.v);
        if (score >= CLOSE_MIN) out.push({ a: have[i]!.id, b: have[j]!.id, score });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, MAX_FOUND);
  }

  async clear(book: string): Promise<void> {
    await this.storage.delete(keptKey(book));
  }
}

/* ---------- finding ------------------------------------------------------------ */

const words = (f: Fact) => new Set(tokenise(`${f.text} ${f.slug ?? ""}`));

/** Close by the words they share, where there are no vectors. */
export function closeInWords(facts: readonly Fact[]): Pair[] {
  const all = facts.map((f) => ({ id: f.id, w: words(f) }));
  const out: Pair[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [x, y] = [all[i]!, all[j]!];
      const shared = [...x.w].filter((w) => y.w.has(w)).length;
      const score = shared / (new Set([...x.w, ...y.w]).size || 1);
      if (shared >= 2 && score >= WORDS_MIN) out.push({ a: x.id, b: y.id, score });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, MAX_FOUND);
}

/** Two about different people are not one thing said twice, however alike they read. */
function aboutOthers(a: Fact, b: Fact, names: readonly string[]): boolean {
  const said = (f: Fact) => new Set(names.filter((n) => new RegExp(`(?<!\\p{L})${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\p{L})`, "iu").test(`${f.text} ${f.slug ?? ""}`)).map((n) => n.toLowerCase()));
  const [x, y] = [said(a), said(b)];
  return [...x].some((n) => !y.has(n)) && [...y].some((n) => !x.has(n));
}

export const pairKey = (a: Fact, b: Fact) => [a, b].map((f) => `${f.id}:${factHash(f)}`).sort().join("~");
export const oneKey = (f: Fact) => `${f.id}:${factHash(f)}`;

export interface Doubt {
  /** The one changed longer ago first. */
  older: Fact;
  newer: Fact;
}
export interface Passed {
  fact: Fact;
  /** The day it spoke of, as yyyy-mm-dd. */
  day: string;
}

/** What to ask about: the pairs found, and what has passed, less what was answered already. */
export function doubts(facts: readonly Fact[], pairs: readonly Pair[], names: readonly string[], kept: readonly string[], now: number, timeZone: string): { pairs: Doubt[]; passed: Passed[] } {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const known = new Set(kept);
  const out: Doubt[] = [];
  for (const p of pairs) {
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    if (!a || !b || known.has(pairKey(a, b)) || aboutOthers(a, b, names)) continue;
    const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a];
    out.push({ older, newer });
    if (out.length >= MAX_PAIRS) break;
  }
  const passed = facts.flatMap((fact) => {
    if (known.has(oneKey(fact))) return [];
    const day = dayPassed(fact, now, timeZone);
    return day === null ? [] : [{ fact, day }];
  });
  return { pairs: out, passed: passed.sort((x, y) => x.day.localeCompare(y.day)) };
}

/* ---------- days --------------------------------------------------------------- */

const MONTHS: Record<string, number> = {};
for (const [i, names] of ["january jan januari", "february feb februari", "march mar mac", "april apr", "may mei", "june jun", "july jul julai", "august aug ogos", "september sep sept", "october oct oktober", "november nov", "december dec dis disember"].entries()) for (const n of names.split(" ")) MONTHS[n] = i;
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DAY_MS = 86_400_000;
/** Said of the day it was saved, and how many days on it still holds. In small letters, or first of all: "Berita Hari Ini" is a name. */
const RELATIVE: [RegExp, number][] = [
  [/(?:^(?:Today|Tonight|Hari ini|Malam ini)|(?<!\p{L})(?:today|tonight|hari ini|malam ini))(?!['’\p{L}])/u, 0],
  [/(?:^(?:Tomorrow|Esok)|(?<!\p{L})(?:tomorrow|esok))(?!['’\p{L}])/u, 1],
  [/(?:^(?:This week|This weekend|Minggu ini)|(?<!\p{L})(?:this week|this weekend|minggu ini|hujung minggu ini))(?!['’\p{L}])/u, 7],
  [/(?:^(?:Next week|Minggu depan)|(?<!\p{L})(?:next week|minggu depan))(?!['’\p{L}])/u, 14],
  [/(?:^(?:This month|Bulan ini)|(?<!\p{L})(?:this month|bulan ini))(?!['’\p{L}])/u, 31],
  [/(?:^(?:Next month|Bulan depan)|(?<!\p{L})(?:next month|bulan depan))(?!['’\p{L}])/u, 62],
];
/** Something that goes on, whatever day it names. */
const ALWAYS = /(?<!\p{L})(?:every|each|daily|weekly|monthly|always|usually|setiap|tiap|selalu|biasanya)(?!\p{L})/iu;

/** The days a text names with their year, as the first and last of each (a month with no day is all of it), in days since 1970. */
export function daysIn(text: string): { first: number; last: number }[] {
  const out: { first: number; last: number }[] = [];
  let left = text;
  const month = (m: string) => MONTHS[m.toLowerCase()]!;
  /** Each way a day is written, taken out as it is read: what is left of one is not a month by itself. */
  const read = (re: RegExp, of: (m: string[]) => [number, number, number?]) => {
    left = left.replace(re, (...m: string[]) => {
      const [y, mo, d] = of(m);
      const first = Date.UTC(y, mo, d ?? 1);
      const ok = mo >= 0 && mo <= 11 && (d === undefined || (d >= 1 && new Date(first).getUTCMonth() === mo));
      if (ok) out.push({ first: first / DAY_MS, last: (d === undefined ? Date.UTC(y, mo + 1, 0) : first) / DAY_MS });
      return " ";
    });
  };
  read(/(?<!\d)(20\d\d)-(\d\d)-(\d\d)(?!\d)/g, (m) => [+m[1]!, +m[2]! - 1, +m[3]!]);
  read(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(20\d\d)(?!\d)/g, (m) => [+m[3]!, +m[2]! - 1, +m[1]!]);
  read(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|hb|\\s*haribulan)?\\s+(?:of\\s+)?(${MONTH})\\.?,?\\s+(20\\d\\d)(?!\\d)`, "giu"), (m) => [+m[3]!, month(m[2]!), +m[1]!]);
  read(new RegExp(`(?<!\\p{L})(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)(?!\\d)`, "giu"), (m) => [+m[3]!, month(m[1]!), +m[2]!]);
  read(new RegExp(`(?<!\\p{L})(${MONTH})\\.?\\s+(20\\d\\d)(?!\\d)`, "giu"), (m) => [+m[2]!, month(m[1]!)]);
  return out;
}

/** The day it is somewhere, in days since 1970. */
function dayAt(t: number, timeZone: string): number {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t).split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / DAY_MS;
}

/**
 * The last day a fact spoke of that was still to come on the day it was saved,
 * as yyyy-mm-dd, once it is over; null when it spoke of none, or only of what was
 * already (a birthday, the day something was bought, that month) or goes on.
 */
export function dayPassed(f: Pick<Fact, "text" | "kind" | "createdAt" | "updatedAt">, now: number, timeZone: string): string | null {
  const saved = dayAt(Math.max(f.createdAt, f.updatedAt), timeZone);
  const named = daysIn(f.text);
  // One already begun when it was saved is not what it looked forward to.
  const ahead = named.filter((d) => d.first > saved).map((d) => d.last);
  if (!named.length && !ALWAYS.test(f.text) && f.kind !== "preference" && f.kind !== "routine") for (const [re, days] of RELATIVE) if (re.test(f.text)) ahead.push(saved + days);
  if (!ahead.length) return null;
  const last = Math.max(...ahead);
  return last < dayAt(now, timeZone) ? new Date(last * DAY_MS).toISOString().slice(0, 10) : null;
}

/* ---------- what its person is shown, and chooses ---------------------------------- */

/** Pairs close in meaning; null where meaning cannot be had (no key, or it failed). What has no vector is embedded first, some at a time. */
export async function closeInMeaning(env: Env, book: string, facts: readonly Fact[]): Promise<Pair[] | null> {
  const state = stateStub(env);
  if (!state || !env.OPENAI_API_KEY || !facts.length) return null;
  const hashes = new Map(facts.map((f) => [f.id, factHash(f)]));
  const missing = new Set(await state.vectorsNeeded(facts.map((f) => ({ id: f.id, hash: hashes.get(f.id)! })), book));
  const todo = facts.filter((f) => missing.has(f.id)).slice(0, MAX_BACKFILL);
  const vecs = todo.length ? await embed(env, todo.map(embedText)) : [];
  if (!vecs) return null;
  return state.memoryPairs(todo.map((f, i) => ({ id: f.id, hash: hashes.get(f.id)!, v: toB64(vecs[i]!) })), facts.map((f) => f.id), book);
}

/**
 * What to ask about in `book` now, as Memory shows it and as Jarvis says it
 * (tools/true-now.ts): close in meaning where the key allows (one embeddings
 * call for facts not yet measured), else in words. Null without the state object.
 */
export async function doubtsOf(env: Env, facts: readonly Fact[], book: string, now = Date.now()): Promise<{ pairs: Doubt[]; passed: Passed[]; byMeaning: boolean } | null> {
  const state = stateStub(env);
  if (!state) return null;
  const near = await closeInMeaning(env, book, facts).catch(() => null);
  const names = [...facts.flatMap((f) => (f.kind === "person" && f.slug ? [f.slug] : [])), ...((await state.familyPeople().catch(() => [])) ?? []).map((p) => p.name)];
  return { ...doubts(facts, near ?? closeInWords(facts), names, await state.trueKept(book), now, localeOf(env).timeZone), byMeaning: !!near };
}

/**
 * One answered, of a pair or a fact whose day passed (`all`): those not in
 * `keep` go to Trash, as forgetting does; with all kept, it is not asked about
 * again until one of them changes. The ids forgotten.
 */
export async function settle(env: Env, store: { remove(id: string): unknown; save(): Promise<void> }, book: string, all: readonly Fact[], keep: readonly unknown[]): Promise<string[]> {
  const going = all.filter((f) => !keep.includes(f.id));
  for (const f of going) store.remove(f.id);
  if (going.length) await store.save();
  else await stateStub(env)?.trueKeep(book, all.length === 1 ? oneKey(all[0]!) : pairKey(all[0]!, all[1]!));
  return going.map((f) => f.id);
}
