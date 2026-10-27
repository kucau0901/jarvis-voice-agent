import type { Env } from "../types.ts";
import type { DraftCard } from "../lib/mail-draft.ts";
import type { Weighed } from "../lib/proposals.ts";
import type { MemoryStore } from "../lib/memory.ts";
import { allows, type Grant, type Scope } from "../lib/scopes.ts";
import * as hermes from "./hermes.ts";
import { memoryTools } from "./memory.ts";
import { lookBackTool } from "./conversation.ts";
import { specialtyTools } from "./specialties.ts";
import { tessieTools } from "./tessie.ts";
import { directionsTools } from "./directions.ts";
import { placeTools } from "./place.ts";
import { placesTools } from "./places.ts";
import { cameraTools } from "./camera.ts";
import { makeImage } from "./image.ts";
import { makePage } from "./page.ts";
import { spotifyTools } from "./spotify.ts";
import { gmailTools } from "./gmail.ts";
import { calendarTools } from "./calendar.ts";
import { sendNote } from "./notes.ts";
import { alertTalk } from "./alerts.ts";
import { routineTools } from "./routines.ts";
import { jobTools } from "./jobs.ts";
import { familyTools } from "./family.ts";
import { passTool } from "./pass.ts";
import { panelTools } from "./panels.ts";
import { stateStub } from "../lib/state-client.ts";
import { voiceWho } from "../lib/context.ts";
import { researchFor, type Job } from "../lib/jobs.ts";

/**
 * The tools the delegation router may call.
 *
 * GPT-Live's delegation event carries no task text — only an id and a timeline
 * offset — so the router reads the transcript and decides what the user actually
 * wants. That decision is what makes third-party MCP servers usable at all.
 */
export interface ToolContext {
  env: Env;
  signal: AbortSignal;
  /** Say something to the driver while slow work is still running. */
  progress(text: string): void;
  /** Loaded once per request, so a write is visible to a read in the same turn. */
  memory: MemoryStore;
  /** Put something on the car's screen. Separate from what Jarvis says aloud. */
  display(payload: Record<string, unknown>): void;
  /** A background job was started (start_job, ask_hermes): typed chat shows it as a pill until its result comes (src/app/fromRoutine.ts). */
  started?(job: { id: string; title: string; engine: string }): void;
  /** A Gmail draft waiting for the person's tap (lib/mail-draft.ts): the screen shows it as a card with Send (src/app/draft.ts). */
  drafted?(d: DraftCard): void;
  /**
   * What the caller may reach. A routine made by voice keeps these, so it can
   * never later do more than the person or device that asked for it.
   */
  grants: readonly Grant[];
  /** The tools the router was offered for this question, by name: what a panel's tile may be wired to (tools/panels.ts). */
  offered?: readonly string[];
  /** The user's latest message, as they said it: what only they can ask for must be in it (tools/specialties.ts). */
  asked?: string;
  /**
   * Told that the call did what was asked: a tool a job may propose says so
   * on success, since it says failure in words, not by throwing. Only what
   * it told counts as done for an approval (lib/proposals.ts).
   */
  done?(): void;
}

/** A picture for the router to look at, as a data: URL. */
interface ToolImage {
  url: string;
  detail?: "low" | "high" | "auto";
}

/**
 * What a tool hands back: words, or words and pictures. A picture goes to the
 * router model itself, which looks at it and answers in the same loop — no
 * second model call — and can still use other tools on what it saw.
 */
export type ToolOutput = string | { text: string; images: ToolImage[] };

export const outputText = (o: ToolOutput): string => (typeof o === "string" ? o : o.text);

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Whether this tool can work at all on this deployment. Absent means always.
   * Keeping the gate next to the tool is what stopped an unconfigured Hermes
   * from disabling every other local tool.
   */
  available?(env: Env): boolean;
  /**
   * How long this tool plausibly takes. Drives the spoken waiting ladder: a
   * "fast" tool narrating "still waiting on home" after twelve seconds is both
   * too early and factually wrong.
   */
  pace?: "fast" | "slow";
  /**
   * What a caller must hold to be offered this tool. Absent means the `ask`
   * baseline suffices. The router is only ever SHOWN the tools a grant allows —
   * filtering here rather than instructing the model is what makes the boundary
   * real, because a tool that was never offered cannot be talked into existence.
   */
  scope?: Scope;
  /**
   * Strict schema adherence. True for tools defined here, where the schema is
   * ours to guarantee. False for MCP tools: strict mode demands
   * `additionalProperties: false` and a full `required` list on every nested
   * object, and rewriting a third-party server's schema to satisfy that risks
   * changing what it means. The MCP server validates its own arguments anyway.
   */
  strict?: boolean;
  /**
   * How a background job may propose this call for the user's tap
   * (lib/proposals.ts): how risky it is, worked out from its arguments, and
   * what it does in words; null when these arguments cannot be proposed.
   * Without it, a job is never handed the tool. Not sent to the model.
   */
  propose?(args: Record<string, unknown>, env: Env): Weighed | null;
  /** What the card shows of the thing the call acts on, looked up when it is filed (an email's sender and subject). Shown only. */
  detail?(args: Record<string, unknown>, ctx: ToolContext): Promise<string | null>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

