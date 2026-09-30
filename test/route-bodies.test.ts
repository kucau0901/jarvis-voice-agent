// How four routes read a request's body, as they do today: what a bad body,
// a body of the wrong shape, and one over each route's size limit get back.
// Written before their readers were shared (lib/http.ts), so the sharing can
// be seen to change nothing.
import { handleAlertApi } from "../src/worker/routes/alerts.ts";
import { handleRoutines } from "../src/worker/routes/routines.ts";
import { handleJobs } from "../src/worker/routes/jobs.ts";
import { handleFamily } from "../src/worker/routes/family.ts";
import { jobTools } from "../src/worker/tools/jobs.ts";

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

type Call = { method: string; args: unknown[] };
/** A Durable Object that answers the few calls these paths make, and remembers them. */
function fakeState(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const stub = new Proxy(
    {},
    {
      get: (_t, method) =>
        typeof method !== "string" || method === "then"
          ? undefined
          : async (...args: unknown[]) => {
              calls.push({ method, args });
              return answers[method];
            },
    },
  );
  const env = { STATE: { idFromName: () => "jarvis", get: () => stub }, JARVIS_FAMILY: "fam:s_test", TIMEZONE: "Asia/Kuala_Lumpur" };
  return { env: env as never, calls };
}

const OWNER = { kind: "owner" } as never;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const req = (method: string, path: string, body: string) => new Request(`https://j.test${path}`, { method, body, headers: { "content-type": "application/json" } });
const answer = async (r: Response | null) => ({ status: r?.status, body: (await r?.json()) as { error?: string } });
const big = (bytes: number) => JSON.stringify({ text: "x".repeat(bytes) });

const SMALL = "body must be a small JSON object";

console.log("alerts: a small JSON object, or 400");
{
  const { env } = fakeState();
  const notify = async (body: string) => answer(await handleAlertApi(req("POST", "/api/v1/notify", body), env, new URL("https://j.test/api/v1/notify"), OWNER));
  for (const [what, body] of [["not JSON", "{"], ["an array", "[1]"], ["a number", "5"], ["null", "null"], ["over 8 KB", big(8 * 1024)]] as const) {
    const r = await notify(body);
    check(`${what}: 400, "${SMALL}"`, r.status === 400 && r.body.error === SMALL, r);
  }
  const empty = await notify("");
  check("an empty body is an empty object: on to the next check", empty.status === 400 && empty.body.error === "text is required", empty);
  const ticket = await answer(await handleAlertApi(req("POST", "/api/v1/events/ticket", "{"), env, new URL("https://j.test/api/v1/events/ticket"), OWNER));
  check("the ticket route reads the same way", ticket.status === 400 && ticket.body.error === SMALL, ticket);
}

console.log("\nroutines: a small JSON object, or 400");
{
  const { env, calls } = fakeState({ addRoutine: "give when: once, daily, event, leave or watch" });
  const post = async (path: string, body: string) => answer(await handleRoutines(req("POST", path, body), env, new URL(`https://j.test${path}`), OWNER));
  for (const [what, body] of [["not JSON", "{"], ["an array", "[1]"], ["over 8 KB", big(8 * 1024)]] as const) {
    const r = await post("/api/v1/routines", body);
    check(`a routine, ${what}: 400, "${SMALL}"`, r.status === 400 && r.body.error === SMALL, r);
  }
  const ok = await post("/api/v1/routines", "{}");
  check("an object is passed on to be checked", ok.status === 400 && ok.body.error === "give when: once, daily, event, leave or watch" && calls.some((c) => c.method === "addRoutine"), ok);
  const trigger = await post("/api/v1/trigger", "{");
  check("an event that is not JSON: 400, no event", trigger.status === 400 && trigger.body.error!.startsWith("event is required"), trigger);
}

console.log("\njobs: a small JSON object (16 KB), or 400");
{
  const { env, calls } = fakeState({ createJob: "a job needs a task: what to find out or work through" });
  const post = async (path: string, body: string) => answer(await handleJobs(req("POST", path, body), env, new URL(`https://j.test${path}`), OWNER));
  for (const [what, body] of [["not JSON", "{"], ["an array", "[1]"], ["over 16 KB", big(16 * 1024)]] as const) {
    const r = await post("/api/v1/jobs", body);
    check(`a job, ${what}: 400, "${SMALL}"`, r.status === 400 && r.body.error === SMALL, r);
  }
  const nine = await post("/api/v1/jobs", big(9 * 1024));
  check("9 KB is within a job's limit, unlike the others'", nine.status === 400 && nine.body.error === "a job needs a task: what to find out or work through" && calls.some((c) => c.method === "createJob"), nine);
  const cancel = await post("/api/v1/jobs/cancel", "{");
  check("cancelling with a body that is not JSON: no such job", cancel.status === 404 && cancel.body.error === "no such job", cancel);
}

