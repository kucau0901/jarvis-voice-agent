import { openaiBase } from "../lib/openai-base.ts";
import OpenAI from "openai";
import type { Env } from "../types.ts";
import { whoOf, grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { isTheirs } from "../lib/context.ts";
import type { EventSink } from "../lib/sse.ts";
import { err, json, readObject } from "../lib/http.ts";
import { asQuotedData } from "../lib/quote.ts";
import { stateStub } from "../lib/state-client.ts";
import { allows, withoutScreen, type Grant } from "../lib/scopes.ts";
import { builtinTools, explicitCache, researchModel } from "../lib/router-model.ts";
import { toToolSchema } from "../tools/registry.ts";
import * as hermes from "../tools/hermes.ts";
import { RESEARCH_MONTHLY_DEFAULT, jobTool, sharesLeft, usageEntry, type Cited, type Job, type JobDeps, type Step } from "../lib/jobs.ts";
import { MERGE_INSTRUCTIONS, PLAN_INSTRUCTIONS, RESEARCH_CHECK, TEAM_INSTRUCTIONS } from "../lib/router-prompt.ts";
import { SHARE, angleMessage, mergeMaterial, shareReply, shareTool, teamView } from "../lib/research-team.ts";
import { prepareRouter, runCalls } from "../lib/router.ts";
import { recordUsage } from "./usage.ts";
import { costOf } from "../lib/usage.ts";

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

/** The pages a response cited, from its web search's url_citation annotations. */
function citationsOf(r: OpenAI.Responses.Response): Cited[] {
  const out: Cited[] = [];
  for (const item of r.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type !== "output_text") continue;
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation") out.push({ url: a.url, title: a.title });
      }
    }
  }
  return out;
}

/** RESEARCH_MONTHLY_LIMIT, or the default; 0 switches research off. */
const researchLimit = (raw: string | undefined): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0 ? n : RESEARCH_MONTHLY_DEFAULT;
};

