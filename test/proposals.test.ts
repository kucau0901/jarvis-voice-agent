// Approvals (lib/proposals.ts, routes/proposals.ts): what a job proposes, how
// risky code says it is, and how a tap has the stored call made once, on the
// object's alarm (tick, lib/approval.ts).
import { classify, DECIDE_MS, GONE_MS, held, LAPSING_MS, PER_JOB, PENDING_MAX, PROPOSE_ONLY, proposable, Proposals, runGrants, START_MS, STUCK_MS, TRIED_MS, UNDO_MS, weigh, type Proposal, type ProposalInput } from "../src/worker/lib/proposals.ts";
import { carryOut, inverseOf, notAsShown } from "../src/worker/lib/approval.ts";
import { mailArchiveMany } from "../src/worker/lib/mail-bulk.ts";
import { handleProposals } from "../src/worker/routes/proposals.ts";
import { baseTools, type Tool } from "../src/worker/tools/registry.ts";
import { carCommand } from "../src/worker/tools/tessie.ts";
import { calendarAdd } from "../src/worker/tools/calendar.ts";
import { mailManage } from "../src/worker/tools/gmail.ts";
import { mailDraftSend } from "../src/worker/lib/mail-draft.ts";
import type { Grant } from "../src/worker/lib/scopes.ts";

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

const T = Date.UTC(2026, 9, 21, 9, 0);
/** No family: the one car in the settings, whatever it is called. A family's: two cars, by name. */
const NO_CARS = {} as never;
const CARS = { JARVIS_CARS: JSON.stringify([{ id: "c1", name: "Ioniq 5", level: "own", mine: true, vin: "VIN_A", token: "t" }, { id: "c2", name: "Model Y", level: "own", mine: true, vin: "VIN_B", token: "t" }]) } as never;
const lock = { tool: "car_command", args: { command: "lock", value: null, temperature: null, percent: null, car: null } };
const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  who: "u_sara~d_tablet",
  person: "u_sara",
  from: { kind: "job", id: "j1", title: "Tidy up after the trip" },
  action: lock,
  weighed: weigh(carCommand, lock.args, NO_CARS)!,
  grants: ["*"],
  ...over,
});

console.log("kept, and decided once");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const p = (await props.add(input(), T)) as Proposal;
  check("filed: waiting, for a day, with its call and the job it came from", p.state === "pending" && p.expires === T + DECIDE_MS && p.action.tool === "car_command" && p.from.id === "j1" && p.why === "From your job “Tidy up after the trip”" && /^a[0-9a-z]{20}$/.test(p.id), p);
  check("kept under its person", [...st._m.keys()].every((k) => k.startsWith("prop:u_sara:")));
  const again = await props.add(input({ action: { tool: "car_command", args: { car: null, percent: null, temperature: null, value: null, command: "lock" } } }), T + 1000);
  check("the same call from the same job again is the one filed, whatever order its words", typeof again !== "string" && again.id === p.id && st._m.size === 1);
  for (let i = 2; i <= PER_JOB; i++) await props.add(input({ action: { tool: "car_command", args: { ...lock.args, command: "start_climate", percent: i } } }), T);
  const sixth = await props.add(input({ action: { tool: "car_command", args: { ...lock.args, command: "stop_climate" } } }), T);
  check(`at most ${PER_JOB} from one job`, typeof sixth === "string" && /At most 5/.test(sixth), sixth);
  const many = new Proposals(fakeStorage() as never);
  for (let i = 0; i < PENDING_MAX; i++) await many.add(input({ from: { kind: "job", id: `j${i}`, title: "x" } }), T);
  const over = await many.add(input({ from: { kind: "job", id: "jx", title: "x" } }), T);
  check(`at most ${PENDING_MAX} waiting for one person`, typeof over === "string" && /already waiting/.test(over), over);
  const big = await props.add(input({ from: { kind: "job", id: "j9", title: "x" }, action: { tool: "calendar_add", args: { title: "x".repeat(5000) } } }), T);
  check("too long to propose", typeof big === "string" && /too long/.test(big));

  const claimed = await props.claim("u_sara", p.id, ["*"], ["*"], T + 5000);
  check("approved: running, by a tap, once", typeof claimed !== "string" && claimed.state === "running" && claimed.by === "tap" && claimed.decidedAt === T + 5000, claimed);
  check("a second tap: already approved", (await props.claim("u_sara", p.id, ["*"], ["*"], T + 6000)) === "It was approved already.");
  check("someone else's: as if there were none", (await props.claim("u_adam", p.id, ["*"], ["*"], T)) === "No such proposal." && (await props.get("u_adam", p.id, T)) === null);
  const done = await props.finish("u_sara", p.id, { ok: true, text: "Locked. ".repeat(100) }, T + 7000);
  check("finished: done, with what came of it, cut short", done?.state === "done" && done.outcome!.text.length === 300 && (await props.finish("u_sara", p.id, { ok: true, text: "again" }, T)) === null);

  const late = (await props.add(input({ from: { kind: "job", id: "j2", title: "x" } }), T)) as Proposal;
  check("past its day: expired, and can no longer be approved", (await props.get("u_sara", late.id, T + DECIDE_MS))?.state === "expired" && (await props.claim("u_sara", late.id, ["*"], ["*"], T + DECIDE_MS)) === "It has expired.");
  const no = (await props.add(input({ from: { kind: "job", id: "j3", title: "x" } }), T)) as Proposal;
  const declined = await props.decline("u_sara", no.id, T + 1);
  check("declined: not done, and no longer waiting", typeof declined !== "string" && declined.state === "declined" && (await props.claim("u_sara", no.id, ["*"], ["*"], T + 2)) === "It was declined.");
  const stuck = (await props.add(input({ from: { kind: "job", id: "j4", title: "x" } }), T)) as Proposal;
  await props.claim("u_sara", stuck.id, ["*"], ["*"], T);
  // Not after five minutes, as when the request made the call: the alarm may start it up to START_MS after the tap.
  check("a run that may still be going is not called failed", (await props.get("u_sara", stuck.id, T + START_MS + 60_000))?.state === "running");
  check("a run that never finished: failed, never run again", (await props.get("u_sara", stuck.id, T + STUCK_MS + 1))?.state === "failed" && typeof (await props.claim("u_sara", stuck.id, ["*"], ["*"], T + STUCK_MS + 1)) === "string");

  const job = (await props.add(input({ from: { kind: "job", id: "j5", title: "x" } }), T)) as Proposal;
  await props.withdrawJob("u_sara", "j5", T + 1);
  check("its job cancelled: withdrawn", (await props.get("u_sara", job.id, T + 2))?.state === "withdrawn");
  await props.forget("u_sara");
  check("someone who left: nothing of theirs kept", st._m.size === 0);
}

console.log("\ntwo identical calls at once");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const ev = { tool: "calendar_add", args: { title: "Dentist", start: "2026-10-23T15:00:00+08:00", duration_minutes: 30, location: null } };
  const w = weigh(calendarAdd, ev.args, NO_CARS)!;
  const both = await Promise.all([props.add(input({ action: ev, weighed: w }), T), props.add(input({ action: ev, weighed: w }), T)]);
  check("filed once: the second sees the first", [...st._m.keys()].filter((k) => k.startsWith("prop:")).length === 1 && typeof both[0] !== "string" && typeof both[1] !== "string" && both[0].id === both[1].id);
}

