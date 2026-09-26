import type { Env } from "../types";
import { err, json } from "../lib/http";
import { stateStub } from "../lib/state-client";
import { localeOf } from "../lib/locale.ts";
import { PRICES_AS_OF } from "../lib/prices.ts";
import { dayOf, type UsageEntry } from "../lib/usage.ts";

/**
 * Usage (lib/usage.ts): recording it, and Settings → Usage.
 *
 *   GET  /api/usage             this month, today, recent and slowest (owner)
 *   POST /api/v1/usage/live     {seconds}: a live session's length, from its screen
 */

/** Add to the owner's usage. Never throws: a count lost is not an answer lost. */
export async function recordUsage(env: Env, e: UsageEntry): Promise<void> {
  const state = stateStub(env);
  if (!state) return;
  try {
    await state.recordUsage(e, dayOf(e.at, localeOf(env).timeZone));
  } catch (x) {
    console.warn("usage not recorded:", x instanceof Error ? x.message : String(x));
  }
}

export async function handleUsage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return err(405, "GET only");
  const state = stateStub(env);
  if (!state) return err(503, "usage needs the STATE Durable Object");
  const timeZone = localeOf(env).timeZone;
  const r = await state.usageReport(dayOf(Date.now(), timeZone));
  return json({ ...r, pricesAsOf: PRICES_AS_OF, timeZone });
}

/**
 * A live session's length. Only the screen knows when one ended — OpenAI
 * holds the session, not Jarvis — so it reports it as it closes.
 */
export async function handleLiveUsage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "POST only");
  const b = (await req.json().catch(() => null)) as { seconds?: unknown } | null;
  const seconds = typeof b?.seconds === "number" ? Math.round(b.seconds) : NaN;
  // Up to four hours: longer is a screen that never reported closing.
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 4 * 3600) return err(400, "seconds must be 1 to 14400");
  await recordUsage(env, {
    at: Date.now() - seconds * 1000,
    surface: "live",
    by: "gpt-live-1",
    ok: true,
    ms: seconds * 1000,
    input: 0,
    cached: 0,
    written: 0,
    output: 0,
    searches: 0,
    seconds,
    tools: [],
    ask: "",
  });
  return json({ ok: true });
}
