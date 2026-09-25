import { McpSessions } from "../src/worker/lib/mcp-sessions.ts";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
