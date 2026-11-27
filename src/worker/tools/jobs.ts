import type { Tool, ToolContext } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER, callerWho, maySteer, mayWork } from "../lib/context.ts";
import { harderOf, wordsOf, type Job } from "../lib/jobs.ts";
import { flagLines } from "../lib/job-results.ts";
import { tells } from "../lib/job-brief.ts";
import { textIn } from "../lib/skill-md.ts";
import { asksSaid, openQuestions } from "../lib/job-tools.ts";
import { asQuotedData, ownPart } from "../lib/quote.ts";
import { WILDCARD, allows } from "../lib/scopes.ts";
import { asFiles } from "../lib/photos.ts";
import { workshopBring, workshopConfig } from "../lib/workshop.ts";
import { repoNamed, reposOf } from "../lib/github.ts";
import { computersOf } from "../lib/devices.ts";
import { namesClaudeCode } from "../lib/mac-build.ts";
import { clampLimit, nearest } from "./args.ts";

/** As much of what goes with a job on the web as is looked through for who they are (lib/job-brief.ts). */
const LOOKED_THROUGH = 400_000;

/** What a person's names and addresses are, to look for in what goes to the web (lib/job-brief.ts). */
const known = async (ctx: ToolContext) => ({
  names: [ctx.env.JARVIS_PERSON_NAME ?? "", ctx.env.JARVIS_PERSON_NICKNAME ?? "", ...((await stateStub(ctx.env)?.familyPeople().catch(() => [])) ?? []).map((p) => p.name)],
  addresses: [...ctx.memory.facts, ...(ctx.memory.family?.facts ?? [])].flatMap((f) => (f.address ? [f.address] : [])),
});

/** Why a brief may not go to the web, what it says of who they are (lib/job-brief.ts) named; null when it may. */
export async function webBrief(brief: string, ctx: ToolContext): Promise<string | null> {
  const said = tells(brief, await known(ctx), ctx.asked ?? "");
  return said.length
    ? `the brief says ${said.map((s) => `"${s}"`).join(", ")}. A job on the web is told nothing of who the user is, their family, ` +
      "or exactly where they live: start it again without, as 'the user' and at most their town. Only what they themselves said in this " +
      "message may be in it; if they want that looked up, ask them to say so."
    : null;
}

/** The state object, to hand to a helper. */
type State = NonNullable<ReturnType<typeof stateStub>>;

/**
 * Why a job on the web may not have this specialty or project of theirs, what
 * it says of who the user is (lib/job-brief.ts) named; null when it may.
 */
async function webWith(ctx: ToolContext, state: State, person: string, used: { id: string; name: string } | null, project: { id: string; name: string; rules: readonly string[]; files: readonly { n: number }[] } | null): Promise<string | null> {
  /** Why what goes with it may not; null when it may. */
  const stays = async (name: string, words: string[], files: ({ name: string; bytes: Uint8Array } | null)[], where: string): Promise<string | null> => {
    const read = files.map((f) => (f ? textIn(f.bytes) : null));
    if (read.includes(null)) return `Not started: "${name}" has a file nothing here can look through, and a job on the web is told nothing of who the user is. They can start it themselves in Jobs, or it can be started on their own things.`;
    const all = [...words, ...files.map((f) => f!.name), ...read].join("\n");
    if (all.length > LOOKED_THROUGH) return `Not started: "${name}" is more than can be looked through here, and a job on the web is told nothing of who the user is. They can start it themselves in Jobs, or it can be started on their own things.`;
    const said = tells(all, await known(ctx), ctx.asked ?? "");
    return said.length
      ? `Not started: "${name}", which they named, says ${said.slice(0, 5).map((s) => `"${s.slice(0, 60)}"`).join(", ")}${said.length > 5 ? ` and ${said.length - 5} more` : ""}, and a job on the web is told nothing of who the user is, their family, or exactly where ` +
        `they live. Start it on their own things, or without it, with what is needed of it in the brief; or they can change it in ${where}.`
      : null;
  };
  const w = used ? await state.specialtyWhole(person, used.id) : null;
  return (
    (w ? await stays(w.specialty.name, [...w.specialty.when, ...w.specialty.steps, w.specialty.why ?? "", w.more.text ?? ""], await Promise.all((w.more.files ?? []).map((f) => state.specialtyFile(person, w.specialty.id, f.n))), "Memory → Specialties") : null) ??
    (project ? await stays(project.name, [...project.rules], await Promise.all(project.files.map((f) => state.projectFile(person, project.id, f.n))), "Jobs → Projects") : null)
  );
}

