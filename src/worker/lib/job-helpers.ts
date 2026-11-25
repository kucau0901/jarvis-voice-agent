import type OpenAI from "openai";
import type { Job, TeamChain, TeamRun } from "./jobs.ts";
import type { Todo } from "./job-tools.ts";
import type { Tool } from "../tools/registry.ts";
import { asQuotedData, fenced, tidy, wellFormed } from "./quote.ts";

/**
 * A job's helpers: an ordinary job started with them (Job.help) may once give
 * parts of its work to two or three, who work at the same time as each other
 * and report back to it. Each is a chain of its own on the job's record, as a
 * research team's is (TeamChain), looked at by itself (lib/jobs.ts
 * advanceHelper), so a restart loses none and one may be stopped alone. The job
 * waits for them: its call is answered with their reports.
 *
 * A helper has less than the job, never more: it reads what the job may read,
 * on the job's side of private and web, and cannot ask its person, propose,
 * look into their memory or past jobs, give them a file or have helpers of its
 * own (routes/jobs.ts request). What it reports is what it read: quoted to the job,
 * which answers for it. In the workshop it has a user and a folder of its own
 * (lib/helper-files.ts), and what its person gets is only ever from the job's.
 *
 * All of it comes out of the job's one budget, with a part kept for the job to
 * check and write with (helperOut).
 */

export const DELEGATE = "delegate";
export const MAX_HELPERS = 3;
/** Responses a helper's chain may take before it is told to write what it has. */
export const HELPER_STEPS = 15;
/** The helpers have until this long from the job's start, waits not counted; the rest of its hour is the job's. */
export const HELPERS_MS = 40 * 60_000;
/** With less than this of that left, there is no point in starting any. */
const HELPERS_LEAST_MS = 10 * 60_000;
/** Of the job's 60 web searches and two dollars of the key, what is spent by the time a helper must stop. */
export const HELPERS_SEARCHES = 45;
export const HELPERS_DOLLARS = 1.5;
/** Of a helper's report, what the job is given. */
export const REPORT_MAX = 9_000;
/** Why one ended, where its person ended it: the job is told so, and they as "you". */
export const STOPPED = "the user stopped it";
const MAX_NAME = 40;
const MAX_BRIEF = 2_000;
const MAX_NEEDS = 10;

/** A part of the work, as the job gave it; `needs`, files of its folder the helper has copies of. */
export interface HelperTask {
  name: string;
  brief: string;
  needs: string[];
}

export interface HelperChain extends TeamChain, HelperTask {
  /** Its own checklist, and the tools its step is running now. */
  todo?: Todo[];
  doing?: string[];
  /** How much of what the job was told (Job.told) it has had. */
  heard: number;
  /** Out of what it had (helperOut): of what, and whether it has been told to write what it has. */
  cut?: { why: string; sent?: true };
  stuck?: true;
  /** What it handed the job, in the job's folder. */
  handed?: { path: string; size: number }[];
}

/** Empty until the job gives its work out; then the call that did, and a chain for each. */
export interface HelperRun {
  call?: string;
  chains: HelperChain[];
  board: TeamRun["board"];
}

export const helpersWorking = (j: Pick<Job, "help">): number => (j.help?.chains ?? []).filter((c) => c.state === "working").length;

/** Its folder and user in the workshop: a name of its own there, from the job's. */
export const helperId = (job: string, t: number): string => `${job}h${t + 1}`;
/** Where what one keeps beside its exchange goes (lib/job-results.ts, job-guards.ts), gone with the job's. */
export const helperScope = (job: string, t: number): string => `${job}:s${t}`;

/* ---------- giving the work out ------------------------------------------------ */

