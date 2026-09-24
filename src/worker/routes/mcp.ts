import type { Env } from "../types";
import { json, err, redact } from "../lib/http";
import { readServersForUi, writeServers, expand, expandUrl, headersForTest } from "../lib/config-store";
import { MASK, unexpand } from "../lib/mcp-config";
import { mcpTools } from "../tools/mcp";

/** GET/PUT the MCP server list, and a connectivity test for the settings UI. */
export async function handleMcp(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/mcp/test") {
    if (req.method !== "POST") return err(405, "method not allowed");
    let body: { url?: unknown; headers?: unknown; label?: unknown };
    try {
      body = await req.json();
    } catch {
      return err(400, "body is not valid JSON");
    }
    if (typeof body.url !== "string") return err(400, "url must be https");
    // Expand ${NAME} exactly as a real call would — in the URL as well as the
    // headers. The URL was missed: the seeded Home Assistant server is
    // `${HA_MCP_URL}`, so its Test button reported "url must be https" for a
    // server that was working the whole time.
    const target = expandUrl(body.url, env);
    if (!/^https:\/\//i.test(target)) {
      return err(400, /\$\{/.test(body.url) ? "the Worker secret that URL names is not set" : "url must be https");
    }
    // A masked token is filled from the stored server first. The panel used to
    // leave it out and trust this route to "use the stored one", which it never
    // did — so Test on a server with a pasted token always answered 401.
    const stored = await headersForTest(env, { label: body.label, url: body.url, headers: body.headers });
    const headers = expand(stored, env);
    const result = await probe(target, headers);
    // Nothing secret goes back to the panel in an error: not the expanded URL,
    // which can be the credential itself, and not a header value this route
    // filled in, which the panel was deliberately never given.
    if (!result.ok && result.error) {
      let e = unexpand(result.error, body.url, env as unknown as Record<string, unknown>);
      for (const v of Object.values(headers)) if (v.length >= 8) e = e.split(v).join(MASK);
      result.error = redact(e);
    }
    return json(result);
  }

  if (url.pathname === "/api/mcp/call") {
    // Diagnostic: invoke one tool on one server. Gated by the shared secret like
    // everything else under /api. Useful when a server is reachable from the
    // Worker but not from a laptop, which is the case for Nabu Casa.
    if (req.method !== "POST") return err(405, "method not allowed");
    let body: { url?: unknown; headers?: unknown; tool?: unknown; args?: unknown };
    try {
      body = await req.json();
    } catch {
      return err(400, "body is not valid JSON");
    }
    if (typeof body.url !== "string" || !/^https:\/\//i.test(body.url)) {
      return err(400, "url must be https");
    }
    if (typeof body.tool !== "string") return err(400, "tool is required");

    const { Client, StreamableHTTPClientTransport, SSEClientTransport } = await import(
      "@modelcontextprotocol/client"
    );
    const opts = { requestInit: { headers: expand(body.headers as Record<string, string>, env) } };
    const client = new Client({ name: "jarvis-diag", version: "1.0.0" });
    try {
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(body.url), opts));
      } catch {
        await client.connect(new SSEClientTransport(new URL(body.url), opts));
      }
      const out = await client.callTool({
        name: body.tool,
        arguments: (body.args ?? {}) as Record<string, unknown>,
      });
      const content = (out.content ?? []) as { type: string; text?: string }[];
      return json({
        ok: !out.isError,
        text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await client.close().catch(() => {});
    }
  }

  if (req.method === "GET") {
    const { servers, source } = await readServersForUi(env);
    // Report what the router can actually see right now, not just what is configured.
    let live: { name: string; description: string }[] = [];
    let liveError: string | null = null;
    try {
      const ac = new AbortController();
      live = (await mcpTools(env, ac.signal)).map((t) => ({
        name: t.name,
        description: t.description.slice(0, 160),
      }));
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
    }
    return json({ servers, source, liveTools: live, liveError });
  }

  if (req.method === "PUT") {
    let body: { servers?: unknown };
    try {
      body = await req.json();
    } catch {
      return err(400, "body is not valid JSON");
    }
    const saved = await writeServers(env, body.servers);
    // Stale catalogs would mask a server that just changed.
    await Promise.all(
      saved.map((s) => env.CONFIG.delete(`mcp:catalog:${s.label}`).catch(() => {})),
    );
    return json({ ok: true, servers: saved.length });
  }

  return err(405, "method not allowed");
}

/**
 * Connect, list tools, disconnect — the same stateless path the router uses,
 * so a green test here means the router will work too.
 */
export async function probe(target: string, headers?: Record<string, string>) {
  const { Client, StreamableHTTPClientTransport, SSEClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  const opts = { requestInit: { headers: headers ?? {} } };
  const started = Date.now();

  for (const [kind, make] of [
    ["streamable-http", () => new StreamableHTTPClientTransport(new URL(target), opts)],
    ["sse", () => new SSEClientTransport(new URL(target), opts)],
  ] as const) {
    const client = new Client({ name: "jarvis-probe", version: "1.0.0" });
    try {
      await client.connect(make());
      const { tools } = await client.listTools();
      await client.close().catch(() => {});
      return {
        ok: true as const,
        transport: kind,
        ms: Date.now() - started,
        toolCount: tools.length,
        tools: tools.slice(0, 120).map((t) => t.name),
      };
    } catch (e) {
      await client.close().catch(() => {});
      if (kind === "sse") {
        return {
          ok: false as const,
          ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }
  return { ok: false as const, error: "unreachable" };
}
