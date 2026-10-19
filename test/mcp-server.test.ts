import { ASK_TOOL, MCP_VERSIONS, mcpReply, type Answer } from "../src/worker/lib/mcp-server.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 240) : "");
  }
}

const asked: string[] = [];
const answering = (a: Answer) => async (q: string) => {
  asked.push(q);
  return a;
};
const fine = answering({ ok: true, text: "The garage door is shut." });
/** id null makes a notification, which has none. */
const rpc = (method: string, params?: unknown, id: number | string | null = 1) => ({
  jsonrpc: "2.0",
  ...(id === null ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});

console.log("starting a connection");
{
  const r = await mcpReply(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok" } }), fine, "9.9.9");
  const res = r?.result as { protocolVersion: string; capabilities: { tools?: object }; serverInfo: { name: string; version: string } };
  check("a version it knows is kept", res.protocolVersion === "2025-06-18", res);
  check("it offers tools", !!res.capabilities.tools, res);
  check("it names itself, with this copy's version", res.serverInfo.name === "jarvis" && res.serverInfo.version === "9.9.9", res);
  check("the id comes back", r?.id === 1 && r?.jsonrpc === "2.0", r);

  const odd = await mcpReply(rpc("initialize", { protocolVersion: "1999-01-01" }), fine, "9.9.9");
  check("an unknown version gets the newest", (odd?.result as { protocolVersion: string }).protocolVersion === MCP_VERSIONS[0], odd);

  check("initialized wants no reply", (await mcpReply(rpc("notifications/initialized", undefined, null), fine, "1")) === null);
  check("a client's answer wants no reply", (await mcpReply({ jsonrpc: "2.0", id: 7, result: {} }, fine, "1")) === null);
  const ping = await mcpReply(rpc("ping", undefined, "p1"), fine, "1");
  check("ping is answered", ping?.id === "p1" && JSON.stringify(ping?.result) === "{}", ping);
}

console.log("the one tool");
{
  const r = await mcpReply(rpc("tools/list"), fine, "1");
  const tools = (r?.result as { tools: { name: string; inputSchema: { required: string[] } }[] }).tools;
  check("only ask_jarvis", tools.length === 1 && tools[0]!.name === "ask_jarvis", tools);
  check("it needs a question", tools[0]!.inputSchema.required.join() === "question", tools);
  check("no Hermes, house or mail tools of their own", !tools.some((t) => t.name !== ASK_TOOL.name));
}

console.log("asking");
{
  asked.length = 0;
  const r = await mcpReply(rpc("tools/call", { name: "ask_jarvis", arguments: { question: "  is the garage shut?  " } }), fine, "1");
  const res = r?.result as { content: { type: string; text: string }[]; isError: boolean };
  check("the question goes to Jarvis, trimmed", asked.join() === "is the garage shut?", asked);
  check("the answer comes back as text", res.content[0]!.type === "text" && res.content[0]!.text === "The garage door is shut.", res);
  check("not an error", res.isError === false, res);

  const failed = await mcpReply(
    rpc("tools/call", { name: "ask_jarvis", arguments: { question: "unlock the car" } }),
    answering({ ok: false, text: "I could not reach the car." }),
    "1",
  );
  const f = failed?.result as { content: { text: string }[]; isError: boolean };
  check("a failure is a tool error, with Jarvis's words", f.isError && f.content[0]!.text === "I could not reach the car.", f);

  asked.length = 0;
  const empty = await mcpReply(rpc("tools/call", { name: "ask_jarvis", arguments: { question: "   " } }), fine, "1");
  check("an empty question is refused without asking", asked.length === 0 && (empty?.result as { isError: boolean }).isError, empty);
  const none = await mcpReply(rpc("tools/call", { name: "ask_jarvis" }), fine, "1");
  check("no arguments at all is refused too", asked.length === 0 && (none?.result as { isError: boolean }).isError, none);

  const other = await mcpReply(rpc("tools/call", { name: "car_command", arguments: {} }), fine, "1");
  check("another tool's name is an error", other?.error?.code === -32602 && asked.length === 0, other);
}

console.log("what is not a request");
{
  check("an unknown method", (await mcpReply(rpc("resources/list"), fine, "1"))?.error?.code === -32601);
  check("a batch is refused", (await mcpReply([rpc("ping")], fine, "1"))?.error?.code === -32600);
  check("not JSON-RPC 2.0", (await mcpReply({ id: 1, method: "ping" }, fine, "1"))?.error?.code === -32600);
  check("not an object", (await mcpReply("ping", fine, "1"))?.error?.code === -32600);
}

console.log("who may reach it");
{
  check("/api/v1/mcp needs ask, as /api/v1/ask does", requiredScope("/api/v1/mcp", "POST") === "ask");
  check("Jarvis's own MCP client list stays owner-only", requiredScope("/api/mcp", "POST") === "owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
