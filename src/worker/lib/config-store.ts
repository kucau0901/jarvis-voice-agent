import type { Env } from "../types";
import seed from "../../../config/mcp-servers.json";
import {
  expandTemplate,
  maskForUi,
  resolveConfigured,
  restoreMasked,
  sane,
  type ConfigSource,
  type McpServerConfig,
} from "./mcp-config";

/**
 * MCP server configuration.
 *
 * The file in the repo seeds it; a KV entry written from the settings UI
 * overrides it, so servers can be added from a phone without a redeploy.
 */
export type { McpServerConfig, ConfigSource } from "./mcp-config";

const KV_KEY = "config:mcp-servers";

/** `${NAME}` in a header value is filled from Worker secrets, never stored inline. */
export function expand(headers: Record<string, string> | undefined, env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const val = (env as unknown as Record<string, string | undefined>)[name];
      return typeof val === "string" ? val : "";
    });
  }
  // Drop any header whose secret is missing, rather than sending "Bearer ".
  for (const [k, v] of Object.entries(out)) {
    if (/^\s*(Bearer|Basic)?\s*$/i.test(v)) delete out[k];
  }
  return out;
}

/** A server URL with its `${NAME}` placeholders filled from Worker secrets. */
export function expandUrl(url: string, env: Env): string {
  return expandTemplate(url, env as unknown as Record<string, unknown>);
}

export async function loadServers(env: Env): Promise<McpServerConfig[]> {
  // Same resolution as the panel's, by construction: see lib/mcp-config.ts.
  const configured = resolveConfigured(await readStored(env), seed.servers).servers;

  return configured
    .map((s) => ({ ...s, url: expandUrl(s.url, env), headers: expand(s.headers, env) }))
    // A server whose URL secret is unset would otherwise be called with a
    // half-expanded address.
    .filter((s) => s.enabled && /^https:\/\//i.test(s.url));
}

/** A KV failure reads as "nothing saved", so the seed applies rather than nothing. */
async function readStored(env: Env): Promise<unknown> {
  try {
    return await env.CONFIG.get(KV_KEY, "json");
  } catch {
    return null;
  }
}

/** The list in force, secrets and placeholders as stored — never sent to a client. */
async function readConfigured(env: Env): Promise<McpServerConfig[]> {
  return resolveConfigured(await readStored(env), seed.servers).servers;
}

/**
 * Header values for a Test from the panel, with any masked one filled from
 * the stored server — the panel cannot send a secret it was never given.
 */
export async function headersForTest(
  env: Env,
  server: { label?: unknown; url: string; headers?: unknown },
): Promise<Record<string, string>> {
  const headers =
    server.headers && typeof server.headers === "object"
      ? (server.headers as Record<string, string>)
      : {};
  const label = typeof server.label === "string" ? server.label.trim() : "";
  const [restored] = restoreMasked([{ label, url: server.url, headers }], await readConfigured(env));
  return restored!.headers ?? {};
}

/**
 * What the settings panel reads: the list the router is actually using, and
 * where it came from. Never returns a resolved header value.
 */
export async function readServersForUi(
  env: Env,
): Promise<{ servers: McpServerConfig[]; source: ConfigSource }> {
  const { servers, source } = resolveConfigured(await readStored(env), seed.servers);
  return { servers: maskForUi(servers), source };
}

export async function writeServers(env: Env, raw: unknown): Promise<McpServerConfig[]> {
  // Against what is in force, not merely what is saved: when the panel is
  // showing the repo defaults, those are what its masks stand for.
  const list = restoreMasked(sane(raw), await readConfigured(env));
  await env.CONFIG.put(KV_KEY, JSON.stringify({ servers: list }));
  return list;
}
