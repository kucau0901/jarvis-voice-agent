import { Client, ProtocolError, ProtocolErrorCode, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Env } from "../types.ts";
import { loadServers, type McpServerConfig } from "../lib/config-store.ts";
import type { Listed } from "../lib/components.ts";
import type { Tool, ToolContext } from "./registry.ts";
import { McpSessions, openWithin } from "../lib/mcp-sessions.ts";
import { sha256Hex } from "../lib/devices.ts";
import { asQuotedData } from "../lib/quote.ts";

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
/**
 * How long a tool catalog is trusted. Listing Home Assistant's tools sends every
 * description and schema, and over a slow link home that took about 10 s
 * (measured 26 Sep 2026). When the copy lasted only ten minutes, most questions
 * asked now and then paid it before Jarvis could start.
 *
 * Now: fresh for ten minutes; after that still used at once, and a new copy
 * fetched after the answer where the caller can wait for it (waitUntil); where
 * nothing can, refetched first only once it is a day old. Kept a week, so a
 * server taken out of settings does not linger for ever. Changing the servers
 * in settings clears it outright (routes/mcp.ts).
 */
const CATALOG_FRESH_MS = 10 * 60_000;
const CATALOG_STALE_MS = 24 * 3_600_000;
const CATALOG_KEEP_S = 7 * 24 * 3_600;

/**
 * What a connection is made to: a server from the MCP list, or a component
 * (tools/components.ts). A component's key, and who is asking, go with every
 * request to it, so no redirect is followed, and it speaks Streamable HTTP
 * or nothing: the older transport's first request would follow one.
 */
export interface Remote extends McpServerConfig {
  component?: true;
}

async function connect(server: Remote): Promise<Client> {
  const client = new Client({ name: "jarvis", version: "1.0.0" });
  // The SDK hands requestInit to fetch with every request it makes.
  const opts = { requestInit: { headers: server.headers ?? {}, ...(server.component ? { redirect: "manual" as const } : {}) } };

  const t0 = Date.now();
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), opts));
    console.log(`mcp: ${server.label} connected (http) ${Date.now() - t0}ms`);
    return client;
  } catch (e) {
    if (server.component) throw e;
    // Home Assistant's MCP Server integration still speaks the older SSE
    // transport, so falling back is not optional here.
    const failedAfter = Date.now() - t0;
    const fallback = new Client({ name: "jarvis", version: "1.0.0" });
    await fallback.connect(new SSEClientTransport(new URL(server.url), opts));
    console.log(`mcp: ${server.label} connected (sse, http failed after ${failedAfter}ms) ${Date.now() - t0}ms`);
    return fallback;
  }
}

interface CatalogEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * When a catalog was listed, and at what address: its SHA-256, since the
 * address can be the credential. A catalog listed at another address is not
 * used. For some seconds after a new address is saved, a Worker still on the
 * old settings (lib/settings-store.ts) can list the old server and write it
 * back, and it would be offered for up to a day.
 */
interface CatalogMeta {
  at?: number;
  urlSha256?: string;
}

/**
 * A question's connections, one per server (lib/mcp-sessions.ts). A component
 * and a server from the MCP list never share one, even under the same label.
 */
export const mcpSessions = () =>
  new McpSessions<Remote, Client>(
    (server) => openWithin(connect(server), CONNECT_TIMEOUT_MS, `connect to ${server.label}`),
    (server) => (server.component ? `component:${server.label}` : server.label),
  );

/** Where a component says which events it reports: an MCP resource of this address (docs/components.md). */
export const MANIFEST_URI = "jarvis://manifest";

/**
 * What a server offers, asked now and kept nowhere: its tools, and its
 * `jarvis://manifest` resource if it has one (lib/components.ts). For a check
 * from Settings → Components, where an admin reads every word of it before
 * any is used. Never its `instructions`, which nothing here reads.
 */
export async function listRemote(server: Remote): Promise<Listed> {
  const client = await openWithin(connect(server), CONNECT_TIMEOUT_MS, `connect to ${server.label}`);
  try {
    const offers = client.getServerCapabilities();
    if (!offers?.tools) throw new Error("it does not say it has tools (capabilities.tools in its answer to initialize)");
    const { tools } = await client.listTools();
    let manifest: string | null = null;
    if (offers.resources) {
      const read = await client.readResource({ uri: MANIFEST_URI }).catch((e: unknown) => {
        // No such resource: it has no manifest, which it need not. Anything else is a check that failed.
        if (e instanceof ProtocolError && (e.code === ProtocolErrorCode.InvalidParams || e.code === ProtocolErrorCode.ResourceNotFound)) return null;
        throw e;
      });
      const first = read?.contents[0];
      manifest = first && "text" in first && typeof first.text === "string" ? first.text : null;
    }
    return {
      url: server.url,
      version: client.getServerVersion()?.version,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> | undefined, readOnly: t.annotations?.readOnlyHint })),
      manifest,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Tool catalogs are cached: re-listing on every turn costs latency and CPU. See CATALOG_FRESH_MS. */
