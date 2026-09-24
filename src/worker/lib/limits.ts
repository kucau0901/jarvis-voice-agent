import type { Env } from "../types";
import { stateStub } from "./state-client.ts";

/**
 * Two ceilings, because there are two different failure modes.
 *
 * The realistic risk here is not an adversary — the perimeter is 160 bits on a
 * domain nobody knows. It is a device with a bug: an ESP32 in a reconnect loop
 * asking the same question four times a second, all night, against a metered
 * OpenAI account. Bursts and slow bleeds need different instruments.
 *
 *   burst  — Cloudflare's own rate limiter. Free, no state to keep, catches a
 *            runaway loop within seconds.
 *   daily  — a KV counter. Not a rate limiter; a cost meter. This is the one
 *            that actually protects the bill.
 *
 * Neither applies to the owner. Being locked out of /api/diag while debugging
 * why a device is locked out would be its own small tragedy.
 */

/** Deliberately generous: a person talking to a device will never approach it. */
const DEFAULT_DAILY = 500;

const day = () => new Date().toISOString().slice(0, 10);
const budgetKey = (deviceId: string) => `dev:spend:${deviceId}:${day()}`;

export interface LimitVerdict {
  ok: boolean;
  /** Seconds, for Retry-After. */
  retryAfter?: number;
  reason?: "rate_limited" | "daily_budget";
  /** True when the request was already counted, so the caller must not charge again. */
  counted?: boolean;
}

/**
 * Cloudflare's binding is per-colo, not global, so the true ceiling is
 * `limit x colos`. For devices that sit in one place that is a distinction
 * without a difference — but it is not a hard global cap and should not be
 * described as one.
 */
async function burst(env: Env, deviceId: string): Promise<boolean> {
  if (!env.DEVICE_LIMIT) return true; // binding not deployed yet
  try {
    const { success } = await env.DEVICE_LIMIT.limit({ key: deviceId });
    return success;
  } catch {
    // A limiter that is itself broken must not take the API down with it.
    return true;
  }
}

async function spentToday(env: Env, deviceId: string): Promise<number> {
  const raw = await env.CONFIG.get(budgetKey(deviceId)).catch(() => null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Charge one request against today's budget.
 *
 * Read-modify-write with no compare-and-swap, so two simultaneous requests can
 * lose a count. That is fine: this is a ceiling measured in hundreds, not an
 * accounting ledger, and a rare off-by-one against it changes nothing. Call it
 * inside ctx.waitUntil so it never delays a response.
 */
export async function charge(env: Env, deviceId: string): Promise<void> {
  const next = (await spentToday(env, deviceId)) + 1;
  await env.CONFIG.put(budgetKey(deviceId), String(next), {
    // Two days, so a counter cannot outlive the day it describes.
    expirationTtl: 60 * 60 * 48,
  }).catch(() => {});
}

export async function check(env: Env, deviceId: string): Promise<LimitVerdict> {
  if (!(await burst(env, deviceId))) {
    return { ok: false, retryAfter: 10, reason: "rate_limited" };
  }

  const cap = Number(env.DEVICE_DAILY_LIMIT) || DEFAULT_DAILY;

  // In the Durable Object: checked and counted in one atomic step, and no KV
  // write at all. On the free plan KV allows 1,000 writes a day, and counting
  // here was one write per device request — the fastest way to run out.
  const state = stateStub(env);
  if (state) {
    try {
      const r = await state.consume(deviceId, cap, day());
      if (r.ok) return { ok: true, counted: true };
      const until = Math.ceil((86_400_000 - (Date.now() % 86_400_000)) / 1000);
      return { ok: false, retryAfter: until, reason: "daily_budget", counted: true };
    } catch {
      // A broken counter must not take the API down, as with burst() above.
      return { ok: true, counted: true };
    }
  }

  if ((await spentToday(env, deviceId)) >= cap) {
    // Until midnight UTC, rounded up — a device that retries sooner just gets
    // the same answer again, cheaply.
    const until = Math.ceil((86_400_000 - (Date.now() % 86_400_000)) / 1000);
    return { ok: false, retryAfter: until, reason: "daily_budget" };
  }
  return { ok: true };
}

/** Spoken, like every other error here: the device's job is to read it aloud. */
export function limitMessage(reason: LimitVerdict["reason"]): string {
  return reason === "daily_budget"
    ? "That device has used up its allowance for today."
    : "Too many requests just now. Try again shortly.";
}
