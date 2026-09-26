import type { Tool } from "./registry";
import { stateStub } from "../lib/state-client.ts";

/**
 * Starting a background job by voice (lib/jobs.ts). The job keeps the
 * caller's grants, and reads but never acts.
 */
export const startJob: Tool = {
  name: "start_job",
  pace: "fast",
  description:
    "Start a background job for anything that needs many steps or several minutes, rather " +
    "than trying to do it now: researching and comparing (products, prices, places, options), " +
    "going through a lot of mail or a long stretch of the calendar, planning a trip, checking " +
    "many things. It runs on its own, even with every screen closed, and the result reaches " +
    "the user as a message and in the Jobs panel. It can READ — the web, mail, calendar, " +
    "memory, the car, cameras — but not act; if the work leads to an action it will say what it " +
    "would do. Write `task` as a complete brief: everything it needs from this conversation, " +
    "names resolved, because it will not see the conversation. Then tell the user it has started " +
    "and that they will hear when it is done. Not for quick questions: answer those now. " +
    "Set research to true only when the user asks for research in depth ('research…', 'dig " +
    "into…', 'find out everything about…'): it runs on a stronger model, searches widely, takes " +
    "10 to 40 minutes and costs about a dollar, and comes back as a report with its sources. " +
    "Say that when you start one.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words to list it by, e.g. 'Dashcams under RM800'." },
      task: { type: "string", description: "The complete brief, as if to a capable assistant who knows nothing of this conversation." },
      research: { type: "boolean", description: "True only for research in depth the user asked for; false for an ordinary job." },
    },
    required: ["title", "task", "research"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const research = args.research === true;
    const j = await state.createJob(
      { title: args.title, task: args.task, engine: research ? "research" : "jarvis" },
      { who: "voice", grants: ctx.grants },
    );
    if (typeof j === "string") return `Not started: ${j}.`;
    return research
      ? `Started research on "${j.title}". It takes 10 to 40 minutes; the report, with its sources, will reach the user as a message and wait in Jobs. Tell them so.`
      : `Started "${j.title}". It usually takes a few minutes; the result will reach the user as a message. Tell them so.`;
  },
};

export const jobTools: Tool[] = [startJob];
