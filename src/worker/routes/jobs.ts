import { openaiBase } from "../lib/openai-base.ts";
import OpenAI from "openai";
import type { Env } from "../types.ts";
import { whoOf, grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { isTheirs, personOfWho } from "../lib/context.ts";
import type { EventSink } from "../lib/sse.ts";
import { err, json, readObject } from "../lib/http.ts";
import { asQuotedData } from "../lib/quote.ts";
import { stateStub } from "../lib/state-client.ts";
import { allows, withoutScreen, type Grant } from "../lib/scopes.ts";
import { builtinTools, explicitCache, researchModel } from "../lib/router-model.ts";
import { toToolSchema } from "../tools/registry.ts";
import * as hermes from "../tools/hermes.ts";
import { RESEARCH_MONTHLY_DEFAULT, jobTool, sharesLeft, usageEntry, type Job, type JobDeps, type Step } from "../lib/jobs.ts";
import { citationsOf } from "../lib/links.ts";
import { toCsv } from "../lib/research-table.ts";
import { MERGE_INSTRUCTIONS, PLAN_INSTRUCTIONS, RESEARCH_CHECK, TABLE_CHECK, TABLE_MERGE_INSTRUCTIONS, TABLE_PLAN_INSTRUCTIONS, TABLE_TEAM_INSTRUCTIONS, TEAM_INSTRUCTIONS } from "../lib/router-prompt.ts";
import { SHARE, angleMessage, mergeMaterial, shareReply, shareTool, teamView } from "../lib/research-team.ts";
import { prepareRouter, runCalls, type Prepared } from "../lib/router.ts";
import { held, proposable, type File, type Finish } from "../lib/proposals.ts";
import { draftThenAsk } from "../lib/mail-draft.ts";
import { mailSend } from "../tools/gmail.ts";
import { recordUsage } from "./usage.ts";
import { costOf } from "../lib/usage.ts";
import { canAsk, clientFor, forKey, forPlan, modelAuth, planFailed, planRespond, refusalOf } from "../lib/openai-auth.ts";
import type { Storage } from "../lib/state-host.ts";

/**
 * Background jobs (lib/jobs.ts): the engine that runs them, and the HTTP
 * surface. All paths need `ask`; a Hermes job also needs `hermes`, and research `routines`.
 *
 *   GET    /api/v1/jobs           the jobs (a device sees its own)
 *   GET    /api/v1/jobs?id=       one, with its whole result
 *   POST   /api/v1/jobs           {task, title?, engine?: "jarvis" | "hermes" | "research", team?: true, from?: id}
 *   POST   /api/v1/jobs/cancel    {id}
 *   DELETE /api/v1/jobs?id=
 */

/** Nowhere to show anything: a job's result is read later. An admin's wildcard too, or the job was never told. */
const jobGrants = (g: readonly Grant[]): Grant[] => withoutScreen(g);

const quiet: EventSink = { send() {}, isClosed: false };

/** How long a Hermes job waits for its answer: inside what one alarm may take. */
const HERMES_WAIT_MS = 6 * 60_000;

/**
 * Said to Hermes at the end of every job's question, by Jarvis: how long it is
 * waited for, and how longer work still reaches the person (docs/api.md, "A home
 * agent reporting back"). Without it Hermes did a long build and deploy inside
 * the one request, the wait ran out, and its answer was lost.
 */
export const HERMES_LONG_WORK =
  `(From Jarvis: I wait at most ${HERMES_WAIT_MS / 60_000} minutes for your answer. If this will take ` +
  "longer, answer at once with what you have started, then carry on; when it is finished, or if it " +
  "fails, tell the person yourself with a Jarvis alert (POST /api/v1/notify with your alerts token), " +
  "saying what happened and, for anything you deployed, its address.)";

type Usage = NonNullable<Job["usage"]>;
function usageOf(r: OpenAI.Responses.Response): Usage {
  const u = r.usage as
    | { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }
    | undefined;
  return {
    input: u?.input_tokens ?? 0,
    cached: u?.input_tokens_details?.cached_tokens ?? 0,
    written: u?.input_tokens_details?.cache_write_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    // Charged by the call, and most of what research costs besides tokens.
    searches: r.output.filter((o) => o.type === "web_search_call").length,
    model: r.model,
  };
}

/** RESEARCH_MONTHLY_LIMIT, or the default; 0 switches research off. */
const researchLimit = (raw: string | undefined): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0 ? n : RESEARCH_MONTHLY_DEFAULT;
};

