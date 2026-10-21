import OpenAI from "openai";
import type { Env } from "../types.ts";
import { openaiBase } from "./openai-base.ts";
import { FAILURE_SAYS, PLAN_BASE, planFailureOf, type PlanFailure } from "./chatgpt-plan.ts";
import { stateStub } from "./state-client.ts";
import { deliver, makeAlert } from "./alerts.ts";
import { OWNER } from "./context.ts";

/**
 * How a model call is paid for: the owner's ChatGPT plan first
 * (lib/chatgpt-plan.ts), else OPENAI_API_KEY. Either alone runs Jarvis; live
 * voice, push-to-talk's OpenAI speech and memory embeddings need the key,
 * which the plan does not cover.
 */
export type ModelAuth = { kind: "plan"; token: string; model: string | null } | { kind: "key" };

/** The plan if it can be used now, else the key; null for neither. Never throws. */
export async function modelAuth(env: Env): Promise<ModelAuth | null> {
  const plan = await (stateStub(env)?.chatgptToken(Date.now()) ?? Promise.resolve(null)).catch(() => null);
  if (plan) return { kind: "plan", ...plan };
  return env.OPENAI_API_KEY ? { kind: "key" } : null;
}

/** Whether anything can answer a question: a plan or a key. */
export const canAsk = async (env: Env): Promise<boolean> => !!(await modelAuth(env));

/**
 * Plan requests go to OpenAI itself, never OPENAI_BASE_URL, which may be a
 * proxy holding the key; and are not retried by the SDK, which would spend
 * the plan again on a limit it has just reported.
 */
export function clientFor(env: Env, auth: ModelAuth): OpenAI {
  return auth.kind === "plan" ? new OpenAI({ apiKey: auth.token, baseURL: PLAN_BASE, maxRetries: 0 }) : new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: openaiBase(env) });
}

/** At the plan's limit, whether to carry on with the key (the owner's choice, CHATGPT_FALLBACK). */
export const mayFallBack = (env: Env): boolean => !!env.OPENAI_API_KEY && env.CHATGPT_FALLBACK !== "0";

/** The plan said no: why, for the caller to fall back to the key or say so. */
export class PlanRefused extends Error {
  why: PlanFailure;
  constructor(why: PlanFailure, detail: string) {
    super(`ChatGPT plan: ${why} (${detail})`);
    this.why = why;
  }
}

/** A thrown API error that is the plan refusing, by its code; null for anything else. */
export function refusalOf(e: unknown): PlanRefused | null {
  if (e instanceof PlanRefused) return e;
  const code = (e as { code?: unknown; error?: { code?: unknown } })?.code ?? (e as { error?: { code?: unknown } })?.error?.code;
  const why = planFailureOf(code);
  return why ? new PlanRefused(why, String(code)) : null;
}

/**
 * The plan said no: noted (at its limit, the key for an hour), the owner told
 * once, and whether to carry on with the key.
 */
export async function planFailed(env: Env, refused: PlanRefused): Promise<boolean> {
  const state = stateStub(env);
  const fallBack = mayFallBack(env);
  const told = await (state?.chatgptFailed(refused.why, Date.now()) ?? Promise.resolve(null)).catch(() => null);
  if (state && told?.first) {
    const text = `${FAILURE_SAYS[refused.why]}${fallBack ? " Jarvis is using the OpenAI key meanwhile." : ""}`;
    const alert = makeAlert({ title: "ChatGPT plan", text, speak: false }, "note", Date.now(), OWNER);
    if (alert) await deliver(env, state, alert, { skipLive: true }).catch(() => {});
  }
  return fallBack;
}

/**
 * What the plan answered so far, made fit for the key after falling back
 * mid-question: no reasoning (encrypted for the plan's account), no ids of
 * items the key's side never stored, no namespace the key's tools do not have.
 */
