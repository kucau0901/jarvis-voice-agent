import type { Storage } from "./state-host.ts";
import { tokenise } from "./memory.ts";
import { localParts } from "./routines.ts";
import { allows, type Grant, type Scope } from "./scopes.ts";
import { overlap } from "./episodes.ts";

/**
 * Habits: the same request, asked at about the same time of day on DAYS_MIN
 * different days within WINDOW_MS, offered once as a routine that asks it
 * for them a little before (state.ts noteAsk files the card). Code alone
 * decides, with no model call: the words (memory.ts tokenise) overlap by SAME
 * or more, the tools used were the same, and the times are within NEAR_MIN
 * minutes of each other, either side of midnight. A request of fewer than
 * MIN_WORDS words that count ("check it again") is a follow-up, not a habit.
 *
 * Only what the router says may be noted (lib/router.ts record): their own
 * words, answered with tools a routine can use (noteworthy). Each habit is offered once, and not again for OFFERED_MS, whatever
 * became of the card; one a routine of theirs already asks is not offered.
 */

export const KEEP_MS = 21 * 86_400_000;
export const WINDOW_MS = 14 * 86_400_000;
export const MAX_ASKED = 300;
export const DAYS_MIN = 3;
export const NEAR_MIN = 45;
export const SAME = 0.75;
export const MIN_WORDS = 3;
export const OFFERED_MS = 180 * 86_400_000;
const MAX_OFFERED = 100;
/** What is kept of a request, and what a card quotes: a longer one is not offered, as cut it would ask something else. */
export const MAX_ASK = 120;

export interface Asked {
  at: number;
  words: string[];
  ask: string;
  tools: string[];
}

interface Stored {
  asked: Asked[];
  /** Habits offered, by their words, and when. */
  offered: Record<string, number>;
}

/** A habit to offer: what to ask, at what time ("07:35"), on which days (0–6, Sunday first; empty for every day). */
export interface Habit {
  key: string;
  ask: string;
  time: string;
  days: number[];
}

/**
 * Whether a request was the house's alone: answered by Assist, or only with Home Assistant's tools (ha-mcp's names
 * start ha_). Such a habit is better as a Home Assistant automation, free every day, than a routine, a paid answer.
 */
export const houseOnly = (r: { by: string; tools: readonly string[] }): boolean =>
  r.by === "home-assistant" || (r.tools.length > 0 && r.tools.every((t) => t.includes("__ha_")));

/** What a routine's question runs without (routes/routines.ts askForRoutine): nothing to draw on, and never Hermes. */
const UNATTENDED: readonly Scope[] = ["screen", "hermes"];

/**
 * Whether a finished turn may be noted (lib/router.ts record): answered, for someone who may have routines, with only
 * tools a routine can use, as `offered` (the tools the router was given) names their scopes: anything that reads,
 * sends or changes, the house's and the car's included, but nothing that draws on a screen or asks Hermes, which a
 * routine runs without. The routine is made only on their tap, with no more than they could reach.
 */
export const noteworthy = (r: { ok: boolean; tools: readonly string[] }, grants: readonly Grant[], offered: readonly { name: string; scope?: Scope }[]): boolean =>
  r.ok && allows(grants, "routines") && r.tools.every((name) => {
    const t = offered.find((o) => o.name === name);
    return !!t && !(t.scope && UNATTENDED.includes(t.scope));
  });

const minuteOf = (at: number, timeZone: string) => {
  const p = localParts(at, timeZone);
  return p.h * 60 + p.mi;
};
/** Minutes from `b` to `a` round the clock, -720 to 720: 23:55 is 10 minutes before 00:05. */
const minutesFrom = (a: number, b: number) => ((a - b + 1440 + 720) % 1440) - 720;
const dateOf = (at: number, timeZone: string) => {
  const p = localParts(at, timeZone);
  return `${p.y}-${p.mo}-${p.d}`;
};

