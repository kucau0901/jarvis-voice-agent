import type { Env } from "../types.ts";

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

/**
 * Work one thing in the house (a guest's pass, lib/access.ts): a service on
 * one entity, nothing else. Throws with Home Assistant's answer if refused.
 */
export async function callService(
  cfg: HaConfig,
  domain: string,
  service: string,
  entityId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${cfg.base}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: entityId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Home Assistant said ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

/** What can go on a guest's pass (lib/access.ts): things that open, switch, run or lock. */
const PASS_DOMAINS = ["cover", "lock", "switch", "light", "fan", "button", "input_button", "input_boolean", "script", "scene"];

/**
 * The house's things a pass can work, by name, for an admin choosing a
 * guest's (GET /api/states, filtered). Throws if the house cannot be asked.
 */
export async function passThings(cfg: HaConfig, fetchImpl: typeof fetch = fetch): Promise<{ entity: string; name: string }[]> {
  const res = await fetchImpl(`${cfg.base}/api/states`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Home Assistant said ${res.status}`);
  const states = (await res.json()) as { entity_id?: string; attributes?: { friendly_name?: string } }[];
  return states
    .filter((s) => typeof s.entity_id === "string" && PASS_DOMAINS.includes(s.entity_id.split(".")[0]!))
    .map((s) => ({ entity: s.entity_id!, name: s.attributes?.friendly_name?.trim() || s.entity_id! }))
    .sort((a, b) => a.entity.split(".")[0]!.localeCompare(b.entity.split(".")[0]!) || a.name.localeCompare(b.name))
    .slice(0, 500);
}

/** A rendered condition as yes or no; null when it is neither. */
export function truthy(rendered: string): boolean | null {
  const v = rendered.trim().toLowerCase();
  if (v === "true" || v === "on" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "off" || v === "no" || v === "0") return false;
  return null;
}