/**
 * A step run on the owner's ChatGPT plan (lib/chatgpt-plan.ts), kept in the
 * Durable Object under its own id until it is polled. The plan's route has
 * no background mode and stores nothing, so the step streams here, inside
 * the alarm as a Hermes question does, and its whole exchange is kept for
 * the next step instead of a response id at OpenAI.
 */
interface PlanStep {
  at: number;
  input: OpenAI.Responses.ResponseInput;
  response: OpenAI.Responses.Response;
}
const PLAN_STEP = "plan_";
const PLAN_KEY = (id: string) => `jobplan:${id}`;
/** Kept this long, past any job's limit; the research check reads its report's step. */
const PLAN_KEEP_MS = 2 * 60 * 60_000;
const isPlanStep = (id: string | undefined): id is string => !!id && id.startsWith(PLAN_STEP);

/**
 * A job's tools that act, held (lib/proposals.ts): each call files a proposal
 * for whoever started it to approve with a tap. Mail is drafted, and its
 * sending proposed (lib/mail-draft.ts draftThenAsk).
 */
function proposing(p: Prepared, job: Job): Prepared {
  const file: File = async (action, weighed, ctx) => {
    const state = stateStub(ctx.env);
    if (!state) return "Nothing can be proposed on this deployment: it has no state object.";
    return state.proposalAdd({ who: job.createdBy, person: personOfWho(job.createdBy), from: { kind: "job", id: job.id, title: job.title }, action, weighed, grants: ctx.grants }, Date.now());
  };
  const finish: Finish = async (q, outcome, ctx) => stateStub(ctx.env)?.proposalFinish(q.person, q.id, outcome, Date.now());
  const mail = p.byName.get(mailSend.name);
  const tools = [...held(p.tools, file, finish), ...(mail ? [draftThenAsk(mail, file)] : [])];
  return { ...p, tools, byName: new Map(tools.map((t) => [t.name, t])) };
}

