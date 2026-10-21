import { saneGrants, type Grant } from "./scopes.ts";
import { pageCondition, pageUrl } from "./page-look.ts";

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
 *   cron    on a cron schedule, for what daily cannot say: "at 8 and 12",
 *           "every 6 hours", "on the 1st of the month"; at most hourly
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
  /** Five fields, minute hour day month weekday, in the deployment's zone as daily is; one minute only, so at most hourly. */
  | { kind: "cron"; expr: string }
  | { kind: "event"; event: string }
  | { kind: "leave"; bufferMin: number }
  /**
   * Watches: a Home Assistant template that is true while the thing to watch
   * for is happening ("{{ is_state('cover.main_gate', 'open') }}"), checked
   * every minute by the alarm with no model involved (lib/scheduler.ts). It
   * fires once when it has been true for forMin minutes, and again only after
   * it has been false.
   */
  | { kind: "watch"; template: string; forMin: number }
  /**
   * A web page watched for an alert ("tell me when the air is unhealthy"),
   * set from a panel's tile (routes/panels.ts): the page found once is
   * fetched every `everyMin` minutes, never under an hour, and read by the
   * cheapest model with no search (lib/page-look.ts). It fires as a watch
   * does: once when `condition` turns true, again only after it was false.
   */
  | { kind: "page"; url: string; question: string; condition: string; everyMin: number };

export type Action =
  | { kind: "say"; text: string }
  /** notify "if-important": the answer is sent only when it is not NOTHING (lib/scheduler.ts); absent, always. */
  | { kind: "ask"; prompt: string; notify?: "if-important" }
  | { kind: "leave" }
  /**
   * Passed on to someone in the family (lib/relays.ts), or to several in
   * turn: a chore rota, a daily check-in on a grandparent, a medicine
   * reminder. Done earns a chore its points; a check-in or medicine left
   * unanswered tells the whole family (`escalate`).
   */
  | {
      kind: "relay";
      relay: "remind" | "ask";
      to: { person: string; name: string }[];
      text: string;
      points?: number;
      escalate?: boolean;
      /** How long they have to answer, in minutes; the family's setting if absent. */
      answerMin?: number;
      /** Whose turn is next, for a rota. */
      turn?: number;
    };

export interface RunRecord {
  at: number;
  ok: boolean;
  detail: string;
}

