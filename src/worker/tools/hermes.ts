import type { Env } from "../types";

/**
 * Client for a self-hosted Nous Research hermes-agent.
 *
 * The contract below is taken from a working integration (Cerap's
 * backend/app/services/hermes.py), not from guesswork:
 *   - the api_server is OpenAI-compatible and defaults to 127.0.0.1:8642
 *   - `Authorization: Bearer <API_SERVER_KEY>` is required on every deployment
 *   - Cloudflare Access adds CF-Access-Client-Id / CF-Access-Client-Secret
 *   - `X-Hermes-Session-Key` scopes Hermes's own long-term memory, so only the
 *     new message is sent rather than the whole transcript
 *   - there is no /health; GET /v1/models is the liveness and auth probe
 */

/** Stable per-device key so Hermes accumulates memory across drives. */
export const SESSION_KEY = "jarvis:tesla";

export class HermesNotConfigured extends Error {
  constructor() {
    super("Hermes is not configured on this Worker");
    this.name = "HermesNotConfigured";
  }
}

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
  cfId?: string;
  cfSecret?: string;
  model: string;
}

/**
 * Sort an Access credential pair into (id, secret) regardless of which slot each
 * was pasted into.
 *
 * A Cloudflare Access Client ID always ends in ".access" and a Client Secret
 * never does, so the pair is self-identifying. Swapping the two during two
 * consecutive terminal prompts is easy to do and produces a bare 403 that looks
 * identical to a policy problem — so rather than fail on it, correct it and say
 * so loudly in /api/diag.
 */
export function orderAccessPair(a?: string, b?: string): { id?: string; secret?: string; swapped: boolean } {
  const x = a?.trim();
  const y = b?.trim();
  if (!x || !y) return { id: x, secret: y, swapped: false };
  if (!x.endsWith(".access") && y.endsWith(".access")) return { id: y, secret: x, swapped: true };
  return { id: x, secret: y, swapped: false };
}

export function hermesConfig(env: Env): HermesConfig | null {
  if (!env.HERMES_BASE_URL || !env.HERMES_API_KEY) return null;
  const pair = orderAccessPair(env.CF_ACCESS_CLIENT_ID, env.CF_ACCESS_CLIENT_SECRET);
  return {
    baseUrl: env.HERMES_BASE_URL.replace(/\/+$/, ""),
    apiKey: env.HERMES_API_KEY.trim(),
    cfId: pair.id,
    cfSecret: pair.secret,
    model: env.HERMES_MODEL || "hermes",
  };
}

function headers(cfg: HermesConfig, extra: Record<string, string> = {}) {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...extra,
  };
  // Optional, and defense in depth: Access validates at the edge before the
  // request ever reaches the box at home.
  if (cfg.cfId && cfg.cfSecret) {
    h["CF-Access-Client-Id"] = cfg.cfId;
    h["CF-Access-Client-Secret"] = cfg.cfSecret;
  }
  return h;
}

/** Map a transport or status failure onto something worth saying out loud. */
function explain(status: number): string {
  if (status === 401) return "Hermes rejected the key.";
  if (status === 403) return "Cloudflare Access blocked the request — check the service token and that the policy action is Service Auth.";
  if (status === 404) return "That endpoint does not exist on Hermes — check the base URL.";
  if (status === 502 || status === 503) return "Hermes is unreachable — the box at home may be down.";
  // 524 is Cloudflare's own origin timeout, not something Hermes sent.
  if (status === 504 || status === 524) {
    return "Hermes did not answer within Cloudflare's 100-second origin timeout.";
  }
  return `Hermes returned ${status}.`;
}

/** Liveness and auth probe. Hermes's api_server has no /health. */
export async function ping(env: Env, signal?: AbortSignal) {
  const cfg = hermesConfig(env);
  if (!cfg) throw new HermesNotConfigured();

  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/v1/models`, { headers: headers(cfg), signal });
  const ms = Date.now() - started;

  if (!res.ok) {
    return { ok: false as const, status: res.status, ms, detail: explain(res.status) };
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
  return {
    ok: true as const,
    status: res.status,
    ms,
    models: (body.data ?? []).map((m) => m.id).slice(0, 20),
  };
}

/**
 * Ask Hermes a question.
 *
 * No timeout by design: a local model can take minutes on a long prompt, and the
 * user's instruction was that Jarvis waits and says so rather than giving up.
 * The caller controls cancellation through `signal`.
 */
export async function ask(
  env: Env,
  question: string,
  opts: { signal?: AbortSignal; system?: string; onFirstToken?: () => void } = {},
): Promise<string> {
  const cfg = hermesConfig(env);
  if (!cfg) throw new HermesNotConfigured();

  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: question });

  /*
   * Streaming is not an optimisation here, it is what makes long answers
   * possible at all.
   *
   * hermes.example.com is proxied by Cloudflare, which gives an origin 100
   * seconds to send its FIRST byte before returning 524. A non-streaming request
   * sends nothing until the model has finished, so any question taking longer
   * than that died at ~130s no matter how patient the caller was — which is
   * exactly the failure we saw. With stream: true the first token arrives almost
   * immediately and the connection then stays open for as long as it needs.
   */
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(cfg, { "X-Hermes-Session-Key": SESSION_KEY }),
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${explain(res.status)}${body ? ` (${body.slice(0, 200)})` : ""}`);
  }
  if (!res.body) throw new Error("Hermes returned no response body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawFirst = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const piece =
          chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
        if (piece) {
          if (!sawFirst) { sawFirst = true; opts.onFirstToken?.(); }
          text += piece;
        }
      } catch {
        // A partial frame split across reads; the next read completes it.
      }
    }
  }

  const trimmed = text.trim();
  if (!trimmed) throw new Error("Hermes returned an empty answer.");
  return trimmed;
}
