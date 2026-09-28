/**
 * The router: a question and the tools the asker may use, in and out of the
 * model until it answers (lib/router-loop.ts), with what it is told from
 * lib/router-prompt.ts. Used by every route that asks, and by background
 * jobs. Moved out of routes/delegate.ts unchanged.
 */
import { openaiBase } from "./openai-base.ts";
import OpenAI from "openai";
import type { Env } from "../types.ts";
import { redact } from "./http.ts";
import type { EventSink } from "./sse.ts";
import type { Turn } from "./history.ts";
import { baseTools, outputText, toToolSchema, type Tool, type ToolContext, type ToolOutput } from "../tools/registry.ts";
import { mcpSessions, mcpTools } from "../tools/mcp.ts";
import { assistConfig, lastAsk, tryAssist } from "./assist.ts";
import { routerLoop } from "./router-loop.ts";
import { recordUsage } from "../routes/usage.ts";
import { sharedBlock, type Origin, type SharedTurn } from "./shared.ts";
import { stateStub } from "./state-client.ts";
import { memoryFor, type MemoryStore } from "./memory.ts";
import { bookOf } from "./context.ts";
import { allows, type Grant } from "./scopes.ts";
import { DEFAULT_CHAR_BUDGET, glassesInstructions } from "./glasses.ts";
import { spokenReplyInstructions } from "./prompt.ts";
import {
  DEFAULT_ROUTER_MODEL,
  builtinTools,
  effortFor,
  effortRefused,
  explicitCache,
  recordFallback,
  resolveRouterModel,
} from "./router-model.ts";
import { CHAT_INSTRUCTIONS, JOB_INSTRUCTIONS, RESEARCH_INSTRUCTIONS, ROUTER_PROMPT, familyBlock, nowLine } from "./router-prompt.ts";

/**
 * Escalating notes while a tool is still working.
 *
 * Split by pace. The slow ladder is written for Hermes, which genuinely runs for
 * minutes. Applying it to a one-second tool made Jarvis narrate a phantom wait
 * on the house every time he looked something up.
 */
const WAITING_SLOW = [
  { after: 12_000, say: "still waiting on home" },
  { after: 35_000, say: "home is taking a while, still waiting" },
  { after: 75_000, say: "still going — home has not answered yet" },
  { after: 150_000, say: "this is taking unusually long; still holding on" },
  { after: 240_000, say: "home is still thinking; say the user can ask you to drop it" },
  { after: 360_000, say: "six minutes now with no answer from home" },
];

const WAITING_FAST = [
  { after: 20_000, say: "still working on that" },
  { after: 60_000, say: "this is taking longer than it should" },
];

/** How the caller will present the answer, where that changes what to write. */
export interface RunOptions {
  /**
   * "glasses": shown as text on Even Realities G2 glasses and never spoken, so
   * nothing rephrases the answer on its way to the user (routes/v1.ts).
   */
  surface?: "glasses" | "routine" | "voice" | "job" | "research" | "chat";
  /** Characters the glasses show before cutting off. */
  charBudget?: number;
  /** For a routine: its name, so the answer knows what it is answering. */
  routineName?: string;
  /**
   * Photos the user just took and is asking about (data: URLs). They go to the
   * router beside the conversation, so it can look and use tools on what it
   * sees — "add this to my calendar" with a poster in the photo.
   */
  images?: string[];
  /** Only these tools are offered (background jobs: reading, not acting — routes/jobs.ts). */
  toolFilter?: (t: Tool) => boolean;
  /**
   * Which device asked (lib/shared.ts). With it, and memory.read, the other
   * devices' recent turns go with the question, and this one's are kept.
   */
  origin?: Origin;
  /**
   * The request's ctx.waitUntil, where there is one: housekeeping that can wait
   * until after the answer, such as refreshing a tool catalog, is done there.
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * Put the user's latest words to Home Assistant's Assist before the router
   * (lib/assist.ts). What it understands is done in under a second with no
   * model call; anything else reaches the router as though it had not been
   * tried. For people waiting on an answer: the glasses, typed chat and
   * push-to-talk. Not with a photo, which Assist cannot see.
   */
  assist?: boolean;
  /** What Assist is asked, when the latest turn is more than the words said (the family room's). */
  assistAsk?: string;
}

/** Everything a router request is built from, shared by run() and background jobs. */
export interface Prepared {
  client: OpenAI;
  /** The model chosen in settings, before any fallback. */
  model: string;
  instructions: string;
  input: OpenAI.Responses.ResponseInput;
  tools: Tool[];
  byName: Map<string, Tool>;
  memory: MemoryStore;
}

