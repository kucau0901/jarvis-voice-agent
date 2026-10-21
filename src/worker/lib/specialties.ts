import type { Storage } from "./state-host.ts";
import { sanitise, tokenise } from "./memory.ts";

/**
 * Specialties, as Hark calls them: a way of doing something the user
 * approved, saved to be done the same way next time ("pre-cool the car for
 * the drive home": check the calendar, then the traffic, then set the
 * climate ten minutes before leaving). Saved only when the user asked for it
 * in their own words (tools/specialties.ts), and offered to the router when a
 * question names one or plainly matches it (lib/router.ts), as a procedure to
 * follow only if it fits. By words, not meaning: no model call per question.
 *
 * Each person's own, under one key; gone when they leave (state.ts).
 */

export const MAX_SPECIALTIES = 50;
const MAX_NAME = 60;
const MAX_WHEN = 8;
const MAX_WHEN_TEXT = 60;
const MAX_STEPS = 12;
const MAX_STEP = 240;
const MAX_WHY = 300;

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
/** A name as compared: its letters and digits, in any script. */
const nameOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

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
    const all = await this.of(person);
    const named = name.text.slice(0, MAX_NAME);
    if (!nameOf(named)) return "its name needs a letter or a digit";
    const same = all.find((s) => nameOf(s.name) === nameOf(named));
    if (!same && all.length >= MAX_SPECIALTIES) return `that is ${MAX_SPECIALTIES} already: forget one first`;
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const s: Specialty = {
      id: same?.id ?? "s" + [...bytes].map((b) => ALPHABET[b % 32]).join(""),
      name: named,
      when,
      steps,
      ...(why?.ok ? { why: why.text.slice(0, MAX_WHY) } : {}),
      keys: [...new Set(tokenise(`${named} ${when.join(" ")}`))],
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

  /**
   * The one a question asks for: named in it ("run my Monday report"), or
   * sharing at least two words with its name and phrases. Otherwise none: a
   * procedure followed for the wrong question is worse than none.
   */
  async match(person: string, ask: string): Promise<Specialty | null> {
    const all = await this.of(person);
    if (!all.length) return null;
    const asked = ` ${nameOf(ask)} `;
    const words = new Set(tokenise(ask));
    let best: { s: Specialty; n: number } | null = null;
    for (const s of all) {
      const name = nameOf(s.name);
      const named = !!name && asked.includes(` ${name} `);
      const n = (named ? 100 : 0) + s.keys.filter((k) => words.has(k)).length;
      if ((named || n >= 2) && (!best || n > best.n)) best = { s, n };
    }
    return best?.s ?? null;
  }

  async clear(person: string): Promise<void> {
    await this.storage.delete(key(person));
  }
}

/**
 * How the router is given it: as the user's own approved way, to follow only
 * if it fits, with the tools it has now. A user message, never an
 * instruction, as the profile is (lib/router.ts).
 */
export function specialtyBlock(s: Specialty): string {
  return (
    `A SPECIALTY THE USER SAVED AND APPROVED: "${s.name}"\n` +
    "Follow it only if it fits this request, using only the tools you have now; if it does not fit, ignore it.\n" +
    s.steps.map((step, i) => `${i + 1}. ${step}`).join("\n") +
    (s.why ? `\nWhy: ${s.why}` : "")
  );
}
