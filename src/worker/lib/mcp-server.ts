/**
 * Jarvis as an MCP server, for assistants that connect to one: Grok's custom
 * connectors (grok.com/connectors), xAI's remote MCP tool, and any other MCP
 * client (routes/v1.ts, POST /api/v1/mcp).
 *
 * One tool, ask_jarvis, which is /api/v1/ask under another name: the router,
 * memory, the conversation across devices and every limit are the device's
 * own, and what it may reach is the token's scopes. The assistant connecting
 * is one more caller in front of the router, so it decides nothing about what
 * the house, the car or the mail may do.
 *
 * Streamable HTTP without the stream: each POST carries one JSON-RPC message
 * and is answered with one JSON object, and no session is kept.
 */

/** Newest first. A client asking for one of these gets it; any other, the newest. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface Answer {
  ok: boolean;
  text: string;
}

type Id = string | number;

export interface RpcReply {
  jsonrpc: "2.0";
  id: Id | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const ASK_TOOL = {
  name: "ask_jarvis",
  title: "Ask Jarvis",
  description:
    "Ask Jarvis, the user's own assistant, to answer or do something for them. It knows " +
    "what the user asked it to remember and can reach whatever this connection was granted: " +
    "their house, car, calendar, mail, music, routines and notes, and, where it is set up, " +
    "their own agent at home, which changes code, websites and apps and works with files and " +
    "programs on their computer: ask Jarvis for that too. Ask in plain words, one " +
    "request at a time, complete on its own (it does not see this conversation). It answers " +
    "in a few sentences and says so when something is out of its reach.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The request, as the user would say it, e.g. 'is the garage door shut?'",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

const fail = (id: Id | null, code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: Id, result: unknown): RpcReply => ({ jsonrpc: "2.0", id, result });
const said = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], isError });

/**
 * The reply to one JSON-RPC message, or null for one that wants none (a
 * notification, or the client's answer to something). `ask` runs a question.
 */
export async function mcpReply(
  msg: unknown,
  ask: (question: string) => Promise<Answer>,
  version: string,
): Promise<RpcReply | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "one JSON-RPC message per request");
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.jsonrpc !== "2.0") return fail(id, -32600, "not a JSON-RPC 2.0 request");
  // The client's answer to something, or a notification: neither is replied to.
  if (!("method" in m) || id === null) return null;
  if (typeof m.method !== "string") return fail(id, -32600, "method must be a string");
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;

  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "jarvis", title: "Jarvis", version },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: [ASK_TOOL] });
    case "tools/call": {
      if (params.name !== ASK_TOOL.name) return fail(id, -32602, `no tool ${String(params.name)}`);
      const args = (params.arguments ?? {}) as { question?: unknown };
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return ok(id, said("Nothing was asked: question is required.", true));
      const a = await ask(question);
      return ok(id, said(a.text || (a.ok ? "Done." : "Something went wrong."), !a.ok));
    }
    default:
      return fail(id, -32601, `no method ${m.method}`);
  }
}