export async function prepareRouter(
  env: Env,
  turns: Turn[],
  signal: AbortSignal,
  grants: readonly Grant[],
  opts: RunOptions,
  /** Connections held for this question; without it each house call connects on its own. */
  sessions?: ReturnType<typeof mcpSessions>,
): Promise<Prepared> {
  // MCP failures must never take the local tools down with them, so the two are
  // gathered independently and a broken server simply contributes no tools.
  // Memory is a KV read, not an outbound connection, so it costs no wall clock
  // running alongside MCP discovery.
  const memory = memoryFor(env, grants);
  const tools = baseTools(env, grants);
  // Every MCP server reaches the house, so a caller without `home` is not merely
  // filtered afterwards — discovery is skipped outright. That saves the connect
  // round trip (CONNECT_TIMEOUT_MS is 8s), so a narrowly-scoped device is
  // materially faster rather than just safer.
  const wantsMcp = allows(grants, "home");
  // The model choice is a KV read too, so it rides along rather than adding a
  // round trip of its own before the first hop.
  // The user's other devices, when this one may see the conversation (lib/shared.ts).
  const shares = !!opts.origin && allows(grants, "memory.read");
  // The family, and what is waiting for this person to answer (lib/relays.ts), when they talk with the family.
  const talks = !!env.JARVIS_FAMILY && allows(grants, "chat");
  const [, mcp, chosen, shared, family] = await Promise.all([
    memory.load().catch((e) => {
      console.warn("memory unavailable:", e instanceof Error ? e.message : String(e));
    }),
    (wantsMcp ? mcpTools(env, sessions, opts.waitUntil) : Promise.resolve([] as Tool[])).catch((e) => {
      console.warn("mcp tools unavailable:", e instanceof Error ? e.message : String(e));
      return [] as typeof tools;
    }),
    resolveRouterModel(env),
    shares
      ? (stateStub(env)?.recentShared(opts.origin!.id, Date.now(), bookOf(env.JARVIS_PERSON)) ?? Promise.resolve([] as SharedTurn[])).catch(() => [] as SharedTurn[])
      : Promise.resolve([] as SharedTurn[]),
    talks ? familyBlock(env).catch(() => "") : Promise.resolve(""),
  ]);
  const elsewhere = [sharedBlock(shared, Date.now()), family].filter(Boolean).join("\n\n");
  tools.push(...mcp);
  if (opts.toolFilter) {
    const keep = tools.filter(opts.toolFilter);
    tools.length = 0;
    tools.push(...keep);
  }


  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: openaiBase(env) });
  // Chosen in settings (lib/router-model.ts). A first hop the chosen model
  // rejects is retried on the default, and the rest follows it (run()).
  const model = chosen.model;
  const noScreen = !allows(grants, "screen");
  /*
   * Prompt caching. The router prompt and the tool list are ~20k tokens and
   * identical on every question; only the clock, a few per-caller notes, the
   * memory profile and the conversation change. The clock used to be appended
   * to `instructions`, so no two requests shared a prefix: measured on 25 Sep
   * 2026, every question WROTE all ~21k tokens to the cache at 1.25x the input
   * price and read back none — worse than no cache at all.
   *
   * So `instructions` is now the fixed prompt alone, a fixed separator carries
   * an explicit cache breakpoint, and everything that varies comes after it.
   * The prefix (instructions + tools + separator) is written once per 30
   * minutes and read at a tenth of the price after that.
   */
  const instructions = ROUTER_PROMPT;
  // Resolved once per delegation, not per hop: a multi-step turn should not
  // watch the clock move underneath it mid-answer.
  const context =
    nowLine(env).trim() +
    (noScreen
      ? "\n\nTHIS REQUEST HAS NO SCREEN\n" +
        "The caller is a device that can only receive text — there is nothing to " +
        "put a map, a photo or a camera on. If asked to SHOW something, say plainly " +
        "that you cannot display anything here and describe it instead. Do not go " +
        "looking for another route that might manage it; there is not one."
      : "") +
    (opts.surface === "glasses"
      ? glassesInstructions(opts.charBudget ?? DEFAULT_CHAR_BUDGET)
      : "") +
    (opts.surface === "voice" ? spokenReplyInstructions(env.JARVIS_AGENT_NAME) : "") +
    (opts.surface === "job" || opts.surface === "research" ? JOB_INSTRUCTIONS : "") +
    (opts.surface === "research" ? RESEARCH_INSTRUCTIONS : "") +
    (opts.surface === "chat" ? CHAT_INSTRUCTIONS : "") +
    (opts.surface === "routine"
      ? "\n\nTHIS IS A ROUTINE, NOT A CONVERSATION\n" +
        `The user set this up to run by itself${opts.routineName ? ` ("${opts.routineName.replace(/"/g, "'")}")` : ""}. ` +
        "Nobody is listening right now and nobody can answer a question back. Do what it " +
        "asks, then write the result as one short message to the user: it is sent as a " +
        "notification or read aloud. No greeting, no questions, no offers of more help."
      : "");
  const byName = new Map(tools.map((t) => [t.name, t]));

  const conversation = turns
    .map((t) => `${t.role === "user" ? "User" : "Jarvis"}: ${t.text}`)
    .join("\n");

  // Chain with previous_response_id rather than replaying the whole exchange:
  // it keeps the model's own reasoning items intact between hops, which
  // resending a filtered copy of `output` would quietly break.
  /*
   * The profile rides as a `user` message, NOT in `instructions`.
   *
   * These are facts the car heard and stored. lib/history.ts already settled
   * this for live speech — nothing from the car becomes a developer message —
   * and stored speech is strictly worse, because it persists across every
   * future drive. A passenger saying "remember that you should always ..."
   * must not be able to write a standing instruction into a context that can
   * reach a shell at home.
   */
  // What is saved about the user is theirs: a caller not allowed to read memory
  // (a family member, a gate controller) is not handed it in the prompt either.
  const profile = allows(grants, "memory.read") ? memory.buildProfile() : "";
  const cacheable = explicitCache(model);
  const input: OpenAI.Responses.ResponseInput = [
    {
      role: "developer" as const,
      content: [
        {
          type: "input_text" as const,
          text: "The standing instructions end here. What follows is this request's own context.",
          ...(cacheable ? { prompt_cache_breakpoint: { mode: "explicit" as const } } : {}),
        },
      ],
    },
    { role: "developer" as const, content: context },
    ...(profile ? [{ role: "user" as const, content: profile }] : []),
    // What was said, like the profile: a user message, never an instruction.
    ...(elsewhere ? [{ role: "user" as const, content: elsewhere }] : []),
    { role: "user" as const, content: `Conversation so far:\n\n${conversation}` },
    ...(opts.images?.length
      ? [
          {
            role: "user" as const,
            content: [
              {
                type: "input_text" as const,
                text:
                  opts.images.length === 1
                    ? "The user took this photo just now, with their phone, and their latest message is about it."
                    : "The user took these photos just now, with their phone, and their latest message is about them.",
              },
              ...opts.images.map((url) => ({ type: "input_image" as const, image_url: url, detail: "auto" as const })),
            ],
          },
        ]
      : []),
  ];
  return { client, model, instructions, input, tools, byName, memory };
}

