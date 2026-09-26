import type { Env } from "../types";

/**
 * Home Assistant over its REST API, for what needs no model: rendering a
 * template (Watches, lib/scheduler.ts), as the camera list already does
 * (lib/cameras.ts). One small request each, which matters over a slow link
 * home.
 *
 * Kept free of Worker globals beyond fetch, so Node can test it.
 */

export interface HaConfig {
  base: string;
  token: string;
}

export function haConfig(env: Env): HaConfig | null {
  const base = env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = env.HA_TOKEN;
  return base && token ? { base, token } : null;
}

/** What Home Assistant makes of a template: its text, or an error saying why not. */
export async function renderTemplate(
  cfg: HaConfig,
  template: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string> {
  const res = await fetchImpl(`${cfg.base}/api/template`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ template }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = (await res.text()).trim();
  // Home Assistant explains a bad template in the body of a 400.
  if (!res.ok) throw new Error(`Home Assistant said ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  return text;
}

/** A rendered condition as yes or no; null when it is neither. */
export function truthy(rendered: string): boolean | null {
  const v = rendered.trim().toLowerCase();
  if (v === "true" || v === "on" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "off" || v === "no" || v === "0") return false;
  return null;
}