console.log("\nmade on the object's alarm (tick)");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const made: { id: string; grants: string[] }[] = [];
  const make = async (p: Proposal, grants: readonly string[]) => (made.push({ id: p.id, grants: [...grants] }), { ok: true, text: "Locked." });
  const p = (await props.add(input(), T)) as Proposal;
  check("nothing approved: nothing to wake for", (await props.nextWake(T)) === null);
  const gone = await props.claim("u_sara", p.id, null, ["*"], T);
  check("for someone no longer in the family: not claimed, still waiting", gone === "Whoever it was for is no longer in the family." && (await props.get("u_sara", p.id, T))?.state === "pending" && (await props.nextWake(T)) === null);
  const claimed = await props.claim("u_sara", p.id, ["ask", "car.control", "calendar"], ["car.control", "ask"], T);
  check("approved: running, nothing made yet, and the alarm wanted at once", typeof claimed !== "string" && claimed.state === "running" && made.length === 0 && (await props.nextWake(T + 10)) === T + 10);
  await props.tick({ carryOut: make }, T + 100);
  const done = await props.get("u_sara", p.id, T + 200);
  check("the alarm makes it once, with what its tap allowed, and keeps what came of it", made.length === 1 && made[0]!.grants.join() === "ask,car.control" && done?.state === "done" && done.outcome?.text === "Locked.", { made, done });
  await props.tick({ carryOut: make }, T + 200);
  check("never made again, and nothing left to wake for", made.length === 1 && (await props.nextWake(T + 200)) === null);

  const failing = (await props.add(input({ from: { kind: "job", id: "jf", title: "x" } }), T)) as Proposal;
  await props.claim("u_sara", failing.id, ["*"], ["*"], T);
  await props.tick({
    carryOut: async () => {
      throw new Error("Tessie unreachable");
    },
  }, T + 1);
  check("a run that throws: failed, with why", (await props.get("u_sara", failing.id, T + 2))?.outcome?.text === "That failed: Tessie unreachable");

  const late = (await props.add(input({ from: { kind: "job", id: "jl", title: "x" } }), T)) as Proposal;
  await props.claim("u_sara", late.id, ["*"], ["*"], T);
  await props.tick({ carryOut: make }, T + START_MS + 1);
  const notMade = await props.get("u_sara", late.id, T + START_MS + 1);
  check("not started within twenty minutes of the tap (the alarm kept failing): not made, and said so", made.length === 1 && notMade?.state === "failed" && /in time/.test(notMade.outcome?.text ?? ""), notMade);

  // The object goes away mid-call (a deploy): the alarm is tried again by a fresh one, over the same storage.
  const cut = (await props.add(input({ from: { kind: "job", id: "jc", title: "x" } }), T)) as Proposal;
  await props.claim("u_sara", cut.id, ["*"], ["*"], T);
  let tries = 0;
  void props.tick({ carryOut: () => (tries++, new Promise<never>(() => {})) }, T + 1);
  await new Promise((r) => setTimeout(r, 0));
  const fresh = new Proposals(st as never);
  await fresh.tick({ carryOut: make }, T + 2);
  check("cut short mid-call: never made a second time", tries === 1 && made.length === 1 && (await fresh.nextWake(T + 2)) === null);
  check("…and read as failed once it cannot still be going", (await fresh.get("u_sara", cut.id, T + 60_000))?.state === "running" && (await fresh.get("u_sara", cut.id, T + STUCK_MS + 1))?.state === "failed");

  // Queued together behind a busy alarm: made in the order they were tapped, whatever order they are kept in, each after the last has finished.
  const second = (await props.add(input({ from: { kind: "job", id: "jo", title: "x" }, action: { tool: "car_command", args: { ...lock.args, command: "stop_climate" } } }), T)) as Proposal;
  const first = (await props.add(input({ from: { kind: "job", id: "jo", title: "x" }, action: { tool: "car_command", args: { ...lock.args, command: "start_climate" } } }), T)) as Proposal;
  await props.claim("u_sara", second.id, ["*"], ["*"], T + 2);
  await props.claim("u_sara", first.id, ["*"], ["*"], T + 1);
  const turns: string[] = [];
  await props.tick({
    async carryOut(q) {
      turns.push(`start ${q.id}`);
      await new Promise((r) => setTimeout(r, 5));
      turns.push(`end ${q.id}`);
      return { ok: true, text: "Done." };
    },
  }, T + 3);
  check("several waiting: made one at a time, in the order they were tapped", turns.join() === [`start ${first.id}`, `end ${first.id}`, `start ${second.id}`, `end ${second.id}`].join(), turns);

  const left = (await props.add(input({ from: { kind: "job", id: "jg", title: "x" } }), T)) as Proposal;
  await props.claim("u_sara", left.id, ["*"], ["*"], T);
  await props.forget("u_sara");
  await props.tick({ carryOut: make }, T + 1);
  check("its person left before the alarm came: nothing made, nothing kept", made.length === 1 && st._m.size === 0);

  // A claim cut short before its record was written: the entry alone is let go, and it can be tapped again.
  const half = (await props.add(input({ from: { kind: "job", id: "jh", title: "x" } }), T)) as Proposal;
  st._m.set(`proprun:u_sara:${half.id}`, { person: "u_sara", id: half.id, grants: ["*"] });
  await props.tick({ carryOut: make }, T + 1);
  check("an entry for one still waiting: nothing made, and it still waits", made.length === 1 && (await props.get("u_sara", half.id, T + 1))?.state === "pending" && (await props.nextWake(T + 1)) === null);
}

console.log("\nshown whole, or not filed");
{
  const props = new Proposals(fakeStorage() as never);
  const unlock = { command: "unlock", value: null, temperature: null, percent: null, car: "Model Y — the nightly routine lock, nothing else changes " + ".".repeat(250) };
  check("a padded name in a family is not one of their cars: not proposed", weigh(carCommand, unlock, CARS) === null);
  const longTo = mailDraftSend.propose!({ draft: "r-12345", to: "a".repeat(300) + "@example.com", subject: "s", asked: "x" }, NO_CARS)!;
  const cut = await props.add(input({ action: { tool: "mail_draft_send", args: { draft: "r-12345" } }, weighed: longTo }), T);
  check("an address too long to show whole: refused, never cut", longTo.says.includes("a".repeat(300)) && typeof cut === "string" && /too long to show/.test(cut));
  const longSubject = await props.add(input({ from: { kind: "job", id: "jls", title: "x" }, action: { tool: "mail_draft_send", args: { draft: "r-3" } }, weighed: { risk: "irreversible", says: "Send the email to a" }, body: `Subject: ${"Re: ".repeat(200)}x\n\n${"w".repeat(4200)}` }), T);
  check("a reply's long subject, with its words and a footer: still shown, not refused after it was drafted", typeof longSubject !== "string");
  const bulk = { note: "x".repeat(300), operations: [{ entity_id: "lock.front_door", action: "unlock" }] };
  const house = await props.add(input({ action: { tool: "home__ha_bulk_control", args: bulk }, weighed: classify("home__ha_bulk_control", bulk)! }), T);
  check("a house call whose last words would be cut: refused", typeof house === "string" && /too long to show/.test(house), house);
  const mail = await props.add(input({ action: { tool: "mail_draft_send", args: { draft: "r-1", to: "a", subject: "b" } }, weighed: { risk: "irreversible", says: "Send the email to a: “b”" }, body: "Hello.\n\nSee you at six." }), T);
  check("an email's words kept with it, to show on its card", typeof mail !== "string" && mail.body === "Hello.\n\nSee you at six.");
  check("words too long to show whole: refused", typeof (await props.add(input({ from: { kind: "job", id: "jm", title: "x" }, action: { tool: "mail_draft_send", args: { draft: "r-2", to: "a", subject: "b" } }, weighed: { risk: "irreversible", says: "Send" }, body: "x".repeat(9000) }), T)) === "string");
}