const askHermes: Tool = {
  name: "ask_hermes",
  scope: "hermes",
  available: (env) => !!hermes.hermesConfig(env),
  pace: "fast",
  description:
    "The user's own agent on their computer at home, which can run commands there; it takes one " +
    "to four minutes. Send it, without the user having to name Hermes, only these: (1) code — " +
    "writing or changing it, and building, fixing or deploying the user's own websites and apps; " +
    "(2) files, folders, scripts and programs on that computer. Never start a job for those (jobs " +
    "only read). The house, the car and anything in Home Assistant (entity ids like sensor.… or " +
    "lock.…, their states) are NOT that computer: read and work them with the house and car tools, " +
    "never with Hermes. For anything else it is the last resort: only when no other tool can " +
    "answer, or when the user asks for Hermes. The question goes to Hermes as a background job and " +
    "this returns at once: Hermes's answer reaches the user as a message when it is ready, " +
    "even if the screen is closed — tell them that, and do not wait for it or guess it. Asked " +
    "later whether it has answered, read it with job_results; never ask Hermes again to find out. It " +
    "does NOT have the user's saved facts; those are in the profile block and in recall.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "A single self-contained question. Hermes does not see the car " +
          "conversation, so resolve pronouns and include any needed context. For code, " +
          "say what to change and in which site, app or project, by the name the user " +
          "used, and ask Hermes to say when it is done or deployed. When " +
          "handing over research, say exactly what Hermes should do with it, e.g. " +
          "'build a first version of the site with Claude Code in a new project " +
          "folder, and tell me when it is done', and nothing more: never the " +
          "report, its summary or its findings, since the whole report goes with " +
          "it, quoted.",
      },
      research: {
        type: ["string", "null"],
        description:
          "Only when the user asks to pass research on to Hermes: words from the " +
          "finished research job's title, or 'latest'. Null otherwise.",
      },
    },
    required: ["question", "research"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const question = str(args.question);
    if (!question) return "No question was supplied.";
    const state = stateStub(ctx.env);
    // Research handed over, only when asked for: the caller's own finished research, whole and quoted (lib/jobs.ts).
    let from: Job | undefined;
    const research = str(args.research);
    if (research) {
      const found = researchFor(state ? await state.listJobs() : [], voiceWho(ctx.env), research);
      if (typeof found === "string") return `${found} Nothing was sent to Hermes.`;
      from = found;
    }
    /*
     * A job, not a wait: Hermes takes minutes, and waiting meant the car's tab
     * had to stay open for the answer — close it and the answer was gone. As a
     * job it runs from the Durable Object and arrives as an alert: spoken on
     * the screen if one is open, a notification if not.
     */
    if (!state) {
      ctx.progress("asking home");
      return hermes.ask(ctx.env, question, { signal: ctx.signal });
    }
    const j = await state.createJob(
      { title: `Hermes: ${question.slice(0, 60)}`, task: question, engine: "hermes", ...(from ? { from: from.id } : {}) },
      { who: voiceWho(ctx.env), grants: ctx.grants },
    );
    if (typeof j === "string") return `Hermes was not asked: ${j}.`;
    ctx.started?.({ id: j.id, title: j.title, engine: j.engine });
    const what = from ? `Asked Hermes, with the whole report "${from.title}".` : "Asked Hermes.";
    return `${what} It usually takes one to four minutes; the answer will reach the user as a message when it is ready. Tell them so, briefly.`;
  },
};

const controlHome: Tool = {
  name: "control_home",
  scope: "hermes",
  available: (env) => !!hermes.hermesConfig(env),
  pace: "slow",
  description:
    "FALLBACK ONLY, and slow — one to four minutes. Changes something in the user's " +
    "home by asking Hermes. The home-assistant tools operate the same lights, " +
    "switches, doors, climate and scenes in about eight seconds, so use those " +
    "first and reach for this only when they have failed or cannot express what " +
    "is being asked. Never for questions, only for changes. Report back exactly " +
    "what Hermes says happened; never assume it succeeded.",
  parameters: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "The action in plain language, e.g. 'turn on the porch light'.",
      },
    },
    required: ["instruction"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const instruction = str(args.instruction);
    if (!instruction) return "No instruction was supplied.";
    ctx.progress("sending that home");
    return hermes.ask(ctx.env, instruction, {
      signal: ctx.signal,
      system:
        "You are acting on a home automation request from the user's car. Carry it " +
        "out if you can. Reply in one short sentence stating what actually " +
        "happened. If you could not do it, say so plainly and say why. Never claim " +
        "success you did not verify.",
    });
  },
};

/** Every local tool. MCP tools are appended separately at request time. */
const ALL: Tool[] = [
  ...memoryTools,
  ...specialtyTools,
  lookBackTool,
  ...tessieTools,
  ...directionsTools,
  ...placeTools,
  ...placesTools,
  ...cameraTools,
  makeImage,
  makePage,
  ...spotifyTools,
  ...gmailTools,
  ...calendarTools,
  sendNote,
  alertTalk,
  ...routineTools,
  ...jobTools,
  ...familyTools,
  passTool,
  ...panelTools,
  askHermes,
  controlHome,
];

/** Everything, for the owner and for any caller that has not been narrowed. */
const EVERYTHING: Grant[] = ["*"];

export function baseTools(env: Env, granted: readonly Grant[] = EVERYTHING): Tool[] {
  return ALL.filter(
    (t) => (!t.available || t.available(env)) && (!t.scope || allows(granted, t.scope)),
  );
}

/** For /api/diag: which local tools are live, and which are not, and why not. */
export function toolAvailability(
  env: Env,
): { name: string; available: boolean; scope: Scope | "ask" }[] {
  // The scope is reported too, because "why will my device not read the car"
  // is otherwise only answerable by reading the source.
  return ALL.map((t) => ({
    name: t.name,
    available: !t.available || t.available(env),
    scope: t.scope ?? "ask",
  }));
}

/** Shape the Responses API expects for a function tool. */
export function toToolSchema(t: Tool) {
  return {
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: t.strict !== false,
  };
}