/**
 * The habit `latest` makes with `earlier`, what was asked before it, if any: it
 * and those like it on DAYS_MIN days or more, at the earliest of their times rounded down to
 * five minutes, on weekdays or weekends when they all were.
 */
export function habitOf(earlier: readonly Asked[], latest: Asked, timeZone: string): Habit | null {
  if (new Set(latest.words).size < MIN_WORDS) return null;
  const tools = [...latest.tools].sort().join();
  const minute = minuteOf(latest.at, timeZone);
  const like = [...earlier, latest].filter(
    (a) =>
      latest.at - a.at < WINDOW_MS &&
      [...a.tools].sort().join() === tools &&
      Math.abs(minutesFrom(minuteOf(a.at, timeZone), minute)) <= NEAR_MIN &&
      overlap(a.words, latest.words) >= SAME,
  );
  if (new Set(like.map((a) => dateOf(a.at, timeZone))).size < DAYS_MIN) return null;
  const earliest = Math.min(...like.map((a) => minutesFrom(minuteOf(a.at, timeZone), minute)));
  const first = Math.floor((((minute + earliest) % 1440) + 1440) % 1440 / 5) * 5;
  const dows = new Set(like.map((a) => localParts(a.at, timeZone).dow));
  const days = [...dows].every((d) => d >= 1 && d <= 5) ? [1, 2, 3, 4, 5] : [...dows].every((d) => d === 0 || d === 6) ? [0, 6] : [];
  const time = `${String(Math.floor(first / 60)).padStart(2, "0")}:${String(first % 60).padStart(2, "0")}`;
  return { key: [...new Set(latest.words)].sort().join(" "), ask: latest.ask, time, days };
}

export class Habits {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }
  private key = (person: string) => `asked:${person}`;

  /**
   * One request they made, noted; the habit to offer when it makes one and it was not offered lately. `made`: what
   * their routines already ask, never offered. Offered only once filed (offered).
   */
  async note(person: string, ask: string, tools: readonly string[], timeZone: string, now: number, made: readonly string[]): Promise<Habit | null> {
    const s = (await this.storage.get<Stored>(this.key(person))) ?? { asked: [], offered: {} };
    const latest: Asked = { at: now, words: tokenise(ask), ask: ask.slice(0, MAX_ASK), tools: [...tools] };
    const earlier = s.asked.filter((a) => now - a.at < KEEP_MS);
    const asked = [...earlier, latest].slice(-MAX_ASKED);
    const offered = Object.fromEntries(Object.entries(s.offered).filter(([, at]) => now - at < OFFERED_MS));
    const habit = habitOf(earlier, latest, timeZone);
    await this.storage.put(this.key(person), { asked, offered });
    if (!habit || ask.length > MAX_ASK || Object.keys(offered).some((k) => overlap(k.split(" "), latest.words) >= SAME) || made.some((m) => overlap(tokenise(m), latest.words) >= SAME)) return null;
    return habit;
  }

  /** A habit's card was filed: not offered again for OFFERED_MS. */
  async offered(person: string, key: string, now: number): Promise<void> {
    const s = (await this.storage.get<Stored>(this.key(person))) ?? { asked: [], offered: {} };
    const kept = Object.entries({ ...s.offered, [key]: now }).sort((a, b) => b[1] - a[1]).slice(0, MAX_OFFERED);
    await this.storage.put(this.key(person), { ...s, offered: Object.fromEntries(kept) });
  }

  /** What they asked, cleared with what they said (Clear chat); what was offered is kept, so it is not offered again. */
  async clearAsked(person: string): Promise<void> {
    const s = await this.storage.get<Stored>(this.key(person));
    if (s) await this.storage.put(this.key(person), { asked: [], offered: s.offered });
  }

  /** All of it, as they leave the family. */
  async forget(person: string): Promise<void> {
    await this.storage.delete(this.key(person));
  }
}
