// A question answered on the owner's ChatGPT plan (lib/openai-auth.ts, lib/router.ts):
// what is sent to OpenAI's plan route, and falling back to the key at the plan's limit.
import { run } from "../src/worker/lib/router.ts";
import { lookAtPage } from "../src/worker/lib/page-look.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 400) : "");
  }
}

type Body = Record<string, unknown> & { input: Record<string, unknown>[]; tools: Record<string, unknown>[] };
type Answer = { error?: { status: number; code: string } } | { items: Record<string, unknown>[] };

const kv = new Map<string, string>();
const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async () => {}, list: async () => ({ keys: [] }) };

/** One question: the plan's and the key's answers in turn, and what was sent to each. */
async function ask(opts: { plan: boolean; plans: Answer[]; keys?: Answer[]; fallback?: "0" | "1" }) {
  const sent: { by: "plan" | "key"; body: Body }[] = [];
  const failed: string[] = [];
  const recorded: { by: string }[] = [];
  const stub = new Proxy({}, {
    get: (_t, m) =>
      m === "then"
        ? undefined
        : async (...args: unknown[]) => {
            if (m === "chatgptToken") return opts.plan ? { token: "at_plan", model: null } : null;
            if (m === "chatgptFailed") return (failed.push(String(args[0])), { first: false });
            if (m === "recordUsage") return void recorded.push(args[0] as { by: string });
            return undefined;
          },
  });
  const env = { CONFIG, OPENAI_API_KEY: "sk-test", TIMEZONE: "Asia/Kuala_Lumpur", STATE: { idFromName: () => "j", get: () => stub }, ...(opts.fallback ? { CHATGPT_FALLBACK: opts.fallback } : {}) };
  const plans = [...opts.plans];
  const keys = [...(opts.keys ?? [])];
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.endsWith("/responses")) throw new Error(`nothing here reaches the network: ${u}`);
    const headers = new Headers(init?.headers);
    const by = headers.get("authorization") === "Bearer at_plan" ? "plan" : "key";
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push({ by, body });
    const a = (by === "plan" ? plans : keys).shift();
    if (!a) throw new Error(`no ${by} answer left`);
    if ("error" in a && a.error) return Response.json({ error: { message: a.error.code, type: "x", code: a.error.code } }, { status: a.error.status });
    const items = (a as { items: Record<string, unknown>[] }).items;
    const id = `resp_${++n}`;
    const usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    if (by === "key") {
      const text = items.flatMap((i) => (i.type === "message" ? (i.content as { text: string }[]).map((c) => c.text) : [])).join("");
      return Response.json({ id, object: "response", status: "completed", output: items, output_text: text, usage });
    }
    // As the plan's route sends it: items as each is done, and an empty output at the end.
    const events = [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      ...items.map((item, i) => ({ type: "response.output_item.done", output_index: i, item })),
      { type: "response.completed", response: { id, object: "response", status: "completed", output: [], usage } },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const said: Record<string, unknown>[] = [];
  const sink = { send: (ev: Record<string, unknown>) => void said.push(ev), get isClosed() { return false; } };
  try {
    await run(env as never, [{ role: "user", text: "what did I save about the dentist?" }], sink as never, new AbortController().signal, ["*"] as never, {});
  } finally {
    globalThis.fetch = realFetch;
  }
  const result = said.find((e) => e.type === "result" || e.type === "error");
  return { sent, failed, recorded, result, said };
}

const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "recall", namespace: "jarvis", arguments: JSON.stringify({ query: "dentist" }), status: "completed" };
const thought = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
const answer = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

console.log("a question on the plan");
{
  const r = await ask({ plan: true, plans: [{ items: [thought, call] }, { items: [answer("Your dentist is on Friday.")] }] });
  const [one, two] = r.sent;
  check("answered, by the plan alone", r.result?.type === "result" && r.result.text === "Your dentist is on Friday." && r.sent.every((s) => s.by === "plan") && r.sent.length === 2, r.result);
  check("streamed, not stored, no chaining by id",
    r.sent.every((s) => s.body.stream === true && s.body.store === false && !("previous_response_id" in s.body) && !("prompt_cache_options" in s.body)));
  check("the tools in one namespace, web search beside them, reasoning carried",
    one!.body.tools[0]!.type === "namespace" && one!.body.tools[0]!.name === "jarvis" && Array.isArray(one!.body.tools[0]!.tools) &&
    one!.body.tools.some((t) => t.type === "web_search") && JSON.stringify(one!.body.include) === '["reasoning.encrypted_content"]', one!.body.tools.map((t) => t.type));
  check("no prompt cache marker in what the plan is sent", !JSON.stringify(r.sent.map((s) => s.body.input)).includes("prompt_cache_breakpoint"));
  const second = two!.body.input;
  check("the second hop carries the whole exchange: the question, the model's own items, the tool's output",
    second.length === one!.body.input.length + 3 && second.some((i) => i.type === "reasoning") && second.some((i) => i.type === "function_call" && i.namespace === "jarvis") &&
    second.at(-1)!.type === "function_call_output" && second.at(-1)!.call_id === "call_1", second.slice(-3));
  check("counted in Usage as the plan's", r.recorded[0]?.by === "chatgpt:gpt-6-luna", r.recorded);
  const toolEvents = r.said.filter((e) => e.type === "tool");
  check("each tool event carries its call, for typed chat's pills (src/app/steps.ts)",
    toolEvents.length === 2 && toolEvents[0]!.phase === "start" && toolEvents.every((e) => e.name === "recall" && e.id === "call_1") && toolEvents[1]!.phase === "done", toolEvents);
}

