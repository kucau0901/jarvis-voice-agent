import type { Env } from "../types.ts";
import { CALENDAR, call, explain, googleConfig, guardTool } from "./google.ts";
import { tidy } from "./quote.ts";
import { dayBegins, localParts, zonedToUtc } from "./routines.ts";

/**
 * A day on the calendar, for a brief (lib/brief.ts): the events, which of
 * them clash, the free time between, and invitations left unanswered.
 *
 * One read of the primary calendar covers it all; the rest is pure, so Node
 * tests it. Everything here except the times was written by whoever made the
 * event, so it reaches a model only through asQuotedData (lib/quote.ts).
 */

export interface AgendaEvent {
  id: string;
  /** The recurring event it is one of, or its own id: one invitation, however many times it happens. */
  series: string;
  summary: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  /** Shown as free ("transparency": "transparent"): it takes no time. */
  free: boolean;
  declined: boolean;
  /** An invitation from someone else, not answered yet. */
  unanswered: boolean;
  /** Who sent it, when that was not them. */
  organizer: string;
  created: number;
}

interface CalItem {
  id?: string;
  recurringEventId?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  transparency?: string;
  created?: string;
  organizer?: { self?: boolean; displayName?: string; email?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** A whole day's "2026-10-21" as the instant it starts in the zone. */
function dayStart(date: string, timeZone: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return dayBegins(y!, mo!, d!, timeZone);
}

export function agendaFrom(items: CalItem[], timeZone: string): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  for (const e of items) {
    if (e.status === "cancelled" || !e.id) continue;
    const allDay = !e.start?.dateTime && !!e.start?.date;
    const start = allDay ? dayStart(e.start!.date!, timeZone) : Date.parse(e.start?.dateTime ?? "");
    const end = allDay ? dayStart(e.end?.date ?? e.start!.date!, timeZone) : Date.parse(e.end?.dateTime ?? "");
    if (!Number.isFinite(start)) continue;
    const self = e.attendees?.find((a) => a.self);
    out.push({
      id: e.id,
      series: e.recurringEventId || e.id,
      summary: tidy(e.summary ?? "").slice(0, 200) || "(no title)",
      location: tidy(e.location ?? "").slice(0, 200),
      start,
      end: Number.isFinite(end) && end > start ? end : start,
      allDay,
      free: e.transparency === "transparent",
      declined: self?.responseStatus === "declined",
      unanswered: !e.organizer?.self && self?.responseStatus === "needsAction",
      organizer: e.organizer?.self ? "" : tidy(e.organizer?.displayName || e.organizer?.email || "").slice(0, 80),
      created: Date.parse(e.created ?? "") || 0,
    });
  }
  return out;
}

/** At most this many events in one read. */
export const AGENDA_MAX = 100;

/**
 * The primary calendar from `from` to `to`, at most AGENDA_MAX events, or a
 * sentence saying why not. `cut`: Google has more (a page may hold fewer
 * than asked for while more match), so the read ends at its last event.
 */
export async function agendaEvents(env: Env, from: number, to: number, timeZone: string, signal: AbortSignal): Promise<{ events: AgendaEvent[]; cut: boolean } | string> {
  return guardTool(async () => {
    const cfg = googleConfig(env, "https://jarvis.invalid");
    if (!cfg) return "Google is not set up.";
    const p = new URLSearchParams({
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(AGENDA_MAX),
    });
    const res = await call(env, cfg, `/calendars/primary/events?${p}`, { base: CALENDAR, signal });
    const problem = explain(res);
    if (problem) return problem;
    const body = res.body as { items?: CalItem[]; nextPageToken?: string } | null;
    return { events: agendaFrom(body?.items ?? [], timeZone), cut: !!body?.nextPageToken };
  }, { notLinked: "Link Google in Family → Accounts to see the calendar here.", relink: "Google needs linking again: Family → Accounts.", prefix: "Calendar" });
}

/** The event that starts then (within a minute), as a job named it by its start: an errand before it (lib/later.ts); why not, in words. */
export async function eventNear(env: Env, start: number, timeZone: string, signal: AbortSignal): Promise<AgendaEvent | string> {
  const got = await agendaEvents(env, start - 60_000, start + 60_000, timeZone, signal);
  if (typeof got === "string") return got;
  return got.events.find((e) => !e.allDay && !e.declined && Math.abs(e.start - start) <= 60_000) ?? "No event in their calendar starts then: give its start as calendar_check gave it.";
}

/** One event as their calendar has it now, for an errand before it: its start, "gone", or null when it could not be read. */
export async function eventById(env: Env, id: string, timeZone: string, signal: AbortSignal): Promise<{ start: number } | "gone" | null> {
  const cfg = googleConfig(env, "https://jarvis.invalid");
  if (!cfg || !/^[A-Za-z0-9_]{5,1024}$/.test(id)) return null;
  try {
    const res = await call(env, cfg, `/calendars/primary/events/${encodeURIComponent(id)}`, { base: CALENDAR, signal });
    if (res.status === 404 || res.status === 410) return "gone";
    if (explain(res)) return null;
    const [e] = agendaFrom([res.body as CalItem], timeZone);
    return !e || e.declined ? "gone" : { start: e.start };
  } catch {
    return null;
  }
}

/** Takes up time: at a time, for some time, not shown as free, not declined. */
export const busy = (e: AgendaEvent) => !e.allDay && !e.free && !e.declined && e.end > e.start;

/** Pairs of busy events that overlap, each pair once, in order of the first's start. */
export function overlaps(events: readonly AgendaEvent[]): [AgendaEvent, AgendaEvent][] {
  const b = events.filter(busy).sort((x, y) => x.start - y.start);
  const out: [AgendaEvent, AgendaEvent][] = [];
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length && b[j]!.start < b[i]!.end; j++) out.push([b[i]!, b[j]!]);
  }
  return out;
}

/** The day's free time between 08:00 and 20:00, in gaps of half an hour or more, from `from` on. */
export const DAY_FROM_H = 8;
export const DAY_TO_H = 20;
const MIN_GAP_MS = 30 * 60_000;

export function freeSlots(events: readonly AgendaEvent[], day: number, timeZone: string, from: number): { start: number; end: number }[] {
  const p = localParts(day, timeZone);
  const open = Math.max(from, zonedToUtc(p.y, p.mo, p.d, DAY_FROM_H, 0, timeZone));
  const close = zonedToUtc(p.y, p.mo, p.d, DAY_TO_H, 0, timeZone);
  const out: { start: number; end: number }[] = [];
  let at = open;
  for (const e of events.filter(busy).sort((x, y) => x.start - y.start)) {
    if (e.end <= at) continue;
    if (e.start >= close) break;
    if (e.start - at >= MIN_GAP_MS) out.push({ start: at, end: e.start });
    at = Math.max(at, e.end);
  }
  if (close - at >= MIN_GAP_MS) out.push({ start: at, end: close });
  return out;
}

/** Old enough that an invitation left unanswered is worth a word. */
export const STALE_MS = 3 * 86_400_000;
const AHEAD_MS = 7 * 86_400_000;

/** Invitations from someone else, unanswered three days or more, for something in the next week: a series once, at its next time. */
export function staleInvites(events: readonly AgendaEvent[], now: number): AgendaEvent[] {
  const seen = new Set<string>();
  const out: AgendaEvent[] = [];
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    if (!e.unanswered || !e.created || now - e.created < STALE_MS || e.start < now || e.start >= now + AHEAD_MS || seen.has(e.series)) continue;
    seen.add(e.series);
    out.push(e);
  }
  return out;
}