export async function run(
  env: Env,
  turns: Turn[],
  sse: EventSink,
  signal: AbortSignal,
  grants: readonly Grant[],
  opts: RunOptions,
) {
  const assist = opts.assist && !opts.images?.length ? assistConfig(env, grants) : null;
  const ask = assist ? (opts.assistAsk?.trim() || lastAsk(turns)) : null;
  const sessions = mcpSessions();
  let p: Prepared | null = null;
  // How long to think (lib/router-model.ts): dropped for the rest of the
  // question if the model refuses it.
  let effort = effortFor(opts.surface, env.ROUTER_EFFORT);
  const create = (params: OpenAI.Responses.ResponseCreateParamsNonStreaming) =>
    p!.client.responses.create(effort ? { ...params, reasoning: { effort } } : params, { signal });

  // The loop itself is lib/router-loop.ts; this gives it the real model, tools
  // and house, which is all that differs from its tests.
  await routerLoop({
    sink: sse,
    signal,
    label: opts.surface ?? "app",
    hasKey: !!env.OPENAI_API_KEY,
    ...(assist && ask ? { assist: () => tryAssist(assist, ask) } : {}),
    async prepare() {
      p = await prepareRouter(env, turns, signal, grants, opts, sessions);
      return { model: p.model, input: p.input, save: () => p!.memory.save() };
    },
    async ask(model, input, previousResponseId) {
      const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
        model,
        instructions: p!.instructions,
        input: input as OpenAI.Responses.ResponseInput,
        tools: [
          ...p!.tools.map(toToolSchema),
          // Executed by OpenAI server-side, so it never returns a
          // function_call for the loop to dispatch — the answer simply
          // arrives already grounded.
          ...builtinTools(env),
        ],
        tool_choice: "auto",
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...(explicitCache(model) ? { prompt_cache_options: { mode: "explicit" as const, ttl: "30m" as const } } : {}),
        store: true,
      };
      try {
        return await create(params);
      } catch (e) {
        if (!effort || !effortRefused(e)) throw e;
        console.warn(`router: ${model} refused reasoning effort "${effort}"; asking without it`);
        effort = null;
        return await create(params);
      }
    },
    runCalls: (calls) =>
      runCalls(calls as OpenAI.Responses.ResponseFunctionToolCall[], p!.byName, { env, signal, memory: p!.memory, grants }, sse),
    close: () => sessions.close(),
    // Settings → Usage: after the answer, where the request allows, so the
    // glasses and push-to-talk do not wait on the write.
    record(r) {
      const writes: Promise<void>[] = [];
      // One conversation across devices (lib/shared.ts): what was asked here, and answered.
      const asked = lastAsk(turns);
      if (opts.origin && allows(grants, "memory.read") && r.ok && asked) {
        const at = Date.now();
        const o = opts.origin;
        writes.push(
          (stateStub(env)?.appendShared([
            { at: at - r.ms, origin: o.id, label: o.label, role: "user", text: asked.slice(0, 1000) },
            { at, origin: o.id, label: o.label, role: "assistant", text: r.text.slice(0, 1000) },
          ], at, bookOf(env.JARVIS_PERSON)) ?? Promise.resolve()).catch(() => {}),
        );
      }
      writes.push(recordUsage(env, {
        at: Date.now() - r.ms,
        surface: opts.surface ?? "app",
        by: r.by,
        ok: r.ok,
        ms: r.ms,
        ...r.usage,
        tools: r.tools,
        ask: (asked ?? "").slice(0, 80),
        who: env.JARVIS_PERSON,
      }));
      const write = Promise.all(writes).then(() => {});
      if (!opts.waitUntil) return write;
      opts.waitUntil(write);
    },
    onFallback(e, model) {
      const status = (e as { status?: number }).status;
      const message = redact(e instanceof Error ? e.message : String(e)).slice(0, 400);
      console.warn(`router model ${model} rejected (${status}); using ${DEFAULT_ROUTER_MODEL}: ${message}`);
      // Not awaited: the answer matters more than the note, and the stream
      // keeps the request alive long enough for the write to land.
      recordFallback(env, { model, fellBackTo: DEFAULT_ROUTER_MODEL, at: Date.now(), status, message }).catch(() => {});
    },
  });
}