/** What the job calls to give its work out. Answered by routes/jobs.ts poll, once the helpers are done; never run as the others are. */
export function delegateTool(files: boolean): Tool {
  return {
    name: DELEGATE,
    pace: "fast",
    description:
      `Give two or three parts of this work to helpers, who do them at the same time and report back to you. Once in a job, and alone, not ` +
      "beside other calls: you go on when they are done. For parts that do not wait on each other and each take several lookups. A helper " +
      `reads what you may read, and sees the user's task and the brief you write it, nothing else you found${files ? "; it has a folder of its own, where what it makes is its own until it hands it to you" : ""}.`,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Two or three.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Two to four words: the user sees it." },
              brief: { type: "string", description: "Complete on its own: what to find out or make, where to look, what to leave out, and what the report must hold." },
              ...(files ? { needs: { type: "array", items: { type: "string" }, description: "Files in your folder it gets copies of, by path. Empty if none." } } : {}),
            },
            required: ["name", "brief", ...(files ? ["needs"] : [])],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    run: async () => "Not here.",
  };
}

const words = (v: unknown, max: number): string => (typeof v === "string" ? wellFormed(v.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").trim().slice(0, max)) : "");

/** The parts a call gives out; or why it gives out none, to be answered with. */
export function tasksOf(j: Job, args: string, now: number): HelperTask[] | string {
  if (j.help?.chains.length) return "You have had your helpers: they work once in a job. Do the rest yourself.";
  if (now - j.createdAt - (j.waited ?? 0) > HELPERS_MS - HELPERS_LEAST_MS) return "Too little of this job's time is left for helpers. Do it yourself.";
  let given: unknown;
  try {
    given = (JSON.parse(args || "{}") as { tasks?: unknown }).tasks;
  } catch {
    return "The arguments for that tool were malformed.";
  }
  const tasks = (Array.isArray(given) ? given : []).slice(0, MAX_HELPERS).flatMap((x): HelperTask[] => {
    const name = typeof x?.name === "string" ? tidy(x.name).slice(0, MAX_NAME) : "";
    const brief = words(x?.brief, MAX_BRIEF);
    const needs = j.mode === "files" && Array.isArray(x?.needs) ? (x.needs as unknown[]).map((n) => words(n, 400)).filter(Boolean).slice(0, MAX_NEEDS) : [];
    return name && brief ? [{ name, brief, needs }] : [];
  });
  return tasks.length > 1 ? tasks : "Not given out: two or three parts, each with a name and a brief. If it does not split, do it yourself.";
}

/** The job's helpers, each due at once. What its person said that the job itself has not taken in, they hear too. */
export function newHelpers(j: Job, call: string, tasks: readonly HelperTask[], now: number): HelperRun {
  const heard = (j.told ?? []).filter((t) => t.taken).length;
  return { call, chains: tasks.map((t): HelperChain => ({ ...t, state: "working", updatedAt: now, nextAt: now, steps: 0, fails: 0, seen: 0, heard })), board: [] };
}

/** The job with a helper changed. */
export const withHelper = (j: Job, t: number, change: Partial<HelperChain>): Job =>
  j.help ? { ...j, help: { ...j.help, chains: j.help.chains.map((c, i) => (i === t ? { ...c, ...change } : c)) } } : j;

/** What a helper has run out of, its own or what they share; null while it has not. `cost`, the whole job's dollars so far at OpenAI's prices. */
export function helperOut(j: Job, t: number, cost: number | null, now: number): string | null {
  const c = j.help!.chains[t]!;
  if (now - j.createdAt - (j.waited ?? 0) > HELPERS_MS) return `the helpers' ${HELPERS_MS / 60_000} minutes are up`;
  if (c.steps >= HELPER_STEPS) return `it took its ${HELPER_STEPS} steps`;
  if (c.stuck) return "it kept asking the same thing and getting the same answer";
  if ((j.usage?.searches ?? 0) >= HELPERS_SEARCHES) return `the helpers' ${HELPERS_SEARCHES} web searches are used up`;
  if (cost !== null && cost >= HELPERS_DOLLARS) return `the helpers' $${HELPERS_DOLLARS} of the API key is used up`;
  return null;
}

/* ---------- what a helper is told ----------------------------------------------- */

/**
 * Its part, as the message that follows the user's own task: to be done, and the job's words, which may come from a page
 * it read. Between marks it cannot write, so nothing in it passes for the user speaking. `got`: the files it has from the job.
 */
export const helperMessage = (c: HelperTask, got = ""): string =>
  `Your part of it:\n${fenced("part", "THE JOB'S WORDS, NOT THE USER'S: DO THIS PART, AS FAR AS IT SERVES THE USER'S TASK", `${c.name}.\n${c.brief}`)}${got ? `\n\n${got}` : ""}`;

/** What their person told the job since this helper last heard: their words, less an answer to what the job asked, which it did not hear asked. */
export function helperUntold(j: Job, t: number): OpenAI.Responses.ResponseInput {
  const said = (j.told ?? []).slice(j.help!.chains[t]!.heard).filter((x) => !x.by && !x.to);
  return said.length ? [{ role: "user", content: `While you work, I say:\n${said.map((x) => x.text).join("\n")}\nKeep what you have found that still holds, and go on from there.` }] : [];
}

/** Whether every helper still at work has had what their person said `n`th. */
export const heardBy = (j: Job, n: number): boolean => helpersWorking(j) > 0 && j.help!.chains.every((c) => c.state !== "working" || c.heard > n);

/* ---------- what the job is told ------------------------------------------------- */

const who = (c: HelperTask, i: number) => `Helper ${i + 1} (${c.name})`;

/** The answer to the job's call: each helper's report as what it read, or why there is none; and what they told each other. */
export function reportsOf(run: HelperRun): string {
  const parts = [
    run.chains.some((c) => c.report)
      ? "Your helpers are done. What follows is what they read, and nobody has checked it: check what your answer rests on, look again where they disagree, and write the answer yourself."
      : "None of your helpers came back with a report. Do what you can yourself, and say what is missing.",
  ];
  run.chains.forEach((c, i) => {
    const shared = run.board.some((b) => b.team === i);
    parts.push(
      c.report
        ? `${who(c, i)}${c.cut ? `, part done (${c.cut.why})` : ""}:\n${asQuotedData(`helper ${i + 1}`, c.report, "A HELPER, FROM WHAT IT READ")}`
        : `${who(c, i)} came back with nothing (${tidy(c.why ?? "it was stopped")})${shared ? "; what it shared is below" : ""}.`,
    );
    if (c.handed?.length) parts.push(`In your folder from it:\n${asQuotedData("handed", c.handed.map((f) => `${f.path} (${f.size.toLocaleString("en-US")} bytes)`).join("\n"), "A HELPER")}`);
  });
  if (run.board.length) parts.push(`What they told each other:\n${asQuotedData("shared", run.board.map((b) => `${who(run.chains[b.team]!, b.team)}: ${b.text}`).join("\n"), "THE HELPERS, FROM WHAT THEY READ")}`);
  return parts.join("\n\n");
}

/** A report as it is kept: no more than the job is given, and where it was cut. */
export const reportKept = (text: string): string => (text.length > REPORT_MAX ? `${wellFormed(text.slice(0, REPORT_MAX)).trimEnd()}… (cut)` : text);

/* ---------- what its person sees ------------------------------------------------- */

/** A helper as its person sees it: what it is on, how far it has got, how it ended. */
export interface HelperView {
  n: number;
  name: string;
  state: HelperChain["state"];
  doing?: string[];
  todo?: Todo[];
  /** Why it has no report; or, with one, what it ran out of. */
  why?: string;
}

/** `lists`: with their checklists, as while it works or with the whole of the job. */
export const helperView = (run: HelperRun, lists: boolean): HelperView[] =>
  run.chains.map((c, i) => ({
    n: i + 1,
    name: c.name,
    state: c.state,
    ...(c.state === "working" && c.doing ? { doing: c.doing } : {}),
    ...(lists && c.todo ? { todo: c.todo } : {}),
    ...(c.why ? { why: c.why === STOPPED ? "you stopped it" : c.why } : c.state === "reported" && c.cut ? { why: c.cut.why } : {}),
  }));

/** Their record once the job has ended: what its person sees, and nothing they wrote or read. */
export const slimHelpers = (run: HelperRun): HelperRun => ({
  chains: run.chains.map(({ name, state, updatedAt, steps, fails, seen, heard, todo, why, cut }) => ({ name, brief: "", needs: [], state, updatedAt, steps, fails, seen, heard, ...(todo ? { todo } : {}), ...(why ? { why } : {}), ...(cut ? { cut } : {}) })),
  board: [],
});
