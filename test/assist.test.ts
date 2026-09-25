import { ASSIST_AGENT, assistConfig, lastAsk, tryAssist, type AssistConfig } from "../src/worker/lib/assist.ts";

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

const CFG: AssistConfig = { base: "https://ha.example", token: "t0k", language: "en" };

/** A fetch that records what it was asked and answers with `body`. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** Home Assistant's envelope, as /api/conversation/process returns it. */
const envelope = (response_type: string, speech: string, data: unknown = { success: [], failed: [] }) => ({
  response: { response_type, speech: { plain: { speech, extra_data: null } }, card: {}, language: "en", data },
  conversation_id: "01ABC",
  continue_conversation: false,
});

console.log("when the fast path is available");
{
  const env = { HA_BASE_URL: "https://ha.example/", HA_TOKEN: "t0k" } as never;
  const cfg = assistConfig(env, ["home"]);
  check("configured with home", cfg !== null && cfg.base === "https://ha.example", cfg);
  check("language defaults to en", cfg?.language === "en");
  check("a wildcard grant counts as home", assistConfig(env, ["*"]) !== null);
  check("not without the home scope", assistConfig(env, ["ask", "mail"]) === null);
  check("not without a token", assistConfig({ HA_BASE_URL: "https://ha.example" } as never, ["home"]) === null);
  check("not without a base url", assistConfig({ HA_TOKEN: "t" } as never, ["home"]) === null);
  check("switched off by HA_ASSIST=0", assistConfig({ HA_BASE_URL: "https://h", HA_TOKEN: "t", HA_ASSIST: "0" } as never, ["home"]) === null);
  check("language from HA_ASSIST_LANGUAGE",
    assistConfig({ HA_BASE_URL: "https://h", HA_TOKEN: "t", HA_ASSIST_LANGUAGE: "ms" } as never, ["home"])?.language === "ms");
  check("the old G2_FASTPATH=0 still switches it off",
    assistConfig({ HA_BASE_URL: "https://h", HA_TOKEN: "t", G2_FASTPATH: "0" } as never, ["home"]) === null);
  check("the new name wins over the old",
    assistConfig({ HA_BASE_URL: "https://h", HA_TOKEN: "t", G2_FASTPATH: "0", HA_ASSIST: "1" } as never, ["home"]) !== null);
}

console.log("\nwhat is put to Assist");
{
  check("the user's latest words", lastAsk([{ role: "user", text: "hi" }, { role: "assistant", text: "Hello" }, { role: "user", text: " open the gate " }]) === "open the gate");
  check("nothing when Jarvis spoke last", lastAsk([{ role: "user", text: "hi" }, { role: "assistant", text: "Hello" }]) === null);
  check("nothing for an empty conversation", lastAsk([]) === null);
}

console.log("\nasking Assist");
{
  const { f, calls } = fakeFetch(envelope("action_done", "Turned on the lights"));
  const r = await tryAssist(CFG, "turn on the study light", f);
  check("an action it did is answered", r.handled && r.text === "Turned on the lights" && r.kind === "action_done", r);

  const call = calls[0]!;
  const sent = JSON.parse(String(call.init.body));
  check("posts to /api/conversation/process", call.url === "https://ha.example/api/conversation/process", call.url);
  check("asks the local agent by name", sent.agent_id === ASSIST_AGENT && ASSIST_AGENT === "conversation.home_assistant");
  check("sends the text and language", sent.text === "turn on the study light" && sent.language === "en");
  check("with the HA token", (call.init.headers as Record<string, string>).Authorization === "Bearer t0k");
}
{
  const r = await tryAssist(CFG, "what is the temperature", fakeFetch(envelope("query_answer", "26.0 degrees")).f);
  check("a question it can answer is answered", r.handled && r.text === "26.0 degrees" && r.kind === "query_answer", r);
}
{
  const miss = envelope("error", "Sorry, I am not aware of any device called capital of France", { code: "no_valid_targets" });
  const r = await tryAssist(CFG, "what is the capital of France", fakeFetch(miss).f);
  check("an error hands over and is never shown", !r.handled && r.reason === "no_match", r);
}
{
  const r = await tryAssist(CFG, "turn on the fan", fakeFetch(envelope("action_done", "")).f);
  check("an action with no speech still reads as done", r.handled && r.text === "Done.", r);
  const partial = envelope("action_done", "", { success: [{ id: "a" }], failed: [{ id: "b" }] });
  const p = await tryAssist(CFG, "turn on the fans", fakeFetch(partial).f);
  check("a partial action says what failed", p.handled && p.text === "1 done, 1 failed.", p);
}
{
  const r = await tryAssist(CFG, "turn on the fan", fakeFetch({ message: "Unauthorized" }, 401).f);
  check("an HTTP error hands over with its status", !r.handled && r.reason === "http" && r.status === 401, r);

  const u = await tryAssist(CFG, "turn on the fan", fakeFetch("<html>not json").f);
  check("an unreadable reply hands over", !u.handled && u.reason === "unreadable", u);

  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const d = await tryAssist(CFG, "turn on the fan", down);
  check("an unreachable house hands over", !d.handled && d.reason === "unreachable", d);
}
{
  // Never answers; gives up only when the signal fires.
  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
  // AbortSignal.timeout's timer is unref'd in Node, so with nothing else
  // pending the process would exit before it fired. A Worker's open request
  // keeps it alive; here something has to.
  const keepAlive = setInterval(() => {}, 1000);
  const t0 = Date.now();
  const r = await tryAssist(CFG, "turn on the fan", hang, 60);
  clearInterval(keepAlive);
  check("a slow house hands over on time", !r.handled && r.reason === "timeout" && Date.now() - t0 < 1000, r);
}
{
  // Gates and doors go to Assist like anything else: what it may do is set in Home Assistant.
  for (const [q, said] of [
    ["open the main gate", "Opened the gate"],
    ["close my main gate", "Closed the gate"],
    ["unlock the front door", "Unlocked"],
  ]) {
    const { f, calls } = fakeFetch(envelope("action_done", said));
    const r = await tryAssist(CFG, q, f);
    check(`"${q}" is done by Assist`, r.handled && r.text === said && calls.length === 1, r);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
