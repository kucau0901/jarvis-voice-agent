import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Env } from "../types";
import { loadServers, type McpServerConfig } from "../lib/config-store";
import type { Tool, ToolContext } from "./registry";

/**
 * Third-party MCP servers, exposed to the delegation router as ordinary tools.
 *
 * MCP v2 (spec 2026-07-28) removed the required handshake and protocol sessions,
 * so a stateless connect → list → call → close per request is the intended shape
 * and no Durable Object is needed to hold anything open.
 */

/** Workers allow 6 concurrent outbound connections; leave headroom for Hermes. */
const MAX_PARALLEL = 4;
const CONNECT_TIMEOUT_MS = 8_000;
const CATALOG_TTL_S = 600;

async function connect(server: McpServerConfig, signal?: AbortSignal): Promise<Client> {
  const client = new Client({ name: "jarvis", version: "1.0.0" });
  const opts = { requestInit: { headers: server.headers ?? {} } };

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), opts));
    return client;
  } catch (e) {
    // Home Assistant's MCP Server integration still speaks the older SSE
    // transport, so falling back is not optional here.
    void e;
    const fallback = new Client({ name: "jarvis", version: "1.0.0" });
    await fallback.connect(new SSEClientTransport(new URL(server.url), opts));
    return fallback;
  }
  void signal;
}

interface CatalogEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Tool catalogs are cached: re-listing on every turn costs latency and CPU. */
async function listTools(env: Env, server: McpServerConfig): Promise<CatalogEntry[]> {
  const key = `mcp:catalog:${server.label}`;
  const cached = await env.CONFIG.get(key, "json").catch(() => null);
  if (cached) return cached as CatalogEntry[];

  const client = await withTimeout(connect(server), CONNECT_TIMEOUT_MS, `connect to ${server.label}`);
  try {
    const { tools } = await client.listTools();
    const catalog: CatalogEntry[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
    // A cache, so a failed write costs a repeat fetch, never the tools. On the
    // free plan KV allows 1,000 writes a day; once they ran out this put threw,
    // and every house tool vanished until the quota reset at 08:00 Malaysia time.
    await env.CONFIG.put(key, JSON.stringify(catalog), { expirationTtl: CATALOG_TTL_S })
      .catch((e) => console.warn("mcp: catalog not cached:", e instanceof Error ? e.message : String(e)));
    return catalog;
  } finally {
    await client.close().catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms)),
  ]);
}


/**
 * Service calls this agent must never make, whatever it is asked.
 *
 * The HA MCP addon exposes 86 tools including ha_restart, ha_write_file and
 * ha_manage_backup; those are kept out by the allowlist in config. But
 * ha_call_service is deliberately allowed — Jarvis cannot control anything
 * without it — and it can reach any service in Home Assistant, including the
 * destructive ones. This is a second line of defence in code rather than in a
 * prompt, because the input here is speech in a moving car: a misheard phrase
 * should not be able to restart the house.
 */
const FORBIDDEN_SERVICES = [
  /^homeassistant\.(restart|stop)$/i,
  /^hassio\./i,
  /^backup\./i,
  /^recorder\.purge/i,
  /^system_log\.clear$/i,
  /^persistent_notification\.dismiss_all$/i,
  /^lock\.open$/i,          // unlatches a door outright; lock/unlock still allowed
];

/** Best-effort extraction of "domain.service" from an arbitrary tool payload. */
function calledService(args: Record<string, unknown>): string | null {
  const direct = typeof args.service === "string" ? args.service : null;
  if (direct) {
    return direct.includes(".") && typeof args.domain === "string"
      ? direct
      : typeof args.domain === "string"
        ? `${args.domain}.${direct}`
        : direct;
  }
  return null;
}

function refuseIfForbidden(tool: string, args: Record<string, unknown>): string | null {
  if (!/call_service|bulk_control/i.test(tool)) return null;
  const svc = calledService(args);
  if (!svc) return null;
  if (FORBIDDEN_SERVICES.some((re) => re.test(svc))) {
    return `Refused: ${svc} is not something I will do from the car. Do that at home directly.`;
  }
  return null;
}

/** Namespaced so two servers exposing `get_state` cannot collide. */
const toolName = (label: string, name: string) =>
  `${label}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

export async function mcpTools(env: Env, signal: AbortSignal): Promise<Tool[]> {
  const servers = await loadServers(env);
  if (!servers.length) return [];

  const out: Tool[] = [];
  for (let i = 0; i < servers.length; i += MAX_PARALLEL) {
    const batch = servers.slice(i, i + MAX_PARALLEL);
    const results = await Promise.allSettled(
      batch.map(async (server) => ({ server, catalog: await listTools(env, server) })),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        // One unreachable server must not take the others, or Hermes, with it.
        console.warn("mcp: listTools failed:", String(r.reason).slice(0, 200));
        continue;
      }
      const { server, catalog } = r.value;
      const allowed = server.allowedTools?.length ? new Set(server.allowedTools) : null;

      for (const entry of catalog) {
        if (allowed && !allowed.has(entry.name)) continue;
        out.push({
          name: toolName(server.label, entry.name),
          description:
            `[${server.spokenAs ?? server.label}] ${entry.description ?? entry.name}` +
            (server.hint ? ` — ${server.hint}` : ""),
          parameters: normaliseSchema(entry.inputSchema),
          strict: false,
          run: (args, ctx) => callRemote(server, entry.name, args, ctx),
        });
      }
    }
  }
  void signal;
  return out;
}

/**
 * Pass the server's own schema through, only ensuring it is a usable object
 * schema. Tools are registered non-strict, so nothing here needs reshaping —
 * an earlier version forced `required` and `additionalProperties` and was
 * rejected for nested objects it had not touched.
 */
function normaliseSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    return { type: "object", properties: {} };
  }
  return { ...schema, properties: (schema.properties as Record<string, unknown>) ?? {} };
}

async function callRemote(
  server: McpServerConfig,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const refusal = refuseIfForbidden(name, args);
  if (refusal) {
    console.warn(`mcp: refused ${name} ${JSON.stringify(args).slice(0, 120)}`);
    return refusal;
  }

  // Spoken to the driver, so it uses the house's name rather than the
  // integration's. The prompt forbids naming the system; handing it the label
  // and asking it to relay the note was undoing that instruction at the source.
  ctx.progress(`checking ${server.spokenAs ?? server.label}`);
  const client = await withTimeout(connect(server), CONNECT_TIMEOUT_MS, `connect to ${server.label}`);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (result.isError) return `${server.label} reported an error: ${text || "no detail"}`;
    return text || "That returned nothing.";
  } finally {
    await client.close().catch(() => {});
  }
}
