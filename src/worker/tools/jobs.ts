import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { callerWho, maySteer, mayWork } from "../lib/context.ts";
import { wordsOf, type Job } from "../lib/jobs.ts";
import { flagLines } from "../lib/job-results.ts";
import { tells } from "../lib/job-brief.ts";
import { asksSaid, openQuestions } from "../lib/job-tools.ts";
import { asQuotedData, ownPart } from "../lib/quote.ts";
import { allows } from "../lib/scopes.ts";
import { clampLimit } from "./args.ts";

/**
 * Starting a background job by voice (lib/jobs.ts). The job keeps the
 * caller's grants, and reads but never acts.
 */
const startJob: Tool = {
  name: "start_job",
  pace: "fast",
  description:
    "Start a background job for anything that needs many steps or several minutes: researching and " +
    "comparing, going through a lot of mail or a long stretch of the calendar, planning a trip, " +
    "checking many things. It runs on its own; the result reaches the user as a message and in Jobs. " +
    "It reads and never acts; what it would do, it proposes. It reads ONE side (`reach`): 'private', " +
    "the user's own mail, calendar, memory, house, car and cameras, without the web; or 'web', without " +
    "any of those. For work that needs both (a trip around their diary), read the private part here " +
    "first and put only the facts it needs in `task`. Write `task` as a complete brief, names resolved: " +
    "it will not see the conversation, and the user can read it. Tell them it has started and, on the " +
    "web, which of their facts it was given. Not for quick questions: answer those now. " +
    "Set research to 'yes' only when asked for research in depth ('research…', 'dig into…', 'find " +
    "out everything about…'): a stronger model, searching widely, 10 to 40 minutes, roughly one to two " +
    "dollars, a report with its sources. 'team' only when asked for research as a team in so many " +
    "words: three teams from different angles sharing what they find, 20 to 55 minutes, roughly four " +
    "to seven dollars. 'table' for a list or table of many items found and compared ('the 10 " +
    "cheapest…', 'every dentist near…', 'a spreadsheet of…'): the same team fills rows, to download " +
    "from Jobs as CSV, same cost and time. Otherwise 'no'. Say the time and cost when you start any.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words to list it by, e.g. 'Dashcams under RM800'." },
      task: { type: "string", description: "The complete brief." },
      reach: { type: "string", enum: ["private", "web"], description: "Research is always the web." },
      mode: { type: "string", enum: ["ordinary", "thorough"], description: "'thorough' only if asked, or to weigh many things together: a stronger, dearer model." },
      research: {
        type: "string",
        enum: ["no", "yes", "team", "table"],
        description: "'no' for an ordinary job.",
      },
    },
    required: ["title", "task", "reach", "mode", "research"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const research = args.research === "yes" || args.research === "team" || args.research === "table";
    const table = args.research === "table";
    const team = args.research === "team" || table;
    // Research spends the family's monthly allowance: for the family, not a guest.
    if (research && !allows(ctx.grants, "routines")) {
      return "Not started: research in depth is for the family, and this person may not start it. Offer an ordinary job, or to answer now.";
    }
    // What goes to the web says nothing of who they are: looked at by code, since the model knows it all (lib/job-brief.ts).
    if (research || args.reach === "web") {
      const family = await state.familyPeople().catch(() => []);
      const said = tells(`${String(args.title ?? "")}\n${String(args.task ?? "")}`, {
        names: [ctx.env.JARVIS_PERSON_NAME ?? "", ctx.env.JARVIS_PERSON_NICKNAME ?? "", ...(family ?? []).map((p) => p.name)],
        addresses: [...ctx.memory.facts, ...(ctx.memory.family?.facts ?? [])].flatMap((f) => (f.address ? [f.address] : [])),
      }, ctx.asked ?? "");
      if (said.length) {
        return `Not started: the brief says ${said.map((s) => `"${s}"`).join(", ")}. A job on the web is told nothing of who the user is, their family, ` +
          "or exactly where they live: start it again without, as 'the user' and at most their town. Only what they themselves said in this " +
          "message may be in it; if they want that looked up, ask them to say so.";
      }
    }
    // So does the stronger model cost: a guest's job is an ordinary one.
    const thorough = !research && args.mode === "thorough" && allows(ctx.grants, "routines");
    const j = await state.createJob(
      { title: args.title, task: args.task, engine: research ? "research" : "jarvis", reach: args.reach, ...(thorough ? { mode: "thorough" } : {}), ...(team ? { team: true } : {}), ...(table ? { table: true } : {}) },
      { who: callerWho(ctx.env), grants: ctx.grants },
    );
    if (typeof j === "string") return `Not started: ${j}.`;
    ctx.started?.({ id: j.id, title: j.title, engine: j.engine });
    if (table) {
      return `Started a research table on "${j.title}": three teams each find their share of the list, then the rows are merged and ` +
        "checked against their sources. It takes 20 to 55 minutes and roughly four to seven dollars; the first rows will reach the " +
        "user as a message, and the whole table waits in Jobs to download as CSV. Tell them so.";
    }
    if (team) {
      return `Started a research team on "${j.title}": three teams look into it from different angles and share what they find as they go, ` +
        "then one report is checked against its sources. It takes 20 to 55 minutes and roughly four to seven dollars; the report " +
        "will reach the user as a message and wait in Jobs. Tell them so.";
    }
    return research
      ? `Started research on "${j.title}". It takes 10 to 40 minutes; the report, with its sources, will reach the user as a message and wait in Jobs. Tell them so.`
      : `Started "${j.title}" ${j.reach === "web" ? "on the web, with only what its brief says of the user" : "on the user's own things, without the web"}. ` +
        `It usually takes ${j.mode === "thorough" ? "ten minutes or more, with a stronger model" : "a few minutes"}; the result will reach the user as a message. Tell them so.`;
  },
};