console.log("\nannounced with the job's result");
{
  const props = new Proposals(fakeStorage() as never);
  const p = (await props.add(input(), T)) as Proposal;
  await props.add(input({ from: { kind: "job", id: "other", title: "y" } }), T);
  const alert = { id: "al1", at: T, title: "Done: Tidy up", text: "SUMMARY: done.", speak: false, urgent: false, source: "job" as const, job: "j1" };
  const a = await props.attach(alert, "u_sara", T);
  check("its own proposals on the alert, for their cards", a.proposals?.length === 1 && a.proposals[0]!.id === p.id && a.proposals[0]!.risk === "reversible");
  check("and in its words, for every channel", a.text === "SUMMARY: done.\n\nWaiting for your OK in Jarvis: Car: lock", a.text);
  const plain = { ...alert, job: undefined };
  check("an alert from no job: as it was", (await props.attach(plain, "u_sara", T)) === plain);
  const none = { ...alert, job: "j-none" };
  check("a job that proposed nothing: as it was", (await props.attach(none, "u_sara", T)) === none);
}

console.log("\nhow risky: code says, from the tool and its arguments");
{
  const car = (command: string, extra: Record<string, unknown> = {}, env = NO_CARS) => weigh(carCommand, { command, value: null, temperature: null, percent: null, car: null, ...extra }, env);
  check("locking the car: reversible, its own kind, its button Lock", JSON.stringify(car("lock")) === JSON.stringify({ risk: "reversible", says: "Car: lock", category: "car_command:lock", verb: "Lock" }), car("lock"));
  check("a temperature says which", car("set_temperature", { temperature: 21 })?.says === "Car: set temperature to 21°C" && car("set_temperature", { temperature: 21 })?.category === "car_command:set_temperature");
  check("unlocking, the trunks, the horn, a destination on its screen: irreversible, no kind",
    ["unlock", "open_frunk", "open_trunk", "vent_windows", "honk", "navigate_to"].every((c) => car(c)?.risk === "irreversible" && !car(c)?.category));
  check("an unknown command: cannot be proposed", car("self_destruct") === null);
  check("a family's car: the command first, then the car it will be, by its own name", car("unlock", { car: "model y" }, CARS)?.says === "Car: unlock (Model Y, …IN_B)" && car("lock", {}, CARS)?.says === "Car: lock (Ioniq 5, …IN_A)");
  // Two cars of one name: told apart by their VINs, so a card cannot pass for the other.
  const twins = (cars: [string, string][]) => ({ JARVIS_CARS: JSON.stringify(cars.map(([name, vin], i) => ({ id: `c${i}`, name, level: "own", mine: true, vin, token: "t" }))) }) as never;
  check("two cars of one name read differently", car("unlock", { car: "Model Y" }, twins([["Model Y", "VIN_1111"], ["Model Y", "VIN_2222"]]))?.says !== car("unlock", { car: "Model Y" }, twins([["Model Y", "VIN_2222"]]))?.says);
  check("a name that is not exactly one of theirs: not proposed (it could pick another car)", car("unlock", { car: "Model Y, not the Ioniq 5" }, CARS) === null);
  check("no family: the one car, with no name to mislead", car("unlock", { car: "the nightly routine lock" })?.says === "Car: unlock");
  check("mail tidying: reversible each, trash always asks", weigh(mailManage, { message_id: "199a2b3c4d5e6f70", action: "archive" }, NO_CARS)?.category === "mail_manage:archive" && weigh(mailManage, { message_id: "199a2b3c4d5e6f70", action: "trash" }, NO_CARS)?.risk === "irreversible" && weigh(mailManage, { message_id: "../x", action: "archive" }, NO_CARS) === null);
  const ev = weigh(calendarAdd, { title: "Dentist", start: "2026-10-22T09:00:00+08:00", duration_minutes: 30, location: null }, NO_CARS);
  check("a calendar event: reversible, says when", ev?.risk === "reversible" && ev.category === "calendar_add" && ev.says.includes("30 min"), ev);
  const kl = { TIMEZONE: "Asia/Kuala_Lumpur" } as never;
  const utc = weigh(calendarAdd, { title: "Dentist", start: "2026-10-22T01:00:00Z", duration_minutes: 30, location: null }, kl);
  check("when, as the event will be: in their time zone, as a date", utc?.says.includes("Thu, 22 Oct 2026, 09:00") === true, utc?.says);
  check("a 30 February: the card says the day it will really be made", weigh(calendarAdd, { title: "x", start: "2026-02-30T09:00:00+08:00", duration_minutes: 30, location: null }, kl)?.says.includes("2 Mar 2026") === true);
  check("no full timestamp: not proposed", weigh(calendarAdd, { title: "x", start: "tomorrow at nine", duration_minutes: 30, location: null }, kl) === null);
  const svc = classify("home__ha_call_service", { domain: "lock", service: "unlock", entity_id: "lock.front" });
  check("a house call: irreversible, never a kind, saying which service on which entity", svc?.risk === "irreversible" && !svc.category && svc.says === "home (ha_call_service): lock.unlock lock.front", svc);
  check("a house call naming its entity in data", classify("home__ha_call_service", { domain: "light", service: "turn_on", data: { entity_id: ["light.porch", "light.hall"] } })?.says === "home (ha_call_service): light.turn_on light.porch, light.hall");
  const more = classify("home__ha_call_service", { domain: "lock", service: "unlock", entity_id: "lock.shed", data: { area_id: "front_porch" } })?.says ?? "";
  const note = classify("home__ha_call_service", { domain: "notify", service: "mobile_app_phone", data: { message: "Your code is 1234" } })?.says ?? "";
  check("and everything else it would send: another target, a message", more.includes("front_porch") && note.includes("Your code is 1234"), { more, note });
  const odd = [
    classify("home__ha_call_service", { domain: "lock", service: "light.turn_on", entity_id: "light.porch" })?.says ?? "",
    classify("home__ha_call_service", { domain: "lock", service: "unlock", data: { entity_id: { area_id: "garage" } } })?.says ?? "",
    classify("home__ha_call_service", { domain: "light", service: "turn_on", entity_id: [["lock.front"]] })?.says ?? "",
  ];
  check("a domain the service does not take, and entity ids that are not plain names: shown too", odd[0].includes("domain lock") && odd[1].includes("garage") && odd[2].includes("lock.front"), odd);
  const asText = classify("home__ha_call_service", { domain: "cover", service: "open_cover", data: '{"entity_id":"cover.garage_door"}' })?.says ?? "";
  check("data written as text, which the server reads too, is shown as it is", asText.includes("cover.garage_door"), asText);
  const cal = (a: Record<string, unknown>) => weigh(calendarAdd, { title: "Dentist", start: "2026-10-22T09:00:00+08:00", duration_minutes: 30, location: null, ...a }, NO_CARS);
  check("a calendar event as it will be made: no length is an hour, a day at most, the title tidied", /, 60 min/.test(cal({ duration_minutes: 0 })?.says ?? "") && /, 1440 min/.test(cal({ duration_minutes: 99999 })?.says ?? "") && cal({ title: "  Dentist   check  " })?.says.startsWith("Calendar: “Dentist check”") === true);
  check("a title or place it would cut short: not proposed", cal({ title: "x".repeat(201) }) === null && cal({ location: "y".repeat(201) }) === null);
  check("one that only reads, or no server's: not proposed", classify("home__ha_get_state", { entity_id: "x" }) === null && classify("recall", {}) === null);
}

