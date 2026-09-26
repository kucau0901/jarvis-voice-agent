import { MAX_STEPS, routerLoop, spokenFailure, type LoopDeps, type LoopRecord, type Reply } from "../src/worker/lib/router-loop.ts";
import { DEFAULT_ROUTER_MODEL } from "../src/worker/lib/router-model.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

type Ev = Record<string, unknown> & { type: string };

const call = (name: string, id = name) => ({ type: "function_call", name, call_id: id, arguments: "{}" });
const reply = (id: string, over: Partial<Reply> = {}): Reply => ({
  id,
  output: [],
  output_text: "",
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 } },
  ...over,
});
const status = (s: number, message = `status ${s}`) => Object.assign(new Error(message), { status: s });

/** A loop with fakes: `answers` is what each model hop returns, or throws. */
function harness(answers: (Reply | Error | ((model: string) => Reply | Error))[], over: Partial<LoopDeps> = {}) {
  const events: Ev[] = [];
  const asks: { model: string; input: unknown; prev: string | undefined }[] = [];
  const counts = { prepare: 0, close: 0, save: 0, runCalls: 0, fallback: 0 };
  const records: LoopRecord[] = [];
  const logs: string[] = [];
  const ac = new AbortController();
  const deps: LoopDeps = {
    sink: { send: (ev) => void events.push(ev as Ev), isClosed: false },
    signal: ac.signal,
    label: "test",
    hasKey: true,
    async prepare() {
      counts.prepare++;
      return { model: "gpt-6-sol", input: "first", save: async () => void counts.save++ };
    },
    async ask(model, input, prev) {
      asks.push({ model, input, prev });
      const a = answers.shift();
      const r = typeof a === "function" ? a(model) : a;
      if (!r) throw new Error("no more answers");
      if (r instanceof Error) throw r;
      return r;
    },
    async runCalls(calls) {
      counts.runCalls++;
      return `outputs of ${calls.map((c) => c.name).join(",")}`;
    },
    close: async () => void counts.close++,
    onFallback: () => void counts.fallback++,
    record: (r) => void records.push(r),
    log: (l) => void logs.push(l),
    ...over,
  };
  return { deps, events, asks, counts, records, logs, ac };
}

const last = (events: Ev[]) => events[events.length - 1]!;

console.log("Home Assistant first");
{
  const h = harness([], {
    assist: async () => ({ handled: true, text: "Main gate is closed", kind: "query_answer", ms: 400 }),
  });
  await routerLoop(h.deps);
  check("Assist's answer is the answer", last(h.events).type === "result" && last(h.events).text === "Main gate is closed" && last(h.events).model === "home-assistant", h.events);
  check("no model, no preparing", h.asks.length === 0 && h.counts.prepare === 0);
  check("recorded as the house's, at no cost", h.records[0]?.by === "home-assistant" && h.records[0].ok && h.records[0].usage.input === 0, h.records);
  check("logged with the surface", h.logs.some((l) => l === "assist (test): query_answer 400ms"), h.logs);
}
{
  const h = harness([reply("r1", { output_text: "391" })], {
    assist: async () => ({ handled: false, reason: "no_match", ms: 380 }),
  });
  await routerLoop(h.deps);
  check("what Assist does not understand goes to the model", last(h.events).text === "391" && h.asks.length === 1, h.events);
}

console.log("\nwithout an OpenAI key");
{
  const h = harness([], { hasKey: false });
  await routerLoop(h.deps);
  check("says only the house can answer", last(h.events).type === "error" && /only the house/.test(String(last(h.events).text)));
  check("and prepares nothing", h.counts.prepare === 0 && h.asks.length === 0);
}