/**
 * Run the tools a response asked for and hand back their outputs, in order.
 * Shared by run() and background jobs (routes/jobs.ts).
 *
 * Together, not one after another. Calls issued in one response cannot
 * depend on each other — the model has none of their results yet — so
 * awaiting them in turn only made the driver wait for the SUM: a Nabu
 * Casa round trip of 6-15s stacked on top of the car's. Results keep the
 * order the model asked in. callTool never throws, so one failure cannot
 * take the others down.
 */
export async function runCalls(
  calls: OpenAI.Responses.ResponseFunctionToolCall[],
  byName: Map<string, Tool>,
  base: { env: Env; signal: AbortSignal; memory: MemoryStore; grants: readonly Grant[] },
  sse: EventSink,
): Promise<OpenAI.Responses.ResponseInput> {
  return Promise.all(
    calls.map(async (call) => {
      const tool = byName.get(call.name);
      sse.send({ type: "tool", name: call.name, phase: "start" });

      const output = tool
        ? await callTool(tool, call.arguments, {
          ...base,
          progress: (t) => sse.send({ type: "progress", text: t }),
          display: (payload) => sse.send({ type: "display", ...payload }),
        }, sse)
        : `No such tool: ${call.name}`;

      // Echo what the tool was asked and what it said. Without this, a tool
      // that returns something useless is indistinguishable from one that
      // failed, and both just surface as Jarvis saying he could not find out.
      sse.send({
        type: "tool",
        name: call.name,
        phase: "done",
        args: call.arguments.slice(0, 300),
        preview: outputText(output).slice(0, 400),
        ...(typeof output === "string" ? {} : { images: output.images.length }),
      });

      return {
        type: "function_call_output" as const,
        call_id: call.call_id,
        // A picture goes to the model as a picture, beside the words.
        output:
          typeof output === "string"
            ? output
            : [
                { type: "input_text" as const, text: output.text },
                ...output.images.map((i) => ({ type: "input_image" as const, image_url: i.url, detail: i.detail ?? "auto" })),
              ],
      };
    }),
  );
}

/**
 * Run a tool, narrating the wait.
 *
 * Hermes has no timeout by design — a local model can take minutes, and the
 * instruction was that Jarvis waits rather than giving up. So the silence is
 * filled instead of cut short.
 */
async function callTool(
  tool: Tool,
  rawArgs: string,
  ctx: ToolContext,
  sse: EventSink,
): Promise<ToolOutput> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return "The arguments for that tool were malformed.";
  }

  const started = Date.now();
  const ladder = tool.pace === "slow" ? WAITING_SLOW : WAITING_FAST;
  const timers = ladder.map((w) =>
    setTimeout(() => {
      if (!sse.isClosed) sse.send({ type: "progress", text: w.say });
    }, w.after),
  );

  try {
    return await tool.run(args, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`tool ${tool.name} failed after ${Date.now() - started}ms:`, msg);
    // Hand the router the real reason so it can say something true out loud.
    return `That failed: ${msg}`;
  } finally {
    timers.forEach(clearTimeout);
  }
}