console.log("\nwhat a job is handed");
{
  const env = { TESSIE_TOKEN: "t", TESSIE_VIN: "LRWTEST0000000000", GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec", HERMES_BASE_URL: "https://hermes.example", HERMES_API_KEY: "k", HA_BASE_URL: "https://house.example", HA_TOKEN: "t", STATE: {} } as never;
  const all = baseTools(env, ["*"]);
  const names = all.map((t) => t.name);
  check("the tools that act are all here to be checked", ["ask_hermes", "control_home", "start_job", "routine_add", "remember", "forget", "specialty_save", "panel_set", "send_note", "mail_send", "make_page", "car_command"].every((n) => names.includes(n)), names);
  check("only those that say how, and nothing else, may be proposed", all.filter(proposable).map((t) => t.name).sort().join() === "calendar_add,car_command,mail_manage", all.filter(proposable).map((t) => t.name));
  const filedCalls: unknown[] = [];
  let ranReal = false;
  const real: Tool = { ...carCommand, run: async () => ((ranReal = true), "Locked.") };
  const read: Tool = { name: "recall", description: "r", parameters: {}, run: async () => "" };
  const mcp: Tool = { name: "home__ha_call_service", description: "Call a service.", parameters: { type: "object" }, strict: false, run: async () => ((ranReal = true), "ok") };
  const out = held([read, real, mcp], async (action, w, ctx) => (filedCalls.push({ action, w, grants: ctx.grants }), "filed"), async () => {});
  check("one that reads: the same tool", out[0] === read);
  check("one that acts: the same name and arguments, said to only propose", out[1]!.name === "car_command" && out[1]!.parameters === carCommand.parameters && out[1]!.description.startsWith(PROPOSE_ONLY) && out[2]!.strict === false);
  const said = await out[1]!.run({ ...lock.args }, { grants: ["car.control"] } as never);
  await out[2]!.run({ domain: "light", service: "turn_on", entity_id: "light.porch" }, { grants: ["home"] } as never);
  check("its run files the call, and never makes it", !ranReal && filedCalls.length === 2 && said === "filed" && JSON.stringify((filedCalls[0] as { action: unknown }).action) === JSON.stringify({ tool: "car_command", args: lock.args }), filedCalls);
  const bodies: (string | undefined)[] = [];
  const looked: Tool = { ...mailManage, detail: async () => "From: Sam\nSubject: Dinner", run: async () => "x" };
  const [hm] = held([looked], async (_a, _w, _c, body) => (bodies.push(body), "filed"), async () => {});
  await hm!.run({ message_id: "199a2b3c4d5e6f70", action: "archive" }, { env: NO_CARS } as never);
  check("what a tool looks up of the thing it acts on goes on the card", bodies[0] === "From: Sam\nSubject: Dinner", bodies);
  const odd = await out[1]!.run({ ...lock.args, command: "self_destruct" }, {} as never);
  check("arguments that cannot be proposed: not filed", filedCalls.length === 2 && /cannot be proposed/.test(String(odd)));
}

console.log("\nallowed without asking: a reversible kind, once approved");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const p = (await props.add(input(), T)) as Proposal;
  check("not before it is approved and done", typeof (await props.allow("u_sara", p.id, T)) === "string");
  await props.claim("u_sara", p.id, ["*"], ["*"], T);
  await props.finish("u_sara", p.id, { ok: true, text: "Locked." }, T);
  check("once approved by a tap and done: that kind is allowed", (await props.allow("u_sara", p.id, T)) === null && (await props.allowed("u_sara")).join() === "car_command:lock");
  const auto = (await props.add(input({ from: { kind: "job", id: "j2", title: "x" } }), T)) as Proposal;
  check("a later job's call of that kind: run without asking", auto.state === "running" && auto.by === "standing");
  const unlock = { tool: "car_command", args: { ...lock.args, command: "unlock" } };
  const asks = (await props.add(input({ from: { kind: "job", id: "j3", title: "x" }, action: unlock, weighed: weigh(carCommand, unlock.args, NO_CARS)! }), T)) as Proposal;
  check("another kind, or anything irreversible: still asks", asks.state === "pending");
  const house = (await props.add(input({ from: { kind: "job", id: "j4", title: "x" }, action: { tool: "home__ha_call_service", args: { domain: "lock", service: "lock" } }, weighed: classify("home__ha_call_service", { domain: "lock", service: "lock" })! }), T)) as Proposal;
  check("a house call, even one that locks: always asks", house.state === "pending" && !house.category);
  const unlockedLater = (await props.add(input({ from: { kind: "job", id: "j3b", title: "x" }, action: unlock, weighed: weigh(carCommand, unlock.args, NO_CARS)! }), T)) as Proposal;
  await props.decline("u_sara", unlockedLater.id, T);
  check("a declined or irreversible one cannot be allowed", typeof (await props.allow("u_sara", unlockedLater.id, T)) === "string");

  // A job's held tool under the permission: run once, finished, and never again on a retried step.
  let runs = 0;
  const finished: string[] = [];
  const real: Tool = { ...carCommand, run: async (_a, c) => (runs++, c.done?.(), "Locked.") };
  const file = (job: string) => async (action: Proposal["action"], w: ReturnType<typeof weigh>) => props.add(input({ from: { kind: "job", id: job, title: "x" }, action, weighed: w! }), T);
  const [h] = held([real], file("j5"), async (q, o) => {
    finished.push(`${q.id}:${o.text}`);
    await props.finish("u_sara", q.id, o, T);
  });
  const said = await h!.run({ ...lock.args }, {} as never);
  check("held, under the permission: the call made once, and finished", runs === 1 && finished.length === 1 && /^Done without asking/.test(String(said)), { runs, finished, said });
  const again = await h!.run({ ...lock.args }, {} as never);
  check("the same call again from that job: not made again", runs === 1 && /Already done without asking/.test(String(again)), again);
  // One that says it could not: recorded so, and said so.
  const fails: Tool = { ...carCommand, run: async () => "Could not wake the car: asleep." };
  const [hf] = held([fails], file("j5b"), async (q, o) => void (await props.finish("u_sara", q.id, o, T)));
  const failedSaid = await hf!.run({ ...lock.args }, {} as never);
  const failedOne = (await props.list("u_sara", T)).find((q) => q.from.id === "j5b");
  const alerted = await props.attach({ id: "x", at: T, title: "t", text: "r", speak: false, urgent: false, source: "job", job: "j5b" }, "u_sara", T);
  const repeat = await hf!.run({ ...lock.args }, {} as never);
  check("that same call again: said not to have worked, and not tried again", !/Already done/.test(String(repeat)) && /did not work/.test(String(repeat)), repeat);
  check("allowed, but the tool says it could not: failed, and said so, never 'done'",
    failedOne?.state === "failed" && /did not work/.test(String(failedSaid)) && /did not work/.test(alerted.text) && !/Done without asking/.test(alerted.text) && alerted.text.includes("Could not wake the car"), { failedOne, failedSaid, text: alerted.text });
  check("asking again for that kind", (await props.disallow("u_sara", "car_command:lock")) && (await props.allowed("u_sara")).length === 0 && ((await props.add(input({ from: { kind: "job", id: "j6", title: "x" } }), T)) as Proposal).state === "pending");
  await props.allow("u_sara", p.id, T);
  await props.forget("u_sara");
  check("someone who left: what they allowed is gone too", (await props.allowed("u_sara")).length === 0 && st._m.size === 0);
}

