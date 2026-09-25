import OpenAI from "openai";
import type { Env } from "../types";
import type { Principal } from "../lib/auth";
import type { EventSink } from "../lib/sse";
import { err, json } from "../lib/http";
import { stateStub } from "../lib/state-client";
import { allows, WILDCARD, type Grant } from "../lib/scopes";
import { builtinTools, explicitCache } from "../lib/router-model";
import { toToolSchema } from "../tools/registry";
import * as hermes from "../tools/hermes";
import { jobTool, type Job, type JobDeps, type Step } from "../lib/jobs";
import { prepareRouter, runCalls } from "./delegate";

/**
 * Background jobs (lib/jobs.ts): the engine that runs them, and the HTTP
 * surface. All paths need `ask`; a Hermes job also needs `home`.
 *
 *   GET    /api/v1/jobs           the jobs (a device sees its own)
 *   GET    /api/v1/jobs?id=       one, with its whole result
 *   POST   /api/v1/jobs           {task, title?, engine?: "jarvis" | "hermes"}
 *   POST   /api/v1/jobs/cancel    {id}
 *   DELETE /api/v1/jobs?id=
 */

/** Nowhere to show anything: a job's result is read later. */
const jobGrants = (g: readonly Grant[]): Grant[] => g.filter((x) => x !== "screen");

const quiet: EventSink = { send() {}, isClosed: false };

type Usage = NonNullable<Job["usage"]>;
function usageOf(r: OpenAI.Responses.Response): Usage {
  const u = r.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
  return { input: u?.input_tokens ?? 0, cached: u?.input_tokens_details?.cached_tokens ?? 0, output: u?.output_tokens ?? 0 };
}

/** The engine, bound to an environment: what the Durable Object runs jobs with. */
export function jobEngine(env: Env, deliver: JobDeps["deliver"]): JobDeps {
  const client = () => new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const signal = () => AbortSignal.timeout(60_000);

  async function request(job: Job, turns: { role: "user"; text: string }[]) {
    const p = await prepareRouter(env, turns, signal(), jobGrants(job.grants), { surface: "job", toolFilter: jobTool });
    return {
      p,
      base: {
        model: p.model,
        instructions: p.instructions,
        tools: [...p.tools.map(toToolSchema), ...builtinTools(env)],
        tool_choice: "auto" as const,
        // Background mode: the step runs at OpenAI, and nobody has to stay connected for it.
        background: true,
        store: true,
        ...(explicitCache(p.model) ? { prompt_cache_options: { mode: "explicit" as const, ttl: "30m" as const } } : {}),
      },
    };
  }

  return {
    deliver,

    async start(job) {
      if (!env.OPENAI_API_KEY) return { error: "no OpenAI key is set" };
      try {
        const { p, base } = await request(job, [{ role: "user", text: job.task }]);
        const res = await p.client.responses.create({ ...base, input: p.input }, { signal: signal() });
        return { responseId: res.id };
      } catch (e) {
        return { error: `it could not start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },

    async poll(job): Promise<Step> {
      const r = await client().responses.retrieve(job.responseId!, {}, { signal: signal() });
      if (r.status === "queued" || r.status === "in_progress") return { kind: "wait" };
      const usage = usageOf(r);
      if (r.status !== "completed") {
        const why = r.error?.message ?? r.incomplete_details?.reason ?? r.status ?? "unknown";
        return { kind: "failed", error: `OpenAI stopped it (${why})` };
      }
      const calls = r.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
      if (!calls.length) {
        const text = r.output_text?.trim() ?? "";
        return text ? { kind: "done", text, usage } : { kind: "failed", error: "it finished without an answer" };
      }
      // The tools it asked for run here, between steps; then the next step starts.
      const { p, base } = await request(job, []);
      const outputs = await runCalls(calls, p.byName, { env, signal: signal(), memory: p.memory, grants: jobGrants(job.grants) }, quiet);
      await p.memory.save().catch(() => {});
      const next = await p.client.responses.create({ ...base, previous_response_id: r.id, input: outputs }, { signal: signal() });
      return { kind: "continued", responseId: next.id, usage };
    },

    async cancel(job) {
      if (job.responseId) await client().responses.cancel(job.responseId).catch(() => {});
    },

    async hermes(job) {
      if (!hermes.hermesConfig(env)) return { ok: false, text: "Hermes is not set up" };
      try {
        const text = await hermes.ask(env, job.task, { signal: AbortSignal.timeout(6 * 60_000) });
        return text.trim() ? { ok: true, text } : { ok: false, text: "Hermes answered with nothing" };
      } catch (e) {
        return { ok: false, text: `Hermes did not answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
    },
  };
}

/* ---------- HTTP ------------------------------------------------------------- */

const MAX_BODY = 16 * 1024;

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The panel's view: everything but the grants and the internals. */
export function jobView(j: Job, whole = false) {
  const { grants: _g, responseId: _r, ...rest } = j;
  void _g;
  void _r;
  return whole ? rest : { ...rest, result: undefined, hasResult: !!j.result };
}

export async function handleJobs(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/v1/jobs" && p !== "/api/v1/jobs/cancel") return null;
  const state = stateStub(env);
  if (!state) return err(503, "jobs need the STATE Durable Object");
  const grants: Grant[] = principal.kind === "owner" ? [WILDCARD] : principal.scopes;
  const who = principal.kind === "owner" ? "owner" : principal.id;
  // A device sees its own jobs; the owner sees all, including those started by voice.
  const mine = (j: Job) => principal.kind === "owner" || j.createdBy === who;

  if (p === "/api/v1/jobs/cancel") {
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await body(req);
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
    const b = await body(req);
    if (!b) return err(400, "body must be a small JSON object");
    if (b.engine === "hermes" && !allows(grants, "home")) return err(403, 'a Hermes job needs "home"', { need: "home" });
    const j = await state.createJob(b, { who, grants });
    return typeof j === "string" ? err(400, j) : json({ ok: true, job: jobView(j) }, { status: 201 });
  }
  return err(405, "method not allowed");
}
