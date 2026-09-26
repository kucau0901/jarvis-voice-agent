import { saneGrants, type Grant } from "./scopes.ts";

/**
 * Routines: things Jarvis does without being asked.
 *
 * A routine is a trigger and an action. The Durable Object keeps them and
 * wakes itself with an alarm when the next one is due (lib/scheduler.ts), so
 * nothing depends on a screen being open — the car's tab cannot run in the
 * background, and nothing automatic may open a paid voice session. What a
 * routine produces is an alert (lib/alerts.ts), which finds its own way to you.
 *
 * Triggers:
 *   once    at a moment: "remind me at five to call Mum"
 *   daily   at a time of day, on chosen weekdays: "every weekday at 7:30"
 *   event   when something sends that event to /api/v1/trigger — Home
 *           Assistant, Node-RED, IFTTT, a phone shortcut: "arrived_home"
 *   leave   for each calendar event with a place: when to set off, from the
 *           car's position and live traffic where those are available
 *
 * Actions:
 *   say     a fixed message
 *   ask     a question for Jarvis, answered then with every tool the
 *           routine's creator may use, and the answer sent: "what's my day?"
 *
 * This file is the pure part — shapes, validation, time zones — so Node tests it.
 */

export type Trigger =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string; days: number[] }
  | { kind: "event"; event: string }
  | { kind: "leave"; bufferMin: number }
  /**
   * Watches: a Home Assistant template that is true while the thing to watch
   * for is happening ("{{ is_state('cover.main_gate', 'open') }}"), checked
   * every minute by the alarm with no model involved (lib/scheduler.ts). It
   * fires once when it has been true for forMin minutes, and again only after
   * it has been false.
   */
  | { kind: "watch"; template: string; forMin: number };

export type Action = { kind: "say"; text: string } | { kind: "ask"; prompt: string } | { kind: "leave" };

export interface RunRecord {
  at: number;
  ok: boolean;
  detail: string;
}

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  /**
   * What the routine's creator could reach. An `ask` runs with exactly this, so
   * a device allowed only the house cannot schedule a question that reads mail.
   */
  grants: Grant[];
  /** "owner", or the device id that made it. */
  createdBy: string;
  createdAt: number;
  /** When a once or daily routine next fires. */
  nextAt?: number;
  /** Queued by an event or by "run now", for the next alarm to pick up. */
  pending?: { at: number; data?: string };
  lastRun?: RunRecord;
  /** A watch's own record of its checks. */
  watch?: WatchState;
}

export interface WatchState {
  /** When it is next looked at. */
  nextCheck?: number;
  checkedAt?: number;
  /** When the condition last became true, while it still is. */
  trueSince?: number;
  /** Already said, for this spell of being true. */
  fired?: boolean;
  /** Checks in a row that failed. */
  errors?: number;
}

export const MAX_WATCHES = 10;
export const MAX_TEMPLATE = 500;

export const MAX_ROUTINES = 50;
export const MAX_TEXT = 1000;
const MAX_NAME = 60;
export const EVENT_NAME = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/* ---------- time zones ------------------------------------------------------ */

export interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  /** 0 = Sunday, as Date.getDay. */
  dow: number;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(ts: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    h: Number(get("hour")),
    mi: Number(get("minute")),
    dow: DOW[get("weekday")] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(ts: number, timeZone: string): number {
  const p = localParts(ts, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ts / 60_000) * 60_000;
}

/**
 * The instant a wall-clock time happens in a zone. Two passes, because the
 * offset to use is the one in force at the answer, which may differ from the
 * one at the guess across a daylight-saving change.
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

/** The next time `HH:MM` comes round in the zone after `after`, on one of `days` (all when empty). */
export function nextDaily(time: string, days: readonly number[], timeZone: string, after: number): number | undefined {
  const m = HHMM.exec(time);
  if (!m) return undefined;
  const p = localParts(after, timeZone);
  for (let i = 0; i <= 8; i++) {
    // Calendar arithmetic on the local date, done in UTC where days have no gaps.
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    if (days.length && !days.includes(day.getUTCDay())) continue;
    const ts = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(m[1]), Number(m[2]), timeZone);
    if (ts > after) return ts;
  }
  return undefined;
}

