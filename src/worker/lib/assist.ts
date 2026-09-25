import type { Env } from "../types";
import { allows, type Grant } from "./scopes.ts";

/**
 * Home Assistant's own Assist pipeline, tried before the router: for the
 * glasses, typed chat and push-to-talk (RunOptions.assist in routes/delegate.ts).
 *
 * Assist is local intent matching, not a language model. For the things it
 * understands (switching lights, reading a sensor, asking whether a door is
 * shut) it answers in tens of milliseconds, where the router has to take a
 * model hop, then an MCP connect-and-call, then another hop: 8 to 11 seconds
 * measured. For anything else it simply says it did not understand, and the
 * question goes to the router as though this had never been tried.
 *
 * Every house request tries it first, opening the gate included. What Assist
 * may do is decided in Home Assistant, by what is exposed to it, and that is
 * the place for the house's safety rules: giving Jarvis the house means
 * giving it the house. An earlier version sent anything naming a lock, door,
 * gate or alarm through the router instead, which only made "close my main
 * gate" take 8 to 17 s where Assist takes under one, and cost a model call.
 *
 * It uses the HA_BASE_URL and HA_TOKEN the camera tools already hold, so it
 * needs no new secret. It asks `conversation.home_assistant` by name, because
 * that is the only conversation agent every installation has. The others are
 * named after whichever integrations and config entries a given house has.
 *
 * Kept free of `openai` and of Worker globals beyond fetch, so Node can test it.
 */

export const ASSIST_AGENT = "conversation.home_assistant";
const TIMEOUT_MS = 3000;

/**
 * What to put to Assist: the user's latest words, if the conversation ends with
 * them. Assist sees only that one line, so a follow-up that needs what came
 * before ("turn it off") simply does not match and goes to the router.
 */
export function lastAsk(turns: readonly { role: string; text: string }[]): string | null {
  const last = turns[turns.length - 1];
  const text = last?.role === "user" ? last.text.trim() : "";
  return text || null;
}

export interface AssistConfig {
  base: string;
  token: string;
  language: string;
}

/**
 * Null when the fast path must not run: switched off, not configured, or not permitted.
 *
 * HA_ASSIST and HA_ASSIST_LANGUAGE were G2_FASTPATH and G2_HA_LANGUAGE while
 * only the glasses used this. The old names are still read, so a setting saved
 * under them keeps working.
 */
export function assistConfig(env: Env, grants: readonly Grant[]): AssistConfig | null {
  if ((env.HA_ASSIST ?? env.G2_FASTPATH) === "0") return null;
  if (!allows(grants, "home")) return null;
  const base = env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = env.HA_TOKEN;
  if (!base || !token) return null;
  const language = (env.HA_ASSIST_LANGUAGE ?? env.G2_HA_LANGUAGE)?.trim() || "en";
  return { base, token, language };
}

export type AssistOutcome =
  | { handled: true; text: string; kind: "action_done" | "query_answer"; ms: number }
  | {
      handled: false;
      reason: "no_match" | "timeout" | "http" | "unreadable" | "unreachable";
      ms: number;
      status?: number;
    };

interface Envelope {
  response?: {
    response_type?: string;
    speech?: { plain?: { speech?: string } };
    data?: { success?: unknown[]; failed?: unknown[] };
  };
}

/**
 * Ask Assist, and say whether it answered.
 *
 * Only `action_done` and `query_answer` count. `error` is how Assist says it
 * matched no intent or found no such device, and that is the signal to hand
 * over, never something to show the user. Every failure is a hand-over too: a
 * slow or broken Home Assistant must cost the fast path, not the question.
 */
export async function tryAssist(
  cfg: AssistConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<AssistOutcome> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.base}/api/conversation/process`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: cfg.language, agent_id: ASSIST_AGENT }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && /abort|timed? ?out/i.test(e.name + " " + e.message);
    return { handled: false, reason: timedOut ? "timeout" : "unreachable", ms: ms() };
  }
  if (!res.ok) return { handled: false, reason: "http", status: res.status, ms: ms() };

  let env: Envelope;
  try {
    env = (await res.json()) as Envelope;
  } catch {
    return { handled: false, reason: "unreadable", ms: ms() };
  }

  const kind = env.response?.response_type;
  if (kind !== "action_done" && kind !== "query_answer") {
    return { handled: false, reason: "no_match", ms: ms() };
  }

  let speech = env.response?.speech?.plain?.speech?.trim() ?? "";
  // Some versions finish an action without saying anything.
  if (!speech && kind === "action_done") {
    const failed = env.response?.data?.failed?.length ?? 0;
    const done = env.response?.data?.success?.length ?? 0;
    speech = failed ? `${done} done, ${failed} failed.` : "Done.";
  }
  if (!speech) return { handled: false, reason: "no_match", ms: ms() };

  return { handled: true, text: speech, kind, ms: ms() };
}
