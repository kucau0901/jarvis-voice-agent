import type { Env } from "../types";

/**
 * Which model routes delegations, and how that gets chosen.
 *
 * This used to be `env.ROUTER_MODEL || "gpt-5.6-terra"`, and changing it meant a
 * `wrangler secret put` from a terminal. Now it is a setting, chosen from a
 * phone. That makes a new failure possible, and the rest of this file exists
 * because of it: a bad choice made in settings would break every question
 * asked in the car, where there is no terminal and no way to find out why.
 *
 * Two things guard against that. Saving runs a real tool round trip on the
 * candidate first (routes/router.ts), because a model can be listed on the
 * account and still reject the tool or chaining features the router depends
 * on. And if a saved model later stops working, the first hop of a
 * delegation falls back to the default and records why, so Jarvis keeps
 * answering and the settings panel says what happened.
 *
 * Deliberately free of the `openai` import, so the tests can load it.
 */

/**
 * The default router, and what a rejected choice falls back to.
 *
 * GPT-6 Luna since 25 September 2026: about 1/20 the price of GPT-6 Sol ($0.10
 * vs $2 per million input tokens). On eight real Jarvis questions — car,
 * memory, the staff roster, calendar, web, Malay, the house, and a planted
 * made-up fact — Luna matched Sol on every one and did better on one: Sol
 * spent all six steps searching for a porch light and gave up, Luna said
 * plainly it could not find one. No slower. A router mostly picks a tool and
 * writes a sentence; that does not need the dearer model.
 */
export const DEFAULT_ROUTER_MODEL = "gpt-6-luna";

const KV_KEY = "config:router-model";
const KV_FALLBACK_KEY = "config:router-model:fallback";

/** Long enough to be seen, short enough that a one-off failure does not linger. */
const FALLBACK_TTL_S = 7 * 24 * 3600;

export type ModelSource = "ui" | "env" | "default";

export interface ResolvedModel {
  model: string;
  source: ModelSource;
}

export interface FallbackRecord {
  model: string;
  fellBackTo: string;
  at: number;
  status?: number;
  message: string;
}

/** OpenAI model ids: short, alphanumeric, punctuated with `.` `-` `_` `:`. */
const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{1,79}$/i;

export function saneModelId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return MODEL_ID.test(t) ? t : null;
}

/**
 * Precedence: the settings panel, then the ROUTER_MODEL secret, then the
 * default.
 *
 * The panel wins because it is the thing the user can see. If a secret beat
 * it, choosing a model on the phone would appear to work and change nothing.
 * The secret stays useful as the one way to set a model the probe refuses.
 */
export function pick(stored: unknown, envValue: string | undefined): ResolvedModel {
  const ui = saneModelId((stored as { model?: unknown } | null)?.model);
  if (ui) return { model: ui, source: "ui" };
  const fromEnv = saneModelId(envValue);
  if (fromEnv) return { model: fromEnv, source: "env" };
  return { model: DEFAULT_ROUTER_MODEL, source: "default" };
}

/** Never throws: a KV hiccup must cost the choice, not the question. */
export async function resolveRouterModel(env: Env): Promise<ResolvedModel> {
  let stored: unknown = null;
  try {
    stored = await env.CONFIG.get(KV_KEY, "json");
  } catch {
    /* behave as unset */
  }
  return pick(stored, env.ROUTER_MODEL);
}

/** `null` clears the choice, so the secret or the default applies again. */
export async function storeRouterModel(env: Env, model: string | null): Promise<void> {
  if (model === null) await env.CONFIG.delete(KV_KEY);
  else await env.CONFIG.put(KV_KEY, JSON.stringify({ model, setAt: Date.now() }));
  // Any deliberate choice supersedes the record of the previous one failing.
  await env.CONFIG.delete(KV_FALLBACK_KEY);
}

export async function readFallback(env: Env): Promise<FallbackRecord | null> {
  try {
    return (await env.CONFIG.get(KV_FALLBACK_KEY, "json")) as FallbackRecord | null;
  } catch {
    return null;
  }
}

export async function recordFallback(env: Env, rec: FallbackRecord): Promise<void> {
  await env.CONFIG.put(KV_FALLBACK_KEY, JSON.stringify(rec), { expirationTtl: FALLBACK_TTL_S });
}

/**
 * How long the router thinks before answering (`reasoning.effort`).
 *
 * The model's own default was used for everything until 26 Sep 2026, and its
 * hops took 2.5 to 4.5 s each — most of any answer Home Assistant cannot give
 * itself. Less thinking is faster and cheaper, which matters most to someone
 * waiting: in the car, on the glasses, typing. Background jobs and routines
 * have nobody waiting and keep the default whatever the setting says.
 *
 * "auto" is what testing on real questions found best (INTERACTIVE_EFFORT).
 */
