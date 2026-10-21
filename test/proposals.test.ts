// Approvals (lib/proposals.ts, routes/proposals.ts): what a job proposes, how
// risky code says it is, and how a tap runs the stored call once.
import { classify, DECIDE_MS, held, PER_JOB, PENDING_MAX, PROPOSE_ONLY, proposable, Proposals, runGrants, weigh, type Proposal, type ProposalInput } from "../src/worker/lib/proposals.ts";
import { handleProposals } from "../src/worker/routes/proposals.ts";
import { baseTools, type Tool } from "../src/worker/tools/registry.ts";
import { carCommand } from "../src/worker/tools/tessie.ts";
import { calendarAdd } from "../src/worker/tools/calendar.ts";
import { mailManage } from "../src/worker/tools/gmail.ts";

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
const lock = { tool: "car_command", args: { command: "lock", value: null, temperature: null, percent: null, car: null } };
const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  who: "u_sara~d_tablet",
  person: "u_sara",
  from: { kind: "job", id: "j1", title: "Tidy up after the trip" },
  action: lock,
  weighed: weigh(carCommand, lock.args)!,
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

  const claimed = await props.claim("u_sara", p.id, T + 5000);
  check("approved: running, by a tap, once", typeof claimed !== "string" && claimed.state === "running" && claimed.by === "tap" && claimed.decidedAt === T + 5000, claimed);
  check("a second tap: already approved", (await props.claim("u_sara", p.id, T + 6000)) === "It was approved already.");
  check("someone else's: as if there were none", (await props.claim("u_adam", p.id, T)) === "No such proposal." && (await props.get("u_adam", p.id, T)) === null);
  const done = await props.finish("u_sara", p.id, { ok: true, text: "Locked. ".repeat(100) }, T + 7000);
  check("finished: done, with what came of it, cut short", done?.state === "done" && done.outcome!.text.length === 300 && (await props.finish("u_sara", p.id, { ok: true, text: "again" }, T)) === null);

  const late = (await props.add(input({ from: { kind: "job", id: "j2", title: "x" } }), T)) as Proposal;
  check("past its day: expired, and can no longer be approved", (await props.get("u_sara", late.id, T + DECIDE_MS))?.state === "expired" && (await props.claim("u_sara", late.id, T + DECIDE_MS)) === "It has expired.");
  const no = (await props.add(input({ from: { kind: "job", id: "j3", title: "x" } }), T)) as Proposal;
  const declined = await props.decline("u_sara", no.id, T + 1);
  check("declined: not done, and no longer waiting", typeof declined !== "string" && declined.state === "declined" && (await props.claim("u_sara", no.id, T + 2)) === "It was declined.");
  const stuck = (await props.add(input({ from: { kind: "job", id: "j4", title: "x" } }), T)) as Proposal;
  await props.claim("u_sara", stuck.id, T);
  check("a run that never finished: failed, never run again", (await props.get("u_sara", stuck.id, T + 6 * 60_000))?.state === "failed" && typeof (await props.claim("u_sara", stuck.id, T + 6 * 60_000)) === "string");

  const job = (await props.add(input({ from: { kind: "job", id: "j5", title: "x" } }), T)) as Proposal;
  await props.withdrawJob("u_sara", "j5", T + 1);
  check("its job cancelled: withdrawn", (await props.get("u_sara", job.id, T + 2))?.state === "withdrawn");
  await props.forget("u_sara");
  check("someone who left: nothing of theirs kept", st._m.size === 0);
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
  const car = (command: string, extra: Record<string, unknown> = {}) => weigh(carCommand, { command, value: null, temperature: null, percent: null, car: null, ...extra });
  check("locking the car: reversible, its own kind", JSON.stringify(car("lock")) === JSON.stringify({ risk: "reversible", says: "Car: lock", category: "car_command:lock" }), car("lock"));
  check("a temperature says which", car("set_temperature", { temperature: 21 })?.says === "Car: set temperature to 21°C" && car("set_temperature", { temperature: 21 })?.category === "car_command:set_temperature");
  check("unlocking, the trunks, the horn, a destination on its screen: irreversible, no kind",
    ["unlock", "open_frunk", "open_trunk", "vent_windows", "honk", "navigate_to"].every((c) => car(c)?.risk === "irreversible" && !car(c)?.category));
  check("an unknown command: cannot be proposed", car("self_destruct") === null);
  check("mail tidying: reversible each, trash always asks", weigh(mailManage, { message_id: "199a2b3c4d5e6f70", action: "archive" })?.category === "mail_manage:archive" && weigh(mailManage, { message_id: "199a2b3c4d5e6f70", action: "trash" })?.risk === "irreversible" && weigh(mailManage, { message_id: "../x", action: "archive" }) === null);
  const ev = weigh(calendarAdd, { title: "Dentist", start: "2026-10-22T09:00:00+08:00", duration_minutes: 30, location: null });
  check("a calendar event: reversible, says when", ev?.risk === "reversible" && ev.category === "calendar_add" && ev.says.includes("2026-10-22T09:00:00+08:00") && ev.says.includes("30 min"), ev);
  const svc = classify("home__ha_call_service", { domain: "lock", service: "unlock", entity_id: "lock.front" });
  check("a house call: irreversible, never a kind, saying which service on which entity", svc?.risk === "irreversible" && !svc.category && svc.says === "home: lock.unlock lock.front", svc);
  check("a house call naming its entity in data", classify("home__ha_call_service", { domain: "light", service: "turn_on", data: { entity_id: ["light.porch", "light.hall"] } })?.says === "home: light.turn_on light.porch, light.hall");
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
  const out = held([read, real, mcp], async (action, w, ctx) => (filedCalls.push({ action, w, grants: ctx.grants }), "filed"));
  check("one that reads: the same tool", out[0] === read);
  check("one that acts: the same name and arguments, said to only propose", out[1]!.name === "car_command" && out[1]!.parameters === carCommand.parameters && out[1]!.description.startsWith(PROPOSE_ONLY) && out[2]!.strict === false);
  const said = await out[1]!.run({ ...lock.args }, { grants: ["car.control"] } as never);
  await out[2]!.run({ domain: "light", service: "turn_on", entity_id: "light.porch" }, { grants: ["home"] } as never);
  check("its run files the call, and never makes it", !ranReal && filedCalls.length === 2 && said === "filed" && JSON.stringify((filedCalls[0] as { action: unknown }).action) === JSON.stringify({ tool: "car_command", args: lock.args }), filedCalls);
  const odd = await out[1]!.run({ ...lock.args, command: "self_destruct" }, {} as never);
  check("arguments that cannot be proposed: not filed", filedCalls.length === 2 && /cannot be proposed/.test(String(odd)));
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
  // The object, as far as the route asks it: its proposals, and who is in the family (hub-client personView).
  const stub = {
    hubCall: async (m: string, a: unknown[]) => (m === "personView" ? { space: { id: "s" }, name: "x", prefs: {}, cars: [], scopes: scopes[a[0] as string] } : null),
    proposalsOf: (person: string, now: number) => props.list(person, now),
    proposalGet: (person: string, id: string, now: number) => props.get(person, id, now),
    proposalClaim: (person: string, id: string, now: number) => props.claim(person, id, now),
    proposalDecline: (person: string, id: string, now: number) => props.decline(person, id, now),
    proposalFinish: (person: string, id: string, outcome: { ok: boolean; text: string }, now: number) => props.finish(person, id, outcome, now),
  };
  const env = { TESSIE_TOKEN: "t", TESSIE_VIN: "LRWTEST0000000000", STATE: { idFromName: () => "jarvis", get: () => stub } } as never;
  const mia = { kind: "member", id: "u_mia", role: "adult", scopes: ["*"], session: "s" } as never;
  const ctx = { waitUntil: () => {} } as never;
  const req = (path: string, body?: unknown) => new Request(`https://j.test${path}`, body ? { method: "POST", body: JSON.stringify(body) } : {});
  const p = (await props.add(input({ person: "u_mia", who: "u_mia" }), Date.now())) as Proposal;
  const theirs = (await props.add(input({ person: "u_lee", who: "u_lee", from: { kind: "job", id: "jl", title: "x" } }), Date.now())) as Proposal;

  const list = (await (await handleProposals(req("/api/hub/proposals"), env, ctx, mia))!.json()) as { open: Record<string, unknown>[] };
  check("listed: their own, waiting, without what it would run with", list.open.length === 1 && list.open[0]!.id === p.id && !("grants" in list.open[0]!) && !("who" in list.open[0]!), list);
  check("not a path of its own: passed on", (await handleProposals(req("/api/hub/me"), env, ctx, mia)) === null);
  const device = await handleProposals(req("/api/hub/proposals"), env, ctx, { kind: "device", id: "d1", name: "tablet", scopes: ["*"] } as never);
  check("a device: refused", device!.status === 403);
  check("someone else's: no such proposal", (await handleProposals(req("/api/hub/proposals/answer", { id: theirs.id, answer: "approve" }), env, ctx, mia))!.status === 404);

  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    sent.push(`${init.method ?? "GET"} ${url}`);
    if (url.includes("/status")) return Response.json({ status: "awake" });
    return Response.json({ result: true });
  }) as typeof fetch;
  try {
    // The request says another call: only what was stored is run.
    const r = await handleProposals(req("/api/hub/proposals/answer", { id: p.id, answer: "approve", tool: "car_command", args: { command: "unlock" } }), env, ctx, mia);
    const body = (await r!.json()) as { proposal: Proposal };
    check("approved: the stored call run, once, and what came of it kept", r!.status === 200 && body.proposal.state === "done" && body.proposal.by === "tap" && sent.some((s) => /\/command\/lock\b/.test(s)) && !sent.some((s) => /unlock/.test(s)), { body, sent });
    const twice = await handleProposals(req("/api/hub/proposals/answer", { id: p.id, answer: "approve" }), env, ctx, mia);
    check("a second tap: already approved, nothing run", twice!.status === 409 && sent.filter((s) => /\/command\/lock\b/.test(s)).length === 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  const q = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "j2", title: "x" } }), Date.now())) as Proposal;
  const no = await handleProposals(req("/api/hub/proposals/answer", { id: q.id, answer: "decline" }), env, ctx, mia);
  check("declined", no!.status === 200 && ((await no!.json()) as { proposal: Proposal }).proposal.state === "declined");
  const r2 = (await props.add(input({ person: "u_mia", who: "u_mia", from: { kind: "job", id: "j3", title: "x" } }), Date.now())) as Proposal;
  const noCar = { STATE: { idFromName: () => "jarvis", get: () => stub } } as never;
  const gone = (await (await handleProposals(req("/api/hub/proposals/answer", { id: r2.id, answer: "approve" }), noCar, ctx, mia))!.json()) as { proposal: Proposal };
  check("a tool no longer set up: not done, and it says so", gone.proposal.state === "failed" && /can no longer be done/.test(gone.proposal.outcome!.text), gone.proposal);
  check("an answer that is neither: refused", (await handleProposals(req("/api/hub/proposals/answer", { id: r2.id, answer: "maybe" }), env, ctx, mia))!.status === 400);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
