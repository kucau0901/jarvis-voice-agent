import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { haConfig } from "../lib/ha.ts";

/**
 * What Jarvis watches in the house (lib/house.ts). Code chooses by kind:
 * doors, locks, lights, presence, leaks and the rest. This changes that for
 * one thing: watch it as well, leave it out, or let its kind decide again.
 */
export const houseWatch: Tool = {
  name: "house_watch",
  scope: "home",
  pace: "fast",
  available: (env) => !!haConfig(env),
  description:
    "Change what Jarvis watches in the house: 'don't watch the garden lights', 'also keep an eye on the freezer " +
    "temperature', 'watch the study light again'. Jarvis watches doors, windows, locks, lights, covers, people, " +
    "motion, climate, leaks, smoke, the alarm, batteries and temperatures by itself; this adds one thing, leaves " +
    "one out, or puts one back to that. Find the entity id with the house tools first, never guess it.",
  parameters: {
    type: "object",
    properties: {
      entity: { type: "string", description: "The entity id, e.g. light.garden or sensor.freezer_temperature." },
      choice: { type: "string", enum: ["watch", "ignore", "default"], description: "watch: as well; ignore: leave it out; default: as its kind decides." },
    },
    required: ["entity", "choice"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "The house cannot be watched on this deployment: it has no state object.";
    const entity = String(args.entity ?? "").trim().toLowerCase();
    const choice = args.choice === "watch" || args.choice === "ignore" ? args.choice : "default";
    const p = await state.houseWatchSet(entity, choice);
    if (typeof p === "string") return `Not changed: ${p}.`;
    return choice === "watch" ? `Watching ${entity} as well.` : choice === "ignore" ? `No longer watching ${entity}.` : `${entity} is watched as its kind decides.`;
  },
};