console.log("\na tool, then the answer");
{
  const h = harness([
    reply("r1", { output: [call("home-assistant__ha_search"), call("look_at_camera")] }),
    reply("r2", { output_text: "  The gate is closed.  " }),
  ]);
  await routerLoop(h.deps);
  check("the answer, trimmed", last(h.events).type === "result" && last(h.events).text === "The gate is closed.", last(h.events));
  check("the tools ran once, both together", h.counts.runCalls === 1);
  check("the next hop carries their outputs, chained to the last", h.asks[1]?.input === "outputs of home-assistant__ha_search,look_at_camera" && h.asks[1]?.prev === "r1", h.asks[1]);
  const used = h.events.find((e) => e.type === "used");
  check("the tools used are reported", JSON.stringify(used?.tools) === JSON.stringify(["home-assistant__ha_search", "look_at_camera"]), used);
  check("usage summed over both hops", JSON.stringify(last(h.events).usage) === JSON.stringify({ input: 200, cached: 160, written: 10, output: 20, hops: 2, searches: 0 }), last(h.events).usage);
  check("memory saved and connections closed, once each", h.counts.save === 1 && h.counts.close === 1, h.counts);
  check("recorded with its model, tools and usage", h.records[0]?.by === "gpt-6-sol" && h.records[0].ok && h.records[0].tools.length === 2 && h.records[0].usage.hops === 2, h.records[0]);
  check("one timing line", h.logs.filter((l) => l.startsWith("router timing: prep ")).length === 1, h.logs);
}
{
  const h = harness([reply("r1", { output_text: "   " })]);
  await routerLoop(h.deps);
  check("an empty answer says so", last(h.events).type === "error" && last(h.events).text === "I could not work out an answer to that.");
  check("recorded as not answered", h.records[0]?.ok === false);
}

{
  const h = harness([reply("r1", { output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "message" }], output_text: "Sunny, 31°C" })]);
  await routerLoop(h.deps);
  check("web searches are counted, as OpenAI charges for each", (last(h.events).usage as { searches: number }).searches === 2 && h.records[0]?.usage.searches === 2);
}

console.log("\na model OpenAI refuses");
{
  const h = harness([status(400, "model not found"), reply("r1", { output_text: "ok" })]);
  await routerLoop(h.deps);
  check("the first hop falls back to the default", h.counts.fallback === 1 && h.asks[1]?.model === DEFAULT_ROUTER_MODEL, h.asks);
  check("and answers", last(h.events).type === "result" && last(h.events).model === DEFAULT_ROUTER_MODEL);
}
{
  const h = harness([reply("r1", { output: [call("web")] }), status(400)]);
  await routerLoop(h.deps);
  check("never after a tool has run: the error is said instead", h.counts.fallback === 0 && last(h.events).type === "error", h.events);
}
{
  const h = harness([status(400)], { prepare: async () => ({ model: DEFAULT_ROUTER_MODEL, input: "x", save: async () => {} }) });
  await routerLoop(h.deps);
  check("the default itself refused: no second try", h.asks.length === 1 && last(h.events).type === "error");
}

console.log("\nfailures, said plainly");
{
  const answers = Array.from({ length: MAX_STEPS + 2 }, (_, i) => reply(`r${i}`, { output: [call("web")] }));
  const h = harness(answers);
  await routerLoop(h.deps);
  check(`stops after ${MAX_STEPS} hops`, h.asks.length === MAX_STEPS && /got stuck/.test(String(last(h.events).text)), h.asks.length);
}
{
  const h = harness([status(429, "rate limit reached")]);
  await routerLoop(h.deps);
  check("OpenAI's refusal becomes something true to say", last(h.events).text === "OpenAI is rate-limiting me. Try again in a moment.", last(h.events));
  check("memory is saved even so", h.counts.save === 1);
}
{
  const h = harness([]);
  h.deps.ask = async () => {
    h.ac.abort();
    throw new Error("aborted");
  };
  await routerLoop(h.deps);
  check("cut off: said, and marked", /cut off/.test(String(last(h.events).text)) && last(h.events).aborted === true, last(h.events));
}
{
  const h = harness([], { prepare: async () => { throw new Error("KV down"); } });
  let threw = "";
  await routerLoop(h.deps).catch((e: Error) => { threw = e.message; });
  check("a failure getting ready still closes the connections", threw === "KV down" && h.counts.close === 1);
}
{
  const h = harness([reply("r1", { output_text: "fine" })], {
    prepare: async () => ({ model: "m", input: "x", save: async () => { throw new Error("disk full"); } }),
    record: () => { throw new Error("no room"); },
  });
  let threw = false;
  await routerLoop(h.deps).catch(() => { threw = true; });
  check("a failed save or record never turns an answer into an error", !threw && last(h.events).type === "result");
}

console.log("\nwhat is said when OpenAI fails");
{
  check("credit", /out of credit/.test(spokenFailure("You exceeded your current quota")));
  check("key", /refused my key/.test(spokenFailure("401 Incorrect API key provided")));
  check("down", /not answering properly/.test(spokenFailure("503 Service Unavailable")));
  check("anything else", spokenFailure("banana") === "Something went wrong while I was working that out.");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