/** When a routine next fires by the clock; undefined for those that wait on something else. */
export function nextRun(r: Pick<Routine, "trigger">, timeZone: string, now: number): number | undefined {
  const t = r.trigger;
  if (t.kind === "once") return t.at > now ? t.at : undefined;
  if (t.kind === "daily") return nextDaily(t.time, t.days, timeZone, now);
  return undefined;
}

/* ---------- saying what a routine does -------------------------------------- */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysSaid(days: readonly number[]): string {
  const set = [...new Set(days)].sort();
  if (!set.length || set.length === 7) return "every day";
  if (set.join() === "1,2,3,4,5") return "weekdays";
  if (set.join() === "0,6") return "weekends";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}

export function whenSaid(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts));
}

export function describeTrigger(t: Trigger, timeZone: string): string {
  switch (t.kind) {
    case "once":
      return `once, ${whenSaid(t.at, timeZone)}`;
    case "daily":
      return `${daysSaid(t.days)} at ${t.time}`;
    case "event":
      return `when the event "${t.event}" arrives`;
    case "leave":
      return `when it is time to leave for a calendar event with a place (${t.bufferMin} min to spare)`;
    case "watch":
      return `when ${t.template} is true${t.forMin ? ` for ${t.forMin} minute${t.forMin === 1 ? "" : "s"}` : ""} (checked every minute)`;
  }
}

export function describeAction(a: Action): string {
  if (a.kind === "say") return `say "${a.text.length > 80 ? a.text.slice(0, 80) + "…" : a.text}"`;
  if (a.kind === "ask") return `ask Jarvis "${a.prompt.length > 80 ? a.prompt.slice(0, 80) + "…" : a.prompt}" and send the answer`;
  return "say when to set off, with the drive time";
}

/* ---------- building one from untrusted input -------------------------------- */

/**
 * What the panel, the API and the voice tool all send. Loose on purpose: each
 * caller has its own shape, and every one is checked here the same way.
 */
export interface RoutineInput {
  name?: unknown;
  when?: unknown; // "once" | "daily" | "event" | "leave"
  /** once: local wall-clock time, "2026-09-26T17:00", in the user's zone. */
  localTime?: unknown;
  /** once: or this many minutes from now. */
  inMinutes?: unknown;
  /** once: or an absolute instant in ms, from the API. */
  at?: unknown;
  /** daily: "07:30". */
  time?: unknown;
  /** daily: 0–6 (Sunday first) or "mon".."sun"; empty or absent is every day. */
  days?: unknown;
  /** event: its name. */
  event?: unknown;
  /** leave: minutes to spare on top of the drive. */
  bufferMin?: unknown;
  /** watch: a Home Assistant template, true while the thing is happening. */
  condition?: unknown;
  /** watch: how long it must stay true first; 0 for at once. */
  forMinutes?: unknown;
  say?: unknown;
  ask?: unknown;
}

