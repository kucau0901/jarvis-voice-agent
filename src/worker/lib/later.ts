import { LOCAL, zonedToUtc } from "./routines.ts";
import type { Proposal } from "./proposals.ts";

/**
 * Errands for later (docs/DESIGN.md, "Read; propose, never act"): a call
 * proposed now and put to its person only when it is wanted, at a time,
 * before a calendar event, or on getting home or leaving it. A job asks
 * for one with its held tool's `later` (lib/proposals.ts held); a brief
 * stages one itself (lib/brief.ts, the car's climate before an event).
 *
 * Until then it is kept apart (Proposals, propstage:), so nothing lists it
 * as waiting and nothing can approve it. The object's alarm puts it to them
 * when its time comes (Proposals.tick), as an ordinary card with a "Ready
 * now" alert, once it has checked again that the call still reads as it did
 * and they may still make it. This file is the pure part: the forms, what a
 * job may ask for, how they are said, and Home Assistant's one check.
 */

/** When it is put to them. An event's id and title are code's, read from the calendar, never the job's words. */
export type Release =
  | { at: number }
  | { event: { id: string; start: number; title: string; leadMin: number; moved?: boolean } }
  | { home: "arrive" | "leave" };

/** A home errand's look at where they are: when next, failures in a row, and what was seen last. */
export interface Check {
  next: number;
  errors: number;
  was?: boolean;
}

/** A proposal staged: the record it will be, kept apart until it is put to them. */
export type Staged = Proposal & { release: Release; stagedAt: number; until: number; check?: Check };
export const isStaged = (p: Proposal): p is Staged => "stagedAt" in p && !!p.release;

/** What a job asked for, before code finds its event. */
export type Asked = { at: number } | { event: { start: number; leadMin: number } } | { home: "arrive" | "leave" };

const DAY = 86_400_000;
/** At least this far ahead: sooner is now, and the card is filed as it is. */
export const MIN_AHEAD_MS = 2 * 60_000;
/** At most a week ahead. */
export const MAX_AHEAD_MS = 7 * DAY;
/** An errand for a time is still put to them this long after it, if the alarm was late; then it is not needed. */
export const AT_GRACE_MS = 30 * 60_000;
/** One for getting home or leaving waits this long for it, then is not needed. */
export const HOME_MS = 3 * DAY;
/** How far before an event, when the job does not say. */
export const LEAD_MIN = 30;
/** Staged at once, each person; for getting home or leaving, the whole household (one Home Assistant look a minute covers them all). */
export const MAX_STAGED = 10;
export const MAX_HOME = 10;

/** Google's ISO with an offset, as calendar_check gives a start. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** A Home Assistant person or tracker, as Family keeps it (routes/hub.ts). */
export const PRESENCE = /^(person|device_tracker)\.[a-z0-9_]+$/;

/** The property every held tool gains (lib/proposals.ts held): strict, and null for now. */
export const LATER_PARAM = {
  type: ["object", "null"],
  description:
    "Null to ask the user now. To ask them only later: exactly one of at (their local time, YYYY-MM-DDTHH:MM), " +
    "before_event (the event's start exactly as calendar_check gave it, with minutes_before, default 30), " +
    "or home (\"arrive\": when they next get home; \"leave\": when they next leave it). At most a week ahead.",
  properties: {
    at: { type: ["string", "null"] },
    before_event: { type: ["string", "null"] },
    minutes_before: { type: ["integer", "null"] },
    home: { type: ["string", "null"], enum: ["arrive", "leave", null] },
  },
  required: ["at", "before_event", "minutes_before", "home"],
  additionalProperties: false,
};

/** A job's `later`: null for now, what it asked for, or why it cannot be. */
export function parseLater(raw: unknown, timeZone: string, now: number): Asked | string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "later must be an object, or null";
  const v = raw as { at?: unknown; before_event?: unknown; minutes_before?: unknown; home?: unknown };
  const given = [v.at, v.before_event, v.home].filter((x) => x !== null && x !== undefined);
  if (!given.length) return null;
  if (given.length > 1) return "later takes one of at, before_event or home, not more";
  const ahead = (t: number) => (t < now + MIN_AHEAD_MS ? "that is too soon to wait for: ask now instead" : t > now + MAX_AHEAD_MS ? "that is more than a week away" : null);
  if (v.at !== null && v.at !== undefined) {
    const m = typeof v.at === "string" ? LOCAL.exec(v.at.trim()) : null;
    if (!m) return "later.at is their local time, YYYY-MM-DDTHH:MM";
    const at = zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, timeZone);
    return ahead(at) ?? { at };
  }
  if (v.before_event !== null && v.before_event !== undefined) {
    const start = typeof v.before_event === "string" && ISO.test(v.before_event.trim()) ? Date.parse(v.before_event.trim()) : NaN;
    if (!Number.isFinite(start)) return "later.before_event is the event's start as calendar_check gave it, with its offset";
    const lead = v.minutes_before === null || v.minutes_before === undefined ? LEAD_MIN : Number(v.minutes_before);
    if (!Number.isInteger(lead) || lead < 0 || lead > 180) return "later.minutes_before is 0 to 180";
    return ahead(start - lead * 60_000) ?? { event: { start, leadMin: lead } };
  }
  return v.home === "arrive" || v.home === "leave" ? { home: v.home } : 'later.home is "arrive" or "leave"';
}

/** When its time has passed it is not needed: half an hour after a time, the event's start, or three days of waiting for home. */
export function untilOf(r: Release, stagedAt: number): number {
  return "at" in r ? r.at + AT_GRACE_MS : "event" in r ? r.event.start : stagedAt + HOME_MS;
}

/** When a timed one is due; one for home is due when they arrive or leave (Proposals' look). */
export function dueAt(r: Release): number | null {
  return "at" in r ? r.at : "event" in r ? r.event.start - r.event.leadMin * 60_000 : null;
}

const time = (ts: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));

/** When, in words, from code's own facts: "When you get home", "30 min before “Dentist”, Thu 23 Oct, 10:00". */
export function whenSaid(r: Release, timeZone: string): string {
  if ("home" in r) return r.home === "arrive" ? "When you get home" : "When you leave home";
  if ("at" in r) return `At ${time(r.at, timeZone)}`;
  const e = r.event;
  const title = e.title.length > 60 ? `${e.title.slice(0, 59)}…` : e.title;
  return `${e.leadMin ? `${e.leadMin} min before` : "At the start of"} “${title}”, ${time(e.start, timeZone)}`;
}

/** The same within a sentence: "(when you get home)", "(30 min before “Dentist”, …)". */
export function whenInline(r: Release, timeZone: string): string {
  const w = whenSaid(r, timeZone);
  return w.charAt(0).toLowerCase() + w.slice(1);
}

/** One Home Assistant look at everyone waited on: `{"<id>": true, …}`, true for at home. Null when there is nothing valid to look at. */
export function presenceTemplate(entries: readonly { id: string; entity: string }[]): string | null {
  const ok = entries.filter((e) => /^a[0-9a-z]{20}$/.test(e.id) && PRESENCE.test(e.entity));
  if (!ok.length) return null;
  return `{{ { ${ok.map((e) => `'${e.id}': is_state('${e.entity}', 'home')`).join(", ")} } | tojson }}`;
}

/** That look's answer, by id; null when it is not one. */
export function presenceRead(raw: string): Map<string, boolean> | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return new Map(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
  } catch {
    return null;
  }
}