/** How much of the newest finished job's result is read out; the rest waits in Jobs. */
const RESULT_CUT = 4000;

const since = (t: number, now: number): string => {
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 120) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
};

const KIND = { hermes: "Hermes", research: "research", jarvis: "job" } as const;
const WRITER = { hermes: "HERMES", research: "A RESEARCH JOB, FROM THE WEB", jarvis: "A BACKGROUND JOB, FROM WHAT IT READ" } as const;

/** Summary and result as one text, without the summary twice where the result begins with it. */
const textOf = (j: Job): string => {
  const r = [flagLines(j), j.result ?? ""].filter(Boolean).join("\n\n");
  const s = j.summary ?? "";
  return !s || r.replace(/\s+/g, " ").startsWith(s) ? r || s : `${s}\n\n${r}`;
};

/**
 * Reading the jobs back: what a finished job said, for a caller that only
 * asks and gets one answer (/api/v1/ask, the MCP server), which never hears
 * the alert. The asker's person's own, as routes/jobs.ts lists them to a person.
 */
const jobResults: Tool = {
  name: "job_results",
  pace: "fast",
  reads: true,
  description:
    "Read the user's own background jobs and what they came back with: Hermes's answers (ask_hermes " +
    "runs as one), research reports and start_job results, newest first. Use it whenever they ask " +
    "whether Hermes has answered, what Hermes said, what the research or a job found, or how one is " +
    "going — never ask Hermes again or start another job to find out. The newest finished one comes " +
    "back with its result; name a job by words from its title to get that one's.",
  parameters: {
    type: "object",
    properties: {
      about: {
        type: ["string", "null"],
        description: "Words from the job's title or brief, e.g. 'dashcam'. Null for the latest.",
      },
      engine: {
        type: "string",
        enum: ["any", "hermes", "research", "jarvis"],
        description: "'hermes' for Hermes's answers, 'research' for research reports, 'jarvis' for ordinary jobs; 'any' otherwise.",
      },
      limit: { type: ["integer", "null"], description: "How many jobs to list, 1 to 10. Null for 3." },
    },
    required: ["about", "engine", "limit"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const want = wordsOf(typeof args.about === "string" ? args.about : "");
    const engine = args.engine === "hermes" || args.engine === "research" || args.engine === "jarvis" ? args.engine : null;
    const jobs = (await state.listJobs()).filter((j) => {
      if (!mayWork(j, ctx.env, ctx.grants) || (engine && j.engine !== engine)) return false;
      const has = wordsOf(`${j.title} ${j.task}`);
      return want.every((w) => has.some((h) => h.startsWith(w)));
    }).slice(0, clampLimit(args.limit, 3, 10));
    if (!jobs.length) {
      const kind = engine === "jarvis" ? "ordinary " : engine ? `${KIND[engine]} ` : "";
      return `This person has no ${kind}background jobs${want.length ? ` matching '${args.about}'` : ""}. Nothing is waiting to be read.`;
    }
    const now = Date.now();
    const whole = jobs.find((j) => j.status === "done" || !!j.result);
    return jobs.map((j, i) => {
      const head = `${i + 1}. "${j.title}" (${KIND[j.engine]})`;
      if (j.status === "running") {
        const open = openQuestions(j.asked);
        const done = (j.todo ?? []).filter((t) => t.state === "done").length;
        const of = (j.todo ?? []).filter((t) => t.state !== "dropped").length;
        return (
          `${head}: ${j.waits ? "waiting for the user's answer" : "still working"}, started ${since(j.createdAt, now)}${of ? `, ${done} of ${of} done` : ""}. ` +
          "Its answer will reach the user as a message; do not ask again." +
          (open.length ? `\nIt asks them, and their reply goes with job_control:\n${asQuotedData("job question", asksSaid(open), WRITER.jarvis)}` : "")
        );
      }
      if (j.status === "cancelled") return `${head}: cancelled ${since(j.finishedAt ?? j.updatedAt, now)}.`;
      const when = since(j.finishedAt ?? j.updatedAt, now);
      if (j.status === "failed" && !j.result) return `${head}: did not finish (${when}).\n${asQuotedData("job error", j.error ?? "no reason given", WRITER[j.engine])}`;
      const ended = j.status === "failed" ? `only part done, not finished (${when}${j.cut ? `; ${j.cut.why}` : ""})` : `finished ${when}`;
      let text = j === whole ? textOf(j) : (j.summary ?? "");
      if (!text) return `${head}: ${ended}.`;
      if (text.length > RESULT_CUT) text = `${text.slice(0, RESULT_CUT)}… (cut; the whole result is in Jobs)`;
      return `${head}: ${ended}.\n${asQuotedData("job result", text, WRITER[j.engine])}`;
    }).join("\n");
  },
};

/**
 * Steering a job that is working (lib/jobs.ts tell): a change, the answer to
 * what it asked, or a stop. What it is told is the person's latest message,
 * word for word and nothing the model wrote: so never in a routine or for a
 * bot, where nobody said anything.
 */
const jobControl: Tool = {
  name: "job_control",
  pace: "fast",
  description:
    "Steer a background job of theirs: 'correct' passes on a change, 'answer' their answer to its " +
    "question, 'stop' ends it. It is told their latest message as they said it. Never answer for them.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["correct", "answer", "stop"] },
      job: { type: ["string", "null"], description: "Words from its title, or the question answered; null for the only one." },
    },
    required: ["op", "job"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const said = ownPart(ctx.asked ?? "");
    if (!said) return "Only the user can do that, in their own words.";
    const op = args.op === "answer" || args.op === "stop" ? args.op : "correct";
    const want = wordsOf(typeof args.job === "string" ? args.job : "");
    const atWork = (await state.listJobs()).filter((j) => j.status === "running" && (op === "stop" || j.engine === "jarvis") && maySteer(j, ctx.env, ctx.grants));
    if (op === "answer") {
      // One answer is to one question: the one its words name, with its job's title; the only one, whatever they are.
      const open = atWork.flatMap((j) => openQuestions(j.asked).map((q) => ({ j, q })));
      if (!open.length) return "No job of theirs is waiting for an answer.";
      const to = nearest(open, want, ({ j, q }) => `${j.title} ${q.text}`);
      if (to.length > 1) {
        return `More than one question waits. For each their message answers, and no other, call this again with words of that question as \`job\`:\n${asQuotedData("job question", to.map(({ j, q }) => `${j.title}: ${asksSaid([q])}`).join("\n"), WRITER.jarvis)}`;
      }
      return told(to[0]!.j, await state.tellJob(to[0]!.j.id, { text: said, question: to[0]!.q.id }));
    }
    const fits = nearest(atWork, want, (j) => j.title, true);
    if (!fits.length) return `No job of theirs at work is called that.${atWork.length ? ` At work: ${atWork.map((j) => `"${j.title}"`).join(", ")}.` : ""}`;
    if (fits.length > 1) return `More than one is: ${fits.map((j) => `"${j.title}"`).join(", ")}. Ask which, and say its title.`;
    const j = fits[0]!;
    if (op === "stop") {
      const r = await state.cancelJob(j.id);
      return typeof r === "string" ? `Not stopped: ${r}.` : `Stopped "${j.title}".`;
    }
    return told(j, await state.tellJob(j.id, { text: said }));
  },
};

/** What came of telling a job something. */
const told = (j: Job, r: Job | string): string =>
  typeof r === "string" ? `Not passed on: ${r}.` : `Passed on to "${j.title}", in their words: it takes it in at its next step. Say so, briefly.`;

/**
 * Those most of `want` names, by the start of their words: the model calls a
 * job by what it was about ("the power bank comparison"), not by its title.
 * With no words, all of them; with none that fit, all, or where `named` (a
 * change or a stop is not given to whatever is there) none, as where a third
 * of the words or fewer fit.
 */
function nearest<T>(all: readonly T[], want: readonly string[], words: (x: T) => string, named = false): T[] {
  const fit = all.map((x) => {
    const has = wordsOf(words(x));
    return want.filter((w) => has.some((h) => h.startsWith(w))).length;
  });
  const best = Math.max(0, ...fit);
  if (named && want.length && best * 3 <= want.length) return [];
  return all.filter((_, i) => fit[i] === best);
}

export const jobTools: Tool[] = [startJob, jobControl, jobResults];
