import {
  DAILY_JOBS,
  Jobs,
  jobTool,
  KEEP_JOBS,
  MAX_JOB_MS,
  MAX_RUNNING,
  MAX_STEPS,
  splitResult,
  type Job,
  type JobDeps,
  type Step,
} from "../src/worker/lib/jobs.ts";
import type { Alert, Delivery } from "../src/worker/lib/alerts.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

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

/* ---------- which tools a job may use --------------------------------------------- */

console.log("reading, not acting");
{
  for (const n of ["recall", "car_state", "mail_search", "calendar_check", "look_at_camera", "directions"]) check(`${n}: yes`, jobTool({ name: n }));
  for (const n of ["car_command", "mail_send", "mail_manage", "calendar_add", "control_home", "remember", "forget", "send_note", "routine_add", "ask_hermes", "start_job", "music_play", "show_camera"]) {
    check(`${n}: no`, !jobTool({ name: n }));
  }
  const ha = {
    "home-assistant__ha_get_state": true, "home-assistant__ha_get_history": true, "home-assistant__ha_search": true,
    "home-assistant__ha_get_overview": true, "home-assistant__ha_list_floors_areas": true, "home-assistant__ha_get_todo": true,
    "home-assistant__ha_config_get_calendar_events": true,
    "home-assistant__ha_call_service": false, "home-assistant__ha_bulk_control": false, "home-assistant__ha_set_todo_item": false,
    "home-assistant__ha_eval_template": false, "other__do_something": false,
  };
  for (const [n, want] of Object.entries(ha)) check(`${n.split("__")[1]}: ${want ? "yes" : "no"}`, jobTool({ name: n }) === want);
}

console.log("\nthe summary line");
{
  const a = splitResult("SUMMARY: The Viofo A229 is the best buy at RM749.\n\nDetails\n- Viofo A229…");
  check("taken from the first line", a.summary === "The Viofo A229 is the best buy at RM749." && a.result.startsWith("Details"), a);
  check("bold is fine too", splitResult("**Summary:** Two options fit.\nMore here.").summary === "Two options fit.");
  const b = splitResult("Nothing was found. I checked three shops. Details follow at length.");
  check("missing: the first two sentences", b.summary === "Nothing was found. I checked three shops.", b);
  check("a summary alone is also the result", splitResult("SUMMARY: Done.").result === "Done.");
}

/* ---------- the engine ------------------------------------------------------------------ */

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

function harness(steps: Step[] = [], opts: { start?: { responseId: string } | { error: string }; hermes?: { ok: boolean; text: string } } = {}) {
  const sent: Alert[] = [];
  const log: string[] = [];
  const queue = [...steps];
  const deps: JobDeps = {
    async start(j) {
      log.push(`start ${j.id}`);
      return opts.start ?? { responseId: "resp_1" };
    },
    async poll(j) {
      log.push(`poll ${j.responseId}`);
      return queue.shift() ?? { kind: "wait" };
    },
    async cancel(j) {
      log.push(`cancel ${j.responseId}`);
    },
    async hermes(j) {
      log.push(`hermes ${j.task}`);
      return opts.hermes ?? { ok: true, text: "The NAS is at 71% capacity." };
    },
    async deliver(a) {
      sent.push(a);
      return { alert: a, attempts: [{ channel: "push", ok: true, detail: "" }], deliveredBy: "push" } as Delivery;
    },
  };
  const storage = fakeStorage();
  return { jobs: new Jobs(storage, async () => deps), sent, log, storage };
}

const BY = { who: "voice", grants: ["*"] as const };
const T0 = 1_800_000_000_000;

