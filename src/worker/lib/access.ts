import { localParts } from "./routines.ts";

/**
 * Limits on one member, set by an admin: for a guest, and for a child.
 *
 *   until   access ends: a visiting relative's week, a helper's month
 *   hours   when they may use Jarvis at all, in the family's time zone:
 *           a helper's working hours ("weekdays 8 to 5"), or a child's
 *           waking hours, which is quiet time turned round (7:00 to 21:00)
 *   allow   a pass: the only things in the house they may work, by Home
 *           Assistant entity — the gate, and nothing else. They get a
 *           button for each, and Jarvis works those and no others for them.
 *
 * Checked on every request (index.ts, lib/hub.ts): outside the hours
 * Jarvis does not answer them; after `until` they are signed out.
 *
 * Plain functions, so Node tests them.
 */

export interface Access {
  until?: number;
  hours?: { days?: number[]; from: string; to: string };
  allow?: { entity: string; label: string }[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** What a pass may work: things that open, switch, run or lock. */
const ENTITY = /^(cover|switch|light|lock|button|input_button|script|scene|input_boolean|fan)\.[a-z0-9_]+$/;

/** An admin's limits, checked; null clears them; a string says what is wrong. */
export function saneAccess(raw: unknown, now = Date.now()): Access | null | string {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return "limits are an object";
  const r = raw as Record<string, unknown>;
  const out: Access = {};
  if (r.until !== undefined && r.until !== null) {
    if (typeof r.until !== "number" || !Number.isFinite(r.until)) return "until is a time";
    if (r.until <= now) return "that end has already passed";
    out.until = r.until;
  }
  if (r.hours !== undefined && r.hours !== null) {
    const h = r.hours as { days?: unknown; from?: unknown; to?: unknown };
    if (typeof h.from !== "string" || typeof h.to !== "string" || !HHMM.test(h.from) || !HHMM.test(h.to)) return "hours need from and to, like 08:00 and 17:00";
    if (h.from === h.to) return "from and to must differ";
    let days: number[] | undefined;
    if (h.days !== undefined && h.days !== null) {
      if (!Array.isArray(h.days) || !h.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return "days are 0 (Sunday) to 6";
      days = [...new Set(h.days as number[])].sort();
      if (!days.length) return "at least one day";
    }
    out.hours = { from: h.from, to: h.to, ...(days && days.length < 7 ? { days } : {}) };
  }
  if (r.allow !== undefined && r.allow !== null) {
    if (!Array.isArray(r.allow)) return "allow is a list";
    const allow: { entity: string; label: string }[] = [];
    for (const a of r.allow.slice(0, 12)) {
      const entity = typeof a?.entity === "string" ? a.entity.trim() : "";
      if (!ENTITY.test(entity)) return `"${entity}" is not something a pass can work (a cover, switch, light, lock, button, script or scene)`;
      const label = typeof a?.label === "string" && a.label.trim() ? a.label.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 40) : entity;
      allow.push({ entity, label });
    }
    if (allow.length) out.allow = allow;
  }
  return Object.keys(out).length ? out : null;
}

const minutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm)!;
  return +m[1]! * 60 + +m[2]!;
};

const DAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** The hours, as said: "08:00 to 17:00, Mondays to Fridays". */
export function hoursSaid(h: NonNullable<Access["hours"]>): string {
  const days = !h.days
    ? ""
    : h.days.join() === "1,2,3,4,5"
      ? ", Mondays to Fridays"
      : h.days.join() === "0,6"
        ? ", at weekends"
        : `, ${h.days.map((d) => DAY[d]).join(", ")}`;
  return `${h.from} to ${h.to}${days}`;
}

/** Whether they may use Jarvis now; if not, why, in words for them. */
export function allowedNow(a: Access | undefined, now: number, timeZone: string): { ok: true } | { ok: false; why: string } {
  if (!a) return { ok: true };
  if (a.until !== undefined && now >= a.until) return { ok: false, why: "your access has ended; ask the family for a new invite" };
  if (!a.hours) return { ok: true };
  const p = localParts(now, timeZone);
  const t = p.h * 60 + p.mi;
  const from = minutes(a.hours.from);
  const to = minutes(a.hours.to);
  // A window past midnight (22:00 to 06:00) belongs to the day it starts on.
  const inWindow = from < to ? t >= from && t < to : t >= from || t < to;
  const day = from > to && t < to ? (p.dow + 6) % 7 : p.dow;
  if (inWindow && (!a.hours.days || a.hours.days.includes(day))) return { ok: true };
  return { ok: false, why: `Jarvis is yours ${hoursSaid(a.hours)}; ask again then` };
}

/**
 * What a pass may do to a thing, as a Home Assistant service. A string
 * says why not.
 */
export function passService(entity: string, action: string): { domain: string; service: string } | string {
  const domain = entity.split(".")[0]!;
  const map: Record<string, Record<string, string>> = {
    cover: { open: "open_cover", close: "close_cover", stop: "stop_cover" },
    lock: { lock: "lock", unlock: "unlock", open: "unlock", close: "lock" },
    switch: { on: "turn_on", off: "turn_off", toggle: "toggle", open: "turn_on", close: "turn_off" },
    light: { on: "turn_on", off: "turn_off", toggle: "toggle" },
    fan: { on: "turn_on", off: "turn_off", toggle: "toggle" },
    input_boolean: { on: "turn_on", off: "turn_off", toggle: "toggle" },
    button: { press: "press", open: "press", on: "press" },
    input_button: { press: "press", open: "press", on: "press" },
    script: { run: "turn_on", press: "turn_on", open: "turn_on", on: "turn_on" },
    scene: { run: "turn_on", on: "turn_on" },
  };
  const service = map[domain]?.[action];
  if (!service) return `a ${domain} cannot be told to ${action}`;
  return { domain: domain === "input_button" ? "input_button" : domain, service };
}

/** The actions a thing offers, for its buttons. */
export function passActions(entity: string): string[] {
  const d = entity.split(".")[0]!;
  if (d === "cover") return ["open", "close"];
  if (d === "lock") return ["unlock", "lock"];
  if (d === "button" || d === "input_button") return ["press"];
  if (d === "script" || d === "scene") return ["run"];
  return ["on", "off"];
}