/** The engine, bound to an environment: what the Durable Object runs jobs with. */
export function jobEngine(env: Env, deliver: JobDeps["deliver"], envFor: (job: Job) => Promise<Env>): JobDeps {
  const client = () => new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: openaiBase(env) });
  const signal = () => AbortSignal.timeout(60_000);

  /** `team`: for a research team's chain, which is offered share_findings besides. */
  async function request(job: Job, turns: { role: "user"; text: string }[], team = false) {
    const research = job.engine === "research";
    // As whoever started it (lib/context.ts): their memory, their mail.
    const env = await envFor(job);
    const p = await prepareRouter(env, turns, signal(), jobGrants(job.grants), { surface: research ? "research" : "job", toolFilter: jobTool });
    // Research: the stronger model, thinking hard (lib/jobs.ts "research").
    const model = research ? researchModel(env.RESEARCH_MODEL) : p.model;
    return {
      p,
      env,
      base: {
        model,
        ...(research ? { reasoning: { effort: "high" as const } } : {}),
        instructions: p.instructions,
        tools: [...p.tools.map(toToolSchema), ...(team ? [toToolSchema(shareTool("", [], 0))] : []), ...builtinTools(env)],
        tool_choice: "auto" as const,
        // Background mode: the step runs at OpenAI, and nobody has to stay connected for it.
        background: true,
        store: true,
        ...(explicitCache(model) ? { prompt_cache_options: { mode: "explicit" as const, ttl: "30m" as const } } : {}),
      },
    };
  }

  return {
    deliver,
    researchLimit: researchLimit(env.RESEARCH_MONTHLY_LIMIT),
    // Research without the web is forty steps of nothing to search.
    researchBlocked: builtinTools(env).length ? null : "research needs web search, which is withheld in Settings → Advanced",
    record: (e) => recordUsage(env, e),

    async start(job, t) {
      if (!env.OPENAI_API_KEY) return { error: "no OpenAI key is set" };
      try {
        const { p, base } = await request(job, [{ role: "user", text: job.task }], t !== undefined);
        // A research team's: the same for every team, then its own angle, planned from the user's brief.
        const input: OpenAI.Responses.ResponseInput =
          t === undefined
            ? p.input
            : [...p.input, { role: "developer", content: TEAM_INSTRUCTIONS }, { role: "user", content: angleMessage(job.team!.angles![t]!) }];
        const res = await p.client.responses.create({ ...base, input }, { signal: signal() });
        return { responseId: res.id };
      } catch (e) {
        return { error: `it could not start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async plan(job) {
      if (!env.OPENAI_API_KEY) return { error: "no OpenAI key is set" };
      try {
        // One answer, no searching: the angles, as JSON (lib/jobs.ts parseAngles).
        const { p, base } = await request(job, [{ role: "user", text: job.task }]);
        const res = await p.client.responses.create(
          { ...base, tool_choice: "none", input: [...p.input, { role: "developer", content: PLAN_INSTRUCTIONS }] },
          { signal: signal() },
        );
        return { responseId: res.id };
      } catch (e) {
        return { error: `the teams could not be planned: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async merge(job) {
      try {
        // One answer, no searching: what the teams found is all it has, quoted (lib/research-team.ts).
        const { p, base } = await request(job, [{ role: "user", text: job.task }]);
        const res = await p.client.responses.create(
          {
            ...base,
            tool_choice: "none",
            input: [...p.input, { role: "developer", content: MERGE_INSTRUCTIONS }, { role: "user", content: mergeMaterial(job) }],
          },
          { signal: signal() },
        );
        return { responseId: res.id };
      } catch (e) {
        return { error: `the teams' reports could not be merged: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async check(job, after) {
      try {
        // The next turn of the chain that wrote the report, with web search still on.
        const { p, base } = await request(job, []);
        const res = await p.client.responses.create(
          { ...base, previous_response_id: after, input: [{ role: "developer", content: RESEARCH_CHECK }] },
          { signal: signal() },
        );
        return { responseId: res.id };
      } catch (e) {
        return { error: `the check could not start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async poll(job, t): Promise<Step> {
      const r = await client().responses.retrieve(t === undefined ? job.responseId! : job.team!.chains[t]!.responseId!, {}, { signal: signal() });
      if (r.status === "queued" || r.status === "in_progress") return { kind: "wait" };
      const usage = usageOf(r);
      if (r.status !== "completed") {
        const why = r.error?.message ?? r.incomplete_details?.reason ?? r.status ?? "unknown";
        return { kind: "failed", error: `OpenAI stopped it (${why})` };
      }
      const calls = r.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
      if (!calls.length) {
        const text = r.output_text?.trim() ?? "";
        if (!text) return { kind: "failed", error: "it finished without an answer" };
        // Research lists them (lib/jobs.ts withSources), after its check.
        return { kind: "done", text, cited: citationsOf(r), usage };
      }
      // The tools it asked for run here, between steps; then the next step starts.
      const { p, env: theirs, base } = await request(job, [], t !== undefined);
      // A team's share_findings: posted by lib/jobs.ts teamStep, answered with what the others shared.
      const shared: string[] = [];
      const byName = t === undefined ? p.byName : new Map(p.byName).set(SHARE.name, shareTool(shareReply(job, t), shared, sharesLeft(job, t)));
      const outputs = await runCalls(calls, byName, { env: theirs, signal: signal(), memory: p.memory, grants: jobGrants(job.grants) }, quiet);
      await p.memory.save().catch(() => {});
      const next = await p.client.responses.create({ ...base, previous_response_id: r.id, input: outputs }, { signal: signal() });
      return { kind: "continued", responseId: next.id, usage, ...(calls.some((c) => c.name === SHARE.name) ? { shared } : {}) };
    },

    async cancel(job) {
      if (job.responseId) await client().responses.cancel(job.responseId).catch(() => {});
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
function jobView(j: Job, whole = false) {
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
  if (p !== "/api/v1/jobs" && p !== "/api/v1/jobs/cancel") return null;
  const state = stateStub(env);
  if (!state) return err(503, "jobs need the STATE Durable Object");
  const grants: Grant[] = grantsOf(principal);
  const who = whoOf(principal);
  // A device sees its own jobs; a person theirs, including those they started by
  // voice (lib/context.ts). Another person's are theirs, admin or not.
  const mine = (j: Job) => (principal.kind === "device" ? j.createdBy === who : isTheirs(j.createdBy, personOf(principal)));

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
