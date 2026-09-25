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
    "and that they will hear when it is done. Not for quick questions: answer those now.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words to list it by, e.g. 'Dashcams under RM800'." },
      task: { type: "string", description: "The complete brief, as if to a capable assistant who knows nothing of this conversation." },
    },
    required: ["title", "task"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const j = await state.createJob({ title: args.title, task: args.task, engine: "jarvis" }, { who: "voice", grants: ctx.grants });
    if (typeof j === "string") return `Not started: ${j}.`;
    return `Started "${j.title}". It usually takes a few minutes; the result will reach the user as a message. Tell them so.`;
  },
};

export const jobTools: Tool[] = [startJob];
