import {
  DAILY_JOBS,
  Jobs,
  jobTool,
  KEEP_JOBS,
  MAX_JOB_MS,
  MAX_RUNNING,
  MAX_STEPS,
  RESEARCH_CHECK_MS,
  RESEARCH_MAX_MS,
  RESEARCH_MAX_STEPS,
  RESEARCH_MONTHLY_DEFAULT,
  addUsage,
  limitsOf,
  splitResult,
  withSources,
  type Job,
  type JobDeps,
  type Step,
} from "../src/worker/lib/jobs.ts";
import type { Alert, Delivery } from "../src/worker/lib/alerts.ts";
import { jobEngine } from "../src/worker/routes/jobs.ts";
import { RESEARCH_CHECK } from "../src/worker/lib/router-prompt.ts";
import { allows, requiredScope, withoutScreen } from "../src/worker/lib/scopes.ts";

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

function harness(steps: (Step | Error)[] = [], opts: { start?: { responseId: string } | { error: string }; check?: { responseId: string } | { error: string }; hermes?: { ok: boolean; text: string }; researchLimit?: number } = {}) {
  const sent: Alert[] = [];
  const log: string[] = [];
  const queue = [...steps];
  const deps: JobDeps = {
    async start(j) {
      log.push(`start ${j.id}`);
      return opts.start ?? { responseId: "resp_1" };
    },
    async check(j, after) {
      log.push(`check ${after}`);
      return opts.check ?? { responseId: "resp_check" };
    },
    async poll(j) {
      log.push(`poll ${j.responseId}`);
      const next = queue.shift() ?? { kind: "wait" };
      if (next instanceof Error) throw next;
      return next;
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
    ...(opts.researchLimit !== undefined ? { researchLimit: opts.researchLimit } : {}),
  };
  const storage = fakeStorage();
  return { jobs: new Jobs(storage, async () => deps), sent, log, storage, deps };
}

/** Tick a job along, each time when it asks to be looked at, until it is no longer running. */
async function drive(h: ReturnType<typeof harness>, id: string, from = T0): Promise<Job> {
  let t = from;
  for (let i = 0; i < 60; i++) {
    const cur = (await h.jobs.get(id))!;
    if (cur.status !== "running") return cur;
    await h.jobs.tick(t);
    t = Math.max(t + 1, (await h.jobs.get(id))?.nextAt ?? t + 1);
  }
  return (await h.jobs.get(id))!;
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

console.log("\nresearch in depth");
{
  // Written, then checked (the check pass below): two answers now, where there was one.
  const h = harness([
    { kind: "done", text: "SUMMARY: The Wallbox Pulsar is the best value.\n\nFindings…", usage: { input: 900, cached: 500, output: 3000, model: "gpt-6-sol" } },
    { kind: "done", text: "SUMMARY: The Wallbox Pulsar is the best value.\n\nFindings, checked…", usage: { input: 400, cached: 300, output: 900, model: "gpt-6-sol" } },
  ]);
  const j = (await h.jobs.create({ title: "Home chargers", task: "Research home EV chargers.", engine: "research" }, BY, T0)) as Job;
  check("a research job", j.engine === "research");
  const done = await drive(h, j.id);
  check("finishes like any job, with its model's usage", done.status === "done" && done.usage?.model === "gpt-6-sol", done);
  check("announced as research", h.sent[0]?.title === "Research done: Home chargers", h.sent[0]?.title);
  check("more time and more steps than a job", limitsOf("research").maxMs === RESEARCH_MAX_MS && limitsOf("research").maxSteps === RESEARCH_MAX_STEPS &&
    RESEARCH_MAX_MS > MAX_JOB_MS && RESEARCH_MAX_STEPS > MAX_STEPS && limitsOf("jarvis").maxSteps === MAX_STEPS);
  check("anything else asked for is an ordinary job", ((await h.jobs.create({ task: "x", engine: "deep" }, BY, T0)) as Job).engine === "jarvis");
}
{
  const h = harness([], { researchLimit: 2 });
  const r1 = await h.jobs.create({ task: "a", engine: "research" }, BY, T0);
  await h.jobs.cancel((r1 as Job).id, T0);
  const r2 = await h.jobs.create({ task: "b", engine: "research" }, BY, T0);
  await h.jobs.cancel((r2 as Job).id, T0);
  const r3 = await h.jobs.create({ task: "c", engine: "research" }, BY, T0);
  check("a month's research is capped", typeof r3 === "string" && /2 research jobs for this month/.test(r3), r3);
  check("an ordinary job is not counted against it", typeof (await h.jobs.create({ task: "d" }, BY, T0)) !== "string");
  const nextMonth = T0 + 32 * 86_400_000;
  check("next month, it starts again", typeof (await h.jobs.create({ task: "e", engine: "research" }, BY, nextMonth)) !== "string");
  const off = harness([], { researchLimit: 0 });
  check("0 switches research off", String(await off.jobs.create({ task: "a", engine: "research" }, BY, T0)).includes("switched off"));
  check(`${RESEARCH_MONTHLY_DEFAULT} a month when unset`, RESEARCH_MONTHLY_DEFAULT === 10);
}

console.log("\nsources, from the searches' own citations");
{
  const cited = [
    { url: "https://maker.example/pulsar?utm_source=chatgpt.com", title: "Pulsar Plus" },
    { url: "https://maker.example/pulsar", title: "Pulsar Plus again" },
    { url: "https://news.example/review?page=2&utm_medium=x", title: "  A review  " },
    { url: "javascript:alert(1)", title: "no" },
    { url: "not a url" },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://site${i}.example/` })),
  ];
  const out = withSources("SUMMARY: x\n\nBody.  ", cited);
  const list = out.split("Sources:\n")[1]!.split("\n");
  check("listed after the report", out.startsWith("SUMMARY: x\n\nBody.\n\nSources:\n"), out.slice(0, 60));
  check("each page once, tracking tags removed", list[0] === "- Pulsar Plus: https://maker.example/pulsar" && !list.some((l) => l.includes("again")), list.slice(0, 3));
  check("other query parameters kept", list[1] === "- A review: https://news.example/review?page=2", list[1]);
  check("only web pages", !out.includes("javascript:") && !out.includes("not a url"));
  check("fifteen at most", list.length === 15, list.length);
  check("no citations: the report as it was", withSources("Just text.", []) === "Just text.");

  // A report near the limit: the Jobs panel keeps 20,000 characters, and the list came last, so it was what got cut.
  const long = withSources(`SUMMARY: chargers\n\n${"Findings. ".repeat(2_500)}`, cited.slice(0, 3));
  check("a long report is shortened to fit, its sources kept whole", long.length <= 20_000 && long.endsWith("- A review: https://news.example/review?page=2") && long.includes("…\n\nSources:\n"), { length: long.length, end: long.slice(-80) });
}

console.log("\na long research report, through to the Jobs panel");
{
  const cited = [{ url: "https://maker.example/pulsar", title: "Pulsar Plus" }, { url: "https://owners.example/forum", title: "Owners" }, { url: "https://test.example/review" }];
  const report = `SUMMARY: The Pulsar Plus suits most homes.\n\n${"A finding with its figures. ".repeat(1_000)}`;
  const h = harness([{ kind: "done", text: report, cited }, { kind: "done", text: report }]);
  const j = (await h.jobs.create({ task: "home chargers", engine: "research" }, BY, T0)) as Job;
  const kept = (await drive(h, j.id)).result ?? "";
  check("its Sources list is all there in Jobs", kept.endsWith("- https://test.example/review") && kept.includes("Sources:\n- Pulsar Plus: https://maker.example/pulsar\n- Owners: https://owners.example/forum\n"), kept.slice(-160));
}

console.log("\na research report is checked before anyone is told");
{
  const draftText = `SUMMARY: The Pulsar Plus suits most homes.\n\n${"It costs RM2,999 installed. ".repeat(40)}`;
  const checked = `SUMMARY: The Pulsar Plus suits most homes.\n\n${"It costs RM3,199 installed. ".repeat(40)}\nChecked: the installed price was corrected.`;
  const wrote = { kind: "done" as const, text: draftText, cited: [{ url: "https://maker.example/pulsar", title: "Maker" }], usage: { input: 1000, cached: 0, output: 500, model: "gpt-6-sol" } };
  const research = (h: ReturnType<typeof harness>) => h.jobs.create({ title: "Home chargers", task: "Research home EV chargers.", engine: "research" }, BY, T0) as Promise<Job>;
  const resultOf = (j: Job) => j.result ?? "";

  // A: written, checked, then sent.
  const h = harness([wrote, { kind: "done", text: checked, cited: [{ url: "https://dealer.example/price", title: "Dealer" }], usage: { input: 600, cached: 400, output: 700, model: "gpt-6-sol" } }]);
  const j = await research(h);
  await h.jobs.tick(T0);
  await h.jobs.tick(T0 + 10_000);
  const drafted = (await h.jobs.get(j.id))!;
  check("the report is kept as a draft, and nobody is told yet", drafted.status === "running" && drafted.draft?.responseId === "resp_1" && !drafted.responseId && h.sent.length === 0, drafted);
  const a = await drive(h, j.id, T0 + 10_000);
  check("the check continues the chain that wrote it, once", h.log.filter((l) => l.startsWith("check")).join() === "check resp_1", h.log);
  check("what is sent is the checked report", a.status === "done" && resultOf(a).includes("RM3,199") && !resultOf(a).includes("RM2,999") && /Checked: the installed price/.test(resultOf(a)), resultOf(a).slice(0, 200));
  check("its Sources: the check's pages first, then the report's", /Sources:\n- Dealer: https:\/\/dealer\.example\/price\n- Maker: https:\/\/maker\.example\/pulsar$/.test(resultOf(a)), resultOf(a).slice(-120));
  check("one alert, and what both cost", h.sent.length === 1 && h.sent[0]!.title === "Research done: Home chargers" && a.usage?.input === 1600 && a.usage?.output === 1200, a.usage);
  check("the draft is not kept once it is sent", !("draft" in a), Object.keys(a));

  // B: the check cannot start: the report as written, and the month's slot stays spent.
  const b = harness([wrote], { check: { error: "the check could not start: 503" }, researchLimit: 1 });
  const bj = await drive(b, (await research(b)).id);
  check("a check that cannot start: the report goes out as written, with its sources", bj.status === "done" && resultOf(bj).includes("RM2,999") && resultOf(bj).endsWith("- Maker: https://maker.example/pulsar") && b.sent[0]?.title === "Research done: Home chargers", resultOf(bj).slice(-100));
  check("…and the research was done, so its slot is not given back", typeof (await research(b)) === "string");

  // C: the check fails at OpenAI, or looking at it throws.
  for (const [name, second] of [["fails at OpenAI", { kind: "failed", error: "OpenAI stopped it (server_error)" }], ["cannot be looked at", new Error("fetch failed")]] as const) {
    const c = harness([wrote, second]);
    const cj = await drive(c, (await research(c)).id);
    check(`a check that ${name}: the report as written, not "Could not finish"`, cj.status === "done" && resultOf(cj).includes("RM2,999") && c.sent.length === 1 && !/Could not finish/.test(c.sent[0]!.title), { status: cj.status, sent: c.sent.map((x) => x.title) });
  }

  // D: once the report is written the job gets ten minutes more, however late it was written.
  const d = harness([wrote]);
  const dj = await research(d);
  await d.jobs.tick(T0);
  await d.jobs.tick(T0 + 10_000);
  await d.jobs.tick(T0 + 10_000);
  await d.jobs.tick(T0 + RESEARCH_MAX_MS + 1);
  check("past the research's own 45 minutes, the check still runs", (await d.jobs.get(dj.id))!.status === "running");
  await d.jobs.tick(T0 + RESEARCH_MAX_MS + RESEARCH_CHECK_MS + 1);
  const dDone = (await d.jobs.get(dj.id))!;
  check("past the 55 minutes, it is stopped and the report goes out as written", dDone.status === "done" && resultOf(dDone).includes("RM2,999") && d.log.includes("cancel resp_check"), { status: dDone.status, log: d.log.slice(-3) });
  // …and only a written report earns them: research still being written stops at its 45 minutes.
  const w = harness();
  const wj = await research(w);
  await w.jobs.tick(T0);
  await w.jobs.tick(T0 + RESEARCH_MAX_MS + 1);
  check("research not yet written gets no extra ten minutes", (await w.jobs.get(wj.id))!.status === "failed" && w.log.includes("cancel resp_1"), w.log);

  // E: the report came on the last step: the check is let go when it asks for more.
  const e = harness([wrote, { kind: "continued", responseId: "resp_42" }]);
  const ej = await research(e);
  await e.storage.put(`job:${ej.id}`, { ...ej, steps: RESEARCH_MAX_STEPS, responseId: "resp_40", nextAt: T0 });
  const eDone = await drive(e, ej.id);
  check("a check past the step limit: stopped, and the report goes out as written", eDone.status === "done" && resultOf(eDone).includes("RM2,999") && e.log.includes("cancel resp_42"), { status: eDone.status, log: e.log });

  // F: a check that answers with notes rather than the report.
  const f = harness([wrote, { kind: "done", text: "SUMMARY: All correct." }]);
  const fDone = await drive(f, (await research(f)).id);
  check("a check that gives notes, not the report: the report is sent", fDone.status === "done" && resultOf(fDone).includes("RM2,999"), resultOf(fDone).slice(0, 80));
  // …but a check that removes what no source supports gives back a shorter report, and that is what is sent.
  const trimmed = `SUMMARY: The Pulsar Plus suits most homes.\n\n${"It costs RM3,199 installed. ".repeat(28)}\nChecked: a claim no source supported was removed.`;
  const f2 = harness([wrote, { kind: "done", text: trimmed }]);
  const f2Done = await drive(f2, (await research(f2)).id);
  check("a check that shortens the report: the shorter, checked report is sent", trimmed.length < draftText.length && f2Done.status === "done" && resultOf(f2Done).includes("RM3,199") && !resultOf(f2Done).includes("RM2,999"), { lengths: [trimmed.length, draftText.length], result: resultOf(f2Done).slice(0, 80) });

  // G: cancelled while the check was being started.
  const g = harness([wrote]);
  const gj = await research(g);
  g.deps.check = async (job, after) => {
    g.log.push(`check ${after}`);
    await g.jobs.cancel(job.id, T0 + 10_000);
    return { responseId: "resp_check" };
  };
  const gDone = await drive(g, gj.id);
  check("cancelled while its check started: stays cancelled, the check is stopped, nobody is told", gDone.status === "cancelled" && g.log.includes("cancel resp_check") && g.sent.length === 0, { status: gDone.status, log: g.log, sent: g.sent.length });

  // H: an ordinary job is not checked, and gets no Sources list.
  const o = harness([{ kind: "done", text: "SUMMARY: The NAS has room.\n\nDetails.", cited: [{ url: "https://nas.example/" }] }]);
  const oDone = await drive(o, ((await o.jobs.create({ task: "How full is the NAS?" }, BY, T0)) as Job).id);
  check("an ordinary job: sent at once, not checked, no Sources", oDone.status === "done" && !o.log.some((l) => l.startsWith("check")) && !resultOf(oDone).includes("Sources:"), { log: o.log, result: resultOf(oDone) });
}

console.log("\nthe engine: what a report's check is sent");
{
  const kv = new Map<string, string>();
  const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async () => {}, list: async () => ({ keys: [] }) };
  const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async () => undefined) });
  const env = { CONFIG, OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://openai.test/v1", TIMEZONE: "Asia/Kuala_Lumpur", STATE: { idFromName: () => "j", get: () => stub } } as never;
  const posted: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = input instanceof Request ? await input.text() : String(init?.body ?? "");
    if (url.endsWith("/responses") && body) {
      posted.push(JSON.parse(body));
      return Response.json({ id: "resp_check", object: "response", status: "queued", output: [] });
    }
    if (url.includes("/responses/resp_report")) {
      return Response.json({
        id: "resp_report", object: "response", status: "completed", model: "gpt-6-sol", usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SUMMARY: ok.\n\nBody.", annotations: [{ type: "url_citation", url: "https://maker.example/pulsar", title: "Maker", start_index: 0, end_index: 3 }] }] }],
      });
    }
    throw new Error(`nothing else is reached here: ${url}`);
  }) as typeof fetch;
  try {
    const engine = jobEngine(env, async (a) => ({ alert: a, attempts: [], deliveredBy: null }) as never, async () => env);
    const job = { id: "j1", title: "Home chargers", task: "Research home EV chargers.", engine: "research", status: "running", createdBy: "owner", grants: ["*"], createdAt: T0, updatedAt: T0, steps: 3, attempts: 0, responseId: "resp_report" } as Job;
    const step = await engine.poll(job);
    check("a report comes back as written, its pages beside it", step.kind === "done" && step.text === "SUMMARY: ok.\n\nBody." && step.cited?.[0]?.url === "https://maker.example/pulsar", step);
    const started = await engine.check(job, "resp_report");
    const sent = posted.at(-1) ?? {};
    check("the check continues the chain that wrote the report", "responseId" in started && started.responseId === "resp_check" && sent.previous_response_id === "resp_report", sent);
    check("with one fixed instruction, and nothing from the web in it", JSON.stringify(sent.input) === JSON.stringify([{ role: "developer", content: RESEARCH_CHECK }]), sent.input);
    check("in the background, with web search, on the research model", sent.background === true && sent.model === "gpt-6-sol" && ((sent.tools ?? []) as { type: string }[]).some((t) => t.type === "web_search"), { model: sent.model, background: sent.background });
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\ncancelled while OpenAI was being asked");
{
  // The alarm is waiting on OpenAI when the user cancels: the step's save must not undo it.
  const recorded: unknown[] = [];
  const cancelled: string[] = [];
  let jobs!: Jobs;
  let id = "";
  const deps: JobDeps = {
    async start() { return { responseId: "resp_1" }; },
    async poll() {
      await jobs.cancel(id, T0 + 5_000); // the user, meanwhile
      return { kind: "continued", responseId: "resp_2", usage: { input: 1000, cached: 0, output: 50, searches: 3, model: "gpt-6-sol" } };
    },
    async cancel(j) { cancelled.push(j.responseId ?? ""); },
    async hermes() { return { ok: true, text: "" }; },
    async deliver(a) { return { alert: a, attempts: [], deliveredBy: null } as Delivery; },
    async record(e) { recorded.push(e); },
  };
  jobs = new Jobs(fakeStorage(), async () => deps);
  id = ((await jobs.create({ task: "Research chargers.", engine: "research" }, BY, T0)) as Job).id;
  await jobs.tick(T0);            // starts: resp_1
  await jobs.tick(T0 + 10_000);   // polls; cancelled during the poll
  const j = (await jobs.get(id))!;
  check("stays cancelled", j.status === "cancelled", j.status);
  check("the step it had just started is stopped too", cancelled.includes("resp_2"), cancelled);
  check("what the step spent is kept on the job", j.usage?.input === 1000 && j.usage?.searches === 3, j.usage);
  check("and the cancel was counted in Usage", recorded.length === 1 && (recorded[0] as { ok: boolean }).ok === false);
  await jobs.tick(T0 + 20_000);
  check("nothing more is asked of OpenAI", (await jobs.get(id))!.status === "cancelled");
}
{
  const cancelled: string[] = [];
  let jobs!: Jobs;
  let id = "";
  const deps: JobDeps = {
    async start() { await jobs.cancel(id, T0 + 1); return { responseId: "resp_x" }; },
    async poll() { return { kind: "wait" }; },
    async cancel(j) { cancelled.push(j.responseId ?? ""); },
    async hermes() { return { ok: true, text: "" }; },
    async deliver(a) { return { alert: a, attempts: [], deliveredBy: null } as Delivery; },
  };
  jobs = new Jobs(fakeStorage(), async () => deps);
  id = ((await jobs.create({ task: "x" }, BY, T0)) as Job).id;
  await jobs.tick(T0);
  check("cancelled while starting: stays cancelled, and what started is stopped", (await jobs.get(id))!.status === "cancelled" && cancelled.includes("resp_x"), cancelled);
}

console.log("\nresearch that cannot run");
{
  const h = harness([], { start: { error: "it could not start: model not found" }, researchLimit: 1 });
  await h.jobs.create({ task: "a", engine: "research" }, BY, T0);
  await h.jobs.tick(T0);
  check("a research job that never started gives its slot back", typeof (await h.jobs.create({ task: "b", engine: "research" }, BY, T0 + 1000)) !== "string");
}
{
  const deps: JobDeps = {
    async start() { return { responseId: "r" }; },
    async poll() { return { kind: "wait" }; },
    async cancel() {},
    async hermes() { return { ok: true, text: "" }; },
    async deliver(a) { return { alert: a, attempts: [], deliveredBy: null } as Delivery; },
    researchBlocked: "research needs web search, which is withheld",
  };
  const jobs = new Jobs(fakeStorage(), async () => deps);
  check("refused when the web is withheld, with why", String(await jobs.create({ task: "a", engine: "research" }, BY, T0)).includes("web search"));
  check("an ordinary job still starts", typeof (await jobs.create({ task: "a" }, BY, T0)) !== "string");
}

console.log("\nwhat a job spent");
{
  const u = addUsage(addUsage(undefined, { input: 100, cached: 50, output: 10, written: 20, searches: 2, model: "gpt-6-sol" }), { input: 200, cached: 150, output: 5, searches: 1 });
  check("tokens, cache writes and searches add up, the model kept", u.input === 300 && u.cached === 200 && u.written === 20 && u.searches === 3 && u.output === 15 && u.model === "gpt-6-sol", u);
}

console.log("\na job has no screen, whoever asked for it");
{
  check("a member's grants lose the screen", !allows(withoutScreen(["ask", "screen", "home"]), "screen") && allows(withoutScreen(["ask", "screen", "home"]), "home"));
  const admin = withoutScreen(["*"]);
  check("an admin's wildcard loses it too", !allows(admin, "screen"), admin);
  check("and keeps everything else", allows(admin, "hermes") && allows(admin, "mail") && allows(admin, "routines"), admin);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
