// Habits (lib/habits.ts): the same request at about the same time on several
// days, found by code alone and offered once as a routine; and the card that
// makes it (tools/routines.ts routine_make), for an approval only.
import { DAYS_MIN, Habits, habitOf, MAX_ASK, MIN_WORDS, NEAR_MIN, noteworthy, OFFERED_MS, WINDOW_MS, type Asked } from "../src/worker/lib/habits.ts";
import { overlap } from "../src/worker/lib/episodes.ts";
import { tokenise } from "../src/worker/lib/memory.ts";
import { zonedToUtc } from "../src/worker/lib/routines.ts";
import { routineMake } from "../src/worker/tools/routines.ts";
import { baseTools } from "../src/worker/tools/registry.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 400) : "");
  }
}

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

const TZ = "Asia/Kuala_Lumpur";
/** 19 October 2026 is a Monday: day 19 + n at hh:mm in Kuala Lumpur. */
const at = (day: number, h: number, m = 0) => zonedToUtc(2026, 10, day, h, m, TZ);
const asked = (ts: number, ask = "What's the traffic to work like?", tools = ["directions"]): Asked => ({ at: ts, words: tokenise(ask), ask, tools });

console.log("what makes a habit");
{
  const mon = asked(at(19, 7, 42));
  const tue = asked(at(20, 7, 38), "what is the traffic to work like");
  const wed = asked(at(21, 7, 51));
  const h = habitOf([mon, tue], wed, TZ);
  check(`asked on ${DAYS_MIN} weekdays at about the same time: weekdays, at the earliest, rounded down`, h?.time === "07:35" && h.days.join() === "1,2,3,4,5" && h.ask === wed.ask, h);
  check("twice is not yet a habit", habitOf([mon], tue, TZ) === null);
  check("twice on one day counts as one day", habitOf([mon, asked(at(19, 7, 50))], tue, TZ) === null);
  check(`more than ${NEAR_MIN} minutes apart is another time`, habitOf([mon, asked(at(20, 9, 0))], wed, TZ) === null);
  check("other tools used: another request", habitOf([mon, asked(at(20, 7, 40), mon.ask, ["directions", "car_state"])], wed, TZ) === null);
  check("other words: another request", habitOf([mon, asked(at(20, 7, 40), "What is on my calendar today?")], wed, TZ) === null);
  check(`older than ${WINDOW_MS / 86_400_000} days does not count`, habitOf([asked(at(1, 7, 40)), tue], wed, TZ) === null);
  const weekend = habitOf([asked(at(24, 9, 0), "Any events in town this weekend?", []), asked(at(25, 9, 10), "Any events in town this weekend?", [])], asked(at(31, 9, 5), "Any events in town this weekend?", []), TZ);
  check("on weekends only: weekends", weekend?.days.join() === "0,6" && weekend.time === "09:00", weekend);
  const daily = habitOf([asked(at(23, 7, 40)), asked(at(24, 7, 40))], asked(at(25, 7, 40)), TZ);
  check("weekdays and weekends: every day", daily?.days.length === 0, daily);
  const follow = (d: number) => asked(at(d, 7, 40), "check it again", []);
  check(`fewer than ${MIN_WORDS} words that count is a follow-up, not a habit`, habitOf([follow(19), follow(20)], follow(21), TZ) === null, tokenise("check it again"));
  check("alike words overlap", overlap(["a", "b", "c"], ["a", "b", "c"]) === 1 && overlap(["a"], []) === 0);
  const late = habitOf([asked(at(19, 23, 55), "Any news from the markets tonight?", []), asked(at(21, 0, 10), "Any news from the markets tonight?", [])], asked(at(22, 0, 5), "Any news from the markets tonight?", []), TZ);
  check("either side of midnight is the same time, at the earliest", late?.time === "23:55", late);
}