/** The engine, bound to an environment: what the Durable Object runs jobs with. `kept`, its storage, for steps on the plan. */
/** `reachFor`: what a job may reach now, null when whoever started it has left (lib/scopes.ts reachNow); as it was given, without. */
export function jobEngine(
  env: Env,
  deliver: JobDeps["deliver"],
  envFor: (job: Job) => Promise<Env>,
  kept?: Storage,
  reachFor: (job: Job) => Promise<readonly Grant[] | null> = async (job) => job.grants,
): JobDeps {
  const client = () => new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: openaiBase(env) });
  const signal = () => AbortSignal.timeout(60_000);

  /** `team`: for a research team's chain, which is offered share_findings besides. */
  async function request(job: Job, turns: { role: "user"; text: string }[], team = false) {
    const research = job.engine === "research";
    // As whoever started it (lib/context.ts): their memory, their mail.
    const env = await envFor(job);
    const reach = await reachFor(job);
    if (!reach) throw new Error("whoever started it is no longer in the family");
    const grants = jobGrants(reach);
    // A job that may act proposes instead (lib/proposals.ts); research only reads.
    const toolFilter = research ? jobTool : (t: { name: string }) => jobTool(t) || proposable(t) || t.name === mailSend.name;
    const prepared = await prepareRouter(env, turns, signal(), grants, { surface: research ? "research" : "job", toolFilter });
    const p = research ? prepared : proposing(prepared, job);
    // Research: the stronger model, thinking hard (lib/jobs.ts "research").
    const model = research ? researchModel(env.RESEARCH_MODEL) : p.model;
    const functions = [...p.tools.map(toToolSchema), ...(team ? [toToolSchema(shareTool("", [], 0))] : [])];
    return {
      p,
      env,
      grants,
      research,
      functions,
      base: {
        model,
        ...(research ? { reasoning: { effort: "high" as const } } : {}),
        instructions: p.instructions,
        tools: [...functions, ...builtinTools(env)],
        tool_choice: "auto" as const,
        // Background mode: the step runs at OpenAI, and nobody has to stay connected for it.
        background: true,
        store: true,
        ...(explicitCache(model) ? { prompt_cache_options: { mode: "explicit" as const, ttl: "30m" as const } } : {}),
      },
    };
  }

  /**
   * Start a step: on the owner's ChatGPT plan when it can be used and the
   * step does not continue a chain at OpenAI (`previous`), else in the
   * background at OpenAI with the key, as before. At the plan's limit the key
   * takes over, if the owner allows it (lib/openai-auth.ts).
   */
  async function send(
    r: Awaited<ReturnType<typeof request>>,
    input: OpenAI.Responses.ResponseInput,
    toolChoice: "auto" | "none" = "auto",
    previous?: string,
  ): Promise<{ responseId: string }> {
    const auth = kept && !previous ? await modelAuth(r.env) : null;
    if (auth?.kind === "plan") {
      try {
        const res = await planRespond(clientFor(r.env, auth), {
          model: r.research ? r.base.model : (auth.model ?? r.base.model),
          instructions: r.base.instructions,
          input: forPlan(input),
          tools: [{ type: "namespace", name: "jarvis", description: "Jarvis's own tools", tools: r.functions }, ...builtinTools(r.env)],
          tool_choice: toolChoice,
          include: ["reasoning.encrypted_content"],
          ...(r.research ? { reasoning: { effort: "high" as const } } : {}),
        }, AbortSignal.timeout(r.research ? 10 * 60_000 : 3 * 60_000));
        const id = `${PLAN_STEP}${crypto.randomUUID()}`;
        const now = Date.now();
        // The old ones go first: a step is kept until its job is long over.
        for (const [k, s] of await kept!.list<PlanStep>({ prefix: "jobplan:" })) if (now - s.at > PLAN_KEEP_MS) await kept!.delete(k);
        await kept!.put(PLAN_KEY(id), { at: now, input: [...input, ...(res.output as unknown as OpenAI.Responses.ResponseInput)], response: res } satisfies PlanStep);
        return { responseId: id };
      } catch (e) {
        const refused = refusalOf(e);
        if (!refused || !(await planFailed(r.env, refused))) throw e;
        input = forKey(input);
      }
    }
    const res = await r.p.client.responses.create(
      { ...r.base, tool_choice: toolChoice, input, ...(previous ? { previous_response_id: previous } : {}) },
      { signal: signal() },
    );
    return { responseId: res.id };
  }

  /** A step kept from the plan, or null. */
  const planStep = async (id: string): Promise<PlanStep | null> => (kept ? ((await kept.get<PlanStep>(PLAN_KEY(id))) ?? null) : null);

  return {
    deliver,
    researchLimit: researchLimit(env.RESEARCH_MONTHLY_LIMIT),
    // Research without the web is forty steps of nothing to search.
    researchBlocked: builtinTools(env).length ? null : "research needs web search, which is withheld in Settings → Advanced",
    record: (e) => recordUsage(env, e),

    async start(job, t) {
      if (!(await canAsk(env))) return { error: "no ChatGPT plan or OpenAI key is set" };
      try {
        const r = await request(job, [{ role: "user", text: job.task }], t !== undefined);
        // A research team's: the same for every team, then its own angle, planned from the user's brief.
        const input: OpenAI.Responses.ResponseInput =
          t === undefined
            ? r.p.input
            : [
                ...r.p.input,
                // Into a table: the same team, filling its share of the rows (lib/research-table.ts).
                { role: "developer", content: TEAM_INSTRUCTIONS + (job.table?.columns ? TABLE_TEAM_INSTRUCTIONS : "") },
                { role: "user", content: angleMessage(job.team!.angles![t]!, job.table?.columns) },
              ];
        return await send(r, input);
      } catch (e) {
        return { error: `it could not start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async plan(job) {
      if (!(await canAsk(env))) return { error: "no ChatGPT plan or OpenAI key is set" };
      try {
        // One answer, no searching: the angles, as JSON (lib/jobs.ts parseAngles).
        const r = await request(job, [{ role: "user", text: job.task }]);
        return await send(r, [...r.p.input, { role: "developer", content: job.table ? TABLE_PLAN_INSTRUCTIONS : PLAN_INSTRUCTIONS }], "none");
      } catch (e) {
        return { error: `the teams could not be planned: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async merge(job) {
      try {
        // One answer, no searching: what the teams found is all it has, quoted (lib/research-team.ts).
        const r = await request(job, [{ role: "user", text: job.task }]);
        return await send(r, [...r.p.input, { role: "developer", content: job.table?.columns ? TABLE_MERGE_INSTRUCTIONS : MERGE_INSTRUCTIONS }, { role: "user", content: mergeMaterial(job) }], "none");
      } catch (e) {
        return { error: `the teams' reports could not be merged: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async check(job, after) {
      try {
        // The next turn of the chain that wrote the report, with web search still on.
        const r = await request(job, []);
        const check: OpenAI.Responses.ResponseInput = [{ role: "developer", content: job.table?.columns ? TABLE_CHECK : RESEARCH_CHECK }];
        // Written on the plan: its whole exchange, then the check.
        const kept = isPlanStep(after) ? await planStep(after) : null;
        if (isPlanStep(after) && !kept) return { error: "the report's step is no longer kept" };
        return kept ? await send(r, [...kept.input, ...check]) : await send(r, check, "auto", after);
      } catch (e) {
        return { error: `the check could not start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async poll(job, t): Promise<Step> {
      const id = t === undefined ? job.responseId! : job.team!.chains[t]!.responseId!;
      // A step on the plan is over by the time it is kept: read here, not at OpenAI.
      const onPlan = isPlanStep(id) ? await planStep(id) : null;
      if (isPlanStep(id) && !onPlan) return { kind: "failed", error: "its step on the ChatGPT plan is no longer kept" };
      const r = onPlan ? onPlan.response : await client().responses.retrieve(id, {}, { signal: signal() });
      if (r.status === "queued" || r.status === "in_progress") return { kind: "wait" };
      // On the plan: part of what the owner already pays for (lib/usage.ts).
      const usage = onPlan ? { ...usageOf(r), model: `chatgpt:${r.model}` } : usageOf(r);
      if (r.status !== "completed") {
        const why = r.error?.message ?? r.incomplete_details?.reason ?? r.status ?? "unknown";
        return { kind: "failed", error: `OpenAI stopped it (${why})` };
      }
      const calls = r.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
      if (!calls.length) {
        const text = r.output_text?.trim() ?? "";
        if (!text) return { kind: "failed", error: "it finished without an answer" };
        // Research lists them (lib/jobs.ts withSources), after its check.
        return { kind: "done", text, cited: citationsOf(r.output), usage };
      }
      // The tools it asked for run here, between steps; then the next step starts.
      const req = await request(job, [], t !== undefined);
      const { p, env: theirs, grants } = req;
      // A team's share_findings: posted by lib/jobs.ts teamStep, answered with what the others shared.
      const shared: string[] = [];
      const byName = t === undefined ? p.byName : new Map(p.byName).set(SHARE.name, shareTool(shareReply(job, t), shared, sharesLeft(job, t)));
      const outputs = await runCalls(calls, byName, { env: theirs, signal: signal(), memory: p.memory, grants }, quiet);
      await p.memory.save().catch(() => {});
      // On the plan, the whole exchange goes again; at OpenAI, the chain carries it.
      const next = onPlan ? await send(req, [...onPlan.input, ...outputs]) : await send(req, outputs, "auto", r.id);
      return { kind: "continued", responseId: next.responseId, usage, ...(calls.some((c) => c.name === SHARE.name) ? { shared } : {}) };
    },

    async cancel(job) {
      if (isPlanStep(job.responseId)) await kept?.delete(PLAN_KEY(job.responseId));
      else if (job.responseId) await client().responses.cancel(job.responseId).catch(() => {});
    },

    async hermes(job, reference) {
      // As whoever started it, like the other engines: their own Hermes memory (hermes.ts sessionKey).
      const theirs = await envFor(job);
      if (!hermes.hermesConfig(theirs)) return { ok: false, text: "Hermes is not set up" };
      // Research handed over: the person's instruction, then the report, quoted. It was written from strangers' pages, and Hermes can run commands.
      const asked =
        reference === undefined
          ? job.task
          : `${job.task}\n\n${asQuotedData("research", reference, "JARVIS, AS A RESEARCH REPORT FROM PAGES ON THE WEB (REFERENCE MATERIAL)")}`;
      try {
        const text = await hermes.ask(theirs, `${asked}\n\n${HERMES_LONG_WORK}`, { signal: AbortSignal.timeout(HERMES_WAIT_MS) });
        return text.trim() ? { ok: true, text } : { ok: false, text: "Hermes answered with nothing" };
      } catch (e) {
        // Past the wait, Hermes has not failed: it carries on with nobody listening for its answer.
        if (e instanceof Error && e.name === "TimeoutError") {
          return { ok: false, late: true, text: `Hermes did not answer within ${HERMES_WAIT_MS / 60_000} minutes, so its answer will not come back here. It may still be working, and if it can, it sends its own alert when it is done.` };
        }
        return { ok: false, text: `Hermes did not answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },
  };
}

/* ---------- HTTP ------------------------------------------------------------- */

const MAX_BODY = 16 * 1024;


/** The panel's view: everything but the grants and the internals; of a research team, its progress. */
export function jobView(j: Job, whole = false) {
  const { grants: _g, responseId: _r, draft: _d, team: _t, ...rest } = j;
  void _g;
  void _r;
  void _d;
  void _t;
  // What it cost so far, at OpenAI's prices (lib/usage.ts); null for a model with no price.
  const cost = j.usage ? costOf(usageEntry(j, true, j.updatedAt)) : null;
  const view = { ...rest, ...(j.team ? { team: teamView(j) } : {}), cost };
  return whole ? view : { ...view, result: undefined, hasResult: !!j.result };
}

export async function handleJobs(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/v1/jobs" && p !== "/api/v1/jobs/cancel" && p !== "/api/v1/jobs/csv") return null;
  const state = stateStub(env);
  if (!state) return err(503, "jobs need the STATE Durable Object");
  const grants: Grant[] = grantsOf(principal);
  const who = whoOf(principal);
  // A device sees its own jobs; a person theirs, including those they started by
  // voice (lib/context.ts). Another person's are theirs, admin or not.
  const mine = (j: Job) => (principal.kind === "device" ? j.createdBy === who : isTheirs(j.createdBy, personOf(principal)));

  // A research table's rows, as a spreadsheet opens them (lib/research-table.ts).
  if (p === "/api/v1/jobs/csv") {
    if (req.method !== "GET") return err(405, "GET only");
    const j = await state.getJob(url.searchParams.get("id") ?? "");
    const t = j && mine(j) ? await state.jobTable(j.id) : null;
    if (!j || !t) return err(404, "no such table");
    // A header carries plain letters only.
    const name = j.title.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 60) || "table";
    return new Response(toCsv(t.columns, t.rows), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" },
    });
  }

  if (p === "/api/v1/jobs/cancel") {
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await readObject(req, MAX_BODY);
    const j = await state.getJob(typeof b?.id === "string" ? b.id : "");
    if (!j || !mine(j)) return err(404, "no such job");
    const r = await state.cancelJob(j.id);
    return typeof r === "string" ? err(404, r) : json({ ok: true, job: jobView(r) });
  }

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const j = await state.getJob(id);
      return j && mine(j) ? json({ job: jobView(j, true) }) : err(404, "no such job");
    }
    return json({ jobs: (await state.listJobs()).filter(mine).map((j) => jobView(j)) });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    const j = await state.getJob(id);
    if (!j || !mine(j)) return err(404, "no such job");
    return json({ ok: await state.removeJob(id) });
  }

  if (req.method === "POST") {
    const b = await readObject(req, MAX_BODY);
    if (!b) return err(400, "body must be a small JSON object");
    if (b.engine === "hermes" && !allows(grants, "hermes")) return err(403, 'a Hermes job needs "hermes"', { need: "hermes" });
    // Research spends the family's monthly allowance (Settings → OpenAI): not a guest's to spend.
    if (b.engine === "research" && !allows(grants, "routines")) return err(403, 'a research job needs "routines"', { need: "routines" });
    const j = await state.createJob(b, { who, grants });
    return typeof j === "string" ? err(400, j) : json({ ok: true, job: jobView(j) }, { status: 201 });
  }
  return err(405, "method not allowed");
}
