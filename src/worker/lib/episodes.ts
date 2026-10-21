import type { Storage } from "./state-host.ts";
import { tokenise } from "./memory.ts";
import { asQuotedData, tidy } from "./quote.ts";

/**
 * What happened last time: each background job, question for Hermes and
 * research run, and each question whose tools failed, as one line — what was
 * wanted, whether it worked, and what came of it ("the site refused the
 * search"). A question that shares words with one is given the best three
 * (lib/router.ts), so Jarvis does not walk into the same wall twice.
 *
 * Tidied as each is written rather than in a nightly pass, so it costs no
 * model call: older than KEEP_MS goes, the same attempt again is counted
 * rather than kept twice, and past MAX_EPISODES the oldest goes. Each
 * person's own; gone when they leave.
 *
 * A lesson can carry what a site or a tool said, so it is always quoted as
 * data, never followed.
 */

export const MAX_EPISODES = 500;
export const KEEP_MS = 180 * 86_400_000;
const SHOWN = 3;
const TEXT = 240;
/** Two attempts sharing this much of their words are the same one again (as memory's near-duplicates). */
const SAME = 0.75;

export type Outcome = "ok" | "failed";

export interface Episode {
  id: string;
  at: number;
  source: "job" | "hermes" | "research" | "chain";
  goal: string;
  outcome: Outcome;
  lesson: string;
  keys: string[];
  /** How many times this attempt was made. */
  seen: number;
}

const key = (person: string) => `episodes:${person}`;
const cut = (s: string) => {
  const t = tidy(s);
  return t.length > TEXT ? `${t.slice(0, TEXT - 1)}…` : t;
};
/** How much two attempts' words are the same: what they share of all they have between them. */
const overlap = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size < 2 || y.size < 2) return 0;
  const both = [...x].filter((k) => y.has(k)).length;
  return both / (x.size + y.size - both);
};

/** What a finished job comes to (lib/jobs.ts): done is ok; failed is failed, its error the lesson. */
export function episodeOfJob(j: { id: string; title: string; task: string; engine: "jarvis" | "hermes" | "research"; status: string; summary?: string; error?: string }): Omit<Episode, "at" | "keys" | "seen"> {
  const ok = j.status === "done";
  return {
    id: j.id,
    source: j.engine === "jarvis" ? "job" : j.engine,
    goal: cut(j.title || j.task),
    outcome: ok ? "ok" : "failed",
    lesson: cut(ok ? j.summary ?? "" : j.error ?? "it did not finish"),
  };
}

/** A question whose tools failed: which, and what they said. */
export function episodeOfChain(asked: string, failed: { tool: string; said: string }[]): Omit<Episode, "at" | "keys" | "seen"> {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return {
    id: "e" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
    source: "chain",
    goal: cut(asked),
    outcome: "failed",
    lesson: cut(failed.map((f) => `${f.tool}: ${f.said.replace(/^That failed:\s*/, "")}`).join("; ")),
  };
}

export class Episodes {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  async of(person: string, now: number): Promise<Episode[]> {
    return ((await this.storage.get<Episode[]>(key(person))) ?? []).filter((e) => now - e.at <= KEEP_MS);
  }

  /** Kept, newest first; the same attempt again is counted on the one kept, and takes its outcome and lesson. */
  async add(person: string, e: Omit<Episode, "at" | "keys" | "seen">, now: number): Promise<void> {
    const keys = [...new Set(tokenise(e.goal))];
    const all = await this.of(person, now);
    const same = all.find((x) => x.id === e.id || overlap(x.keys, keys) >= SAME);
    const kept: Episode = { ...e, id: same?.id ?? e.id, at: now, keys, seen: (same?.seen ?? 0) + (same?.id === e.id ? 0 : 1) };
    await this.storage.put(key(person), [kept, ...all.filter((x) => x !== same)].slice(0, MAX_EPISODES));
  }

  /** The best few sharing words with a question, by how many: only those with at least two in common. */
  async match(person: string, ask: string, now: number): Promise<Episode[]> {
    const words = new Set(tokenise(ask));
    if (words.size < 2) return [];
    return (await this.of(person, now))
      .map((e) => ({ e, n: e.keys.filter((k) => words.has(k)).length }))
      .filter((x) => x.n >= 2)
      .sort((a, b) => b.n - a.n || b.e.at - a.e.at)
      .slice(0, SHOWN)
      .map((x) => x.e);
  }

  async forget(person: string, id: string): Promise<boolean> {
    const all = (await this.storage.get<Episode[]>(key(person))) ?? [];
    const keep = all.filter((e) => e.id !== id);
    if (keep.length === all.length) return false;
    await this.storage.put(key(person), keep);
    return true;
  }

  async clear(person: string): Promise<void> {
    await this.storage.delete(key(person));
  }
}

/** How the router is given them: what happened before, as data. */
export function pastBlock(eps: readonly Episode[], timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" });
  const said = { ok: "worked", failed: "failed" } as const;
  const lines = eps.map((e) => `- ${day.format(e.at)}: "${e.goal}" ${said[e.outcome]}${e.seen > 1 ? ` (tried ${e.seen} times)` : ""}${e.lesson ? `. ${e.lesson}` : ""}`);
  return (
    "PAST ATTEMPTS AT SOMETHING LIKE THIS. Use them to avoid repeating what did not work; do not mention them unless it helps.\n" +
    asQuotedData("past attempts", lines.join("\n"), "JARVIS'S EARLIER WORK, INCLUDING WHAT SITES AND TOOLS SAID")
  );
}
