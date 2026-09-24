import type { Env } from "../types";
import { json } from "../lib/http";
import { ping, hermesConfig, orderAccessPair } from "../tools/hermes";
import { toolAvailability } from "../tools/registry";
import { orderCandidates, readFallback, resolveRouterModel } from "../lib/router-model";

/**
 * Reachability check for both backends.
 *
 * Exists because the two things most likely to be wrong — OpenAI credit and
 * Hermes credentials — are invisible from the driver's seat, and "Jarvis went
 * quiet" is not a diagnosis.
 */
export async function handleDiag(_req: Request, env: Env): Promise<Response> {
  const out: Record<string, unknown> = { ts: new Date().toISOString() };
  out.localTools = toolAvailability(env);
  out.router = { ...(await resolveRouterModel(env)), fallback: await readFallback(env) };

  // OpenAI: cheap authenticated call, no generation, no cost.
  out.openai = await (async () => {
    if (!env.OPENAI_API_KEY) return { configured: false };
    try {
      const started = Date.now();
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      });
      const ms = Date.now() - started;
      if (!r.ok) return { configured: true, ok: false, status: r.status, ms };
      const j = (await r.json()) as { data?: { id: string }[] };
      const ids = (j.data ?? []).map((m) => m.id);
      return {
        configured: true,
        ok: true,
        ms,
        total: ids.length,
        live: ids.filter((i) => i.includes("live")),
        candidateRouterModels: orderCandidates(ids).slice(0, 60),
      };
    } catch (e) {
      return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();

  /**
   * Shape-check the Access credentials without ever revealing them.
   *
   * A 403 with the token showing "Not Seen Yet" in the dashboard means Access
   * never matched it at all, which is almost always a paste problem: the two
   * values swapped, a truncated copy, or stray whitespace. Cloudflare's format
   * is strict enough to catch every one of those from the shape alone.
   */
  out.credentials = (() => {
    const id = env.CF_ACCESS_CLIENT_ID ?? "";
    const secret = env.CF_ACCESS_CLIENT_SECRET ?? "";
    const bearer = env.HERMES_API_KEY ?? "";
    const problems: string[] = [];

    // Only one property here is reliable: a Client ID always ends in ".access",
    // and a Client Secret never does. Secret LENGTH is not a safe signal — an
    // earlier version of this check assumed 64 hex and wrongly reported a
    // perfectly good 54-character secret as malformed.
    const looksLikeId = (v: string) => v.endsWith(".access");

    if (!id) problems.push("CF_ACCESS_CLIENT_ID is empty");
    if (!secret) problems.push("CF_ACCESS_CLIENT_SECRET is empty");

    if (id && secret) {
      if (looksLikeId(secret) && !looksLikeId(id)) {
        problems.push(
          "The two values are SWAPPED. The Worker is correcting for this automatically, " +
          "so Hermes still works — but swap them with `wrangler secret put` when convenient.",
        );
      } else if (!looksLikeId(id)) {
        problems.push("CF_ACCESS_CLIENT_ID does not end in '.access', so it is not a Client ID");
      } else if (looksLikeId(secret)) {
        problems.push("CF_ACCESS_CLIENT_SECRET ends in '.access', so it is an ID, not a secret");
      }
    }
    if (id !== id.trim()) problems.push("CF_ACCESS_CLIENT_ID has stray whitespace");
    if (secret !== secret.trim()) problems.push("CF_ACCESS_CLIENT_SECRET has stray whitespace");
    if (!bearer) problems.push("HERMES_API_KEY is empty");

    return {
      clientId: id ? `${id.length} chars, ${looksLikeId(id) ? "ends in .access ✓" : "does NOT end in .access ✗"}` : "empty",
      clientSecret: secret ? `${secret.length} chars, ${looksLikeId(secret) ? "ends in .access ✗ (that is an ID)" : "no .access suffix ✓"}` : "empty",
      hermesKeyLength: bearer.length,
      autoCorrected: orderAccessPair(id, secret).swapped,
      problems,
    };
  })();

  // Hermes: GET /v1/models is the documented liveness and auth probe.
  out.hermes = await (async () => {
    const cfg = hermesConfig(env);
    if (!cfg) {
      return {
        configured: false,
        missing: [
          !env.HERMES_BASE_URL && "HERMES_BASE_URL",
          !env.HERMES_API_KEY && "HERMES_API_KEY",
        ].filter(Boolean),
      };
    }
    try {
      // Bounded here, unlike a real question: a probe that hangs is a failed probe.
      const res = await ping(env, AbortSignal.timeout(15_000));
      return {
        configured: true,
        host: new URL(cfg.baseUrl).host,
        cfAccess: Boolean(cfg.cfId && cfg.cfSecret),
        model: cfg.model,
        ...res,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        configured: true,
        host: new URL(cfg.baseUrl).host,
        cfAccess: Boolean(cfg.cfId && cfg.cfSecret),
        ok: false,
        error: msg.includes("timed out") || msg.includes("aborted")
          ? "no response within 15s — is the tunnel up?"
          : msg,
      };
    }
  })();

  return json(out);
}