console.log("\noffered once");
{
  const h = new Habits(fakeStorage() as never);
  const ask = "What's the traffic to work like?";
  const got = [];
  for (const day of [19, 20, 21, 22]) got.push(await h.note("u_sara", ask, ["directions"], TZ, at(day, 7, 40), []));
  check("offered on the third day; until it is filed, offered again", got[0] === null && got[1] === null && got[2]?.time === "07:40" && got[3]?.time === "07:40", got);
  await h.offered("u_sara", got[3]!.key, at(22, 7, 40));
  check("filed: not again", (await h.note("u_sara", ask, ["directions"], TZ, at(23, 7, 40), [])) === null);
  const later = await h.note("u_sara", ask, ["directions"], TZ, at(19, 7, 40) + OFFERED_MS + 86_400_000, []);
  check("not even much later while it is remembered as offered: what was asked is kept 21 days", later === null);
  const other = new Habits(fakeStorage() as never);
  let made = null;
  for (const day of [19, 20, 21]) made = await other.note("u_sara", ask, ["directions"], TZ, at(day, 7, 40), ["what is the traffic to work like?"]);
  check("not when a routine of theirs already asks it", made === null);
  const theirs = new Habits(fakeStorage() as never);
  for (const day of [19, 20]) await theirs.note("u_sara", ask, ["directions"], TZ, at(day, 7, 40), []);
  check("each person's own", (await theirs.note("u_adam", ask, ["directions"], TZ, at(21, 7, 40), [])) === null);
  await theirs.clearAsked("u_sara");
  check("what they asked is cleared with what they said", (await theirs.note("u_sara", ask, ["directions"], TZ, at(21, 7, 40), [])) === null);
  for (const day of [22, 23, 24]) await theirs.note("u_sara", ask, ["directions"], TZ, at(day, 7, 40), []);
  await theirs.offered("u_sara", "like traffic work", at(24, 7, 40));
  await theirs.clearAsked("u_sara");
  for (const day of [25, 26]) await theirs.note("u_sara", ask, ["directions"], TZ, at(day, 7, 40), []);
  check("but what was offered stays offered", (await theirs.note("u_sara", ask, ["directions"], TZ, at(27, 7, 40), [])) === null);
  await theirs.forget("u_sara");
  for (const day of [25, 26]) await theirs.note("u_sara", ask, ["directions"], TZ, at(day, 7, 40), []);
  check("forgotten wholly as they leave", (await theirs.note("u_sara", ask, ["directions"], TZ, at(27, 7, 40), []))?.time === "07:40");
  const long = new Habits(fakeStorage() as never);
  const words = `${"What is the traffic to the office this morning ".repeat(4)}?`;
  let lh = null;
  for (const day of [19, 20, 21]) lh = await long.note("u_sara", words, [], TZ, at(day, 7, 40), []);
  check(`a request longer than ${MAX_ASK} characters is not offered: cut, it would ask something else`, words.length > MAX_ASK && lh === null, lh);
}

console.log("\nwhat may be noted");
{
  check("answered by reading: yes", noteworthy({ ok: true, by: "gpt-5", tools: ["directions", "calendar_check"] }, ["*"]));
  check("answered with no tool: yes", noteworthy({ ok: true, by: "gpt-5", tools: [] }, ["ask", "routines"]));
  check("a tool that changes something: no", !noteworthy({ ok: true, by: "gpt-5", tools: ["directions", "car_command"] }, ["*"]));
  check("Hermes or a page: no", !noteworthy({ ok: true, by: "gpt-5", tools: ["ask_hermes"] }, ["*"]) && !noteworthy({ ok: true, by: "gpt-5", tools: ["make_page"] }, ["*"]));
  check("Home Assistant's own answer (Assist): yes, the house decides what it may do", noteworthy({ ok: true, by: "home-assistant", tools: [] }, ["*"]));
  check("the router changing the house with Home Assistant's tools: yes, whatever the server is called", noteworthy({ ok: true, by: "gpt-5", tools: ["home-assistant__ha_call_service"] }, ["*"]) && noteworthy({ ok: true, by: "gpt-5", tools: ["house__ha_bulk_control", "car_state"] }, ["*"]));
  check("another MCP server's tool that changes something: no", !noteworthy({ ok: true, by: "gpt-5", tools: ["notes__create_page"] }, ["*"]));
  check("a failed answer: no", !noteworthy({ ok: false, by: "gpt-5", tools: [] }, ["*"]));
  check("someone who may not have routines (a guest): no", !noteworthy({ ok: true, by: "gpt-5", tools: [] }, ["ask", "voice"]));
}

console.log("\nthe card that makes it");
{
  const w = routineMake.propose?.({ ask: "What's the traffic to work like?", time: "07:35", days: [1, 2, 3, 4, 5] }, {} as never);
  check("says what it would set up, waiting for a tap", w?.says === 'Routine: ask "What\'s the traffic to work like?" weekdays at 07:35, and send you the answer' && w.risk === "reversible" && !w.category && w.verb === "Make it a routine", w);
  check("the same each time: an approval checks it again", JSON.stringify(routineMake.propose?.({ ask: "What's the traffic to work like?", time: "07:35", days: [1, 2, 3, 4, 5] }, {} as never)) === JSON.stringify(w));
  check("not a routine: no card", [{ ask: "", time: "07:35", days: [] }, { ask: "x", time: "7:35", days: [] }, { ask: "x", time: "07:35", days: [7] }, { ask: "x".repeat(MAX_ASK + 1), time: "07:35", days: [] }].every((a) => routineMake.propose?.(a, {} as never) === null));
  check("never offered to the router or a job: an approval only", !baseTools({} as never).some((t) => t.name === "routine_make"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
