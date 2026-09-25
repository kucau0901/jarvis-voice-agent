import { ASSIST_AGENT, SENSITIVE, assistConfig, fastPathAllowed, tryAssist, type AssistConfig } from "../src/worker/lib/assist.ts";

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

console.log("the doors, gates and alarm");
{
  for (const q of [
    "unlock the front door",
    "open the main gate",
    "Open main gate.",
    "disarm the alarm",
    "arm the security system",
    "is the garage closed",
    "lock the back door",
    "buka pintu pagar",
    "kunci pintu depan",
  ]) {
    check(`sensitive: "${q}"`, SENSITIVE.test(q));
  }
  for (const q of [
    "turn on the study light",
    "what is the temperature in the master bedroom",
    "Close master bedroom curtain.",
    "turn off the armchair lamp",
    "dim the doorway light",
  ]) {
    check(`not sensitive: "${q}"`, !SENSITIVE.test(q));
  }
}

console.log("\nwhich of them may take the fast path");
{
  // Toward a safer house, or only asking: Assist, as the glasses had it directly.
  for (const q of [
    "close the main gate",
    "Close my main gate.",
    "shut the garage door",
    "lock the back door",
    "arm the security system",
    "is the main gate closed?",
    "Is the gate open",
    "did the garage door close",
    "what's the front door lock status",
    "tutup pagar",
    "kunci pintu depan",
    "turn on the study light",
  ]) {
    check(`fast path: "${q}"`, fastPathAllowed(q));
  }
  // Anything that lets someone in, or does not say which way, stays with the router.
  for (const q of [
    "open the main gate",
    "Open main gate.",
    "unlock the front door",
    "disarm the alarm",
    "turn on the gate",
    "press the gate button",
    "trigger the garage",
    "toggle the main gate",
    "close the gate then open the garage",
    "let the car in through the gate",
    "can you open the gate",
    "have the gate opened",
    "the main gate",
    "gate",
    "buka pintu pagar",
    "buka kunci pintu",
  ]) {
    check(`router: "${q}"`, !fastPathAllowed(q));
  }
}

console.log("\nwhen the fast path is available");
{
  const env = { HA_BASE_URL: "https://ha.example/", HA_TOKEN: "t0k" } as never;
  const cfg = assistConfig(env, ["home"]);
  check("configured with home", cfg !== null && cfg.base === "https://ha.example", cfg);
  check("language defaults to en", cfg?.language === "en");
  check("a wildcard grant counts as home", assistConfig(env, ["*"]) !== null);
  check("not without the home scope", assistConfig(env, ["ask", "mail"]) === null);
  check("not without a token", assistConfig({ HA_BASE_URL: "https://ha.example" } as never, ["home"]) === null);
  check("not without a base url", assistConfig({ HA_TOKEN: "t" } as never, ["home"]) === null);
  check("switched off by G2_FASTPATH=0", assistConfig({ HA_BASE_URL: "https://h", HA_TOKEN: "t", G2_FASTPATH: "0" } as never, ["home"]) === null);
  check("language from G2_HA_LANGUAGE",
    assistConfig({ HA_BASE_URL: "https://h", HA_TOKEN: "t", G2_HA_LANGUAGE: "ms" } as never, ["home"])?.language === "ms");
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
  const { f, calls } = fakeFetch(envelope("action_done", "Unlocked"));
  const r = await tryAssist(CFG, "unlock the front door", f);
  check("a request that opens never reaches Assist", !r.handled && r.reason === "sensitive" && calls.length === 0, r);

  const shut = fakeFetch(envelope("action_done", "Closed the gate"));
  const s = await tryAssist(CFG, "close the main gate", shut.f);
  check("closing the gate is done by Assist", s.handled && s.text === "Closed the gate" && shut.calls.length === 1, s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