console.log("\nwhat an approval may run with");
{
  check("never more than the job had, whoever approves", runGrants(["ask"], ["*"], ["*"])?.join() === "ask");
  check("no more than its maker may now", runGrants(["*"], ["ask", "car.control"], ["*"])?.join() === "ask,car.control");
  check("nor than the one approving", runGrants(["car.control", "calendar"], ["*"], ["calendar"])?.join() === "calendar");
  const all = runGrants(["*"], ["*"], ["*"])!;
  check("never Hermes nor a screen", !all.includes("hermes") && !all.includes("screen") && all.includes("car.control") && !all.includes("*"));
  check("no one to say: nothing", runGrants(["*"], null, ["*"]) === null && runGrants(["*"], undefined, ["*"]) === null);
}

console.log("\nanswered by a tap (routes/proposals.ts)");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const scopes: Record<string, string[] | null> = { u_mia: ["*"], u_lee: null };
  let hubDown = false;
  // The object, as far as the route asks it: its proposals, and who is in the family (hub-client personView).
  const stub = {
    hubCall: async (m: string, a: unknown[]) => {
      if (hubDown) throw new Error("hub unreachable");
      return m === "personView" ? { space: { id: "s" }, name: "x", prefs: {}, cars: [], scopes: scopes[a[0] as string] } : null;
    },
    proposalsOf: (person: string, now: number) => props.list(person, now),
    proposalGet: (person: string, id: string, now: number) => props.get(person, id, now),
    proposalApprove: (person: string, id: string, scopesNow: Grant[] | null | undefined, approver: Grant[], now: number) => props.claim(person, id, scopesNow, approver, now),
    proposalDecline: (person: string, id: string, now: number) => props.decline(person, id, now),
    proposalFinish: (person: string, id: string, outcome: { ok: boolean; text: string }, now: number) => props.finish(person, id, outcome, now),
    proposalAllowed: (person: string) => props.allowed(person),
    proposalAllow: (person: string, id: string, now: number) => props.allow(person, id, now),
    proposalDisallow: (person: string, category: string) => props.disallow(person, category),
    proposalUndo: (person: string, id: string, scopesNow: Grant[] | null | undefined, approver: Grant[], now: number) => props.undo(person, id, (q) => inverseOf(env, q), scopesNow, approver, now),
  };
  const env = { TESSIE_TOKEN: "t", TESSIE_VIN: "LRWTEST0000000000", STATE: { idFromName: () => "jarvis", get: () => stub } } as never;
  const mia = { kind: "member", id: "u_mia", role: "adult", scopes: ["*"], session: "s" } as never;
  /** The object's alarm, as state.ts runs it: each call made as its person (here, the env given). */
  const alarm = (e: unknown = env) => props.tick({ carryOut: (q, grants) => carryOut(e as never, q, grants) });
  const req = (path: string, body?: unknown) => new Request(`https://j.test${path}`, body ? { method: "POST", body: JSON.stringify(body) } : {});
  const p = (await props.add(input({ person: "u_mia", who: "u_mia" }), Date.now())) as Proposal;
  const theirs = (await props.add(input({ person: "u_lee", who: "u_lee", from: { kind: "job", id: "jl", title: "x" } }), Date.now())) as Proposal;

  const list = (await (await handleProposals(req("/api/hub/proposals"), env, mia))!.json()) as { open: Record<string, unknown>[] };
  check("listed: their own, waiting, without what it would run with", list.open.length === 1 && list.open[0]!.id === p.id && !("grants" in list.open[0]!) && !("who" in list.open[0]!), list);
  check("not a path of its own: passed on", (await handleProposals(req("/api/hub/me"), env, mia)) === null);
  const device = await handleProposals(req("/api/hub/proposals"), env, { kind: "device", id: "d1", name: "tablet", scopes: ["*"] } as never);
  check("a device: refused", device!.status === 403);
  check("someone else's: no such proposal", (await handleProposals(req("/api/hub/proposals/answer", { id: theirs.id, answer: "approve" }), env, mia))!.status === 404);

  const sent: string[] = [];
  let refuse = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    sent.push(`${init.method ?? "GET"} ${url}`);
    if (url.includes("/status")) return Response.json({ status: "awake" });
    return Response.json({ result: !refuse });
  }) as typeof fetch;
  try {
    // The request says another call: only what was stored is run.
    const r = await handleProposals(req("/api/hub/proposals/answer", { id: p.id, answer: "approve", tool: "car_command", args: { command: "unlock" } }), env, mia);
    const body = (await r!.json()) as { proposal: Proposal };
    check("approved: answered at once, running, and nothing made in the request", r!.status === 200 && body.proposal.state === "running" && body.proposal.by === "tap" && sent.length === 0, { body, sent });
    await alarm();
    const made = await props.get("u_mia", p.id, Date.now());
    check("then the alarm makes the stored call, once, and what came of it is kept", made?.state === "done" && sent.some((s) => /\/command\/lock\b/.test(s)) && !sent.some((s) => /unlock/.test(s)), { made, sent });
    refuse = true;
    const nope = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "jn", title: "x" } }), Date.now())) as Proposal;
    await handleProposals(req("/api/hub/proposals/answer", { id: nope.id, answer: "approve" }), env, mia);
    await alarm();
    const refused = (await props.get("u_mia", nope.id, Date.now()))!;
    check("the car did not accept it: failed, with its words, so it cannot be allowed without asking", refused.state === "failed" && /did not accept/.test(refused.outcome!.text) && (await handleProposals(req("/api/hub/proposals/allow", { id: nope.id }), env, mia))!.status === 409, refused);
    refuse = false;
    const locks = sent.filter((s) => /\/command\/lock\b/.test(s)).length;
    const twice = await handleProposals(req("/api/hub/proposals/answer", { id: p.id, answer: "approve" }), env, mia);
    check("a second tap: already approved, nothing run", twice!.status === 409 && sent.filter((s) => /\/command\/lock\b/.test(s)).length === locks);
    const allow = await handleProposals(req("/api/hub/proposals/allow", { id: p.id }), env, mia);
    const listed = (await (await handleProposals(req("/api/hub/proposals"), env, mia))!.json()) as { allowed: string[] };
    check("approved and done: that kind allowed without asking, and listed", allow!.status === 200 && listed.allowed.join() === "car_command:lock", listed);
    const reordered = { ...(env as object), JARVIS_CARS: JSON.stringify([{ id: "c9", name: "Ioniq 5", level: "own", mine: true, vin: "VIN_9999", token: "t" }]) } as never;
    check("allowing that kind does not care which car it was then", (await handleProposals(req("/api/hub/proposals/allow", { id: p.id }), reordered, mia))!.status === 200);
    const stop = await handleProposals(new Request("https://j.test/api/hub/proposals/allow?category=car_command%3Alock", { method: "DELETE" }), env, mia);
    check("and asked for again", stop!.status === 200 && (await props.allowed("u_mia")).length === 0);
    // One that named its car, which has since gone: the kind is still allowed.
    const named = { ...lock.args, car: "Model Y" };
    const withY = { ...(env as object), JARVIS_CARS: JSON.stringify([{ id: "c2", name: "Model Y", level: "own", mine: true, vin: "VIN_B", token: "t" }]) } as never;
    const ny = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "jny", title: "x" }, action: { tool: "car_command", args: named }, weighed: weigh(carCommand, named, withY)! }), Date.now())) as Proposal;
    await handleProposals(req("/api/hub/proposals/answer", { id: ny.id, answer: "approve" }), withY, mia);
    await alarm(withY);
    check("one that named a car since gone: the kind still allowed", (await props.get("u_mia", ny.id, Date.now()))?.state === "done" && (await handleProposals(req("/api/hub/proposals/allow", { id: ny.id }), reordered, mia))!.status === 200);
    await props.disallow("u_mia", "car_command:lock");
    // Approved as its card said; by the time the alarm makes it, the first car is gone and the other would be used.
    const nameless = { command: "unlock", value: null, temperature: null, percent: null, car: null };
    const later = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "jcar1", title: "x" }, action: { tool: "car_command", args: nameless }, weighed: weigh(carCommand, nameless, CARS)! }), Date.now())) as Proposal;
    const both = { ...(env as object), ...(CARS as object) } as never;
    const answered = await handleProposals(req("/api/hub/proposals/answer", { id: later.id, answer: "approve" }), both, mia);
    const before = sent.length;
    await alarm({ ...(env as object), JARVIS_CARS: JSON.stringify([{ id: "c2", name: "Model Y", level: "own", mine: true, vin: "VIN_B", token: "t" }]) });
    const changed = await props.get("u_mia", later.id, Date.now());
    check("the card no longer matches when the alarm comes: failed, said so, and nothing made", answered!.status === 200 && changed?.state === "failed" && /has changed/.test(changed.outcome?.text ?? "") && sent.length === before, { changed, sent: sent.slice(before) });
  } finally {
    globalThis.fetch = realFetch;
  }
  const kiv = (await props.add(input({ person: "u_kiv", who: "u_kiv", from: { kind: "job", id: "jk", title: "x" } }), Date.now())) as Proposal;
  hubDown = true;
  const kivP = { kind: "member", id: "u_kiv", role: "adult", scopes: ["*"], session: "s" } as never;
  const later = await handleProposals(req("/api/hub/proposals/answer", { id: kiv.id, answer: "approve" }), env, kivP);
  check("who it is for could not be looked up: try again, and it is still waiting", later!.status === 503 && (await props.get("u_kiv", kiv.id, Date.now()))?.state === "pending");
  hubDown = false;
  const leeP = { kind: "member", id: "u_lee", role: "adult", scopes: ["*"], session: "s" } as never;
  const left = await handleProposals(req("/api/hub/proposals/answer", { id: theirs.id, answer: "approve" }), env, leeP);
  check("no longer in the family: refused, nothing queued, and it is still waiting", left!.status === 409 && (await props.get("u_lee", theirs.id, Date.now()))?.state === "pending" && (await props.nextWake(Date.now())) === null);
  const q = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "j2", title: "x" } }), Date.now())) as Proposal;
  const no = await handleProposals(req("/api/hub/proposals/answer", { id: q.id, answer: "decline" }), env, mia);
  check("declined", no!.status === 200 && ((await no!.json()) as { proposal: Proposal }).proposal.state === "declined");
  check("a declined one cannot be allowed without asking", (await handleProposals(req("/api/hub/proposals/allow", { id: q.id }), env, mia))!.status === 409);
  // Filed in the morning, approved in the evening, after twenty newer ones were decided: still listed while it is made.
  const morning = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "jam", title: "x" } }), Date.now() - 10 * 3_600_000)) as Proposal;
  for (let i = 0; i < 20; i++) {
    const later = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: `jd${i}`, title: "x" } }), Date.now() - 3_600_000)) as Proposal;
    await props.decline("u_mia", later.id, Date.now() - 3_600_000);
  }
  await handleProposals(req("/api/hub/proposals/answer", { id: morning.id, answer: "approve" }), env, mia);
  const listedNow = (await (await handleProposals(req("/api/hub/proposals"), env, mia))!.json()) as { recent: Proposal[] };
  check("one just approved comes first in what was decided lately, however long it waited", listedNow.recent[0]?.id === morning.id && listedNow.recent[0]?.state === "running" && listedNow.recent.length === 20, listedNow.recent.map((p) => p.state));
  // Filed for the first of two cars; by the tap, that car is gone, and the other is first.
  const nameless = { command: "unlock", value: null, temperature: null, percent: null, car: null };
  const moved = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "jcar2", title: "x" }, action: { tool: "car_command", args: nameless }, weighed: weigh(carCommand, nameless, CARS)! }), Date.now())) as Proposal;
  const onlyY = { TESSIE_TOKEN: "t", TESSIE_VIN: "LRWTEST0000000000", STATE: { idFromName: () => "jarvis", get: () => stub }, JARVIS_CARS: JSON.stringify([{ id: "c2", name: "Model Y", level: "own", mine: true, vin: "VIN_B", token: "t" }]) } as never;
  const before = sent.length;
  const changedRes = await handleProposals(req("/api/hub/proposals/answer", { id: moved.id, answer: "approve" }), onlyY, mia);
  const changed = (await changedRes!.json()) as { error?: string };
  check("the car it named is not the one it would now be: not done, said so, and still waiting", moved.says === "Car: unlock (Ioniq 5, …IN_A)" && changedRes!.status === 409 && /has changed/.test(changed.error ?? "") && sent.length === before && (await props.get("u_mia", moved.id, Date.now()))?.state === "pending", changed);
  const r2 = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "j3", title: "x" } }), Date.now())) as Proposal;
  const noCar = { STATE: { idFromName: () => "jarvis", get: () => stub } } as never;
  const goneRes = await handleProposals(req("/api/hub/proposals/answer", { id: r2.id, answer: "approve" }), noCar, mia);
  const gone = (await goneRes!.json()) as { error?: string };
  check("a tool no longer set up: not done, it says so, and it still waits", goneRes!.status === 409 && /can no longer be done/.test(gone.error ?? "") && (await props.get("u_mia", r2.id, Date.now()))?.state === "pending", gone);
  check("an answer that is neither: refused", (await handleProposals(req("/api/hub/proposals/answer", { id: r2.id, answer: "maybe" }), env, mia))!.status === 400);
  const promos = { tool: "mail_archive_many", args: { ids: ["promo001x"], total: 1 } };
  const archived = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "brief", id: "rb@1", title: "Brief", routine: "rb" }, action: promos, weighed: weigh(mailArchiveMany, promos.args, env)! }), Date.now())) as Proposal;
  check("Put back on something not done yet: refused", (await handleProposals(req("/api/hub/proposals/answer", { id: archived.id, answer: "undo" }), env, mia))!.status === 409);
  await props.claim("u_mia", archived.id, ["*"], ["*"], Date.now());
  await props.finish("u_mia", archived.id, { ok: true, text: "Archived 1 promotion." }, Date.now());
  const lee = { ...mia, id: "u_lee" } as never;
  scopes.u_lee = ["*"];
  check("someone else's cannot be put back: no such proposal, nothing queued", (await handleProposals(req("/api/hub/proposals/answer", { id: archived.id, answer: "undo" }), env, lee))!.status === 404 && !(await props.get("u_mia", archived.id, Date.now()))?.undone);
  const undone = await handleProposals(req("/api/hub/proposals/answer", { id: archived.id, answer: "undo", tool: "mail_manage", args: { action: "trash" } }), env, mia);
  const ub = (await undone!.json()) as { proposal: Proposal };
  check("Put back once done: its undo comes back running, made from what was stored, whatever the request says", undone!.status === 200 && ub.proposal.state === "running" && ub.proposal.action.tool === "mail_inbox_many" && ub.proposal.undoes === archived.id && !("grants" in ub.proposal), ub);
  // Put back all week: an archive that can still be put back stays listed past the newest twenty decided.
  const one = { tool: "mail_archive_many", args: { ids: ["promo009x"], total: 1 } };
  const keepable = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "jk", title: "x" }, action: one, weighed: { ...weigh(mailArchiveMany, one.args, env)!, about: undefined } }), Date.now() - 5000)) as Proposal;
  await props.claim("u_mia", keepable.id, ["*"], ["*"], Date.now() - 5000);
  await props.finish("u_mia", keepable.id, { ok: true, text: "Archived 1 promotion." }, Date.now() - 5000);
  // Twenty-two decided since (unlocking always asks: lock is allowed without asking by now).
  const unlock = { tool: "car_command", args: { command: "unlock", value: null, temperature: null, percent: null, car: null } };
  for (let i = 0; i < 22; i++) {
    const n = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: `jd${i}`, title: "x" }, action: unlock, weighed: weigh(carCommand, unlock.args, env)! }), Date.now())) as Proposal;
    await props.decline("u_mia", n.id, Date.now() + i);
  }
  const listed = (await (await handleProposals(req("/api/hub/proposals"), env, mia))!.json()) as { recent: Proposal[] };
  check("an archive that can still be put back stays listed past the newest twenty", listed.recent.length > 20 && listed.recent.some((x) => x.id === keepable.id), listed.recent.length);

}