const DAY_KEYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function parseDays(v: unknown): number[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "days must be a list";
  const out: number[] = [];
  for (const d of v) {
    const n = typeof d === "number" ? d : DAY_KEYS[String(d).trim().toLowerCase().slice(0, 3)];
    if (n === undefined || !Number.isInteger(n) || n < 0 || n > 6) return `"${String(d)}" is not a day`;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort();
}

export type Built = { ok: true; trigger: Trigger; action: Action; name: string } | { ok: false; error: string };

export function buildRoutine(input: RoutineInput, timeZone: string, now: number): Built {
  const when = str(input.when).toLowerCase();
  let trigger: Trigger;

  if (when === "once") {
    let at: number | undefined;
    const local = LOCAL.exec(str(input.localTime));
    const mins = Number(input.inMinutes);
    if (typeof input.at === "number" && Number.isFinite(input.at)) at = input.at;
    else if (local) at = zonedToUtc(+local[1]!, +local[2]!, +local[3]!, +local[4]!, +local[5]!, timeZone);
    else if (input.inMinutes !== undefined && input.inMinutes !== null && Number.isFinite(mins)) at = now + Math.round(mins) * 60_000;
    if (at === undefined) return { ok: false, error: "a one-off routine needs a time: localTime (2026-09-26T17:00) or inMinutes" };
    if (at < now + 30_000) return { ok: false, error: "that time has already passed" };
    if (at > now + 366 * 86_400_000) return { ok: false, error: "that is more than a year away" };
    trigger = { kind: "once", at };
  } else if (when === "daily") {
    const time = str(input.time);
    if (!HHMM.test(time)) return { ok: false, error: "a daily routine needs a time of day, like 07:30" };
    const days = parseDays(input.days);
    if (typeof days === "string") return { ok: false, error: days };
    trigger = { kind: "daily", time, days };
  } else if (when === "event") {
    const event = str(input.event).toLowerCase();
    if (!EVENT_NAME.test(event)) return { ok: false, error: "an event name is letters, digits and _ . : - (up to 40), like arrived_home" };
    trigger = { kind: "event", event };
  } else if (when === "leave") {
    const b = input.bufferMin === undefined || input.bufferMin === null ? 10 : Number(input.bufferMin);
    if (!Number.isInteger(b) || b < 0 || b > 120) return { ok: false, error: "the spare time must be 0 to 120 minutes" };
    trigger = { kind: "leave", bufferMin: b };
  } else if (when === "watch") {
    const template = str(input.condition);
    if (!template.includes("{{") || !template.includes("}}")) {
      return { ok: false, error: "a watch needs a condition: a Home Assistant template such as {{ is_state('cover.main_gate', 'open') }}" };
    }
    if (template.length > MAX_TEMPLATE) return { ok: false, error: `keep the condition under ${MAX_TEMPLATE} characters` };
    const f = input.forMinutes === undefined || input.forMinutes === null ? 0 : Number(input.forMinutes);
    if (!Number.isInteger(f) || f < 0 || f > 1440) return { ok: false, error: "for_minutes must be 0 to 1440" };
    trigger = { kind: "watch", template, forMin: f };
  } else {
    return { ok: false, error: "when must be once, daily, event, leave or watch" };
  }

  let action: Action;
  if (trigger.kind === "leave") {
    action = { kind: "leave" };
  } else {
    const say = str(input.say);
    const ask = str(input.ask);
    if (!!say === !!ask) return { ok: false, error: "give exactly one of say (a message) or ask (a question for Jarvis)" };
    if ((say || ask).length > MAX_TEXT) return { ok: false, error: `keep it under ${MAX_TEXT} characters` };
    action = say ? { kind: "say", text: say } : { kind: "ask", prompt: ask };
  }

  const fallback =
    action.kind === "say" ? action.text : action.kind === "ask" ? action.prompt : "Time to leave";
  const name = (str(input.name) || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_NAME);
  return { ok: true, trigger, action, name };
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newRoutineId(): string {
  let s = "r";
  for (const b of crypto.getRandomValues(new Uint8Array(9))) s += ALPHABET[b & 31];
  return s;
}

export function makeRoutine(
  built: Extract<Built, { ok: true }>,
  by: { who: string; grants: readonly Grant[] },
  timeZone: string,
  now: number,
): Routine {
  const r: Routine = {
    id: newRoutineId(),
    name: built.name,
    enabled: true,
    trigger: built.trigger,
    action: built.action,
    grants: saneGrants([...by.grants]),
    createdBy: by.who,
    createdAt: now,
  };
  const next = nextRun(r, timeZone, now);
  if (next !== undefined) r.nextAt = next;
  return r;
}