export function forKey(input: OpenAI.Responses.ResponseInput): OpenAI.Responses.ResponseInput {
  return input.flatMap((item): OpenAI.Responses.ResponseInputItem[] => {
    if (item.type === "reasoning") return [];
    if (item.type === "function_call") return [{ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments }];
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      const text = item.content.map((c) => (c.type === "output_text" ? c.text : "")).join("");
      return text ? [{ role: "assistant", content: text }] : [];
    }
    return [item];
  });
}

/** What the plan route rejects that Jarvis otherwise sends: explicit prompt caching. */
export function forPlan(input: OpenAI.Responses.ResponseInput): OpenAI.Responses.ResponseInput {
  return input.map((item) => {
    if (!("content" in item) || !Array.isArray(item.content)) return item;
    return { ...item, content: item.content.map((c) => ("prompt_cache_breakpoint" in c ? (({ prompt_cache_breakpoint: _, ...rest }) => rest)(c) : c)) } as typeof item;
  });
}

type PlanParams = Omit<OpenAI.Responses.ResponseCreateParamsStreaming, "stream" | "store" | "previous_response_id" | "background" | "prompt_cache_options">;

/**
 * One request on the plan: streamed and not stored, as the route requires,
 * and read to its end. The output items arrive one by one as each is done;
 * the closing event carries none (measured, 19 Oct 2026), so they are
 * gathered here. Throws PlanRefused when the plan says no.
 *
 * The route takes `input` only as a list of items: a bare string, which the
 * key's route accepts, is answered 400 "Input must be a list" (seen 20 Oct
 * 2026, when every page watch on the plan failed that way). So a string
 * becomes the one user message it stands for, here, for every caller.
 */
export async function planRespond(client: OpenAI, params: PlanParams, signal?: AbortSignal): Promise<OpenAI.Responses.Response> {
  const input: OpenAI.Responses.ResponseInput | undefined = typeof params.input === "string" ? [{ role: "user", content: params.input }] : params.input;
  let stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
  try {
    stream = await client.responses.create({ ...params, input, stream: true, store: false }, { signal });
  } catch (e) {
    throw refusalOf(e) ?? e;
  }
  const items: OpenAI.Responses.ResponseOutputItem[] = [];
  let last: OpenAI.Responses.Response | null = null;
  for await (const ev of stream) {
    if (ev.type === "response.output_item.done") items.push(ev.item);
    else if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") last = ev.response;
    else if (ev.type === "error") throw refusalOf(ev) ?? new Error(`ChatGPT plan: ${ev.message}`);
  }
  if (!last) throw new Error("ChatGPT plan: the answer stopped before it was complete");
  if (last.status === "failed") throw refusalOf(last.error) ?? new Error(`ChatGPT plan: ${last.error?.message ?? "the request failed"}`);
  const output = last.output?.length ? last.output : items;
  const text = output
    .flatMap((o) => (o.type === "message" ? o.content : []))
    .map((c) => (c.type === "output_text" ? c.text : ""))
    .join("");
  return { ...last, output, output_text: text };
}

/**
 * One answer with no tools: on the owner's ChatGPT plan first, else the key,
 * when the plan refuses and the owner allows it (planFailed). A page watch's
 * look (lib/page-look.ts), a brief's opening (lib/brief.ts). Its words, and
 * what it cost, for Usage.
 */
export async function respondOnce(
  env: Env,
  req: { model: string; instructions: string; input: string },
  signal: AbortSignal,
): Promise<{ text: string; input: number; output: number; model: string }> {
  const auth = await modelAuth(env);
  if (!auth) throw new Error("no ChatGPT plan or OpenAI key is set");
  if (auth.kind === "plan") {
    try {
      const r = await planRespond(clientFor(env, auth), req, signal);
      return { text: r.output_text ?? "", input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0, model: `chatgpt:${req.model}` };
    } catch (e) {
      const refused = refusalOf(e);
      if (!refused || !(await planFailed(env, refused))) throw e;
    }
  }
  const r = await clientFor(env, { kind: "key" }).responses.create(req, { signal });
  return { text: r.output_text ?? "", input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0, model: req.model };
}