/** One of a routine's past runs, as Routines → Past runs shows them (lib/scheduler.ts): with what it said, when it said something. */
export interface RunEntry extends RunRecord {
  said?: string;
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
/** Pages watched, at most: each look costs a little, unlike a watch's. */
export const MAX_PAGES = 10;
/** A page is looked at no more than hourly, and at least daily. */
export const PAGE_EVERY_MIN = 60;
const PAGE_EVERY_MAX = 24 * 60;
const MAX_TEMPLATE = 500;

export const MAX_ROUTINES = 50;
const MAX_TEXT = 1000;
const MAX_NAME = 60;
export const EVENT_NAME = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

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

/** A cron schedule, read: the values each field allows, and whether the two day fields were left open. */
interface Cron {
  min: number[];
  hour: number[];
  dom: number[];
  mon: number[];
  dow: number[];
  anyDom: boolean;
  anyDow: boolean;
}

const CRON_FIELDS: { name: string; lo: number; hi: number; names?: string[] }[] = [
  { name: "minute", lo: 0, hi: 59 },
  { name: "hour", lo: 0, hi: 23 },
  { name: "day of the month", lo: 1, hi: 31 },
  { name: "month", lo: 1, hi: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  // 7 is Sunday too, as in most crons.
  { name: "weekday", lo: 0, hi: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

/**
 * The classic five fields, each a list of `*`, `n`, `a-b` and `/step`, with
 * month and weekday names; nothing else (no L, W, # or @daily). Why not, in
 * words, when it is not one.
 */
export function parseCron(expr: string): Cron | string {
  const fields = expr.trim().toLowerCase().split(/\s+/);
  if (fields.length !== 5) return "a cron schedule is five fields, minute hour day month weekday, like 0 8,12 * * *";
  const sets: number[][] = [];
  for (const [i, field] of fields.entries()) {
    const spec = CRON_FIELDS[i]!;
    const value = (v: string) => {
      const named = spec.names?.indexOf(v.slice(0, 3)) ?? -1;
      if (named >= 0 && /^[a-z]+$/.test(v)) return named + (spec.name === "month" ? 1 : 0);
      return /^\d{1,2}$/.test(v) ? Number(v) : NaN;
    };
    const set = new Set<number>();
    for (const part of field.split(",")) {
      const m = /^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d{1,2}))?$/.exec(part);
      if (!m) return `the ${spec.name} cannot be "${part}"`;
      const step = m[3] ? Number(m[3]) : 1;
      const lo = m[1] === "*" ? spec.lo : value(m[1]!);
      let hi = m[1] === "*" ? spec.hi : m[2] ? value(m[2]) : m[3] ? spec.hi : lo;
      // "sat-sun": a range ends on Sunday as 7.
      if (spec.name === "weekday" && m[2] && hi === 0) hi = 7;
      if (!(lo >= spec.lo && hi <= spec.hi && lo <= hi && step >= 1)) return `the ${spec.name} cannot be "${part}" (${spec.lo} to ${spec.hi})`;
      for (let v = lo; v <= hi; v += step) set.add(spec.name === "weekday" && v === 7 ? 0 : v);
    }
    sets.push([...set].sort((a, b) => a - b));
  }
  return { min: sets[0]!, hour: sets[1]!, dom: sets[2]!, mon: sets[3]!, dow: sets[4]!, anyDom: fields[2]!.startsWith("*"), anyDow: fields[4]!.startsWith("*") };
}

/** How far ahead a schedule is looked for: four years and a day, so a 29 February comes round. */
const CRON_DAYS = 4 * 366 + 1;

/** The next time a cron schedule comes round in the zone after `after`; as nextDaily does it. */
export function nextCron(expr: string, timeZone: string, after: number): number | undefined {
  const c = parseCron(expr);
  if (typeof c === "string") return undefined;
  const p = localParts(after, timeZone);
  for (let i = 0; i <= CRON_DAYS; i++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    if (!c.mon.includes(day.getUTCMonth() + 1)) continue;
    const onDom = c.dom.includes(day.getUTCDate());
    const onDow = c.dow.includes(day.getUTCDay());
    // As cron has it: with both day fields restricted, either will do; with one starred ("*" or "*/2"), both must.
    if (!(c.anyDom || c.anyDow ? onDom && onDow : onDom || onDow)) continue;
    for (const h of c.hour) {
      for (const mi of c.min) {
        if (i === 0 && (h < p.h || (h === p.h && mi <= p.mi))) continue;
        const ts = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, timeZone);
        if (ts > after) return ts;
      }
    }
  }
  return undefined;
}

/** When a routine next fires by the clock; undefined for those that wait on something else. */
export function nextRun(r: Pick<Routine, "trigger">, timeZone: string, now: number): number | undefined {
  const t = r.trigger;
  if (t.kind === "once") return t.at > now ? t.at : undefined;
  if (t.kind === "daily") return nextDaily(t.time, t.days, timeZone, now);
  if (t.kind === "cron") return nextCron(t.expr, timeZone, now);
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
    case "cron":
      return `on the schedule "${t.expr}" (minute hour day month weekday)`;
    case "event":
      return `when the event "${t.event}" arrives`;
    case "leave":
      return `when it is time to leave for a calendar event with a place (${t.bufferMin} min to spare)`;
    case "watch":
      return `when ${t.template} is true${t.forMin ? ` for ${t.forMin} minute${t.forMin === 1 ? "" : "s"}` : ""} (checked every minute)`;
    case "page": {
      const every = t.everyMin % 60 ? `${t.everyMin} minutes` : t.everyMin === 60 ? "hour" : `${t.everyMin / 60} hours`;
      return `when ${new URL(t.url).hostname} says ${pageCondition(t.condition)} (read every ${every}, about a tenth of a cent a look)`;
    }
  }
}

export function describeAction(a: Action): string {
  if (a.kind === "relay") {
    const who = a.to.length > 1 ? `${a.to.map((p) => p.name).join(", then ")}, in turn` : a.to[0]?.name ?? "someone";
    const what = `${a.relay === "ask" ? "ask" : "remind"} ${who}: "${a.text.length > 80 ? a.text.slice(0, 80) + "…" : a.text}"`;
    return what + (a.points ? `, ${a.points} point${a.points === 1 ? "" : "s"} for doing it` : "") + (a.escalate ? "; the family is told if there is no answer" : "");
  }
  if (a.kind === "say") return `say "${a.text.length > 80 ? a.text.slice(0, 80) + "…" : a.text}"`;
  if (a.kind === "ask") {
    return `ask Jarvis "${a.prompt.length > 80 ? a.prompt.slice(0, 80) + "…" : a.prompt}" and send the answer` +
      (a.notify === "if-important" ? " only if something deserves attention" : "");
  }
  return "say when to set off, with the drive time";
}

/* ---------- building one from untrusted input -------------------------------- */

/**
 * What the panel, the API and the voice tool all send. Loose on purpose: each
 * caller has its own shape, and every one is checked here the same way.
 */
