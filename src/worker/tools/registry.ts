import type { Env } from "../types";
import type { MemoryStore } from "../lib/memory";
import { allows, type Grant, type Scope } from "../lib/scopes";
import * as hermes from "./hermes";
import { memoryTools } from "./memory";
import { tessieTools } from "./tessie";
import { directionsTools } from "./directions";
import { placeTools } from "./place";
import { placesTools } from "./places.ts";
import { cameraTools } from "./camera";
import { spotifyTools } from "./spotify";
import { gmailTools } from "./gmail";
import { calendarTools } from "./calendar";

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
}

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
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

export const askHermes: Tool = {
  name: "ask_hermes",
  scope: "home",
  available: (env) => !!hermes.hermesConfig(env),
  pace: "slow",
  description:
    "Last resort. The user's own agent at home — reaches things nothing else here can, " +
    "but takes one to four minutes, which the driver notices. Use it only when no other " +
    "tool can answer, or when the user explicitly asks for Hermes. It does NOT have the " +
    "user's saved facts; those are in the profile block and in recall.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "A single self-contained question. Hermes does not see the car " +
          "conversation, so resolve pronouns and include any needed context.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const question = str(args.question);
    if (!question) return "No question was supplied.";
    ctx.progress("asking home");
    return hermes.ask(ctx.env, question, { signal: ctx.signal });
  },
};

export const controlHome: Tool = {
  name: "control_home",
  scope: "home",
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
  ...tessieTools,
  ...directionsTools,
  ...placeTools,
  ...placesTools,
  ...cameraTools,
  ...spotifyTools,
  ...gmailTools,
  ...calendarTools,
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
