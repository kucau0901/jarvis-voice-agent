// A day on the calendar, for a brief (lib/agenda.ts): one read of the
// primary calendar, then which events clash, the free time between them, and
// invitations left unanswered.
import { agendaEvents, agendaFrom, eventById, eventNear, freeSlots, overlaps, staleInvites, type AgendaEvent } from "../src/worker/lib/agenda.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

const TZ = "Asia/Kuala_Lumpur";
/** 21 October 2026 at hh:mm in Kuala Lumpur (UTC+8). */
const at = (h: number, m = 0) => Date.UTC(2026, 9, 21, h - 8, m);
const iso = (ts: number) => new Date(ts).toISOString();
const DAY = 86_400_000;
const NOW = at(7);

const ev = (over: Partial<AgendaEvent>): AgendaEvent => ({
  id: "e1", series: over.id ?? "e1", summary: "Standup", location: "", start: at(9), end: at(10), allDay: false,
  free: false, declined: false, unanswered: false, organizer: "", created: 0, ...over,
});

console.log("what is kept of each event");
{
  const got = agendaFrom([
    {
      id: "a", summary: "  Dentist\n", location: "12 Example Road", start: { dateTime: iso(at(9)) }, end: { dateTime: iso(at(10)) },
      created: iso(NOW - 5 * DAY), organizer: { displayName: "Clinic Example", email: "desk@example.com" },
      attendees: [{ self: true, responseStatus: "needsAction" }],
    },
    { id: "b", status: "cancelled", start: { dateTime: iso(at(11)) }, end: { dateTime: iso(at(12)) } },
    { id: "c", summary: "Holiday", start: { date: "2026-10-22" }, end: { date: "2026-10-23" }, transparency: "transparent", organizer: { self: true } },
    { id: "d", summary: "Lunch", start: { dateTime: iso(at(12)) }, end: { dateTime: iso(at(13)) }, organizer: { self: true }, attendees: [{ self: true, responseStatus: "needsAction" }] },
    { summary: "no id", start: { dateTime: iso(at(14)) } },
  ], TZ);
  check("cancelled and id-less events are dropped", got.map((e) => e.id).join() === "a,c,d", got.map((e) => e.id));
  const a = got[0]!;
  check("titles are tidied onto one line", a.summary === "Dentist" && a.location === "12 Example Road", a);
  check("an invitation from someone else, unanswered, names who sent it", a.unanswered && a.organizer === "Clinic Example" && a.created === NOW - 5 * DAY, a);
  const c = got[1]!;
  check("an all-day event runs from midnight to midnight in the zone", c.allDay && c.start === Date.UTC(2026, 9, 21, 16) && c.end === c.start + DAY, c);
  check("shown as free is kept as free", c.free && c.organizer === "");
  check("their own event is never unanswered", !got[2]!.unanswered);
  const answered = agendaFrom([
    { id: "no", start: { dateTime: iso(at(9)) }, end: { dateTime: iso(at(10)) }, attendees: [{ self: false, responseStatus: "accepted" }, { self: true, responseStatus: "declined" }] },
    { id: "yes", start: { dateTime: iso(at(9)) }, end: { dateTime: iso(at(10)) }, attendees: [{ self: true, responseStatus: "accepted" }] },
  ], TZ);
  check("one they turned down is kept as declined, by their own answer", answered[0]!.declined && !answered[1]!.declined && !a.declined, answered);
  // Santiago's 6 September 2026 has no midnight: its clocks go from 00:00 to 01:00.
  const santiago = agendaFrom([{ id: "h", summary: "Holiday", start: { date: "2026-09-06" }, end: { date: "2026-09-07" } }], "America/Santiago")[0]!;
  check("an all-day event on a day with no midnight begins when the day does", santiago.start === Date.UTC(2026, 8, 6, 4) && santiago.end === Date.UTC(2026, 8, 7, 3), santiago);
}

