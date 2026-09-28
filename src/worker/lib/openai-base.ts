import type { Env } from "../types.ts";

/**
 * Where OpenAI is reached: OpenAI itself, or an OpenAI-compatible gateway
 * set in Settings → Advanced (OPENAI_BASE_URL) — a proxy a company requires,
 * or a stand-in for testing the whole of Jarvis without spending anything.
 */
export function openaiBase(env: Pick<Env, "OPENAI_BASE_URL">): string {
  const set = env.OPENAI_BASE_URL?.trim().replace(/\/+$/, "");
  return set || "https://api.openai.com/v1";
}
