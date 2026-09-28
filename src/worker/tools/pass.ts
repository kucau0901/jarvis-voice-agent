import type { Tool } from "./registry.ts";
import type { Env } from "../types.ts";
import { haConfig, callService } from "../lib/ha.ts";
import { passService } from "../lib/access.ts";

/**
 * A guest's pass (lib/access.ts): the few things in the house an admin let
 * them work — "open the gate" for a helper, and nothing else. They have no
 * house tools otherwise, so this is all the house they can reach.
 */

export function passOf(env: Env): { entity: string; label: string }[] {
  try {
    const v = JSON.parse(env.JARVIS_PASS ?? "[]") as { entity: string; label: string }[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Work one thing on a pass, by its label or entity. A string says what happened. */
export async function usePass(env: Env, thing: string, action: string): Promise<string> {
  const pass = passOf(env);
  const want = thing.trim().toLowerCase();
  // Nothing named is nothing to work (an empty name would match every label).
  if (!want) return `Which one? This pass covers: ${pass.map((p) => p.label).join(", ") || "nothing"}.`;
  const hit = pass.find((p) => p.entity === want || p.label.toLowerCase() === want) ?? pass.find((p) => p.label.toLowerCase().includes(want) || want.includes(p.label.toLowerCase()));
  if (!hit) return `That is not on this pass. It covers: ${pass.map((p) => p.label).join(", ") || "nothing"}.`;
  const svc = passService(hit.entity, action);
  if (typeof svc === "string") return `Not done: ${svc}.`;
  const ha = haConfig(env);
  if (!ha) return "The house is not connected to Jarvis.";
  try {
    await callService(ha, svc.domain, svc.service, hit.entity);
    return `Done: ${hit.label}, ${action}.`;
  } catch (e) {
    return `The house did not do it: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}.`;
  }
}

export const passTool: Tool = {
  name: "use_pass",
  scope: "ask",
  pace: "fast",
  available: (env) => passOf(env).length > 0,
  description:
    "Work one of the things on this person's pass, and nothing else: they are a guest, allowed only " +
    "the things listed in PASS in the context (the gate, say). Anything else in the house, tell them " +
    "plainly that their pass does not cover it.",
  parameters: {
    type: "object",
    properties: {
      thing: { type: "string", description: "Its name as on the pass, e.g. Main gate." },
      action: {
        type: "string",
        enum: ["open", "close", "stop", "on", "off", "toggle", "lock", "unlock", "press", "run"],
        description: "What to do to it.",
      },
    },
    required: ["thing", "action"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    return usePass(ctx.env, String(args.thing ?? ""), String(args.action ?? ""));
  },
};
