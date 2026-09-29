import type { Env } from "../types.ts";
import seed from "../../../config/mcp-servers.json" with { type: "json" };
import {
  expandHeaderTemplates,
  expandUrlTemplate,
  leftBehind,
  maskForUi,
  resolveConfigured,
  restoreMasked,
  sane,
  type ConfigSource,
  type McpServerConfig,
} from "./mcp-config.ts";

/**
 * MCP server configuration.
 *
 * The file in the repo seeds it; a KV entry written from the settings UI
 * overrides it, so servers can be added from a phone without a redeploy.
 */
export type { McpServerConfig, ConfigSource } from "./mcp-config.ts";

const KV_KEY = "config:mcp-servers";

/**
 * `${NAME}` in a header value is filled from Worker secrets, never stored
 * inline: for a server at `url` (expanded), and never with one of Jarvis's own
 * keys that is not already sent there (mcp-config.ts fillable()).
 */
export function expand(headers: Record<string, string> | undefined, env: Env, url: string): Record<string, string> {
  const out = expandHeaderTemplates(headers, env as unknown as Record<string, unknown>, url);
  // Drop any header whose secret is missing, rather than sending "Bearer ".
  for (const [k, v] of Object.entries(out)) {
    if (/^\s*(Bearer|Basic)?\s*$/i.test(v)) delete out[k];
  }
  return out;
}

/** A server URL with its `${NAME}` placeholders filled from Worker secrets. */
export function expandUrl(url: string, env: Env): string {
  return expandUrlTemplate(url, env as unknown as Record<string, unknown>);
}

export async function loadServers(env: Env): Promise<McpServerConfig[]> {
  // Same resolution as the panel's, by construction: see lib/mcp-config.ts.
  const configured = resolveConfigured(await readStored(env), seed.servers).servers;

  return configured
    .map((s) => {
      const url = expandUrl(s.url, env);
      return { ...s, url, headers: expand(s.headers, env, url) };
    })
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
 * `null` when one cannot be: the server has moved to another host, and its
 * token is not sent there until it is typed again (mcp-config.ts restoreMasked()).
 */
export async function headersForTest(
  env: Env,
  server: { label?: unknown; url: string; headers?: unknown },
): Promise<Record<string, string> | null> {
  const headers =
    server.headers && typeof server.headers === "object"
      ? (server.headers as Record<string, string>)
      : {};
  const label = typeof server.label === "string" ? server.label.trim() : "";
  const incoming = [{ label, url: server.url, headers }];
  const restored = restoreMasked(incoming, await readConfigured(env), (u) => expandUrl(u, env));
  return leftBehind(incoming, restored).length ? null : restored[0]!.headers ?? {};
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

/** Saves the list; `retype` names the servers whose token stayed at their old host. */
export async function writeServers(env: Env, raw: unknown): Promise<{ saved: McpServerConfig[]; retype: string[] }> {
  // Against what is in force, not merely what is saved: when the panel is
  // showing the repo defaults, those are what its masks stand for.
  const incoming = sane(raw);
  const saved = restoreMasked(incoming, await readConfigured(env), (u) => expandUrl(u, env));
  await env.CONFIG.put(KV_KEY, JSON.stringify({ servers: saved }));
  return { saved, retype: leftBehind(incoming, saved) };
}
