import type { Env } from "../types.ts";
import { calendarEvents, type LeaveEvent } from "./leave.ts";
import { localParts } from "./routines.ts";
import { sanitise } from "./memory.ts";
import { localeOf } from "./locale.ts";

/**
 * Where someone works, as their calendar suggests it, for Family → You to
 * offer (ui/Profile.ts): the place they have been on most days of the last
 * month, if on enough of them. Only offered, never saved without a tap: a
 * calendar can be wrong, and an address is said with every question.
 */

export const LOOK_BACK_DAYS = 30;
/** On at least this many days: one meeting somewhere is not work. */
export const MIN_DAYS = 3;
const MAX_EVENTS = 250;

export interface WorkGuess {
  address: string;
  days: number;
}

/** The place on most local days, if on MIN_DAYS or more, leaving out those already saved (`known`) and anything memory would refuse. */
export function guessWork(events: readonly LeaveEvent[], timeZone: string, known: readonly string[]): WorkGuess | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const skip = new Set(known.map(norm));
  const seen = new Map<string, { address: string; days: Set<string> }>();
  for (const e of events) {
    const clean = sanitise(e.location);
    if (!clean.ok || skip.has(norm(clean.text))) continue;
    const p = localParts(e.start, timeZone);
    const at = seen.get(norm(clean.text)) ?? { address: clean.text, days: new Set<string>() };
    at.days.add(`${p.y}-${p.mo}-${p.d}`);
    seen.set(norm(clean.text), at);
  }
  const best = [...seen.values()].sort((a, b) => b.days.size - a.days.size)[0];
  return best && best.days.size >= MIN_DAYS ? { address: best.address, days: best.days.size } : null;
}

/** The guess from their own calendar's last month: only events they made or accepted. Why not, in words, when it cannot be read. */
export async function workFromCalendar(env: Env, now: number, known: readonly string[]): Promise<WorkGuess | null | string> {
  const events = await calendarEvents(env, now - LOOK_BACK_DAYS * 86_400_000, now, MAX_EVENTS, true);
  return typeof events === "string" ? events : guessWork(events, localeOf(env).timeZone, known);
}
