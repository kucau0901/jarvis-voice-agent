// Another place's time (lib/locale.ts timeAt, tools/clock.ts time_in): worked
// out from the time zone, daylight saving included, never by the model.
import { timeAt } from "../src/worker/lib/locale.ts";
import { timeIn } from "../src/worker/tools/clock.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : ""); }
}

console.log("the time somewhere else");
{
  // 07:56 UTC on 29 October 2026, after the UK's clocks went back on the 25th.
  const winter = timeAt("Europe/London", new Date("2026-10-29T07:56:00Z"));
  check("London in winter is UTC", winter === "Thursday 29 October, 07:56 in Europe/London (UTC+00:00)", winter);
  const summer = timeAt("Europe/London", new Date("2026-07-01T07:56:00Z"));
  check("…and an hour ahead in summer", summer === "Wednesday 1 July, 08:56 in Europe/London (UTC+01:00)", summer);
  const ny = timeAt("America/New_York", new Date("2026-10-29T07:56:00Z"));
  check("a day earlier where it is", ny === "Thursday 29 October, 03:56 in America/New_York (UTC-04:00)", ny);
  check("not a time zone: null", timeAt("London") === null && timeAt("") === null);
}

console.log("\nthe tool");
{
  const now = String(await timeIn.run({ zone: " Asia/Tokyo " }, {} as never));
  check("names the zone and its offset", /in Asia\/Tokyo \(UTC\+09:00\)$/.test(now), now);
  const bad = String(await timeIn.run({ zone: "Londres" }, {} as never));
  check("a wrong name says what to give", bad === 'Not a time zone: "Londres". Use an IANA name, such as Europe/London.', bad);
  check("offered to anyone who may ask", timeIn.scope === undefined && timeIn.available === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
