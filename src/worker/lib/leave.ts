import type { Env } from "../types";
import { CALENDAR, call, explain, googleConfig, NeedsRelink } from "./google.ts";

/**
 * "Leave now": for each calendar event with a place, say when to set off.
 *
 * Works with whatever is connected. With Google Maps and a starting point —
 * the car's position from Tessie, else the place saved as "home" — the warning
 * comes at start − live drive time − spare minutes, and the drive time is
 * checked again just before, because traffic moves. Without them it is a
 * plain warning DEFAULT_LEAD_MIN before the start. Without Google Calendar
 * there is nothing to go on, and the routine says so in the panel.
 *
 * Maps bills per route, so drive times are asked for only inside
 * TRAVEL_WINDOW_MS of an event and at most every RECHECK_MS, plus once at the
 * moment of warning: about five routes per event.
 *
 * The planning is pure (plan, due, message) so Node tests it; the calendar
 * read is the only I/O here.
 */

/** How far ahead the calendar is read. */
export const HORIZON_MS = 4 * 3_600_000;
/** How often the calendar is read while a leave routine is on. */
export const SCAN_MS = 15 * 60_000;
/** Drive times are fetched only this close to an event… */
export const TRAVEL_WINDOW_MS = 2 * 3_600_000;
/** …and not more often than this. */
export const RECHECK_MS = 30 * 60_000;
/** At the moment of warning, a drive time older than this is fetched again. */
export const FRESH_MS = 10 * 60_000;
/** With no drive time to go on, warn this long before the start (plus the spare minutes). */
export const DEFAULT_LEAD_MIN = 30;

export interface LeaveEvent {
  id: string;
  summary: string;
  location: string;
  start: number;
}

export interface LeavePlan extends LeaveEvent {
  /** id@start: a moved event is a new plan, and warned about afresh. */
  key: string;
  travelMin: number | null;
  /** Where the drive time was measured from: the car's position, or the saved home. */
  from?: "car" | "home";
  checkedAt: number;
  leaveAt: number;
  /** Warned, or missed; either way, never again. */
  done: boolean;
  /** A fresh drive time pushed the warning later once already; never twice. */
  postponed?: boolean;
}

export const leaveAt = (start: number, travelMin: number | null, bufferMin: number): number =>
  start - ((travelMin ?? DEFAULT_LEAD_MIN) + bufferMin) * 60_000;

/** Fold a fresh read of the calendar into the plans. */
export function mergeEvents(
  plans: Record<string, LeavePlan>,
  events: LeaveEvent[],
  bufferMin: number,
  now: number,
): Record<string, LeavePlan> {
  const out: Record<string, LeavePlan> = {};
  const seen = new Set<string>();
  for (const ev of events) {
    const key = `${ev.id}@${ev.start}`;
    seen.add(key);
    const had = plans[key];
    const moved = had && had.location !== ev.location;
    const p: LeavePlan = had
      ? { ...had, summary: ev.summary, location: ev.location, ...(moved ? { travelMin: null, checkedAt: 0 } : {}) }
      : { ...ev, key, travelMin: null, checkedAt: 0, leaveAt: 0, done: false };
    p.leaveAt = leaveAt(p.start, p.travelMin, bufferMin);
    out[key] = p;
  }
  // Kept: anything already warned about, until an hour after it started, so a
  // re-read of the calendar cannot warn twice. Dropped: a plan whose event has
  // gone (cancelled, or moved — which makes a new key).
  for (const [key, p] of Object.entries(plans)) {
    if (!seen.has(key) && p.done && p.start > now - 3_600_000) out[key] = p;
  }
  return out;
}

/** Which plans want a drive time fetched now. */
export function needsTravel(p: LeavePlan, now: number): boolean {
  return !p.done && p.start - now <= TRAVEL_WINDOW_MS && now - p.checkedAt >= RECHECK_MS;
}

/** The earliest moment anything here needs attention, if anything does. */
export function nextLeaveWake(plans: Record<string, LeavePlan>): number | undefined {
  let next: number | undefined;
  for (const p of Object.values(plans)) {
    if (!p.done && (next === undefined || p.leaveAt < next)) next = p.leaveAt;
  }
  return next;
}

export function leaveMessage(p: LeavePlan, timeZone: string, now: number): { title: string; text: string } {
  const at = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(p.start),
  );
  const inMin = Math.max(0, Math.round((p.start - now) / 60_000));
  if (p.travelMin === null) {
    return { title: `${p.summary} at ${at}`, text: `${p.summary} starts at ${at}, in ${inMin} minutes, at ${p.location}.` };
  }
  const late = now + p.travelMin * 60_000 > p.start;
  return {
    title: late ? "You'll be late" : "Time to leave",
    text: late
      ? `${p.summary} starts at ${at}, and the drive to ${p.location} is about ${p.travelMin} minutes right now. Leave as soon as you can.`
      : `Time to leave for ${p.summary} at ${at}: about ${p.travelMin} minutes ${p.from === "home" ? "from home " : ""}to ${p.location} in current traffic.`,
  };
}

/* ---------- the calendar ---------------------------------------------------- */

interface CalItem {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** A place someone can drive to, not a video call. */
function drivable(location: string): boolean {
  return !/https?:\/\/|zoom\.us|meet\.google|teams\.microsoft|webex/i.test(location) && location.length >= 3;
}

const tidy = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export function eventsFrom(items: CalItem[]): LeaveEvent[] {
  const out: LeaveEvent[] = [];
  for (const e of items) {
    if (e.status === "cancelled" || !e.id || !e.start?.dateTime) continue; // all-day: nowhere to be at a time
    if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
    const location = tidy(e.location ?? "");
    if (!location || !drivable(location)) continue;
    const start = Date.parse(e.start.dateTime);
    if (!Number.isFinite(start)) continue;
    out.push({ id: e.id, summary: tidy(e.summary ?? "") || "Your event", location, start });
  }
  return out;
}

/** The next few hours of the primary calendar, or a sentence saying why not. */
export async function upcomingEvents(env: Env, now: number): Promise<LeaveEvent[] | string> {
  const cfg = googleConfig(env, "https://jarvis.invalid");
  if (!cfg) return "Google is not set up, so there is no calendar to read.";
  const p = new URLSearchParams({
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + HORIZON_MS).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "15",
  });
  try {
    const res = await call(env, cfg, `/calendars/primary/events?${p}`, { base: CALENDAR, signal: AbortSignal.timeout(10_000) });
    const problem = explain(res);
    if (problem) return problem;
    return eventsFrom(((res.body as { items?: CalItem[] } | null)?.items ?? []) as CalItem[]);
  } catch (e) {
    if (e instanceof NeedsRelink) return "The Google link has expired; link it again in the settings panel.";
    const msg = e instanceof Error ? e.message : String(e);
    return /not linked/i.test(msg) ? "No Google account is linked yet." : `Calendar error: ${msg}`;
  }
}