console.log("the plan's limit, part way through");
{
  const r = await ask({
    plan: true,
    plans: [{ items: [call] }, { error: { status: 429, code: "subscription_sharing_usage_limit_exceeded" } }],
    keys: [{ items: [answer("From the key: Friday.")] }],
  });
  const key = r.sent.find((s) => s.by === "key")!;
  check("noted as the limit", r.failed.join() === "limit", r.failed);
  check("the key finishes the question", r.result?.type === "result" && r.result.text === "From the key: Friday.", r.result);
  check("with what the plan had done, the tool not run again",
    r.sent.length === 3 && key.body.input.filter((i) => i.type === "function_call_output").length === 1 && !("previous_response_id" in key.body), key.body.input.slice(-2));
  check("made fit for the key: no namespace, no ids, flat tools",
    key.body.input.some((i) => i.type === "function_call" && !("namespace" in i) && !("id" in i)) && !key.body.tools.some((t) => t.type === "namespace"));
  check("counted in Usage at the key's price", r.recorded[0]?.by === "gpt-6-luna", r.recorded);
}

console.log("the limit, with the key not to be used");
{
  const r = await ask({ plan: true, fallback: "0", plans: [{ error: { status: 429, code: "subscription_sharing_usage_limit_exceeded" } }] });
  check("says the plan's limit is reached, and nothing goes to the key",
    r.result?.type === "error" && /usage limit is reached/.test(String(r.result.text)) && !r.sent.some((s) => s.by === "key"), r.result);
}

console.log("another error is not a reason to spend the key");
{
  const r = await ask({ plan: true, plans: [{ error: { status: 500, code: "server_error" } }] });
  check("no fallback, no note", r.result?.type === "error" && !r.sent.some((s) => s.by === "key") && !r.failed.length, r.result);
}

console.log("no plan: the key, as before");
{
  const r = await ask({ plan: false, plans: [], keys: [{ items: [call] }, { items: [answer("Friday.")] }] });
  check("chained by id and stored, the tools flat",
    r.result?.text === "Friday." && r.sent.every((s) => s.by === "key" && s.body.store === true && !s.body.stream) &&
    r.sent[1]!.body.previous_response_id === "resp_1" && !r.sent[0]!.body.tools.some((t) => t.type === "namespace"), r.sent.map((s) => s.body.previous_response_id));
}

console.log("a page watch's look, on the plan (lib/page-look.ts)");
{
  // Until 20 Oct 2026 every page watch on the plan failed: its question went as a
  // string, and the plan's route takes only a list. The route below answers as the
  // real one did, so this would have caught it; lookAtPage's own tests pass a model
  // of their own and never reach the plan.
  const look = async (route: (body: Body) => Response) => {
    const sent: { by: "plan" | "key"; body: Body }[] = [];
    const failed: string[] = [];
    const stub = new Proxy({}, {
      get: (_t, m) =>
        m === "then"
          ? undefined
          : async (...args: unknown[]) => {
              if (m === "chatgptToken") return { token: "at_plan", model: null };
              if (m === "chatgptFailed") return (failed.push(String(args[0])), { first: false });
              return undefined;
            },
    });
    const env = { CONFIG, OPENAI_API_KEY: "sk-test", STATE: { idFromName: () => "j", get: () => stub } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (!u.endsWith("/responses")) throw new Error(`nothing here reaches the network: ${u}`);
      const by = new Headers(init?.headers).get("authorization") === "Bearer at_plan" ? "plan" : "key";
      const body = JSON.parse(String(init?.body)) as Body;
      sent.push({ by, body });
      if (by === "key") throw new Error("the key was not to be used");
      return route(body);
    }) as typeof fetch;
    const page = (async () => new Response("<p>Springfield air quality: API 175, unhealthy, updated 3 PM.</p>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    try {
      const r = await lookAtPage(env as never, "https://air.example.gov/springfield", "the air in Springfield", "the API is above 150", page);
      return { r, sent, failed };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const usage = { input_tokens: 900, output_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const streamed = (text: string) => {
    const events = [
      { type: "response.created", response: { id: "resp_p", status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item: answer(text) },
      { type: "response.completed", response: { id: "resp_p", object: "response", status: "completed", output: [], usage } },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const asTheRouteDoes = (body: Body) =>
    Array.isArray(body.input) ? streamed("YES\nAPI 175 at 3 PM") : Response.json({ detail: "Input must be a list" }, { status: 400 });

  const ok = await look(asTheRouteDoes);
  const first = ok.sent[0]?.body.input;
  check("the question goes as a list: one user message, the page quoted inside it",
    Array.isArray(first) && first.length === 1 && first[0]!.role === "user" && String(first[0]!.content).includes("THE PAGE'S AUTHOR"), first);
  check("read on the plan alone, and the reading comes back",
    ok.r.state === true && ok.r.text === "API 175 at 3 PM" && ok.sent.length === 1 && ok.sent[0]!.by === "plan" && ok.r.usage?.model === "chatgpt:gpt-6-luna", ok.r);

  const bad = await look(() => Response.json({ detail: "Something the route did not like" }, { status: 400 }));
  check("a 400 from the plan is not its limit: said, not noted, and the key not spent",
    bad.r.state === null && /400/.test(bad.r.error ?? "") && !bad.failed.length && bad.sent.every((s) => s.by === "plan"), bad);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
