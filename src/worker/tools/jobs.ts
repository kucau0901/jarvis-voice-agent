import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { voiceWho } from "../lib/context.ts";
import { allows } from "../lib/scopes.ts";

/**
 * Starting a background job by voice (lib/jobs.ts). The job keeps the
 * caller's grants, and reads but never acts.
 */
const startJob: Tool = {
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
    "Set research to 'yes' only when the user asks for research in depth ('research…', 'dig " +
    "into…', 'find out everything about…'): it runs on a stronger model, searches widely, takes " +
    "10 to 40 minutes and costs roughly one to two dollars, and comes back as a report with its sources. " +
    "Set it to 'team' only when they ask for research as a team, or a research team, in so many words: " +
    "three teams research it from different angles and share what they find, 20 to 55 minutes, roughly " +
    "four to seven dollars. Otherwise 'no'. Say the time and cost when you start either.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words to list it by, e.g. 'Dashcams under RM800'." },
      task: { type: "string", description: "The complete brief, as if to a capable assistant who knows nothing of this conversation." },
      research: {
        type: "string",
        enum: ["no", "yes", "team"],
        description: "'yes' or 'team' only as described above, when the user asked for it; 'no' for an ordinary job.",
      },
    },
    required: ["title", "task", "research"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const research = args.research === "yes" || args.research === "team";
    const team = args.research === "team";
    // Research spends the family's monthly allowance: for the family, not a guest.
    if (research && !allows(ctx.grants, "routines")) {
      return "Not started: research in depth is for the family, and this person may not start it. Offer an ordinary job, or to answer now.";
    }
    const j = await state.createJob(
      { title: args.title, task: args.task, engine: research ? "research" : "jarvis", ...(team ? { team: true } : {}) },
      { who: voiceWho(ctx.env), grants: ctx.grants },
    );
    if (typeof j === "string") return `Not started: ${j}.`;
    if (team) {
      return `Started a research team on "${j.title}": three teams look into it from different angles and share what they find as they go, ` +
        "then one report is checked against its sources. It takes 20 to 55 minutes and roughly four to seven dollars; the report " +
        "will reach the user as a message and wait in Jobs. Tell them so.";
    }
    return research
      ? `Started research on "${j.title}". It takes 10 to 40 minutes; the report, with its sources, will reach the user as a message and wait in Jobs. Tell them so.`
      : `Started "${j.title}". It usually takes a few minutes; the result will reach the user as a message. Tell them so.`;
  },
};

export const jobTools: Tool[] = [startJob];