/**
 * Starting a background job by voice (lib/jobs.ts). The job keeps the
 * caller's grants, and reads but never acts.
 */
const startJob: Tool = {
  name: "start_job",
  pace: "fast",
  description:
    "Start a background job for what needs many steps or several minutes: comparing, going " +
    "through a lot of mail or calendar, planning a trip, checking many things. The result reaches the " +
    "user as a message and in Jobs. " +
    "It reads and never acts; what it would do, it proposes. It reads ONE side (`reach`): 'private', " +
    "the user's own mail, calendar, memory, house, car and cameras, without the web; or 'web', without " +
    "any of those. For work that needs both (a trip around their diary), read the private part here " +
    "first and put only the facts it needs in `task`. Write `task` as a complete brief, names resolved: " +
    "it will not see the conversation, and the user can read it. Tell them it has started and, on the " +
    "web, which of their facts it was given. Answer quick questions now. " +
    "Set research to 'yes' only when asked for research in depth ('research…', 'dig into…', 'find " +
    "out everything about…'): a stronger model, searching widely, 10 to 40 minutes, roughly one to two " +
    "dollars, a report with its sources. 'team' only when asked for research as a team in so many " +
    "words: three teams from different angles sharing what they find, 20 to 55 minutes, roughly four " +
    "to seven dollars. 'table' for a list or table of many items found and compared ('the 10 " +
    "cheapest…', 'every dentist near…', 'a spreadsheet of…'): the same team fills rows, to download " +
    "as CSV, same cost and time. Else 'no'. Say the time and cost when you start any.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words to list it by, e.g. 'Dashcams under RM800'." },
      task: { type: "string", description: "The complete brief." },
      reach: { type: "string", enum: ["private", "web"], description: "Research is always the web." },
      mode: {
        type: "string",
        enum: ["ordinary", "thorough", "files", "build"],
        description: "'thorough' only if asked, or to weigh many things together: a stronger, dearer model. 'files' makes files to download. " +
          "'build' builds a site or changes code, on the web alone, for the user to publish with a tap.",
      },
      helpers: { type: "boolean", description: "Only if asked for: up to three share the work." },
      research: { type: "string", enum: ["no", "yes", "team", "table"] },
    },
    required: ["title", "task", "reach", "mode", "helpers", "research"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Background jobs cannot run on this deployment: it has no state object.";
    const research = args.research === "yes" || args.research === "team" || args.research === "table";
    const table = args.research === "table";
    const team = args.research === "team" || table;
    // Building is the web's: it has nothing of theirs.
    const build = !research && args.mode === "build";
    const reach = build ? "web" : args.reach;
    // Research spends the family's monthly allowance: for the family, not a guest.
    if (research && !allows(ctx.grants, "routines")) {
      return "Not started: research in depth is for the family, and this person may not start it. Offer an ordinary job, or to answer now.";
    }
    // What goes to the web says nothing of who they are: looked at by code, since the model knows it all (lib/job-brief.ts).
    if (research || reach === "web") {
      const no = await webBrief(`${String(args.title ?? "")}\n${String(args.task ?? "")}`, ctx);
      if (no) return `Not started: ${no}`;
    }
    // One of their specialties, named in the brief: it is given to the job whole (lib/job-specialties.ts).
    // On the web only one they themselves named just now: what they read may have had a word in the brief.
    const person = ctx.env.JARVIS_PERSON || OWNER;
    const mine = ownPart(ctx.asked ?? "");
    const used = !research && allows(ctx.grants, "memory.read") ? await state.specialtyNamed(person, reach === "web" ? [mine] : [mine, String(args.title ?? ""), String(args.task ?? "")]).catch(() => null) : null;
    // And its project, the same way (lib/job-project.ts).
    const project = !research && allows(ctx.grants, "memory.read") ? await state.projectNamed(person, reach === "web" ? [mine] : [mine, String(args.title ?? ""), String(args.task ?? "")]).catch(() => null) : null;
    if (reach === "web") {
      const no = await webWith(ctx, state, person, used, project);
      if (no) return no;
    }
    // The owner's repository it works on: one an admin named just now, in their own words. It may be private, so that job searches nothing.
    const repos = build && ctx.grants.includes(WILDCARD) ? repoNamed(reposOf(ctx.env), mine) : [];
    if (repos.length > 1) return `Not started: they named ${repos.join(" and ")}, and a job works on one: ask which, or start one for each with its name in their words.`;
    // Claude Code on their Mac writes it, where they asked for that in their own words and may have it (lib/mac-build.ts).
    const wantsClaude = build && !repos.length && namesClaudeCode(mine);
    const claudeWhy = !wantsClaude ? "" : !allows(ctx.grants, "computer") ? "Claude Code on a Mac is not theirs to use, so the job writes it itself. " : !(await computersOf(ctx.env, person)).length ? 'No Mac of theirs is linked (the Jarvis desktop app, "Let Jarvis control this Mac"), so the job writes it itself. ' : "";
    const claude = wantsClaude && !claudeWhy;
    const makes = !research && (args.mode === "files" || build);
    const shop = makes ? workshopConfig(ctx.env) : null;
    if (makes && (!shop || !allows(ctx.grants, "workshop"))) {
      return `Not started: ${build ? "building" : "making files"} needs the workshop, which ${shop ? "this person or device may not use" : "is not set up here (Settings → Workshop)"}. Offer an ordinary job, whose answer is words.`;
    }
    // What they attached goes to a job on their own things only: on the web it would be something of theirs beside a search.
    const brought = shop && reach !== "web" ? asFiles(ctx.attached) : [];
    // Counted, not named: a name is its author's words, and list_files gives it quoted.
    const task = `${String(args.task ?? "")}${brought.length ? `\n\n(In its folder, from the user: ${brought.length === 1 ? "a file" : `${brought.length} files`}.)` : ""}`;
    // So do the stronger model and helpers cost: a guest's job is an ordinary one.
    const thorough = !research && args.mode === "thorough" && allows(ctx.grants, "routines");
    // And only where somebody asked, in words of their own: not a routine, a bot or a page.
    const helpers = !research && args.helpers === true && allows(ctx.grants, "routines") && !!ownPart(ctx.asked ?? "");
    const j = await state.createJob(
      { title: args.title, task, engine: research ? "research" : "jarvis", reach, ...(thorough ? { mode: "thorough" } : build ? { mode: "build", ...(repos[0] ? { repo: repos[0] } : claude ? { coder: "claude_code" } : {}) } : shop ? { mode: "files" } : {}), ...(helpers ? { helpers: true } : {}), ...(used ? { specialty: used.id } : {}), ...(project ? { project: project.id } : {}), ...(team ? { team: true } : {}), ...(table ? { table: true } : {}) },
      { who: callerWho(ctx.env), grants: ctx.grants },
    );
    if (typeof j === "string") return `Not started: ${j}.`;
    for (const f of brought) {
      try {
        await workshopBring(shop!, j.id, f.name, f.bytes, ctx.signal);
      } catch (e) {
        await state.cancelJob(j.id);
        return `Not started: what they attached could not be given to it (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
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
      : `Started "${j.title}" ${j.repo ? `on the repository ${j.repo}, without the web` : j.reach === "web" ? "on the web, with only what its brief says of the user" : "on the user's own things, without the web"}. ` +
        `${brought.length ? `It has what they attached (${brought.length === 1 ? "one file" : `${brought.length} files`}). ` : shop && asFiles(ctx.attached).length ? "It was NOT given what they attached: a job on the web has nothing of theirs. " : ""}` +
        `${build && !j.repo && reposOf(ctx.env).length && ctx.grants.includes(WILDCARD) ? "It was given NO repository: they named none of those listed (Settings → GitHub). " : ""}` +
        `${j.coder ? "Claude Code on their Mac writes it, once they tap the card the job puts to them with what it found. " : claudeWhy}` +
        `${used ? `It uses their specialty "${used.name}". ` : ""}${project ? `It is in their project "${project.name}". ` : ""}` +
        `${!research && args.helpers === true && !helpers ? "It has NO helpers: those are for the family, when one of them asks. " : ""}` +
        `It usually takes ${j.mode === "thorough" ? `ten minutes or more, with a stronger model${j.help ? " and helpers" : ""}` : j.help ? "ten minutes or so, splitting the work between helpers" : "a few minutes"}; the result${shop ? ", with its files to download," : ""} will reach the user as a message. Tell them so.`;
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
        description: "Words of its title, brief or answer, e.g. 'dashcam'. Null for the latest.",
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
      // Its title and brief, and what came of it.
      const has = wordsOf(`${j.title} ${j.task} ${j.summary ?? ""} ${j.result ?? ""}`);
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
    "question, 'stop' ends it. It is told their latest message as they said it. Never answer for them. " +
    "'remove' deletes one with its files; 'harder' tries a finished one again with the stronger model, at several times the cost.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["correct", "answer", "stop", "remove", "harder"] },
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
    const want = wordsOf(typeof args.job === "string" ? args.job : "");
    if (args.op === "remove" || args.op === "harder") return finished(args.op, want, state, ctx);
    const op = args.op === "answer" || args.op === "stop" ? args.op : "correct";
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

/**
 * Removing one of theirs, with its files and what it waits on an OK for, as
 * Remove in Jobs does; or a finished ordinary one tried again harder, as its
 * button fills the form there (lib/jobs.ts harderOf). Their asking is the press
 * of Start: nothing is spent because a model judged its own work poor.
 */
async function finished(op: "remove" | "harder", want: readonly string[], state: State, ctx: ToolContext): Promise<string> {
  const theirs = (await state.listJobs()).filter((j) => mayWork(j, ctx.env, ctx.grants) && (op === "remove" || typeof harderOf(j) !== "string"));
  const fits = nearest(theirs, want, (j) => j.title, true);
  if (!fits.length) return `No job of theirs ${op === "harder" ? "that can be tried again harder " : ""}is called that.${theirs.length ? ` Theirs: ${theirs.slice(0, 8).map((j) => `"${j.title}"`).join(", ")}.` : ""}`;
  if (fits.length > 1) return `More than one is: ${fits.slice(0, 8).map((j) => `"${j.title}"`).join(", ")}. Ask which, and say its title.`;
  const j = fits[0]!;
  if (op === "remove") return (await state.removeJob(j.id)) ? `Removed "${j.title}", with its files; anything it waited on their OK for is withdrawn.` : `"${j.title}" is gone already.`;
  // The stronger model costs several times as much: the family's, as in Jobs.
  if (!allows(ctx.grants, "routines")) return "Not started: trying again harder uses the stronger model, which is for the family, and this person may not.";
  const again = harderOf(j);
  if (typeof again === "string") return `Not started: ${again}.`;
  const named = allows(ctx.grants, "memory.read");
  const start = { ...again, ...(named ? {} : { specialty: undefined, project: undefined }) };
  if (start.reach === "web") {
    const no = await webBrief(`${start.title}\n${start.task}`, ctx);
    if (no) return `Not started: ${no}`;
    // As it is now, which may not be as it was when the first one went.
    const person = ctx.env.JARVIS_PERSON || OWNER;
    const project = start.project ? ((await state.projectsOf(person)).find((p) => p.id === start.project) ?? null) : null;
    const theirsNow = await webWith(ctx, state, person, start.specialty && j.using ? j.using : null, project);
    if (theirsNow) return theirsNow;
  }
  const n = await state.createJob(start, { who: callerWho(ctx.env), grants: ctx.grants });
  if (typeof n === "string") return `Not started: ${n}.`;
  ctx.started?.({ id: n.id, title: n.title, engine: n.engine });
  const left = (j.told ?? []).some((t) => t.to || t.card) ? " What they answered it, and changed on its card, is not in it: theirs to say again if it still holds." : "";
  return `Started "${n.title}" again with the stronger model, ${n.reach === "web" ? "on the web" : "on their own things"}, with what they told it as it worked. It usually takes ten minutes or more, at several times the cost; the result will reach the user as a message.${left} Tell them so.`;
}

/** What came of telling a job something. */
const told = (j: Job, r: Job | string): string =>
  typeof r === "string" ? `Not passed on: ${r}.` : `Passed on to "${j.title}", in their words: it takes it in at its next step. Say so, briefly.`;

export const jobTools: Tool[] = [startJob, jobControl, jobResults];
