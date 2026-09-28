// How four routes read a request's body, as they do today: what a bad body,
// a body of the wrong shape, and one over each route's size limit get back.
// Written before their readers were shared (lib/http.ts), so the sharing can
// be seen to change nothing.
import { handleAlertApi } from "../src/worker/routes/alerts.ts";
import { handleRoutines } from "../src/worker/routes/routines.ts";
import { handleJobs } from "../src/worker/routes/jobs.ts";
import { handleFamily } from "../src/worker/routes/family.ts";

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
