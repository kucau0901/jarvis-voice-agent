import type { Env } from "../types";
import { allows, type Grant } from "./scopes.ts";

/**
 * Home Assistant's own Assist pipeline, tried before the router.
 *
 * Assist is local intent matching, not a language model. For the things it
 * understands (switching lights, reading a sensor, asking whether a door is
 * shut) it answers in tens of milliseconds, where the router has to take a
 * model hop, then an MCP connect-and-call, then another hop: 8 to 11 seconds
 * measured. For anything else it simply says it did not understand, and the
 * question goes to the router as though this had never been tried.
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
 * Locks, doors, gates, garages and the alarm: the things a way into the house
 * is made of.
 *
 * Requests that would OPEN one skip Assist (see fastPathAllowed). Not because
 * Assist would get them wrong, but because the router's path to the house has
 * guards this one does not: an allowlist of tools and a hard FORBIDDEN_SERVICES
 * list in tools/mcp.ts. Assist acts on whatever the house has exposed to it,
 * and "unlock the front door" would simply happen. Sending these through the
 * router keeps this path from ever being the weaker way into the house.
 *
 * Malay is included because the user speaks it and the phone transcribes it.
 */
export const SENSITIVE = new RegExp(
  "\\b(" +
    [
      "unlock(s|ed|ing)?", "lock(s|ed|ing)?", "disarm(s|ed|ing)?", "arm(s|ed|ing)?",
      "alarms?", "sirens?", "security", "garages?", "gates?", "doors?", "doorbells?",
      // Malay: door, gate or fence, lock, garage, alarm.
      "pintu", "pagar", "kunci", "garaj", "penggera",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * Words that would let someone in: opening, unlocking, disarming, and switching
 * or pressing something "on" — many gate openers are a relay that opens on "on".
 */
const OPENS = new RegExp(
  "\\b(" +
    [
      "open\\w*", "unlock\\w*", "unlatch\\w*", "disarm\\w*", "turn(s|ed|ing)?\\s+on",
      "switch(es|ed|ing)?\\s+on", "activat\\w*", "trigger\\w*", "press\\w*", "push\\w*",
      "toggl\\w*", "start\\w*", "rais\\w*", "lift\\w*", "releas\\w*", "let",
      // Malay: open.
      "buka\\w*",
    ].join("|") +
    ")\\b",
  "i",
);

/** Closing, shutting, locking, arming; Malay close and lock. */
const SECURES = /\b(close|shut|lock|arm|tutup|kunci)\b/i;

/**
 * A question reads the house rather than acting on it. Only words that cannot
 * start a command: not "can", "could" or "have", which begin polite ones.
 */
const ASKS = /^\s*(is|are|was|were|has|did|does|what|what's|whats|which|who|when|where|why|how|adakah|apakah)\b/i;

/**
 * Whether a request may try Assist first.
 *
 * The guard on the doors and gates is about letting people IN. Closing the
 * gate, locking a door or arming the alarm points the other way, and asking
 * whether the gate is shut changes nothing, so those take the fast path like
 * anything else. That is what the glasses did when they spoke to Home
 * Assistant directly: "close the main gate" was done in under a second, where
 * the router took 8 to 17 (measured 26 Sep 2026). Anything that opens, or
 * that says neither which way nor that it is a question, stays with the router.
 */
export function fastPathAllowed(text: string): boolean {
  if (!SENSITIVE.test(text)) return true;
  if (ASKS.test(text)) return true;
  return SECURES.test(text) && !OPENS.test(text);
}

export interface AssistConfig {
  base: string;
  token: string;
  language: string;
}

/** Null when the fast path must not run: switched off, not configured, or not permitted. */
export function assistConfig(env: Env, grants: readonly Grant[]): AssistConfig | null {
  if (env.G2_FASTPATH === "0") return null;
  if (!allows(grants, "home")) return null;
  const base = env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = env.HA_TOKEN;
  if (!base || !token) return null;
  return { base, token, language: env.G2_HA_LANGUAGE?.trim() || "en" };
}

export type AssistOutcome =
  | { handled: true; text: string; kind: "action_done" | "query_answer"; ms: number }
  | {
      handled: false;
      reason: "sensitive" | "no_match" | "timeout" | "http" | "unreadable" | "unreachable";
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
  if (!fastPathAllowed(text)) return { handled: false, reason: "sensitive", ms: 0 };

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
