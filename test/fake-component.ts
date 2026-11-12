/**
 * A made-up component's MCP server, for tests: hand-written JSON-RPC over one
 * POST each, as lib/mcp-server.ts is, answering the real MCP client in
 * process through `fetch`. It can be told to misbehave (a redirect, an error
 * page that quotes its key, words meant for the model), which the example in
 * docs/components/school never does.
 */

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

/** One request as it reached the component: what was asked, and what came with it. */
export interface Seen {
  method: string;
  /** The JSON-RPC method, for a POST. */
  rpc?: string;
  tool?: string;
  args?: Record<string, unknown>;
  authorization: string | null;
  person: string | null;
  /** How fetch was told to treat a redirect. */
  redirect?: string;
}

export interface FakeComponent {
  url: string;
  tools: FakeTool[];
  /** Its `jarvis://manifest` resource: text, null for none, or undefined when it has no resources at all. */
  manifest?: string | null;
  /** What it tells a client to do, in its answer to initialize: nothing here may read it. */
  instructions?: string;
  /** It does not say it has tools at all. */
  noTools?: true;
  seen: Seen[];
  /** What a tool call answers. Throwing answers with a JSON-RPC error. */
  answer(tool: string, args: Record<string, unknown>): { text: string; isError?: boolean };
  /** Answered to every request instead, while set: a redirect, an error page. */
  instead?: (() => Response) | null;
}

const str = { type: "string" };
export const schemaOf = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, str])), required: names });

/** A school, as components.test.ts and component-reports.test.ts plug it in. */
export function fakeSchool(url = "https://school.example.com/mcp"): FakeComponent {
  return {
    url,
    tools: [
      { name: "get_absent", description: "Who is absent on a date.", inputSchema: schemaOf("date"), annotations: { readOnlyHint: true } },
      { name: "get_timetable", description: "A teacher's timetable for a date.", inputSchema: schemaOf("teacher", "date") },
      { name: "find_relief", description: "Relief plans for a date's absences.", inputSchema: schemaOf("date"), annotations: { readOnlyHint: true } },
      { name: "apply_relief", description: "Apply a relief plan for a date.", inputSchema: schemaOf("date", "plan"), annotations: { readOnlyHint: false } },
    ],
    manifest: JSON.stringify({ jarvis: 1, events: [{ type: "leave_filed", says: "A teacher filed leave" }] }),
    seen: [],
    answer: (tool, args) => ({ text: `${tool} ${JSON.stringify(args)}` }),
  };
}

const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const refuse = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

async function answer(c: FakeComponent, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const seen: Seen = { method: init.method ?? "GET", authorization: headers.get("authorization"), person: headers.get("x-jarvis-person"), ...(init.redirect ? { redirect: init.redirect } : {}) };
  c.seen.push(seen);
  if (c.instead) return c.instead();
  // No stream of its own to offer: the client then reads each answer from its POST.
  if (seen.method !== "POST") return new Response(null, { status: 405 });
  const msg = JSON.parse(String(init.body ?? "{}")) as { id?: unknown; method?: string; params?: Record<string, unknown> };
  seen.rpc = msg.method;
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: params.protocolVersion,
        capabilities: { ...(c.noTools ? {} : { tools: {} }), ...(c.manifest !== undefined ? { resources: {} } : {}) },
        serverInfo: { name: "fake", version: "1.2.3" },
        ...(c.instructions ? { instructions: c.instructions } : {}),
      });
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: c.tools.map((t) => ({ inputSchema: { type: "object", properties: {} }, ...t })) });
    case "resources/read":
      if (params.uri !== "jarvis://manifest" || typeof c.manifest !== "string") return refuse(msg.id, -32602, "Resource not found");
      return reply(msg.id, { contents: [{ uri: params.uri, mimeType: "application/json", text: c.manifest }] });
    case "tools/call": {
      seen.tool = String(params.name);
      seen.args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const said = c.answer(seen.tool, seen.args);
        return reply(msg.id, { content: [{ type: "text", text: said.text }], isError: said.isError === true });
      } catch (e) {
        return refuse(msg.id, -32603, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return refuse(msg.id, -32601, `no method ${msg.method}`);
  }
}

/**
 * These components in place of the network, until the returned function is
 * called: a request anywhere else fails, and is kept in `strays`.
 */
export function serve(parts: readonly FakeComponent[], strays: string[] = []): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const c = parts.find((p) => p.url === url);
    if (c) return answer(c, init);
    strays.push(url);
    throw new Error(`nothing is at ${url}`);
  }) as typeof fetch;
  return () => void (globalThis.fetch = real);
}
