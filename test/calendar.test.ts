import { calendarAdd, calendarCheck, calendarTools } from "../src/worker/tools/calendar.ts";
import { SCOPES as GOOGLE_SCOPES, CALENDAR, PEOPLE, GMAIL } from "../src/worker/lib/google.ts";
import { allows, requiredScope, SCOPES } from "../src/worker/lib/scopes.ts";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 220) : "");
  }
}

/** Nothing below reaches the network: every case returns before the first fetch. */
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    env: { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec" },
    signal: new AbortController().signal,
    memory: {},
    progress: () => {},
    display: () => {},
    ...over,
  }) as never;

console.log("scopes — calendar and contacts ride the same grant");

check("calendar is a real route scope", (SCOPES as readonly string[]).includes("calendar"));
check("a calendar grant allows calendar", allows(["calendar"], "calendar"));
check("a mail grant does not imply calendar", !allows(["mail"], "calendar"));
check("the wildcard allows calendar", allows(["*"], "calendar"));
check("/api/google/* stays owner-only", requiredScope("/api/google/auth", "GET") === "owner");

check("requests calendar.events", GOOGLE_SCOPES.includes("auth/calendar.events"));
check("requests contacts.readonly", GOOGLE_SCOPES.includes("auth/contacts.readonly"));
// The broad `calendar` scope can delete whole calendars; calendar.events cannot.
check(
  "does NOT request the broad calendar scope",
  !/auth\/calendar(\s|$)/.test(GOOGLE_SCOPES),
  GOOGLE_SCOPES,
);
// Read-only contacts: this exists to answer "which address is Sam", nothing more.
check("does NOT request contacts write", !/auth\/contacts(\s|$)/.test(GOOGLE_SCOPES));
check("still does NOT request mail.google.com", !GOOGLE_SCOPES.includes("mail.google.com"));

console.log("\nthe privacy policy matches what is actually requested");

{
  /*
   * public/privacy.html is linked from the Google consent screen, so it is the
   * one document that must never understate what the app reaches. It is also
   * the easiest thing in the repo to forget when a scope is added — hence a
   * test rather than a comment. Adding a scope to lib/google.ts now fails here
   * until the policy describes it.
   */
  const policy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");

  for (const url of GOOGLE_SCOPES.split(" ")) {
    const name = url.split("/auth/")[1]!; // e.g. "gmail.modify"
    check(`privacy.html describes ${name}`, policy.includes(name), name);
  }

  // And the other direction: the page claims certain scopes are NOT requested.
  // If one were ever added, that claim would silently become a false statement
  // in a published privacy policy.
  for (const absent of ["mail.google.com", "gmail.settings", "auth/drive"]) {
    check(
      `privacy.html's claim about ${absent} is still true`,
      !GOOGLE_SCOPES.includes(absent),
      GOOGLE_SCOPES,
    );
  }
  check("privacy.html names the OpenAI disclosure", /OpenAI/.test(policy));
}

console.log("\nAPI bases are distinct");

check("gmail, calendar and people have separate bases",
  new Set([GMAIL, CALENDAR, PEOPLE]).size === 3);
check("calendar base is v3", CALENDAR.endsWith("/calendar/v3"));
check("people base is v1", PEOPLE.endsWith("/v1"));

console.log("\ntool registration");

check("two calendar tools", calendarTools.length === 2);
check("both carry the calendar scope", calendarTools.every((t) => t.scope === "calendar"));
check("both are fast-paced", calendarTools.every((t) => t.pace === "fast"));
check(
  "unavailable without credentials",
  calendarTools.every((t) => t.available?.({} as never) === false),
);
check(
  "available with them",
  calendarTools.every(
    (t) => t.available?.({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" } as never) === true,
  ),
);
check(
  "names match the router prompt",
  [calendarCheck.name, calendarAdd.name].join() === "calendar_check,calendar_add",
);

console.log("\ncalendar_add — refuses before it reaches Google");

{
  const add = async (args: Record<string, unknown>) => await calendarAdd.run(args, ctx());
  const soon = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00");

  const noTitle = await add({ title: "  ", start: soon, duration_minutes: 60, location: null });
  check("refuses an empty title", /no title/i.test(noTitle), noTitle);

  // A bare date, or a time with no offset, is ambiguous by up to a day.
  for (const bad of ["tomorrow at 3", "2026-09-22", "2026-09-22T15:00", "15:00"]) {
    const r = await add({ title: "x", start: bad, duration_minutes: 60, location: null });
    if (!/not a full timestamp/i.test(r)) check(`refuses "${bad}"`, false, r);
  }
  check("refuses every ambiguous start", true);

  /*
   * The one that matters. A model that gets the year or the day wrong files a
   * meeting into the past, and nobody discovers it until the meeting is missed
   * — so a past start is treated as a mistake rather than a booking.
   */
  const past = await add({
    title: "standup", start: "2020-01-01T09:00:00+08:00", duration_minutes: 30, location: null,
  });
  check("refuses a start in the past", /in the past/i.test(past), past);

  // But not the recent past: a meeting that started ten minutes ago is a real
  // thing a person logs, so the guard is a day wide, not a minute.
  const justNow = new Date(Date.now() - 600_000).toISOString().replace("Z", "+00:00");
  const recent = await add({ title: "x", start: justNow, duration_minutes: 30, location: null });
  check("does not refuse something ten minutes old", !/in the past/i.test(recent), recent);

  for (const r of [noTitle, past]) {
    if (/^Added /.test(r)) check("no refusal claims the event was added", false, r);
  }
  check("no refusal claims the event was added", true);
}

console.log("\ncalendar_check — the directions handoff");

{
  // The location is the argument the next tool needs; a summary that dropped
  // it would break "when do I need to leave", which is the point of this tool.
  const desc = calendarCheck.description;
  check("advertises that it returns the location", /location/i.test(desc), desc);
  check("points the router at directions for leave-time", /directions/i.test(desc), desc);

  const ranges = (calendarCheck.parameters as { properties: Record<string, { enum?: string[] }> })
    .properties.range.enum!;
  check("offers next", ranges.includes("next"));
  check("offers today", ranges.includes("today"));
  check("offers tomorrow", ranges.includes("tomorrow"));
  check("offers week", ranges.includes("week"));
}

console.log("\nunconfigured deployment");

{
  const bare = await calendarCheck.run({ range: "next", limit: 5 }, ctx({ env: {} }));
  check("says it is not configured", /not configured|not linked/i.test(bare), bare);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
