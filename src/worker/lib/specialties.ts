import type { Storage } from "./state-host.ts";
import { sanitise, tokenise } from "./memory.ts";

/**
 * Specialties, as Hark calls them: a way of doing something the user
 * approved, saved to be done the same way next time ("pre-cool the car for
 * the drive home": check the calendar, then the traffic, then set the
 * climate ten minutes before leaving). An answer that took two tools or more
 * offers to save its steps (lib/router.ts); they are saved only when the
 * user's next message asks in their own words (tools/specialties.ts), and
 * offered to the router when a question names one or plainly matches it
 * (lib/router.ts), as a procedure to follow only if it fits. By words, not
 * meaning: no model call per question.
 *
 * Each person's own, under one key, and what was last offered under another;
 * gone when they leave (state.ts).
 */

export const MAX_SPECIALTIES = 50;
const MAX_NAME = 60;
const MAX_WHEN = 8;
const MAX_WHEN_TEXT = 60;
const MAX_STEPS = 12;
const MAX_STEP = 240;
const MAX_WHY = 300;
/** Steps offered and not taken by a next question within this long (one Assist answered, say) are let go. */
const OFFER_MS = 30 * 60_000;

/**
 * How to keep them is said only after an answer that took this many tools,
 * and once in this long: said after every answer of two, it trailed most of
 * what a person asked. The steps are kept for their next question either way.
 */
export const OFFER_TOOLS = 3;
export const OFFER_SAID_MS = 24 * 60 * 60_000;

/** Said at the end of an answer whose steps are offered: how to keep them. */
export const OFFER = 'Say "save this as" and a name, and I will do it the same way next time.';

/** An answer's steps, offered to be saved: the person's own words, and the tools in order with only the values they said. */
export interface Procedure {
  asked: string;
  steps: string[];
}

export interface Specialty {
  id: string;
  name: string;
  /** What asking for it sounds like: a few phrases. */
  when: string[];
  steps: string[];
  why?: string;
  /** Its words, for matching a question (lib/memory.ts tokenise). */
  keys: string[];
  createdAt: number;
  updatedAt: number;
}

const key = (person: string) => `specialties:${person}`;
const offerKey = (person: string) => `specialty-offer:${person}`;
const saidKey = (person: string) => `specialty-offer-said:${person}`;
/** A name as compared: its letters and digits, in any script. */
const nameOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** One line, as compared for what was said. */
const plain = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether `part` is in `words`: as whole words, compared as names are, and
 * every character of it theirs, so nothing rides along unseen (Unicode tag
 * characters can spell hidden text after a word they did say).
 */
export function saidIn(words: string, part: string): boolean {
  const p = nameOf(part);
  return !!p && ` ${nameOf(words)} `.includes(` ${p} `) && plain(words).includes(plain(part));
}

