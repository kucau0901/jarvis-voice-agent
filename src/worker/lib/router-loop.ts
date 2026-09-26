import type { EventSink } from "./sse.ts";
import type { AssistOutcome } from "./assist.ts";
import { DEFAULT_ROUTER_MODEL, shouldFallBack } from "./router-model.ts";

/**
 * The router's loop: from a conversation to an answer.
 *
 * Home Assistant's Assist first where asked for; then up to MAX_STEPS model
 * hops, running the tools each hop asks for, until the model answers in
 * words. Everything with a side effect (the model, the tools, memory, the
 * house connections) comes in through `deps`, so Node can test the loop with
 * fakes (test/router-loop.test.ts). routes/delegate.ts `run()` builds the real
 * ones.
 */

/** Hard ceiling on tool hops, so a confused router cannot loop forever. */
export const MAX_STEPS = 6;

/** What a question cost, summed over every hop, and reported with the answer. */
export interface Usage {
  input: number;
  cached: number;
  written: number;
  output: number;
  hops: number;
}

/** A tool call the model asked for. */
export interface FunctionCall {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

/** As much of a model response as the loop reads. */
export interface Reply {
  id: string;
  output: readonly { type: string }[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  } | null;
}

/** How a question went, for whoever keeps count (usage, the shared conversation). */
export interface LoopRecord {
  /** The model that answered, or "home-assistant". */
  by: string;
  ok: boolean;
  text: string;
  usage: Usage;
  tools: string[];
  ms: number;
}

export interface LoopDeps {
  sink: EventSink;
  signal: AbortSignal;
  /** For the log lines: which surface asked. */
  label: string;
  /** Home Assistant's Assist, when it is to be tried first. */
  assist?: () => Promise<AssistOutcome>;
  /** Without an OpenAI key only Assist can answer. */
  hasKey: boolean;
  /** Tools, memory and the first input: prepareRouter, in production. */
  prepare(): Promise<{ model: string; input: unknown; save(): Promise<void> }>;
  /** One model hop. */
  ask(model: string, input: unknown, previousResponseId: string | undefined): Promise<Reply>;
  /** Run the tools asked for; returns the next hop's input. */
  runCalls(calls: FunctionCall[]): Promise<unknown>;
  /** Whatever must be let go at the end, even if preparing failed (house connections). */
  close(): Promise<void>;
  /** The chosen model was refused on the first hop and the default is taking over. */
  onFallback?(e: unknown, model: string): void;
  record?(r: LoopRecord): void | Promise<void>;
  now?(): number;
  log?(line: string): void;
}

export async function routerLoop(deps: LoopDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const { sink, signal } = deps;
  const started = now();
  const usage: Usage = { input: 0, cached: 0, written: 0, output: 0, hops: 0 };
  const used: string[] = [];
  let outcome: LoopRecord | null = null;
  const settle = (by: string, ok: boolean, text: string) => {
    outcome = { by, ok, text, usage: { ...usage }, tools: [...used], ms: now() - started };
  };
  const record = async () => {
    if (!outcome || !deps.record) return;
    try {
      await deps.record(outcome);
    } catch (e) {
      console.warn("could not record the question:", e instanceof Error ? e.message : String(e));
    }
  };

  if (deps.assist) {
    const a = await deps.assist();
    log(`assist (${deps.label}): ${a.handled ? a.kind : a.reason} ${a.ms}ms`);
    if (a.handled) {
      sink.send({ type: "result", text: a.text, model: "home-assistant", usage });
      settle("home-assistant", true, a.text);
      await record();
      return;
    }
  }
  if (!deps.hasKey) {
    // The house may still answer without one (above); everything else needs it.
    sink.send({ type: "error", text: "Jarvis has no OpenAI key configured, so only the house can answer right now." });
    return;
  }

  let p: Awaited<ReturnType<LoopDeps["prepare"]>>;
  try {
    p = await deps.prepare();
  } catch (e) {
    await deps.close();
    throw e;
  }
  // Where a slow answer spent its time: getting ready, each model hop, each
  // round of tools. One line per question, in the Worker's log.
  const timing = { prep: now() - started, hops: [] as number[], tools: [] as number[] };
  const logTiming = () =>
    log(`router timing: prep ${timing.prep}ms, model ${timing.hops.join("+")}ms, tools ${timing.tools.join("+") || "-"}ms`);
  // `let`, because a first hop the chosen model rejects is retried on the
  // default and the rest follows it.
  let model = p.model;
  let turn = p.input;
  let previousResponseId: string | undefined;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;

      let res: Reply;
      const hopStart = now();
      try {
        res = await deps.ask(model, turn, previousResponseId);
      } catch (e) {
        // A model picked in settings that OpenAI now refuses must not take the
        // car down with it. Hop 0 only, before any tool has run, so the retry
        // cannot repeat a side effect.
        if (!shouldFallBack(e, model, step, signal.aborted)) throw e;
        deps.onFallback?.(e, model);
        model = DEFAULT_ROUTER_MODEL;
        res = await deps.ask(model, turn, previousResponseId);
      }
      timing.hops.push(now() - hopStart);
      previousResponseId = res.id;
      const u = res.usage;
      usage.input += u?.input_tokens ?? 0;
      usage.cached += u?.input_tokens_details?.cached_tokens ?? 0;
      usage.written += u?.input_tokens_details?.cache_write_tokens ?? 0;
      usage.output += u?.output_tokens ?? 0;
      usage.hops += 1;

      const calls = res.output.filter((o): o is FunctionCall => o.type === "function_call");

      if (!calls.length) {
        logTiming();
        const text = res.output_text?.trim();
        if (used.length) sink.send({ type: "used", tools: used });
        if (text) {
          sink.send({ type: "result", text, model, usage });
          settle(model, true, text);
        } else {
          const said = "I could not work out an answer to that.";
          sink.send({ type: "error", text: said, model, usage });
          settle(model, false, said);
        }
        return;
      }

      // Only the outputs go back; the chain carries everything else.
      for (const call of calls) if (!used.includes(call.name)) used.push(call.name);

      /*
       * Together, not one after another (runCalls). Calls issued in one
       * response cannot depend on each other — the model has none of their
       * results yet — so awaiting them in turn only made the driver wait for
       * the SUM.
       */
      const toolStart = now();
      turn = await deps.runCalls(calls);
      timing.tools.push(now() - toolStart);
    }

