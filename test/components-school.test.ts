// The example component (docs/components/school/school.mjs), plugged into the
// real Jarvis code in process: the real MCP client asks it what it offers and
// calls its tools, and its report reaches the real route. What the developer
// guide (docs/components.md) promises, checked against the example it points at.
import { objectWith, settings, type Person } from "./fake-object.ts";
import { createSchool, MANIFEST, TOOLS } from "../docs/components/school/school.mjs";
import { handleComponents, handleReport } from "../src/worker/routes/components.ts";
import { prepareRouter, runCalls } from "../src/worker/lib/router.ts";
import { catalogOf, EVENT_TYPE, TOOL_NAME } from "../src/worker/lib/components.ts";
import { ROLE_SCOPES } from "../src/worker/lib/hub.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 600) : "");
  }
}

const PEOPLE: Person[] = [
  { person: "owner", name: "Adam", role: "admin", scopes: ["*"] },
  { person: "u_sara", name: "Sara", role: "adult", scopes: [...ROLE_SCOPES.adult] },
];
const o = await objectWith(PEOPLE);
const env = o.envOf("owner");
const URL_SCHOOL = "https://school.example.com/mcp";
const EVENTS = "https://jarvis.example.com/api/v1/component/events";
const KEY = "school-key-0123456789";
/** The school's address at Jarvis: made below, and read by the school each time it reports. */
const jarvis = { events: EVENTS, token: "" };
const school = createSchool({ key: KEY, office: ["T1"], jarvis });

/** What reached the school, by who Jarvis said was asking. */
const asked: (string | null)[] = [];
const after: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void after.push(p), passThroughOnException() {} } as never;
const settle = async () => {
  await Promise.all(after.splice(0));
};
const real = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === URL_SCHOOL) {
    const request = new Request(url, init);
    if (init.method === "POST" && String(init.body).includes('"tools/call"')) asked.push(request.headers.get("x-jarvis-person"));
    return school.handle(request);
  }
  if (url === EVENTS) return handleReport(new Request(url, init), env, ctx);
  throw new Error(`nothing is at ${url}`);
}) as typeof fetch;

const { change: admin } = settings(env);
const signal = new AbortController().signal;
const use = async (person: string, grants: readonly string[], name: string, args: Record<string, unknown>) => {
  const p = await prepareRouter(o.envOf(person), [{ role: "user", text: "hello" }], signal, grants as never, {});
  const out = await runCalls([{ type: "function_call", call_id: "c1", name, arguments: JSON.stringify(args) }] as never, p.byName, { env: o.envOf(person), signal, memory: p.memory, grants: grants as never }, { send() {}, isClosed: false });
  const first = out[0];
  return first && "output" in first ? String(first.output) : "";
};
const DAY = "2026-11-13";

