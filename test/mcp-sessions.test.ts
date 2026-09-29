import { McpSessions, openWithin } from "../src/worker/lib/mcp-sessions.ts";
import { mcpTools } from "../src/worker/tools/mcp.ts";

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

/** A connect that counts what it opened and closed, and fails when told to. */
function fakeServer() {
  const log = { opened: 0, closed: 0, failNext: false };
  const connect = async (server: { label: string }) => {
    await new Promise((r) => setTimeout(r, 5));
    if (log.failNext) {
      log.failNext = false;
      throw new Error(`cannot reach ${server.label}`);
    }
    const n = ++log.opened;
    return { n, close: async () => { log.closed++; } };
  };
  return { log, connect };
}

const HOUSE = { label: "home-assistant" };
const OTHER = { label: "notes" };

console.log("one connection per server, for one question");
{
  const { log, connect } = fakeServer();
  const s = new McpSessions(connect);
  s.warm(HOUSE);
  const [a, b] = await Promise.all([s.client(HOUSE), s.client(HOUSE)]);
  const c = await s.client(HOUSE);
  check("warming and three calls open it once", log.opened === 1 && a === b && b === c, log);
  await s.client(OTHER);
  check("another server has its own", log.opened === 2, log);
  await s.close();
  check("closing the question closes both", log.closed === 2, log);
  await s.client(HOUSE);
  check("a question after closing connects afresh", log.opened === 3, log);
  await s.close();
}

console.log("\nwhen connecting fails");
{
  const { log, connect } = fakeServer();
  const s = new McpSessions(connect);
  log.failNext = true;
  s.warm(HOUSE);
  let reported = "";
  await s.client(HOUSE).catch((e: Error) => { reported = e.message; });
  check("the first call reports the failed warm-up", reported === "cannot reach home-assistant", reported);
  await new Promise((r) => setTimeout(r, 0));
  const ok = await s.client(HOUSE);
  check("the next call tries again, and gets one", ok.n === 1 && log.opened === 1, log);
  await s.close();
}

console.log("\nwhen a call fails mid-question");
{
  const { log, connect } = fakeServer();
  const s = new McpSessions(connect);
  const first = await s.client(HOUSE);
  s.forget(HOUSE);
  await new Promise((r) => setTimeout(r, 0));
  check("the broken connection is closed", log.closed === 1, log);
  const second = await s.client(HOUSE);
  check("and not handed out again", second !== first && log.opened === 2, log);
  await s.close();
  check("closing the question closes the new one only", log.closed === 2, log);
}

console.log("\nopenWithin: a connection too slow to use is still closed when it comes");
{
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let closed = 0;
  const conn = { close: async () => void closed++ };
  const opens = (ms: number) => new Promise<typeof conn>((r) => setTimeout(() => r(conn), ms));

  check("in time: the connection", (await openWithin(opens(5), 200, "a")) === conn && closed === 0);
  const slow = await openWithin(opens(80), 20, "b").then(() => "opened", (e: Error) => e.message);
  check("too slow: timed out, by name", slow === "timed out: b", slow);
  await wait(120);
  check("and closed when it did open", closed === 1, closed);
  const refused = await openWithin(Promise.reject(new Error("refused")), 50, "c").then(() => "opened", (e: Error) => e.message);
  check("a refusal is the refusal, not a time-out", refused === "refused", refused);
}

console.log("\njust after a new MCP address is saved, a Worker still on the old settings");
{
  // Home Assistant's MCP server, wherever it is asked: each house lists a tool of its own.
  let listedAt: string[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const msg = JSON.parse(String(init.body ?? "{}")) as { id?: number; method?: string };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === "tools/list") listedAt.push(url);
    const result = msg.method === "tools/list"
      ? { tools: [{ name: url.includes("new-house") ? "ha_get_state" : "ha_search", inputSchema: { type: "object" } }] }
      : { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "house", version: "1" } };
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  }) as typeof fetch;
  const m = new Map<string, { v: string; md: unknown }>();
  const CONFIG = {
    get: async () => null,
    getWithMetadata: async (k: string) => ({ value: m.has(k) ? JSON.parse(m.get(k)!.v) : null, metadata: m.get(k)?.md ?? null }),
    put: async (k: string, v: string, o?: { metadata?: unknown }) => void m.set(k, { v, md: o?.metadata ?? null }),
  };
  const oldHouse = { CONFIG, HA_MCP_URL: "https://old-house.example/mcp" } as never;
  const newHouse = { CONFIG, HA_MCP_URL: "https://new-house.example/mcp" } as never;
  const names = async (env: never) => (await mcpTools(env)).map((t) => t.name).join();

  check("lists the old server's tools, and writes them back", (await names(oldHouse)) === "home-assistant__ha_search");
  listedAt = [];
  const now = await names(newHouse);
  check("the new server's are not those: its own are asked for", now === "home-assistant__ha_get_state" && listedAt.length === 1, { now, listedAt });
  await names(newHouse);
  check("…and then kept", listedAt.length === 1, listedAt);
  const meta = JSON.stringify(m.get("mcp:catalog:home-assistant")?.md);
  check("the address is kept only as a hash: it can be the credential", !meta.includes("new-house"), meta);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