    const said = "I got stuck working that one out. Ask me again in a moment.";
    sink.send({ type: "error", text: said, model, usage });
    settle(model, false, said);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("delegate failed:", msg);
    // Returning silently on abort left the car with a closed stream and no
    // explanation, which reads to the driver as Jarvis simply giving up. Say
    // something whenever the stream is still open, whatever the cause.
    const said = signal.aborted ? "That request was cut off before your home answered." : spokenFailure(msg);
    if (!sink.isClosed) {
      sink.send({ type: "error", text: said, detail: msg.slice(0, 300), aborted: signal.aborted, model, usage });
    }
    settle(model, false, said);
  } finally {
    const closing = deps.close();
    // Persist once, at the end. Saving inside each tool would mean a KV write
    // per hop, and a turn that saves three facts should cost one write, not
    // three. A failed save must not turn a good answer into an error, so it is
    // logged rather than thrown — the answer was already spoken by then.
    try {
      // Deliberately not gated on signal.aborted: if the user taught Jarvis
      // something and then ended the session, the fact was still learned and
      // must still be kept.
      await p.save();
    } catch (e) {
      console.error("memory save failed:", e instanceof Error ? e.message : String(e));
    }
    await closing;
    await record();
  }
}

/**
 * What to say when the router loop itself fails.
 *
 * Tool failures never reach here — callTool catches them and hands the reason
 * to the router, which says it properly — so what does is the OpenAI call. This
 * used to blame the home system for everything, so an expired key or an empty
 * account was announced as Home Assistant refusing credentials, and the user
 * went to debug the wrong thing.
 */
export function spokenFailure(msg: string): string {
  if (/insufficient_quota|exceeded your current quota|billing/i.test(msg)) {
    return "My OpenAI account is out of credit, so I cannot work that out right now.";
  }
  if (/\b401\b|incorrect api key|invalid_api_key/i.test(msg)) {
    return "OpenAI refused my key, so I cannot work that out right now.";
  }
  if (/\b429\b|rate limit/i.test(msg)) return "OpenAI is rate-limiting me. Try again in a moment.";
  if (/\b5\d\d\b|overloaded|timed? ?out|fetch failed|network/i.test(msg)) {
    return "OpenAI is not answering properly right now. Try again in a moment.";
  }
  return "Something went wrong while I was working that out.";
}