async function listTools(
  env: Env,
  server: McpServerConfig,
  sessions?: McpSessions<Remote, Client>,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<CatalogEntry[]> {
  const hit = await env.CONFIG
    .getWithMetadata<CatalogEntry[], CatalogMeta>(catalogKey(server), "json")
    .catch(() => null);
  if (hit?.value && hit.metadata?.urlSha256 === (await sha256Hex(server.url))) {
    const age = Date.now() - (hit.metadata?.at ?? 0);
    if (age < CATALOG_FRESH_MS) return hit.value;
    if (waitUntil) {
      // Its own connection: this question's are closed when it has answered.
      waitUntil(fetchCatalog(env, server).catch((e) =>
        console.warn("mcp: catalog not refreshed:", e instanceof Error ? e.message : String(e))));
      return hit.value;
    }
    if (age < CATALOG_STALE_MS) return hit.value;
  }
  return fetchCatalog(env, server, sessions);
}

const catalogKey = (server: McpServerConfig) => `mcp:catalog:${server.label}`;

async function fetchCatalog(
  env: Env,
  server: McpServerConfig,
  sessions?: McpSessions<Remote, Client>,
): Promise<CatalogEntry[]> {
  const t0 = Date.now();
  const client = sessions
    ? await sessions.client(server)
    : await openWithin(connect(server), CONNECT_TIMEOUT_MS, `connect to ${server.label}`);
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
    const meta: CatalogMeta = { at: Date.now(), urlSha256: await sha256Hex(server.url) };
    await env.CONFIG.put(catalogKey(server), JSON.stringify(catalog), {
      expirationTtl: CATALOG_KEEP_S,
      metadata: meta,
    }).catch((e) => console.warn("mcp: catalog not cached:", e instanceof Error ? e.message : String(e)));
    console.log(`mcp: ${server.label} catalog fetched ${Date.now() - t0}ms`);
    return catalog;
  } catch (e) {
    sessions?.forget(server);
    throw e;
  } finally {
    if (!sessions) await client.close().catch(() => {});
  }
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
export function calledService(args: Record<string, unknown>): string | null {
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

/** Every "domain.service" anywhere in an automation's or script's config: what it would call, whenever it runs. */
function servicesIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (/^[a-z_]+\.[a-z0-9_]+$/i.test(v.trim())) out.push(v.trim());
  } else if (Array.isArray(v)) {
    for (const x of v) servicesIn(x, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) servicesIn(x, out);
  }
  return out;
}

export function refuseIfForbidden(tool: string, args: Record<string, unknown>): string | null {
  // Written into Home Assistant, a forbidden service would run later, whenever the automation fires: refused here too.
  if (/config_set_(automation|script)/i.test(tool)) {
    const bad = servicesIn(args).find((s) => FORBIDDEN_SERVICES.some((re) => re.test(s)));
    return bad ? `Refused: an automation that calls ${bad} is not something I will set up. Do that at home directly.` : null;
  }
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

/**
 * With `sessions`, calls share one connection per server and it starts opening
 * now (lib/mcp-sessions.ts). With `waitUntil`, an old catalog is refreshed after
 * the answer rather than before it.
 */
export async function mcpTools(
  env: Env,
  sessions?: McpSessions<Remote, Client>,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Tool[]> {
  const servers = await loadServers(env);
  if (!servers.length) return [];

  const out: Tool[] = [];
  for (let i = 0; i < servers.length; i += MAX_PARALLEL) {
    const batch = servers.slice(i, i + MAX_PARALLEL);
    const results = await Promise.allSettled(
      batch.map(async (server) => ({ server, catalog: await listTools(env, server, sessions, waitUntil) })),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        // One unreachable server must not take the others, or Hermes, with it.
        console.warn("mcp: listTools failed:", String(r.reason).slice(0, 200));
        continue;
      }
      const { server, catalog } = r.value;
      const allowed = server.allowedTools?.length ? new Set(server.allowedTools) : null;
      sessions?.warm(server);

      for (const entry of catalog) {
        if (allowed && !allowed.has(entry.name)) continue;
        out.push(remoteTool(server, entry, sessions));
      }
    }
  }
  return out;
}

/** One of a server's tools, as the router is offered it: named by the server's label, and run at the server. */
export function remoteTool(server: Remote, entry: CatalogEntry, sessions?: McpSessions<Remote, Client>): Tool {
  return {
    name: toolName(server.label, entry.name),
    description:
      `[${server.spokenAs ?? server.label}] ${entry.description ?? entry.name}` +
      (server.hint ? ` — ${server.hint}` : ""),
    parameters: normaliseSchema(entry.inputSchema),
    strict: false,
    run: (args, ctx) => callRemote(server, entry.name, args, ctx, sessions),
  };
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
  server: Remote,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  sessions?: McpSessions<Remote, Client>,
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
  const client = sessions
    ? await sessions.client(server)
    : await openWithin(connect(server), CONNECT_TIMEOUT_MS, `connect to ${server.label}`);
  const t0 = Date.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    console.log(`mcp: ${server.label} ${name} ${Date.now() - t0}ms`);
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    // What the server returns can carry text written by others (a calendar entry, a media title): quoted as data.
    const said = (t: string) => asQuotedData(`${server.label} result`, t, `THE ${server.label.toUpperCase()} SERVER`);
    if (result.isError) return `${server.label} reported an error: ${text ? said(text) : "no detail"}`;
    ctx.done?.();
    return text ? said(text) : "That returned nothing.";
  } catch (e) {
    // Not retried here: the call may already have acted. The next call connects afresh.
    sessions?.forget(server);
    throw e;
  } finally {
    if (!sessions) await client.close().catch(() => {});
  }
}
