import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";
import { saidIn } from "../lib/specialties.ts";

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
 *
 * The steps are never written here: they are the ones Jarvis kept when the
 * answer before offered them (ToolContext.procedure, lib/router.ts), so
 * nothing a tool said, nor the answer, can be in them. The name and why are
 * kept only if they are the user's own words.
 */

const said = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Asking to save, in their words: "save this as…", "remember how to…", or in Malay. */
const SAVE = /\b(save|remember|keep|store|simpan|ingat)\b/i;

export const specialtySave: Tool = {
  name: "specialty_save",
  scope: "memory.write",
  pace: "fast",
  description:
    "Save the steps of the answer you just gave, so you do it the same way next time: a specialty. Only " +
    "when the user asks you to in their latest message ('save this as my Monday report'), after an answer " +
    "that ended by offering it. Jarvis keeps the steps itself, as they were done: give only the user's " +
    "words asking, the name they gave it, and why, if they said.",
  parameters: {
    type: "object",
    properties: {
      user_words: { type: "string", description: "The user's own words asking to save it, copied exactly from their latest message." },
      name: { type: ["string", "null"], description: "The name the user gave it, in their words, e.g. 'Monday report'. Null if they gave none." },
      why: { type: ["string", "null"], description: "Why it is done this way, in the user's words, if they said. Null otherwise." },
    },
    required: ["user_words", "name", "why"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Specialties cannot be kept on this deployment: it has no state object.";
    const words = typeof args.user_words === "string" ? said(args.user_words) : "";
    const asked = ctx.asked;
    if (words.length < 4 || !SAVE.test(words) || !asked || !said(asked).includes(words)) {
      return "Not saved: only the user can ask for a specialty, in their own latest message. Ask them whether to save it.";
    }
    const offered = ctx.procedure;
    if (!offered) return "Not saved: only the steps of an answer that offered to save them can be kept, by the very next message. Say so.";
    const theirs = (v: unknown) => (typeof v === "string" && saidIn(asked, v) ? v : null);
    const s = await state.specialtySave(
      ctx.env.JARVIS_PERSON || OWNER,
      { name: theirs(args.name) ?? offered.asked, when: [offered.asked], steps: offered.steps, why: theirs(args.why) },
      Date.now(),
    );
    if (typeof s === "string") return `Not saved: ${s}.`;
    return `Saved the specialty "${s.name}": ${s.steps.join("; then ")}. It is in Memory → Specialties. Asking for it by name, or as they usually would, uses it.`;
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