try {
  console.log("the example keeps to the contract");
  {
    const made = await catalogOf({ url: URL_SCHOOL, tools: TOOLS.map((t) => ({ ...t, readOnly: t.annotations.readOnlyHint })), manifest: JSON.stringify(MANIFEST) }, 0);
    check("every tool it lists is one Jarvis can use, and every event one it can declare", typeof made !== "string" && made.skipped.length === 0 && TOOLS.every((t) => TOOL_NAME.test(t.name)) && MANIFEST.events.every((e) => EVENT_TYPE.test(e.type)), made);
  }

  console.log("\nplugged in through Settings → Components, with the real MCP client");
  const added = await admin("POST", { name: "School", url: URL_SCHOOL });
  const id = added.id;
  {
    const bare = await handleComponents(new Request("https://jarvis.example.com/api/components", { method: "PATCH", body: JSON.stringify({ id, check: true }) }), env, { kind: "owner" });
    check("without its key it tells Jarvis nothing", bare.status === 502 && !JSON.stringify(await bare.json()).includes(KEY));
    await admin("PUT", { id, key: KEY });
    const checked = await admin("PATCH", { id, check: true });
    const by = Object.fromEntries((checked.waiting?.tools ?? []).map((t) => [t.name, t]));
    check("what it offers waits to be approved: four tools and its one event", checked.waiting?.tools.length === 4 && checked.waiting.events.map((e) => `${e.type}: ${e.says}`).join() === "leave_filed: A teacher filed leave" && checked.waiting.version === "1.0.0", checked.waiting);
    check("the three that look things up are classed as reading; the one that changes the timetable as acting", by.get_absent?.reads === true && by.get_timetable?.reads === true && by.find_relief?.reads === true && by.apply_relief?.reads === false && !by.apply_relief?.looksUp, by);
    await admin("PATCH", { id, approve: checked.waiting?.hash });
    await admin("PATCH", { id, shares: { owner: { level: "use", tell: true, as: "T1" }, u_sara: { level: "use", as: "T3" } } });
    const address = await o.jarvis.componentNewAddress(id, Date.now());
    jarvis.token = typeof address === "string" ? "" : address.token;
  }

  console.log("\nsomeone asking");
  {
    asked.length = 0;
    const mine = await use("owner", ["*"], "school__get_timetable", { date: DAY });
    check("their own timetable, with no teacher named: the school reads who is asking from the mapped id", asked[0] === "T1" && mine.includes("Mr Lim (T1) on 2026-11-13: period 1 4A Maths; period 2 5A Maths; period 4 4B Maths."), { asked, mine });
    const hers = await use("u_sara", ROLE_SCOPES.adult, "school__get_timetable", { date: DAY });
    check("someone else is someone else there", hers.includes("Mr Hassan (T3)"), hers);
    check("nobody is absent yet", (await use("owner", ["*"], "school__get_absent", { date: DAY })).includes(`Nobody is absent on ${DAY}.`));
    const bad = await use("owner", ["*"], "school__get_absent", { date: "tomorrow" });
    check("what it refuses comes back as its own words, quoted", bad.startsWith("school reported an error: --- school result:") && bad.includes("date is YYYY-MM-DD."), bad);
  }

  console.log("\na teacher files leave: the school reports it, with the relief as a suggestion");
  {
    o.told.length = 0;
    const filed = await school.fileLeave("T2", DAY);
    await settle();
    check("Jarvis took its report", JSON.stringify(filed.answer) === JSON.stringify({ ok: true, name: "School", taken: 1, refused: [] }), filed);
    const mine = o.toldTo("owner")[0];
    const card = (await o.jarvis.proposalsOf("owner", Date.now())).find((p) => p.state === "pending");
    check("who it tells is told, in the school's words, under its name", mine?.title === "School" && mine.text.startsWith("Ms Devi is on leave on 2026-11-13. Periods 1, 3, 4 need cover."), mine);
    check("with plan A as a card to approve, and nothing applied", card?.says === "school (apply_relief): date 2026-11-13, plan A" && mine?.proposals?.[0]?.id === card?.id && school.inForce(DAY) === null, card);
    check("someone who did not ask to be told is not", o.toldTo("u_sara").length === 0);
    const again = await school.fileLeave("T2", DAY);
    await settle();
    check("the same leave reported again is taken once: no second card", JSON.stringify(again.answer) === JSON.stringify(filed.answer) && (await o.jarvis.proposalsOf("owner", Date.now())).length === 1 && o.toldTo("owner").length === 1);

    asked.length = 0;
    await o.jarvis.proposalApprove("owner", card!.id, ["*"], ["*"], Date.now());
    await o.jarvis.alarm();
    check("approved: plan A is in force, applied as the office (the person who tapped)", school.inForce(DAY) === "A" && asked.join() === "T1" && (await o.jarvis.proposalGet("owner", card!.id, Date.now()))?.state === "done", { asked, inForce: school.inForce(DAY) });
    const twice = await use("owner", ["*"], "school__apply_relief", { date: DAY, plan: "A" });
    check("applying it again changes nothing, and says so: safe to call twice", twice.includes("Plan A is already in force for 2026-11-13: nothing changed.") && !twice.startsWith("school reported an error"), twice);
    const covering = await use("u_sara", ROLE_SCOPES.adult, "school__get_timetable", { date: DAY });
    check("whoever covers sees the relief in their day", covering.includes("period 4 4A Science (relief for Ms Devi)"), covering);
    const notOffice = await use("u_sara", ROLE_SCOPES.adult, "school__apply_relief", { date: DAY, plan: "B" });
    check("the school keeps its own rule: shared to use, but not in its office, she may not apply relief", notOffice.includes("Only the timetable office may apply relief") && school.inForce(DAY) === "A", notOffice);
  }

  console.log("\nit checks again as it acts");
  {
    const day = "2026-11-16";
    await school.fileLeave("T4", day);
    await settle();
    const card = (await o.jarvis.proposalsOf("owner", Date.now())).find((p) => p.state === "pending" && p.action.args.date === day);
    school.withdrawLeave("T4", day);
    await o.jarvis.proposalApprove("owner", card!.id, ["*"], ["*"], Date.now());
    await o.jarvis.alarm();
    const done = await o.jarvis.proposalGet("owner", card!.id, Date.now());
    check("a card approved after the leave was withdrawn applies nothing, and the card says why", done?.state === "failed" && /Nobody is absent on 2026-11-16 any more: nothing was applied\./.test(done.outcome?.text ?? "") && school.inForce(day) === null, done);
  }

  console.log("\nset to run by itself by the owner");
  {
    const day = "2026-11-17";
    await admin("PATCH", { id, alone: { apply_relief: true } });
    o.told.length = 0;
    asked.length = 0;
    const filed = await school.fileLeave("T5", day);
    check("the school has its answer first", filed.answer?.taken === 1 && after.length === 1);
    await settle();
    check("then plan A is applied, by code, with nobody named to the school", school.inForce(day) === "A" && asked.length === 1 && asked[0] === null, { asked, inForce: school.inForce(day) });
    check("and told, in words written from the call", o.toldTo("owner").some((a) => a.text === "Done by itself: school (apply_relief): date 2026-11-17, plan A" && a.title === "School"), o.toldTo("owner").map((a) => a.text));
    check("no card was needed", !(await o.jarvis.proposalsOf("owner", Date.now())).some((p) => p.action.args.date === day));
  }
} finally {
  globalThis.fetch = real;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