console.log("\nclashes");
{
  const list = [
    ev({ id: "a", start: at(9), end: at(10) }),
    ev({ id: "b", start: at(9, 30), end: at(11) }),
    ev({ id: "c", start: at(10, 30), end: at(10, 45) }),
    ev({ id: "d", start: at(11), end: at(12) }),
    ev({ id: "e", start: at(9), end: at(17), free: true }),
    ev({ id: "f", start: at(9), end: at(10), declined: true }),
    ev({ id: "g", start: at(0), end: at(0) + DAY, allDay: true }),
  ];
  const got = overlaps(list).map(([x, y]) => x.id + y.id);
  check("each overlapping pair once; touching ends do not clash", got.join() === "ab,bc", got);
  check("free, declined and all-day events clash with nothing", !got.some((p) => /[efg]/.test(p)));
  const moment = [ev({ id: "m", start: at(11), end: at(13) }), ev({ id: "z", start: at(12), end: at(12) })];
  check("a moment with no length clashes with nothing", overlaps(moment).length === 0 && overlaps([...moment].reverse()).length === 0);
  check("nor splits free time", JSON.stringify(freeSlots([ev({ id: "z", start: at(12), end: at(12) })], NOW, TZ, NOW)) === JSON.stringify([{ start: at(8), end: at(20) }]));
}

console.log("\nfree time");
{
  const list = [
    ev({ id: "a", start: at(9), end: at(10) }),
    ev({ id: "b", start: at(9, 30), end: at(11) }),
    ev({ id: "c", start: at(11, 15), end: at(12) }),
    ev({ id: "d", start: at(13), end: at(19, 45) }),
    ev({ id: "e", start: at(12), end: at(13), free: true }),
  ];
  const slots = freeSlots(list, NOW, TZ, NOW).map((s) => `${(s.start - at(0)) / 3_600_000}-${(s.end - at(0)) / 3_600_000}`);
  check("between 08:00 and 20:00, gaps of half an hour or more, free events ignored", slots.join() === "8-9,12-13", slots);
  const later = freeSlots(list, NOW, TZ, at(12, 40));
  check("none before the time asked from: a gap cut under half an hour is not one", later.length === 0, later);
  check("an empty day is one slot", JSON.stringify(freeSlots([], NOW, TZ, NOW)) === JSON.stringify([{ start: at(8), end: at(20) }]));
  check("an evening brief has no free time left today", freeSlots([], NOW, TZ, at(21)).length === 0);
}

console.log("\ninvitations left unanswered");
{
  const old = NOW - 4 * DAY;
  const list = [
    ev({ id: "a", unanswered: true, created: old, start: NOW + DAY }),
    ev({ id: "b", unanswered: true, created: NOW - DAY, start: NOW + DAY }),
    ev({ id: "c", unanswered: true, created: old, start: NOW + 8 * DAY }),
    ev({ id: "d", unanswered: true, created: old, start: NOW - 3_600_000 }),
    ev({ id: "e", unanswered: false, created: old, start: NOW + DAY }),
    ev({ id: "f", unanswered: true, created: 0, start: NOW + DAY }),
  ];
  const got = staleInvites(list, NOW).map((e) => e.id);
  check("three days old, for something in the next week, still unanswered", got.join() === "a", got);
  const daily = [1, 2, 3].map((n) => ev({ id: `s_${n}`, series: "s", unanswered: true, created: old, start: NOW + n * DAY }));
  const once = staleInvites([...daily, ev({ id: "x", unanswered: true, created: old, start: NOW + 4 * DAY })], NOW).map((e) => e.id);
  check("a recurring invitation once, at its next time, leaving room for the others", once.join() === "s_1,x", once);
  const kept = agendaFrom([{ id: "s_1", recurringEventId: "s", start: { dateTime: iso(at(9)) }, end: { dateTime: iso(at(10)) } }, { id: "solo", start: { dateTime: iso(at(9)) } }], TZ);
  check("which series an event is one of is kept", kept[0]!.series === "s" && kept[1]!.series === "solo", kept);
}