console.log("\na brief's cards: one subject, offered once, dismissed for a while");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const ids = Array.from({ length: 30 }, (_, i) => `promo${String(i).padStart(3, "0")}x`);
  const archive = { tool: "mail_archive_many", args: { ids, total: 42 } };
  const brief = (run: string, over: Partial<ProposalInput> = {}) =>
    input({ from: { kind: "brief", id: `rb1@${run}`, title: "Morning brief", routine: "rb1" }, action: archive, weighed: weigh(mailArchiveMany, archive.args, NO_CARS)!, ...over });
  const shown = { n: 0 };
  const first = (await props.add({ ...brief("1"), detail: async () => (shown.n++, "Among them:\nShop Example: Sale") }, T)) as Proposal;
  check("filed from a brief: its subject, its button, why in words of a brief, never allowed without asking",
    first.state === "pending" && first.about === "inbox:promotions" && first.verb === "Archive" && first.why === "From your brief “Morning brief”" && first.risk === "reversible" && !first.category && first.from.kind === "brief", first);
  check("what the card shows is read once, as it is filed anew", first.body === "Among them:\nShop Example: Sale" && shown.n === 1);
  const again = await props.add({ ...brief("2"), detail: async () => (shown.n++, "x") }, T + 3_600_000);
  check("the next brief, while it still waits: that card again, not a second, its sample not read again", typeof again !== "string" && again.id === first.id && shown.n === 1 && (await props.list("u_sara", T)).length === 1, again);
  await props.decline("u_sara", first.id, T + 2 * 3_600_000);
  const gone = await props.add(brief("3"), T + 86_400_000);
  check("dismissed: not offered again", gone === "Dismissed: not offered again for now.", gone);
  const daily = new Proposals(fakeStorage() as never);
  const yesterday = (await daily.add(brief("y"), T + 800)) as Proposal;
  const today = await daily.add(brief("t"), T + DECIDE_MS + 200);
  check("yesterday's card, a moment from expiring, does not stand in for today's: a fresh one, with its day", typeof today !== "string" && today.id !== yesterday.id && today.expires === T + DECIDE_MS + 200 + DECIDE_MS && (await daily.get("u_sara", yesterday.id, T + DECIDE_MS + 200))?.state === "expired", today);
  const soon = await daily.add(brief("s"), T + DECIDE_MS + 200 + 3_600_000);
  check("…while one with most of its day left is that card again", typeof soon !== "string" && typeof today !== "string" && soon.id === today.id);
  const evening = await daily.add(brief("e"), T + DECIDE_MS + 200 + 14 * 3_600_000);
  check("an evening brief the same day: the morning's card again, not let go hours early", typeof evening !== "string" && typeof today !== "string" && evening.id === today.id && (await daily.get("u_sara", today.id, T + DECIDE_MS + 200 + 14 * 3_600_000))?.state === "pending");
  const full = new Proposals(fakeStorage() as never);
  const old = (await full.add(brief("o"), T)) as Proposal;
  for (let i = 0; i < PENDING_MAX - 1; i++) await full.add(input({ from: { kind: "job", id: `jf${i}`, title: "x" } }), T);
  const fresh = await full.add(brief("f"), T + DECIDE_MS - LAPSING_MS + 60_000);
  check("the one it replaces does not count towards those waiting", typeof fresh !== "string" && fresh.id !== old.id && (await full.get("u_sara", old.id, T + DECIDE_MS - LAPSING_MS + 60_000))?.state === "expired", fresh);
  const refusing = new Proposals(fakeStorage() as never);
  const keep = (await refusing.add(brief("k"), T)) as Proposal;
  // Refused for what it would show (too long to show whole): the card it was to replace still waits.
  const refused = await refusing.add({ ...brief("r"), detail: async () => "x".repeat(9_000) }, T + DECIDE_MS - 60_000);
  check("a fresh one refused: the old card is left waiting, not let go", typeof refused === "string" && (await refusing.get("u_sara", keep.id, T + DECIDE_MS - 60_000))?.state === "pending", refused);
  // While the fresh card's sample is fetched, the person answers the old one: their answer stands.
  for (const how of ["approve", "decline"] as const) {
    const store = fakeStorage();
    const race = new Proposals(store as never);
    const old = (await race.add(brief(`o${how}`), T)) as Proposal;
    const at = T + DECIDE_MS - 60_000;
    const fresh = await race.add({ ...brief(`f${how}`), detail: async () => {
      if (how === "approve") await race.claim("u_sara", old.id, ["*"], ["*"], at);
      else await race.decline("u_sara", old.id, at);
      return "Among them:\nShop Example: Sale";
    } }, at);
    const after = await race.get("u_sara", old.id, at);
    const pending = (await race.list("u_sara", at)).filter((p) => p.state === "pending");
    check(`the old card ${how === "approve" ? "approved" : "dismissed"} meanwhile: kept as answered, and no fresh card filed`,
      typeof fresh === "string" && after?.state === (how === "approve" ? "running" : "declined") && pending.length === 0 &&
      (how === "approve" ? [...store._m.keys()].some((k) => k === `proprun:u_sara:${old.id}`) : true), { fresh, after: after?.state, pending: pending.length });
  }
  const meeting = new Proposals(fakeStorage() as never);
  const soonAt = T + 3 * 3_600_000;
  const invite = await meeting.add(input({ from: { kind: "brief", id: "rb@i", title: "Brief", routine: "rb" }, weighed: { risk: "irreversible", says: "Calendar: accept “Offsite”", verb: "Accept", about: "rsvp:x@y", until: soonAt } }), T);
  check("a card that stops making sense at a time waits no longer than that", typeof invite !== "string" && invite.expires === soonAt && (await meeting.get("u_sara", invite.id, soonAt))?.state === "expired", invite);
  const kept = (st._m.get("propgone:u_sara") ?? {}) as Record<string, number>;
  check("remembered by its subject, beside the proposals, for 30 days", kept["inbox:promotions"] === T + 2 * 3_600_000 + GONE_MS && !(await props.list("u_sara", T)).some((p) => p.about === undefined && p.state === "pending"), kept);
  const later = await props.add(brief("4"), T + 2 * 3_600_000 + GONE_MS + 1);
  check("and offered again once that lapses", typeof later !== "string" && later.state === "pending", later);

  const jobs = new Proposals(fakeStorage() as never);
  const job = (await jobs.add(input(), T)) as Proposal;
  await jobs.decline("u_sara", job.id, T + 1);
  check("a job's Not now is not remembered: the same call from another job is filed", typeof (await jobs.add(input({ from: { kind: "job", id: "j2", title: "x" } }), T + 2)) !== "string");

  const tried = new Proposals(fakeStorage() as never);
  const t1 = (await tried.add(brief("5"), T)) as Proposal;
  await tried.claim("u_sara", t1.id, ["*"], ["*"], T + 1);
  await tried.finish("u_sara", t1.id, { ok: true, text: "Archived 30 promotions." }, T + 2);
  check("tried lately: not offered again within the week", (await tried.add(brief("6"), T + TRIED_MS - 1)) === "Tried lately: not offered again yet.");
  check("…and offered once the week is out", typeof (await tried.add(brief("7"), T + 2 + TRIED_MS)) !== "string");

  await props.forget("u_sara");
  check("someone who left: what they dismissed goes too", !st._m.has("propgone:u_sara") && st._m.size === 0, [...st._m.keys()]);
}