export const EFFORTS = ["auto", "none", "minimal", "low", "medium", "high"] as const;
export type Effort = Exclude<(typeof EFFORTS)[number], "auto">;

/**
 * What "auto" means for a question someone is waiting on; null is the model's
 * own default. Tested on ten real questions with GPT-6 Luna (26 Sep 2026,
 * docs/DESIGN.md): low and minimal were no faster, and "none" invented a task.
 * So the default stays; the setting is there for a heavier router model.
 */
export const INTERACTIVE_EFFORT: Effort | null = null;

export function effortFor(surface: string | undefined, setting: string | undefined): Effort | null {
  if (surface === "job" || surface === "research" || surface === "routine") return null;
  const s = setting?.trim().toLowerCase();
  if (s && s !== "auto" && (EFFORTS as readonly string[]).includes(s)) return s as Effort;
  return INTERACTIVE_EFFORT;
}

/**
 * The model a research job runs on (RESEARCH_MODEL): stronger than the router,
 * because it is asked for depth and nobody is waiting on it.
 */
export const DEFAULT_RESEARCH_MODEL = "gpt-6-sol";
export const researchModel = (setting: string | undefined): string => saneModelId(setting) ?? DEFAULT_RESEARCH_MODEL;

/**
 * A 400 that is about the effort itself, from a model that does not take it
 * (or not that value): the call is made again without it rather than failing,
 * and rather than read as the model being refused (shouldFallBack).
 */
export function effortRefused(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  return status === 400 && /reasoning|effort/i.test(message);
}

/**
 * Whether a failed call should be retried on the default model.
 *
 * Only the FIRST hop, because nothing has run yet: no tool has fired, so
 * repeating the call cannot repeat a side effect. By the second hop the chosen
 * model has already worked once, and whatever went wrong is not about it.
 *
 * Only 400 and 404, which is how OpenAI rejects an unknown model or a feature
 * the model does not support. Not 401 or 429 — the key and the quota are the
 * same whichever model is asked — and not 5xx, which is weather rather than
 * incompatibility.
 */
export function shouldFallBack(e: unknown, model: string, step: number, aborted: boolean): boolean {
  if (step !== 0 || aborted || model === DEFAULT_ROUTER_MODEL) return false;
  const status = (e as { status?: unknown } | null)?.status;
  return status === 400 || status === 404;
}

/**
 * Models that take explicit prompt-cache breakpoints: GPT-5.6 and later.
 *
 * Sending the breakpoint or `prompt_cache_options` to an older model risks a
 * 400 — which the first-hop fallback would then read as the model being
 * rejected — so they are sent only where supported.
 */
export function explicitCache(model: string): boolean {
  return /^gpt-(5\.([6-9]|[1-9]\d)|[6-9]|[1-9]\d)(?![0-9])/.test(model);
}

/** OpenAI-executed tools the router always offers. Shared with the probe so it tests the same request. */
export function builtinTools(env: Env): { type: "web_search" }[] {
  return env.DISABLE_WEB_SEARCH === "1" ? [] : [{ type: "web_search" }];
}

/* ---------- which models are worth offering ------------------------------ */

/**
 * Text models only: anything for audio, images, embeddings or moderation
 * cannot route a question. This is NOT a compatibility check — the probe is
 * that. It only keeps the list short enough to scroll on a phone.
 */
const NOT_A_ROUTER = new Set([
  "audio", "realtime", "live", "tts", "transcribe", "image", "embedding",
  "moderation", "search", "instruct", "codex", "computer", "research",
]);

/** Pinned snapshots (`gpt-5-2025-08-07`) duplicate their alias and triple the list. */
const DATED = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Matched on whole name segments, never substrings: a substring test for
 * "live" would also throw out any future model with "deliver" in its name.
 */
export function isRouterCandidate(id: string): boolean {
  if (!/^(gpt-\d|o\d)/.test(id) || DATED.test(id)) return false;
  return !id.toLowerCase().split(/[-_.:]/).some((seg) => NOT_A_ROUTER.has(seg));
}

/** Newest GPT family first, then the o-series, so the likely choices sit at the top. */
export function orderCandidates(ids: string[]): string[] {
  const rank = (id: string): [number, number] => {
    const g = /^gpt-(\d+(?:\.\d+)?)/.exec(id);
    if (g) return [0, -parseFloat(g[1]!)];
    const o = /^o(\d+)/.exec(id);
    return [1, o ? -parseInt(o[1]!, 10) : 0];
  };
  return [...new Set(ids.filter(isRouterCandidate))].sort((a, b) => {
    const [fa, va] = rank(a);
    const [fb, vb] = rank(b);
    return fa - fb || va - vb || a.localeCompare(b);
  });
}
