import OpenAI from "openai";
import type { Env } from "../types";
import { json, err, redact } from "../lib/http";
import {
  DEFAULT_ROUTER_MODEL,
  builtinTools,
  orderCandidates,
  pick,
  readFallback,
  resolveRouterModel,
  saneModelId,
  storeRouterModel,
  type FallbackRecord,
} from "../lib/router-model";

/**
 * The router model setting.
 *
 *   GET    /api/router        what is in use, where it came from, what else exists
 *   POST   /api/router/test   probe a model without saving it
 *   PUT    /api/router        probe, then save only if the probe passed
 *   DELETE /api/router        forget the choice; the secret or default applies
 *
 * Owner-only (lib/scopes.ts): which model reads the house and the mailbox is
 * not something a device gets to decide.
 */
export async function handleRouter(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/router/test") {
    if (req.method !== "POST") return err(405, "POST a model to test");
    const model = await modelFrom(req);
    if (!model) return err(400, "model must be an OpenAI model id");
    return json(await probeModel(env, model));
  }

  switch (req.method) {
    case "GET":
      return json(await state(env));

    case "PUT": {
      const model = await modelFrom(req);
      if (!model) return err(400, "model must be an OpenAI model id");
      const probe = await probeModel(env, model);
      // Refused rather than saved with a warning: a model that cannot route
      // would make every question in the car fail, and the car is exactly where
      // nobody can open a settings panel to undo it.
      if (!probe.ok) {
        return json({ saved: false, probe, ...(await state(env)) }, { status: 422 });
      }
      await storeRouterModel(env, model);
      return json({ saved: true, probe, ...(await state(env, { model })) });
    }

    case "DELETE":
      await storeRouterModel(env, null);
      return json({ saved: true, ...(await state(env, null)) });

    default:
      return err(405, "GET, PUT or DELETE");
  }
}

async function modelFrom(req: Request): Promise<string | null> {
  const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
  return saneModelId(body?.model);
}

/**
 * `justStored` is what was written a moment ago, passed in rather than read
 * back: KV caches reads for up to a minute, so reading straight after a write
 * can return the OLD value, and the panel would report that the change did not
 * take.
 */
async function state(env: Env, justStored?: unknown) {
  const fresh = justStored !== undefined;
  const [resolved, fallback, catalogue] = await Promise.all([
    fresh ? Promise.resolve(pick(justStored, env.ROUTER_MODEL)) : resolveRouterModel(env),
    fresh ? Promise.resolve(null as FallbackRecord | null) : readFallback(env),
    listModels(env),
  ]);
  return {
    model: resolved.model,
    source: resolved.source,
    default: DEFAULT_ROUTER_MODEL,
    envModel: saneModelId(env.ROUTER_MODEL),
    // null when the list could not be fetched, so "unknown" is not shown as "missing".
    listed: catalogue.ids ? catalogue.ids.includes(resolved.model) : null,
    candidates: catalogue.ids ? orderCandidates(catalogue.ids) : [],
    ...(catalogue.error ? { candidatesError: catalogue.error } : {}),
    // Only relevant while the failing model is still the chosen one.
    fallback: fallback && fallback.model === resolved.model ? fallback : null,
  };
}

async function listModels(env: Env): Promise<{ ids?: string[]; error?: string }> {
  if (!env.OPENAI_API_KEY) return { error: "OPENAI_API_KEY is not set" };
  try {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    if (!r.ok) return { error: `OpenAI answered ${r.status}` };
    const j = (await r.json()) as { data?: { id: string }[] };
    return { ids: (j.data ?? []).map((m) => m.id) };
  } catch (e) {
    return { error: redact(e instanceof Error ? e.message : String(e)) };
  }
}

/* ---------- the probe ------------------------------------------------------ */

export interface ProbeResult {
  ok: boolean;
  model: string;
  /** Where it failed: the call itself, calling the tool, or following up after it. */
  stage?: "call" | "tool" | "chain";
  status?: number;
  error?: string;
  /** First hop: question in, tool call out. The latency a driver waits on. */
  toolMs?: number;
  /** Second hop: tool result in, answer out, chained by previous_response_id. */
  chainMs?: number;
}

/** Strict, like every tool the router is given, so strict-mode support is tested too. */
const PROBE_TOOL = {
  type: "function" as const,
  name: "probe_ok",
  description: "Confirms the connectivity check.",
  parameters: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  strict: true,
};

const PROBE_INSTRUCTIONS =
  "This is a connectivity check. Call probe_ok with ok set to true. " +
  "When it returns, reply with the single word: ready.";

/** A model this slow on a one-word task is not usable from a car anyway. */
const HOP_TIMEOUT_MS = 30_000;

/**
 * Two real hops, shaped like the router's own: strict function tools alongside
 * web search, `tool_choice: "auto"`, then a function result chained with
 * `previous_response_id`. A model can appear in /v1/models and still reject any
 * one of those, and each is something every delegation depends on.
 *
 * Costs a few hundred tokens.
 */
async function probeModel(env: Env, model: string): Promise<ProbeResult> {
  if (!env.OPENAI_API_KEY) return { ok: false, model, stage: "call", error: "OPENAI_API_KEY is not set" };
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const tools = [PROBE_TOOL, ...builtinTools(env)];
  let stage: "call" | "chain" = "call";
  let toolMs: number | undefined;

  try {
    const t0 = Date.now();
    const first = await client.responses.create(
      {
        model,
        instructions: PROBE_INSTRUCTIONS,
        input: [{ role: "user", content: "Run the check." }],
        tools,
        tool_choice: "auto",
        store: true,
      },
      { signal: AbortSignal.timeout(HOP_TIMEOUT_MS) },
    );
    toolMs = Date.now() - t0;

    const call = first.output.find(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call",
    );
    if (!call) {
      return {
        ok: false, model, stage: "tool", toolMs,
        error: "It answered without calling the tool it was told to call, so it cannot be trusted to route.",
      };
    }

    stage = "chain";
    const t1 = Date.now();
    const second = await client.responses.create(
      {
        model,
        // Not carried over by previous_response_id; the router re-sends it every hop too.
        instructions: PROBE_INSTRUCTIONS,
        previous_response_id: first.id,
        input: [{ type: "function_call_output", call_id: call.call_id, output: "ok" }],
        tools,
        tool_choice: "auto",
        store: true,
      },
      { signal: AbortSignal.timeout(HOP_TIMEOUT_MS) },
    );
    const chainMs = Date.now() - t1;

    if (!second.output_text?.trim()) {
      return {
        ok: false, model, stage: "chain", toolMs, chainMs,
        error: "It called the tool but said nothing afterwards.",
      };
    }
    return { ok: true, model, toolMs, chainMs };
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status;
    const aborted = e instanceof Error && /abort|timed? ?out/i.test(e.name + " " + e.message);
    return {
      ok: false,
      model,
      stage,
      ...(typeof status === "number" ? { status } : {}),
      ...(toolMs !== undefined ? { toolMs } : {}),
      error: aborted
        ? `No answer within ${HOP_TIMEOUT_MS / 1000}s.`
        : redact(e instanceof Error ? e.message : String(e)).slice(0, 400),
    };
  }
}