console.log("\nthe button is part of the card");
{
  const env = { TESSIE_TOKEN: "t", TESSIE_VIN: "LRWTEST0000000000" } as never;
  const stored = (verb?: string): Proposal => ({
    id: "a" + "0".repeat(20), who: "u_sara", person: "u_sara", from: { kind: "job", id: "j1", title: "x" }, why: "x", action: lock, says: "Car: lock", risk: "reversible",
    ...(verb ? { verb } : {}), state: "pending", createdAt: T, expires: T + DECIDE_MS, grants: ["*"],
  });
  check("the same words and the same button: as shown", notAsShown(env, stored("Lock")) === null);
  check("a card filed before buttons had words still approves", notAsShown(env, stored()) === null);
  check("a button that would now say something else: not as shown", /changed since it was proposed/.test(notAsShown(env, stored("Unlock")) ?? ""));
}

console.log("\nPut back: archived promotions, for a week, once");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const ids = ["promo001x", "promo002x"];
  const archive = { tool: "mail_archive_many", args: { ids, total: 2 } };
  const p = (await props.add(input({ from: { kind: "brief", id: "rb@1", title: "Brief", routine: "rb" }, action: archive, weighed: weigh(mailArchiveMany, archive.args, NO_CARS)! }), T)) as Proposal;
  const inverse = (q: Proposal) => inverseOf(NO_CARS, q);
  check("not yet done: nothing to put back", (await props.undo("u_sara", p.id, inverse, ["*"], ["*"], T)) === "That cannot be put back.");
  await props.claim("u_sara", p.id, ["*"], ["*"], T + 1);
  await props.tick({ carryOut: async () => ({ ok: true, text: "Archived 2 promotions." }) }, T + 2);
  const back = await props.undo("u_sara", p.id, inverse, ["mail", "ask"], ["mail"], T + 3);
  check("done by a tap: its undo, made by code from what was stored, claimed and queued as a tap is",
    typeof back !== "string" && back.state === "running" && back.by === "tap" && back.undoes === p.id && back.action.tool === "mail_inbox_many" && JSON.stringify(back.action.args.ids) === JSON.stringify(ids) && back.verb === "Put back" && !back.about && !back.body, back);
  const queued = [...st._m.entries()].filter(([k]) => k.startsWith("proprun:"));
  check("queued for the alarm with no more than the tap and its person allow", queued.length === 1 && JSON.stringify((queued[0]![1] as { grants: string[] }).grants) === JSON.stringify(["mail"]), queued);
  check("once only", (await props.undo("u_sara", p.id, inverse, ["*"], ["*"], T + 4)) === "It was put back already." && (await props.get("u_sara", p.id, T))?.undone === (back as Proposal).id);
  const retry = await (async () => {
    const own = new Proposals(fakeStorage() as never);
    const q = (await own.add(input({ from: { kind: "brief", id: "rb@9", title: "Brief", routine: "rb" }, action: archive, weighed: weigh(mailArchiveMany, archive.args, NO_CARS)! }), T)) as Proposal;
    await own.claim("u_sara", q.id, ["*"], ["*"], T);
    await own.finish("u_sara", q.id, { ok: true, text: "x" }, T);
    const first = (await own.undo("u_sara", q.id, inverse, ["*"], ["*"], T + 1)) as Proposal;
    await own.tick({ carryOut: async () => ({ ok: false, text: "Gmail said 503." }) }, T + 2);
    return { failed: await own.get("u_sara", first.id, T + 3), again: await own.undo("u_sara", q.id, inverse, ["*"], ["*"], T + 3) };
  })();
  check("a Put back that did not work can be tapped again", retry.failed?.state === "failed" && typeof retry.again !== "string" && retry.again.state === "running", retry);
  const cut = await (async () => {
    const own = new Proposals(fakeStorage() as never);
    const q = (await own.add(input({ from: { kind: "brief", id: "rb@8", title: "Brief", routine: "rb" }, action: archive, weighed: weigh(mailArchiveMany, archive.args, NO_CARS)! }), T)) as Proposal;
    await own.claim("u_sara", q.id, ["*"], ["*"], T);
    await own.finish("u_sara", q.id, { ok: true, text: "x" }, T);
    await own.undo("u_sara", q.id, inverse, ["*"], ["*"], T + 1);
    // Cut short by a deploy: taken off the queue, its call never coming back.
    void own.tick({ carryOut: () => new Promise(() => {}) }, T + 2);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    const later = T + 2 + STUCK_MS + 1;
    return { shown: (await own.list("u_sara", later)).find((x) => x.id === q.id), again: await own.undo("u_sara", q.id, inverse, ["*"], ["*"], later) };
  })();
  check("one cut short (a deploy) reads failed: offered again, and can be tapped again", cut.shown !== undefined && !cut.shown.undone && typeof cut.again !== "string", cut);
  const made: string[] = [];
  await props.tick({ carryOut: async (q) => (made.push(q.action.tool), { ok: true, text: "Put 2 messages back in the Inbox." }) }, T + 5);
  check("and the alarm makes it", made.join() === "mail_inbox_many" && (await props.get("u_sara", (back as Proposal).id, T + 6))?.state === "done");
  /** An archive done by a tap, on its own store (one subject a week). */
  const doneArchive = async () => {
    const own = new Proposals(fakeStorage() as never);
    const q = (await own.add(input({ from: { kind: "brief", id: "rb@2", title: "Brief", routine: "rb" }, action: archive, weighed: weigh(mailArchiveMany, archive.args, NO_CARS)! }), T)) as Proposal;
    await own.claim("u_sara", q.id, ["*"], ["*"], T);
    await own.finish("u_sara", q.id, { ok: true, text: "x" }, T);
    return { own, q };
  };
  const late = await doneArchive();
  check("not after the week", (await late.own.undo("u_sara", late.q.id, inverse, ["*"], ["*"], T + UNDO_MS + 1)) === "That cannot be put back.");
  const car = (await props.add(input(), T)) as Proposal;
  await props.claim("u_sara", car.id, ["*"], ["*"], T);
  await props.finish("u_sara", car.id, { ok: true, text: "Locked." }, T);
  check("nor anything that has no undo", (await props.undo("u_sara", car.id, inverse, ["*"], ["*"], T + 1)) === "That cannot be put back.");
  const left = await doneArchive();
  check("nor for someone no longer in the family", (await left.own.undo("u_sara", left.q.id, inverse, null, ["*"], T + 1)) === "Whoever it was for is no longer in the family.");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