console.log("\njobs: a research team's view shows its progress, not its workings");
{
  // Invented throughout: made-up angles, figures and sites.
  const teamJob = {
    id: "jteam", title: "Home chargers", task: "Research home EV chargers.", engine: "research", status: "running", createdBy: "owner",
    grants: ["*"], createdAt: 1, updatedAt: 2, nextAt: 3, steps: 1, attempts: 0,
    team: {
      angles: [
        { name: "makers and prices", brief: "What the makers list." },
        { name: "owners' experience", brief: "What owners report." },
        { name: "the case against", brief: "Cheaper alternatives." },
      ],
      chains: [
        { state: "reported", updatedAt: 2, steps: 3, fails: 0, seen: 1, report: "SUMMARY: The maker lists RM2,999.", cited: [{ url: "https://maker.example/" }] },
        { state: "working", responseId: "resp_t1", updatedAt: 2, nextAt: 3, steps: 2, fails: 0, seen: 0 },
        { state: "working", responseId: "resp_t2", updatedAt: 2, nextAt: 3, steps: 2, fails: 1, seen: 0 },
      ],
      board: [{ team: 0, text: "The maker lists RM2,999 installed." }],
    },
  };
  const { env } = fakeState({ listJobs: [teamJob], getJob: teamJob });
  for (const path of ["/api/v1/jobs", "/api/v1/jobs?id=jteam"]) {
    const r = await handleJobs(new Request(`https://j.test${path}`), env, new URL(`https://j.test${path}`), OWNER);
    const text = (await r?.text()) ?? "";
    const body = JSON.parse(text || "{}") as { jobs?: { team?: unknown }[]; job?: { team?: unknown } };
    const view = body.jobs?.[0] ?? body.job;
    check(`${path}: how many teams reported, and which part it is in`, r?.status === 200 && JSON.stringify(view?.team) === JSON.stringify({ of: 3, reported: 1, phase: "teams" }), view);
    check(`${path}: none of the teams' workings`, ["resp_", "board", "chains", "draft", '"report"', "angles", "RM2,999", "maker.example"].every((s) => !text.includes(s)), text.slice(0, 300));
  }
  const { env: env2, calls } = fakeState({ createJob: teamJob });
  const r = await answer(await handleJobs(req("POST", "/api/v1/jobs", JSON.stringify({ task: "Research home EV chargers.", engine: "research", team: true })), env2, new URL("https://j.test/api/v1/jobs"), OWNER));
  const made = calls.find((c) => c.method === "createJob")?.args[0] as { engine?: string; team?: unknown } | undefined;
  check("asked for with team: true beside engine research", r.status === 201 && made?.engine === "research" && made.team === true, { r, made });
}

console.log("\nstart_job: research as a team, by voice");
{
  const created = { id: "j2", title: "Home chargers", task: "Research home EV chargers.", engine: "research", status: "running" };
  const start = async (research: string, grants: string[]) => {
    const { env, calls } = fakeState({ createJob: created });
    const said = String(await jobTools[0]!.run({ title: "Home chargers", task: "Research home EV chargers.", research }, { env, grants } as never));
    return { said, made: calls.find((c) => c.method === "createJob")?.args[0] as { engine?: string; team?: unknown } | undefined };
  };
  const team = await start("team", ["*"]);
  check("'team': research, as a team, and the reply says three teams", team.made?.engine === "research" && team.made.team === true && /three teams/.test(team.said), team);
  const guest = await start("team", ["ask"]);
  check("…not for someone who may not start research", guest.said.startsWith("Not started") && !guest.made, guest);
  const yes = await start("yes", ["*"]);
  check("'yes': research on its own", yes.made?.engine === "research" && !("team" in yes.made) && !/three teams/.test(yes.said), yes);
  const no = await start("no", ["*"]);
  check("'no': an ordinary job", no.made?.engine === "jarvis" && !("team" in no.made), no);
  const schema = jobTools[0]!.parameters as { properties: { research: { type: string; enum: string[] } }; required: string[]; additionalProperties: boolean };
  check("the schema stays strict: research is one of three words, and required",
    schema.properties.research.type === "string" && JSON.stringify(schema.properties.research.enum) === JSON.stringify(["no", "yes", "team"]) && schema.required.includes("research") && schema.additionalProperties === false, schema.properties.research);
}

console.log("\nfamily: anything that is not an object is taken as {}");
{
  const { env, calls } = fakeState({ relayCreate: 'nobody in the family is called "". The family: only you so far', relayCancel: "no such message from this person" });
  const call = async (method: string, path: string, body: string) => answer(await handleFamily(req(method, path, body), env, ctx, OWNER));
  const chat = await call("POST", "/api/hub/chat/messages", "{");
  check("a chat message that is not JSON: no such conversation", chat.status === 404 && chat.body.error === "no such conversation", chat);
  for (const [what, body] of [["not JSON", "{"], ["an array", "[1]"]] as const) {
    calls.length = 0;
    const r = await call("POST", "/api/hub/relays", body);
    const made = calls.find((c) => c.method === "relayCreate")?.args[0] as { kind?: string; to?: string; text?: string } | undefined;
    check(`passing on, ${what}: an empty "tell" to nobody is asked for`, r.status === 400 && made?.kind === "tell" && made.to === "" && made.text === "", { r, made });
  }
  const answered = await call("POST", "/api/hub/relays/answer", "{");
  check("an answer that is not JSON: 400, the statuses listed", answered.status === 400 && answered.body.error === "status is done, declined or answered", answered);
  const cancelled = await call("DELETE", "/api/hub/relays", "{");
  check("taking back with a body that is not JSON: no such message", cancelled.status === 400 && cancelled.body.error === "no such message from this person", cancelled);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
