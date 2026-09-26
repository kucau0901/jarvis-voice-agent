import { LIVE_PER_MINUTE, WEB_SEARCH_PER_CALL, priceOf } from "./prices.ts";

/**
 * What Jarvis costs, and how it answers: one entry per question, per job and
 * per live session, kept in the Durable Object and shown in Settings → Usage.
 *
 * Nothing was kept before: each answer's usage was sent with it and dropped,
 * so there was no way to see the month's cost, how much Home Assistant's
 * Assist saved by answering on its own, or which answers were slow.
 *
 * Plain functions of the entries, so Node can test them.
 */

export interface UsageEntry {
  at: number;
  /** "voice", "glasses", "chat", "app" (Live and the API), "routine", "job", "live". */
  surface: string;
  /** The model that answered, "home-assistant", or "gpt-live-1". */
  by: string;
  ok: boolean;
  ms: number;
  input: number;
  cached: number;
  written: number;
  output: number;
  searches: number;
  /** Model hops, for a question the AI answered. */
  hops?: number;
  /** A live session: how long it was open. */
  seconds?: number;
  tools: string[];
  /** The start of what was asked, to recognise it by. */
  ask: string;
}

/** US dollars, or null for a model with no known price (tokens are still counted). */
export function costOf(e: UsageEntry): number | null {
  if (e.by === "home-assistant") return 0;
  if (e.seconds !== undefined) return (e.seconds / 60) * LIVE_PER_MINUTE;
  const p = priceOf(e.by);
  if (!p) return null;
  const plain = Math.max(0, e.input - e.cached - e.written);
  return (
    (plain * p.input + e.cached * p.cached + e.written * (p.write ?? p.input) + e.output * p.output) / 1e6 +
    e.searches * WEB_SEARCH_PER_CALL
  );
}

/** One day's totals: what the month is made of. */
export interface DayTotals {
  day: string;
  /** Questions answered, by the AI or the house. */
  questions: number;
  /** Of them, answered by Home Assistant's Assist, for nothing. */
  byHouse: number;
  /** Dollars, split by what spent them. */
  cost: { router: number; live: number; jobs: number };
  liveSeconds: number;
  jobs: number;
  /** Tokens from models with no known price, so the cost is known to be short. */
  unpriced: number;
}

export const emptyDay = (day: string): DayTotals => ({
  day,
  questions: 0,
  byHouse: 0,
  cost: { router: 0, live: 0, jobs: 0 },
  liveSeconds: 0,
  jobs: 0,
  unpriced: 0,
});

export function addToDay(d: DayTotals, e: UsageEntry): DayTotals {
  const out: DayTotals = { ...d, cost: { ...d.cost } };
  const cost = costOf(e);
  if (cost === null) out.unpriced += e.input + e.output;
  if (e.seconds !== undefined) {
    out.liveSeconds += e.seconds;
    out.cost.live += cost ?? 0;
  } else if (e.surface === "job") {
    out.jobs += 1;
    out.cost.jobs += cost ?? 0;
  } else {
    out.questions += 1;
    if (e.by === "home-assistant") out.byHouse += 1;
    out.cost.router += cost ?? 0;
  }
  return out;
}

/** The calendar day an entry belongs to, in the owner's time zone. */
export function dayOf(at: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export interface UsageReport {
  month: string;
  total: DayTotals;
  today: DayTotals;
  /** Median answer time over the recent questions, ms; null with none. */
  medianMs: number | null;
  slowest: UsageEntry[];
  recent: UsageEntry[];
}

/** The month's totals, today's, and what the recent questions say about speed. */
export function report(days: DayTotals[], recent: UsageEntry[], today: string): UsageReport {
  const month = today.slice(0, 7);
  const total = days
    .filter((d) => d.day.startsWith(month))
    .reduce((t, d) => ({
      ...t,
      questions: t.questions + d.questions,
      byHouse: t.byHouse + d.byHouse,
      cost: { router: t.cost.router + d.cost.router, live: t.cost.live + d.cost.live, jobs: t.cost.jobs + d.cost.jobs },
      liveSeconds: t.liveSeconds + d.liveSeconds,
      jobs: t.jobs + d.jobs,
      unpriced: t.unpriced + d.unpriced,
    }), emptyDay(month));
  const questions = recent.filter((e) => e.seconds === undefined && e.surface !== "job");
  const times = questions.map((e) => e.ms).sort((a, b) => a - b);
  const medianMs = times.length ? times[Math.floor((times.length - 1) / 2)]! : null;
  return {
    month,
    total,
    today: days.find((d) => d.day === today) ?? emptyDay(today),
    medianMs,
    slowest: [...questions].sort((a, b) => b.ms - a.ms).slice(0, 5),
    recent,
  };
}
