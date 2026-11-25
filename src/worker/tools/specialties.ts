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
const SAVE = /\b(save|remember|keep|store|learn|simpan|ingat|belajar)\b/i;

export const specialtySave: Tool = {
  name: "specialty_save",
  scope: "memory.write",
  pace: "fast",
  description:
    "Save the steps of the answer you just gave, so you do it the same way next time: a specialty. Only " +
    "when the user asks you to in their latest message ('save this as my Monday report', 'learn this'), after " +
    "an answer that offered it or a job. Jarvis keeps the steps itself: give only the user's " +
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
    if (!offered) {
      // "Learn this", of a background job: a card, for their tap (lib/learn.ts). Nothing is kept here.
      const from = await state.specialtyLearn(ctx.env.JARVIS_PERSON || OWNER, Date.now());
      if (typeof from === "object") return from.card === "pending" ? `Not saved yet: a card to keep how "${from.title}" was done waits for their tap, in Chat and in Jobs. Say so.` : `A card for that was already answered (${from.card}). It can be kept by hand in Jobs, under that job.`;
      return `Not saved: only the steps of an answer that offered to save them can be kept, by the very next message, or how a background job was done; ${from}. Say so.`;
    }
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

/**
 * How a finished job was done, kept by its person's tap on the card that shows
 * it whole (lib/learn.ts, lib/approval.ts): never offered to the router or a job.
 */
export const specialtyKeep: Tool = {
  name: "specialty_keep",
  scope: "memory.write",
  pace: "fast",
  description: "Keep how a job was done.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  propose(args) {
    const name = typeof args.name === "string" ? args.name : "";
    if (!name || !Array.isArray(args.steps) || !args.steps.length) return null;
    return { risk: "reversible", says: args.id ? `Change how “${name}” is done, for next time` : `Keep how “${name}” was done, for next time`, verb: "Save" };
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Specialties cannot be kept on this deployment: it has no state object.";
    // Where it came from is only said of a new one; a change keeps the one it changes (SpecialtyMore.save), its notes and files as they are.
    const person = ctx.env.JARVIS_PERSON || OWNER;
    const id = typeof args.id === "string" ? args.id : undefined;
    const was = id ? await state.specialtyWhole(person, id) : null;
    // Their own change of it since is not undone by a card that showed what it was before.
    if (was && was.specialty.updatedAt !== args.at) return `Not kept: "${was.specialty.name}" was changed after this was offered. It can be changed by hand in Memory → Specialties.`;
    const s = await state.specialtyKeep(person, { ...(id ? { id } : {}), name: args.name, when: args.when, steps: args.steps, why: args.why, ...(was?.more.text ? { text: was.more.text } : {}) }, "learned", false, Date.now());
    if (typeof s === "string") return `Not kept: ${s}.`;
    ctx.done?.();
    return `Kept as "${s.name}", in Memory → Specialties. A background job may be told to use it, and asking for it by name follows it.`;
  },
};

export const specialtyTools = [specialtySave, specialtyForget];