export interface RoutineInput {
  name?: unknown;
  when?: unknown; // "once" | "daily" | "cron" | "event" | "leave" | "watch" | "page"
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
  /** cron: "0 8,12 * * *", minute hour day month weekday. */
  cron?: unknown;
  /** event: its name. */
  event?: unknown;
  /** leave: minutes to spare on top of the drive. */
  bufferMin?: unknown;
  /** watch: a Home Assistant template, true while the thing is happening. */
  condition?: unknown;
  /** watch: how long it must stay true first; 0 for at once. page: what must be true, in words. */
  forMinutes?: unknown;
  /** page: the web page to read, found once, when the alert is set. */
  url?: unknown;
  /** page: what it is about ("the air quality in Springfield"). */
  question?: unknown;
  /** page: how often it is read, in minutes (at least 60). */
  everyMinutes?: unknown;
  say?: unknown;
  ask?: unknown;
  /** ask: "always" (the default) or "if-important", sent only when something deserves attention, as Hark's checks do. */
  notify?: unknown;
  /** Pass it on to these family members (already named as people: lib/relays.ts), in turn if several. */
  passTo?: unknown;
  /** remind (Done or Can't) or ask (an answer). */
  passKind?: unknown;
  /** A chore's points, earned on Done. */
  points?: unknown;
  /** Unanswered, tell the whole family: a check-in, medicine. */
  escalate?: unknown;
  /** How long they have to answer, in minutes. */
  answerMin?: unknown;
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
  } else if (when === "cron") {
    const expr = str(input.cron).toLowerCase().split(/\s+/).join(" ");
    if (expr.length > 100) return { ok: false, error: "keep the cron schedule under 100 characters" };
    const c = parseCron(expr);
    if (typeof c === "string") return { ok: false, error: c };
    // An ask is a paid answer each time: no more than once an hour.
    if (c.min.length !== 1) return { ok: false, error: "a cron schedule runs at most once an hour: one number for the minute, like 0 8,12 * * *" };
    if (nextCron(expr, timeZone, now) === undefined) return { ok: false, error: "that schedule never comes round" };
    trigger = { kind: "cron", expr };
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
  } else if (when === "page") {
    const url = pageUrl(str(input.url));
    if (!url) return { ok: false, error: "a page watch needs a public https page to read" };
    const condition = str(input.condition).slice(0, 300);
    if (condition.length < 3) return { ok: false, error: "say what must be true for the alert, in words" };
    const every = input.everyMinutes === undefined || input.everyMinutes === null ? PAGE_EVERY_MIN : Math.round(Number(input.everyMinutes));
    trigger = {
      kind: "page",
      url: url.toString(),
      question: (str(input.question) || str(input.name)).slice(0, 300),
      condition,
      everyMin: Math.min(PAGE_EVERY_MAX, Math.max(PAGE_EVERY_MIN, Number.isFinite(every) ? every : PAGE_EVERY_MIN)),
    };
  } else {
    return { ok: false, error: "when must be once, daily, cron, event, leave, watch or page" };
  }

  let action: Action;
  const passTo = Array.isArray(input.passTo)
    ? (input.passTo as { person?: unknown; name?: unknown }[]).filter((p) => typeof p?.person === "string" && typeof p?.name === "string")
    : [];
  if (trigger.kind === "leave") {
    action = { kind: "leave" };
  } else if (passTo.length) {
    // Passed on to someone: the words are for them.
    const text = str(input.say) || str(input.ask);
    if (!text) return { ok: false, error: "say what to remind them of, or what to ask them" };
    if (text.length > MAX_TEXT) return { ok: false, error: `keep it under ${MAX_TEXT} characters` };
    const points = input.points === undefined || input.points === null ? 0 : Number(input.points);
    if (!Number.isInteger(points) || points < 0 || points > 100) return { ok: false, error: "points are 0 to 100" };
    const answerMin = input.answerMin === undefined || input.answerMin === null ? 0 : Number(input.answerMin);
    if (answerMin && (!Number.isInteger(answerMin) || answerMin < 2 || answerMin > 1440)) return { ok: false, error: "the time to answer is 2 to 1440 minutes" };
    action = {
      kind: "relay",
      relay: str(input.passKind) === "ask" || (!str(input.say) && !!str(input.ask)) ? "ask" : "remind",
      to: passTo.slice(0, 10).map((p) => ({ person: String(p.person), name: String(p.name).slice(0, 40) })),
      text,
      ...(points ? { points } : {}),
      ...(input.escalate === true ? { escalate: true } : {}),
      ...(answerMin ? { answerMin } : {}),
    };
  } else {
    const say = str(input.say);
    const ask = str(input.ask);
    if (!!say === !!ask) return { ok: false, error: "give exactly one of say (a message) or ask (a question for Jarvis)" };
    if ((say || ask).length > MAX_TEXT) return { ok: false, error: `keep it under ${MAX_TEXT} characters` };
    // Only an answer can be judged worth sending; a message to say is always said.
    const notify = str(input.notify).toLowerCase();
    if (notify && notify !== "always" && notify !== "if-important") return { ok: false, error: 'notify is "always" or "if-important"' };
    action = say ? { kind: "say", text: say } : { kind: "ask", prompt: ask, ...(notify === "if-important" ? { notify: "if-important" as const } : {}) };
  }

  const fallback =
    action.kind === "say" ? action.text : action.kind === "ask" ? action.prompt : action.kind === "relay" ? action.text : "Time to leave";
  const name = (str(input.name) || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_NAME);
  return { ok: true, trigger, action, name };
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function newRoutineId(): string {
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
