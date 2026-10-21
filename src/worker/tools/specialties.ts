import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";

/**
 * Saving and forgetting a specialty (lib/specialties.ts): a way of doing
 * something the user wants done the same way again.
 *
 * Saved steps are followed later, so they are a standing instruction of the
 * user's: only the user may make one. specialty_save takes the user's own
 * words asking for it, and they must be in their latest message, so a page,
 * a mail or a tool's output that asks to save one cannot. Jobs are never
 * offered these (lib/jobs.ts READ_TOOLS), and a routine runs without them
 * having been asked for.
 */

const said = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export const specialtySave: Tool = {
  name: "specialty_save",
  scope: "memory.write",
  pace: "fast",
  description:
    "Save a way of doing something so you do it the same way next time: a specialty. Only when " +
    "the user asks you to ('save this as my Monday report', 'remember how to do this'), or agrees " +
    "when you offer at the end of a task that took several steps. Give it a short name, the " +
    "phrases that would ask for it, and the steps as you did them, with the tools and values used.",
  parameters: {
    type: "object",
    properties: {
      user_words: { type: "string", description: "The user's own words asking to save it, copied exactly from their latest message." },
      name: { type: "string", description: "A short name, e.g. 'Monday report' or 'pre-cool the car'." },
      when: { type: "array", items: { type: "string" }, description: "A few phrases that would ask for it." },
      steps: { type: "array", items: { type: "string" }, description: "The steps in order, each one line, with the tools and values to use." },
      why: { type: ["string", "null"], description: "Why it is done this way, if the user said. Null otherwise." },
    },
    required: ["user_words", "name", "when", "steps", "why"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Specialties cannot be kept on this deployment: it has no state object.";
    const words = typeof args.user_words === "string" ? said(args.user_words) : "";
    if (words.length < 4 || !ctx.asked || !said(ctx.asked).includes(words)) {
      return "Not saved: only the user can ask for a specialty, in their own latest message. Ask them whether to save it.";
    }
    const s = await state.specialtySave(ctx.env.JARVIS_PERSON || OWNER, { name: args.name, when: args.when, steps: args.steps, why: args.why }, Date.now());
    if (typeof s === "string") return `Not saved: ${s}.`;
    return `Saved the specialty "${s.name}" (${s.steps.length} step${s.steps.length === 1 ? "" : "s"}). It is in Memory → Specialties. Asking for it by name, or as they usually would, uses it.`;
  },
};

export const specialtyForget: Tool = {
  name: "specialty_forget",
  scope: "memory.write",
  pace: "fast",
  description: "Forget a saved specialty, by its name, when the user asks.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Its name." } },
    required: ["name"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Specialties cannot be kept on this deployment: it has no state object.";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    return (await state.specialtyForget(ctx.env.JARVIS_PERSON || OWNER, name)) ? `Forgot the specialty "${name}".` : `No specialty is called "${name}".`;
  },
};

export const specialtyTools = [specialtySave, specialtyForget];