console.log("\na job from start to finish");
{
  const h = harness([
    { kind: "wait" },
    { kind: "continued", responseId: "resp_2", usage: { input: 100, cached: 80, output: 10 } },
    { kind: "done", text: "SUMMARY: The A229 is the best buy.\n\nFull comparison…", usage: { input: 200, cached: 150, output: 400 } },
  ]);
  const j = (await h.jobs.create({ title: "Dashcams", task: "Compare dashcams under RM800." }, BY, T0)) as Job;
  check("created running, due at once", j.status === "running" && (await h.jobs.nextWake(T0)) === T0);
  await h.jobs.tick(T0);
  let cur = (await h.jobs.get(j.id))!;
  check("first step started", cur.responseId === "resp_1" && cur.steps === 1 && cur.nextAt! > T0, cur);
  await h.jobs.tick(cur.nextAt!);
  cur = (await h.jobs.get(j.id))!;
  check("still working: looks again later", cur.status === "running" && cur.nextAt! > T0 + 4000);
  await h.jobs.tick(cur.nextAt!);
  cur = (await h.jobs.get(j.id))!;
  check("its tools ran and the next step started", cur.responseId === "resp_2" && cur.steps === 2);
  await h.jobs.tick(cur.nextAt!);
  cur = (await h.jobs.get(j.id))!;
  check("done, with summary and result", cur.status === "done" && cur.summary === "The A229 is the best buy." && cur.result === "Full comparison…", cur);
  check("usage added up", cur.usage?.input === 300 && cur.usage.output === 410);
  check("one alert: short, so all of it, summary first", h.sent.length === 1 && h.sent[0]!.title === "Done: Dashcams" && h.sent[0]!.text === "The A229 is the best buy.\n\nFull comparison…" && h.sent[0]!.source === "job", h.sent);
  check("recorded how it was delivered", cur.deliveredBy === "push");
  check("nothing more to wake for", (await h.jobs.nextWake(T0 + 60_000)) === null);
  await h.jobs.tick(T0 + 120_000);
  check("never told twice", h.sent.length === 1);
}

console.log("\na long result: the summary, and where to read the rest");
{
  const h = harness([{ kind: "done", text: `SUMMARY: Three chargers fit the budget.\n\n${"Details. ".repeat(200)}` }]);
  await h.jobs.create({ title: "Chargers", task: "x" }, BY, T0);
  await h.jobs.tick(T0);
  await h.jobs.tick(T0 + 10_000);
  check("summary plus a pointer", h.sent[0]?.text === "Three chargers fit the budget.\n\nThe full result is in Jobs.", h.sent[0]?.text);
}

console.log("\nwhen it goes wrong");
{
  const h = harness([{ kind: "failed", error: "OpenAI stopped it (rate_limit)" }]);
  const j = (await h.jobs.create({ task: "x y z" }, BY, T0)) as Job;
  await h.jobs.tick(T0);
  await h.jobs.tick(T0 + 10_000);
  const cur = (await h.jobs.get(j.id))!;
  check("failed, with the reason", cur.status === "failed" && /rate_limit/.test(cur.error!));
  check("the user is told, quietly", h.sent[0]?.title.startsWith("Could not finish") === true && h.sent[0]!.speak === false);
  const h2 = harness([], { start: { error: "it could not start: 401" } });
  const j2 = (await h2.jobs.create({ task: "x" }, BY, T0)) as Job;
  await h2.jobs.tick(T0);
  check("could not start: failed at once", (await h2.jobs.get(j2.id))!.status === "failed");
}