console.log("\nthe read");
{
  const kv = new Map<string, string>([["google:refresh", "refresh-token"]]);
  const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
  const env = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec", CONFIG } as never;
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
    urls.push(u);
    return Response.json({ items: [{ id: "a", summary: "Standup", start: { dateTime: iso(at(9)) }, end: { dateTime: iso(at(10)) } }] });
  }) as typeof fetch;
  try {
    const read = await agendaEvents(env, at(7), at(7) + 7 * DAY, TZ, new AbortController().signal);
    const got = typeof read === "string" ? read : read.events;
    check("one read of the primary calendar", urls.length === 1 && urls[0]!.includes("/calendars/primary/events?"), urls);
    const q = new URL(urls[0]!).searchParams;
    check("single events, in order, at most 100, over the window", q.get("singleEvents") === "true" && q.get("orderBy") === "startTime" && q.get("maxResults") === "100" && q.get("timeMin") === iso(at(7)), q.toString());
    check("the events come back", Array.isArray(got) && got[0]?.summary === "Standup", got);
  } finally {
    globalThis.fetch = real;
  }
  check("without Google, a sentence", (await agendaEvents({} as never, NOW, NOW + DAY, TZ, new AbortController().signal)) === "Google is not set up.");
}

console.log("\nan errand's event (lib/later.ts): found by its start, read again by its id");
{
  const kv = new Map<string, string>([["google:refresh", "refresh-token"]]);
  const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
  const env = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec", CONFIG } as never;
  const signal = new AbortController().signal;
  const timed = (id: string, start: number, over: Record<string, unknown> = {}) => ({ id, summary: id, start: { dateTime: iso(start) }, end: { dateTime: iso(start + 3_600_000) }, ...over });
  let items: unknown[] = [];
  let one: { status: number; body: unknown } = { status: 200, body: {} };
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
    asked.push(u);
    if (u.includes("/calendars/primary/events?")) return Response.json({ items });
    return Response.json(one.body, { status: one.status });
  }) as typeof fetch;
  try {
    const near = async () => {
      const e = await eventNear(env, at(10), TZ, signal);
      return typeof e === "string" ? e : e.id;
    };
    items = [timed("focus", at(10), { transparency: "transparent" }), timed("dentist", at(10)), { id: "holiday", start: { date: "2026-10-21" }, end: { date: "2026-10-22" } }];
    check("the one that starts then, one that takes time before one shown as free", (await near()) === "dentist");
    items = [timed("focus", at(10), { transparency: "transparent" })];
    check("only one shown as free: that one", (await near()) === "focus");
    items = [timed("dentist", at(10)), timed("call", at(10))];
    check("two that take time at once: neither, and why", /More than one event/.test(await near()));
    items = [timed("later", at(10, 2)), timed("turned", at(10), { attendees: [{ self: true, responseStatus: "declined" }] })];
    check("none within a minute but one they declined: why", /No event in their calendar starts then/.test(await near()));
    const again = (status: number, body: unknown) => {
      one = { status, body };
      return eventById(env, "dentist1", TZ, signal);
    };
    check("read again by its id: its start now", JSON.stringify(await again(200, timed("dentist1", at(11)))) === JSON.stringify({ start: at(11) }) && asked.at(-1)!.endsWith("/calendars/primary/events/dentist1"));
    check("deleted: gone", (await again(404, {})) === "gone" && (await again(410, {})) === "gone");
    check("cancelled, or declined: gone", (await again(200, { ...timed("dentist1", at(10)), status: "cancelled" })) === "gone" && (await again(200, timed("dentist1", at(10), { attendees: [{ self: true, responseStatus: "declined" }] }))) === "gone");
    check("Google not answering: not known (null)", (await again(500, { error: { message: "backend" } })) === null);
    const before = asked.length;
    check("an id that is not one: not known, and nothing asked", (await eventById(env, "a/b", TZ, signal)) === null && asked.length === before);
  } finally {
    globalThis.fetch = real;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