/** The words and numbers in a tool call's arguments. */
function valuesOf(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (typeof v === "number" && Number.isFinite(v)) return [String(v)];
  if (Array.isArray(v)) return v.flatMap(valuesOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(valuesOf);
  return [];
}

/**
 * An answer's steps, to offer as a specialty: each tool once, in the order
 * first used, with only those of its values the person said (asked: their own
 * words, lib/router.ts ownWords). Never what a tool said, nor the answer: a
 * code read from mail and passed on to another tool is not theirs, so it is
 * not kept.
 */
export function stepsOf(asked: string, calls: readonly { name: string; arguments: string }[]): string[] {
  const steps = new Map<string, Set<string>>();
  for (const c of calls) {
    const values = steps.get(c.name) ?? new Set<string>();
    steps.set(c.name, values);
    let args: unknown = null;
    try {
      args = JSON.parse(c.arguments);
    } catch {
      // No values, then: the tool's name is still a step.
    }
    for (const v of valuesOf(args)) if (saidIn(asked, v)) values.add(v);
  }
  return [...steps].slice(0, MAX_STEPS).map(([name, values]) => (values.size ? `${name}: ${[...values].join(", ")}` : name).slice(0, MAX_STEP));
}

/**
 * What an answer offers to save (lib/router.ts): the person's question, ended
 * at a word within what a name and a phrase may hold, and its steps. None
 * when the question could not be either (it reads as an instruction, say), so
 * nothing is offered that could not be kept.
 */
export function procedureOf(asked: string, calls: readonly { name: string; arguments: string }[]): Procedure | null {
  const said = asked.replace(/\s+/g, " ").trim();
  const space = said.lastIndexOf(" ", MAX_WHEN_TEXT);
  const short = sanitise(said.length <= MAX_WHEN_TEXT ? said : said.slice(0, space > 0 ? space : MAX_WHEN_TEXT));
  if (!short.ok || !nameOf(short.text)) return null;
  return { asked: short.text, steps: stepsOf(asked, calls) };
}

/** A list of short texts, each checked as memory checks a fact; why not when one is not. */
function texts(raw: unknown, max: number, len: number, what: string): string[] | string {
  if (!Array.isArray(raw)) return `${what} must be a list`;
  const out: string[] = [];
  for (const r of raw.slice(0, max)) {
    const clean = sanitise(r);
    if (!clean.ok) return `a ${what.replace(/s$/, "")}: ${clean.why}`;
    out.push(clean.text.slice(0, len));
  }
  return out;
}

/** Whether a text names one: a name of one word, a word like any other, only where it stands in quotes. */
function names(text: string, name: string): boolean {
  if (!name) return false;
  if (name.includes(" ")) return ` ${nameOf(text)} `.includes(` ${name} `);
  return [...text.matchAll(/["“”«»]([^"“”«»\n]{1,80})["“”«»]/g)].some((m) => nameOf(m[1]!) === name);
}

export class Specialties {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  async of(person: string): Promise<Specialty[]> {
    return (await this.storage.get<Specialty[]>(key(person))) ?? [];
  }

  /** Saved, or changed if one of that name is kept already; why not, in words. */
  async save(person: string, input: { name: unknown; when: unknown; steps: unknown; why?: unknown }, now: number): Promise<Specialty | string> {
    const name = sanitise(input.name);
    if (!name.ok) return `its name: ${name.why}`;
    const when = texts(input.when ?? [], MAX_WHEN, MAX_WHEN_TEXT, "phrases");
    if (typeof when === "string") return when;
    const steps = texts(input.steps, MAX_STEPS, MAX_STEP, "steps");
    if (typeof steps === "string") return steps;
    if (!steps.length) return "a specialty needs its steps";
    const why = input.why === undefined || input.why === null || input.why === "" ? undefined : sanitise(input.why);
    if (why && !why.ok) return `why: ${why.why}`;
    return this.keep(person, { name: name.text, when, steps, ...(why?.ok ? { why: why.text } : {}) }, now);
  }

  /**
   * Kept as it is given: what may be in it is its caller's to have checked
   * (save, above; lib/specialty-more.ts, for what a person wrote themselves).
   * The one of that id, or of that name, is changed; with neither, a new one.
   * `fresh`: only a new one will do. `byName`: a question asks for it by its
   * name alone, what it says it is for being someone else's words.
   */
  async keep(person: string, input: { id?: string; fresh?: boolean; name: string; when: string[]; steps: string[]; why?: string; byName?: boolean }, now: number): Promise<Specialty | string> {
    const all = await this.of(person);
    const named = input.name.slice(0, MAX_NAME).trim();
    if (!nameOf(named)) return "its name needs a letter or a digit";
    const alike = all.find((s) => nameOf(s.name) === nameOf(named));
    const same = input.id ? all.find((s) => s.id === input.id) : alike;
    if (input.id && !same) return "it is not kept any more";
    if (alike && (alike !== same || input.fresh)) return `another is called "${alike.name}" already`;
    if (!same && all.length >= MAX_SPECIALTIES) return `that is ${MAX_SPECIALTIES} already: forget one first`;
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const s: Specialty = {
      id: same?.id ?? "s" + [...bytes].map((b) => ALPHABET[b % 32]).join(""),
      name: named,
      when: input.when,
      steps: input.steps,
      ...(input.why ? { why: input.why.slice(0, MAX_WHY) } : {}),
      keys: [...new Set(tokenise(input.byName ? named : `${named} ${input.when.join(" ")}`))],
      createdAt: same?.createdAt ?? now,
      updatedAt: now,
    };
    await this.storage.put(key(person), same ? all.map((x) => (x.id === same.id ? s : x)) : [...all, s]);
    return s;
  }

  /** Forgotten, by its id or its name: whether there was one. */
  async forget(person: string, which: string): Promise<boolean> {
    const all = await this.of(person);
    const name = nameOf(which);
    const keep = all.filter((s) => s.id !== which && (!name || nameOf(s.name) !== name));
    if (keep.length === all.length) return false;
    await this.storage.put(key(person), keep);
    return true;
  }

  /** The one whose whole name is in one of `texts`: by name alone, where nothing less would do (tools/jobs.ts start_job). The longest, where one name is in another. */
  async named(person: string, texts: readonly string[]): Promise<Specialty | null> {
    return (await this.of(person)).filter((s) => texts.some((t) => names(t, nameOf(s.name)))).sort((a, b) => nameOf(b.name).length - nameOf(a.name).length)[0] ?? null;
  }

  /**
   * The one a question asks for: named in it ("run my Monday report"), or
   * sharing at least two words with its name and phrases. Otherwise none: a
   * procedure followed for the wrong question is worse than none. One with no
   * steps is a background job's to read: named as it must be for one.
   */
  async match(person: string, ask: string): Promise<Specialty | null> {
    const all = await this.of(person);
    if (!all.length) return null;
    const asked = ` ${nameOf(ask)} `;
    const words = new Set(tokenise(ask));
    let best: { s: Specialty; n: number } | null = null;
    for (const s of all) {
      const name = nameOf(s.name);
      const named = !!name && (s.steps.length ? asked.includes(` ${name} `) : names(ask, name));
      const n = (named ? 100 : 0) + (s.steps.length ? s.keys.filter((k) => words.has(k)).length : 0);
      if ((named || n >= 2) && (!best || n > best.n)) best = { s, n };
    }
    return best?.s ?? null;
  }

  /** The steps of the answer just given, kept for the person's next question to save (lib/router.ts). */
  /** `said`: the answer ended by saying how to keep them (OFFER), which is not said again for a while. */
  async offer(person: string, p: Procedure, now: number, said: boolean): Promise<void> {
    await this.storage.put(offerKey(person), { asked: p.asked, steps: p.steps, at: now });
    if (said) await this.storage.put(saidKey(person), now);
  }

  /** When an answer of theirs last said how to keep its steps; 0 when none has. */
  async offerSaid(person: string): Promise<number> {
    return (await this.storage.get<number>(saidKey(person))) ?? 0;
  }

  /** What was offered after their last answer, taken: their next question saves it or lets it go. */
  async take(person: string, now: number): Promise<Procedure | null> {
    const o = await this.storage.get<Procedure & { at: number }>(offerKey(person));
    if (!o) return null;
    await this.storage.delete(offerKey(person));
    return now - o.at < OFFER_MS ? { asked: o.asked, steps: o.steps } : null;
  }

  async clear(person: string): Promise<void> {
    await this.storage.delete(key(person));
    await this.storage.delete(offerKey(person));
    await this.storage.delete(saidKey(person));
  }
}

/**
 * How the router is given it: as the user's own approved way, to follow only
 * if it fits, with the tools it has now. A user message, never an
 * instruction, as the profile is (lib/router.ts).
 */
/** `more`: it holds more than its steps (lib/specialty-more.ts), which only a background job reads; `whole`, all of it, between its marks, for a routine that names it. */
export function specialtyBlock(s: Specialty, more = false, whole?: string): string {
  if (whole) return `This names a specialty the user saved. Follow it only as far as it fits, using only the tools you have now.\n${whole}`;
  return (
    `A SPECIALTY THE USER SAVED AND APPROVED: "${s.name}"\n` +
    "Follow it only if it fits this request, using only the tools you have now; if it does not fit, ignore it.\n" +
    s.steps.map((step, i) => `${i + 1}. ${step}`).join("\n") +
    (s.why ? `\nWhy: ${s.why}` : "") +
    (more ? `\nThere is more to it, which a background job reads: to follow it all, start one whose brief says to use "${s.name}".` : "")
  );
}