console.log("\nlimits");
{
  const loop: Step[] = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({ kind: "continued" as const, responseId: `r${i}` }));
  const h = harness(loop);
  const j = (await h.jobs.create({ task: "loop" }, BY, T0)) as Job;
  let now = T0;
  for (let i = 0; i < MAX_STEPS + 5; i++) {
    await h.jobs.tick(now);
    now = (await h.jobs.get(j.id))!.nextAt ?? now + 1000;
  }
  const cur = (await h.jobs.get(j.id))!;
  check(`stopped after ${MAX_STEPS} steps`, cur.status === "failed" && /steps/.test(cur.error!) && cur.steps === MAX_STEPS, cur);
  check("and stopped at OpenAI", h.log.some((l) => l.startsWith("cancel")));

  const t = harness();
  const k = (await t.jobs.create({ task: "slow" }, BY, T0)) as Job;
  await t.jobs.tick(T0);
  await t.jobs.tick(T0 + MAX_JOB_MS + 1);
  check("stopped when it runs too long", (await t.jobs.get(k.id))!.status === "failed" && t.log.includes("cancel resp_1"));

  const r = harness();
  for (let i = 0; i < MAX_RUNNING; i++) await r.jobs.create({ task: `t${i}` }, BY, T0);
  check(`at most ${MAX_RUNNING} running`, typeof (await r.jobs.create({ task: "one more" }, BY, T0)) === "string");
  check("an empty task is refused", typeof (await r.jobs.create({ task: "  " }, BY, T0)) === "string");

  const d = harness();
  for (let i = 0; i < DAILY_JOBS; i++) {
    const x = (await d.jobs.create({ task: `t${i}` }, BY, T0)) as Job;
    await d.jobs.cancel(x.id, T0);
  }
  check(`at most ${DAILY_JOBS} a day`, typeof (await d.jobs.create({ task: "late" }, BY, T0)) === "string");
  check("…and tomorrow again", typeof (await d.jobs.create({ task: "tomorrow" }, BY, T0 + 86_400_000)) !== "string");
  check(`only the newest ${KEEP_JOBS} finished jobs are kept`, (await d.jobs.list()).filter((x) => x.status !== "running").length <= KEEP_JOBS);
}

console.log("\ncancelling");
{
  const h = harness([{ kind: "done", text: "SUMMARY: late" }]);
  const j = (await h.jobs.create({ task: "x" }, BY, T0)) as Job;
  await h.jobs.tick(T0);
  const c = await h.jobs.cancel(j.id, T0 + 1000);
  check("cancelled, and stopped at OpenAI", typeof c !== "string" && c.status === "cancelled" && h.log.includes("cancel resp_1"));
  await h.jobs.tick(T0 + 60_000);
  check("nothing more happens, and nobody is told", h.sent.length === 0 && (await h.jobs.get(j.id))!.status === "cancelled");
  check("removed", (await h.jobs.remove(j.id)) && (await h.jobs.get(j.id)) === undefined);
}

console.log("\na question for Hermes");
{
  const h = harness();
  const j = (await h.jobs.create({ task: "How full is the NAS?", engine: "hermes" }, BY, T0)) as Job;
  await h.jobs.tick(T0);
  const cur = (await h.jobs.get(j.id))!;
  check("asked, answered, done", cur.status === "done" && h.log.includes("hermes How full is the NAS?"));
  check("the answer arrives as 'Hermes answered', whole when short", h.sent[0]?.title === "Hermes answered" && h.sent[0]!.text === "The NAS is at 71% capacity.", h.sent[0]);
  const bad = harness([], { hermes: { ok: false, text: "Hermes did not answer: timeout" } });
  const k = (await bad.jobs.create({ task: "q", engine: "hermes" }, BY, T0)) as Job;
  await bad.jobs.tick(T0);
  check("Hermes failing is reported", (await bad.jobs.get(k.id))!.status === "failed" && bad.sent[0]!.title.startsWith("Could not finish"));
  // An alarm cut short mid-question: the job was marked as being asked, then nothing.
  const cut = harness();
  const m = (await cut.jobs.create({ task: "q", engine: "hermes" }, BY, T0)) as Job;
  await cut.storage.put(`job:${m.id}`, { ...m, attempts: 2 });
  await cut.jobs.tick(T0);
  check("interrupted twice: given up, not asked a third time", (await cut.jobs.get(m.id))!.status === "failed" && !cut.log.some((l) => l.startsWith("hermes")));
}

console.log("\nwho may");
{
  check("/api/v1/jobs needs ask", requiredScope("/api/v1/jobs", "POST") === "ask" && requiredScope("/api/v1/jobs/cancel", "POST") === "ask");
  check("a lookalike is the owner's", requiredScope("/api/v1/jobsx", "GET") === "owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
