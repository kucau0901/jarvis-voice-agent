import { doing } from "./steps.ts";

/**
 * A background job (src/worker/lib/jobs.ts) in words, for whoever started it:
 * what it is doing now, what it may do, how far it has got. Written by code
 * from what the server says it was handed, never by a model. No DOM, so node
 * can test it (test/steps.test.ts); ui/JobLive.ts draws it.
 */

export interface JobCard {
  outcome: string;
  limits: string[];
  assumptions: string[];
}

export interface Todo {
  text: string;
  state: "open" | "doing" | "done" | "dropped";
  why?: string;
}

/** A question a job put to its person, with its choices where it gave any. */
export interface JobAsk {
  id: string;
  at: number;
  text: string;
  choices: string[];
}

/** One it put, and what came of it: their answer, or that they went on without it, or none came in time. */
export interface JobAsked extends JobAsk {
  answer?: { at: number; text: string };
  over?: "skipped" | "late";
}

/** A file it made, to save. */
export interface JobFile {
  n: number;
  name: string;
  size: number;
  at: number;
}

/** One of its helpers (src/worker/lib/job-helpers.ts): its number, what it is on, its list, and why it has no report, or what it ran out of with one. */
export interface JobHelper {
  n: number;
  name: string;
  state: "working" | "reported" | "stopped";
  doing?: string[];
  todo?: Todo[];
  why?: string;
}

/** A command it ran in the workshop, and how it ended; no `code` while it is running, or if that was never learned. `by`, its helper of that number. */
export interface JobRan {
  at: number;
  cmd: string;
  p?: string;
  by?: number;
  code?: number | string | null;
  ms?: number;
  late?: true;
  full?: true;
}

export interface JobView {
  id: string;
  title: string;
  task: string;
  engine: "jarvis" | "hermes" | "research";
  status: "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  steps: number;
  summary?: string;
  result?: string;
  hasResult?: boolean;
  error?: string;
  /** What it could not do, and what it took for granted. */
  missing?: string[];
  assumed?: string[];
  deliveredBy?: string | null;
  /** Dollars so far, at OpenAI's prices; null when the model has no listed price. */
  cost?: number | null;
  /** Research as a team: how many teams reported and, while it runs, which part it is in. */
  team?: { of: number; reported: number; phase?: "planning" | "teams" | "merging" | "checking" };
  /** What it may look at: your own things, or the web. */
  reach?: "private" | "web";
  /** The stronger model, for hard work; or it makes files, in the workshop. */
  mode?: "thorough" | "files";
  /** It builds something, to publish with a tap; and the repository it works on, with no search of the web. */
  build?: true;
  repo?: string;
  /** The specialty you named for it (ui/Specialties.ts). */
  using?: { id: string; name: string };
  /** The project of yours it is in (ui/Projects.ts). */
  project?: { id: string; name: string };
  /** Started with helpers: none until it gives its work out, then each of them. */
  helpers?: JobHelper[];
  /** It outgrew one conversation, and went on from its notes: how often. */
  carried?: number;
  /** What it made, and what it ran: the last of it while it works, all that is kept with the whole. */
  files?: JobFile[];
  ran?: JobRan[];
  /**
   * Waiting until then: for the ChatGPT plan, at its limit (`key`, when it may go on with the API key instead, and
   * what it has used would have cost there); or for you, with nothing left to do until you answer.
   */
  waiting?: { for: "plan" | "you"; until: number; key?: { soFar: number | null } };
  /** What it asks you and has not been answered, while it works. */
  asks?: JobAsk[];
  /** With the whole of it: all it asked. */
  asked?: JobAsked[];
  /** Moved to the API key rather than wait. */
  onKey?: boolean;
  /** Research into a table: its columns, and how many rows it came back with, to download. */
  table?: { columns?: string[]; rows?: number };
  /** What it set out to do, which its person may change while it works, and its checklist. */
  card?: JobCard;
  todo?: Todo[];
  /** The tools its step is running now. */
  doing?: string[];
  /** What it may take; and, out of that, of what: it is writing what it has. */
  limits?: { steps: number; going: number; minutes: number };
  wrapping?: string;
  /** What its person told it while it worked, and whether a step has had it: an answer (`to`), a change to its card, or their words. */
  told?: { at: number; text: string; taken?: true; helped?: true; to?: string; card?: true }[];
}

/** What it is doing this moment. */
export function nowDoing(j: JobView): string {
  if (j.waiting) return j.waiting.for === "you" ? "Waiting for your answer" : "Waiting for the ChatGPT plan";
  if (j.wrapping) return `Writing what it has: ${j.wrapping}`;
  const out = atWork(j);
  if (out) return `${out} of ${j.helpers!.length} helpers at work`;
  return doings(j.doing);
}

/** Its helpers still at work. */
const atWork = (j: JobView): number => (j.helpers ?? []).filter((h) => h.state === "working").length;

function doings(tools: readonly string[] | undefined): string {
  const on = [...new Set((tools ?? []).map((t) => (t === "web_search" ? "Searching the web" : doing(t))))];
  return on.length ? on.join(", ") : "Thinking";
}

/** What one of its helpers is doing, or how it ended. The job waiting, so does it; the job over, whatever it was on is. */
export function helperNow(h: JobHelper, j: Pick<JobView, "status" | "waiting">): string {
  if (h.state === "reported") return h.why ? `Part done: ${h.why}, and it reported what it had` : "Done: it has reported to the job";
  if (h.state === "stopped") return `Came back with nothing: ${h.why ?? "it was stopped"}`;
  if (j.status !== "running") return "Ended with the job";
  return j.waiting?.for === "plan" ? "Waiting for the ChatGPT plan" : doings(h.doing);
}

/** How far it has got down its list; null with none. A dropped line is settled, and is not counted as done. */
export function progress(j: Pick<JobView, "todo">): string | null {
  const of = (j.todo ?? []).filter((t) => t.state !== "dropped").length;
  return of ? `${(j.todo ?? []).filter((t) => t.state === "done").length} of ${of}` : null;
}

/** What it may look at, do and take. */
export function powers(j: JobView): string {
  const looks = j.repo
    ? `Has the files of ${j.repo}, and nothing else of yours but what it was asked. Does not search the web.`
    : j.reach === "web"
      ? "Searches the web, and has nothing of yours but what it was asked."
      : "Reads your own things, as far as you may: mail, calendar, memory, house, car and cameras. Does not search the web.";
  const takes = j.limits ? ` Up to ${j.limits.minutes} minutes and ${j.limits.steps} steps, ${j.limits.going} while its list moves.` : "";
  const makes = j.build ? " Builds with programs of its own, on a machine with no network, and puts what it made to you to publish." : j.mode === "files" ? " Makes files with programs of its own, on a machine with no network, and gives them to you to save." : "";
  const splits = j.helpers ? " Splits its work between up to three helpers of its own, who may read what it may and nothing more." : "";
  const way = j.using ? ` Follows “${j.using.name}”, of your specialties${j.reach === "web" ? ", which goes with it to the web" : ""}.` : "";
  const part = j.project ? ` Part of “${j.project.name}”: its rules, its files${j.reach === "web" ? ", which go with it to the web" : " and what its last jobs found"}.` : "";
  return `${looks}${makes}${splits}${way}${part} Never acts: what it would do, it proposes.${j.mode === "thorough" ? " On the stronger model." : ""}${takes}`;
}

/** A file's size, as a person says it. */
export const sizeSaid = (bytes: number): string =>
  bytes < 1000 ? `${bytes} bytes` : bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

/** How a command it ran ended; `over`, its job is too. */
export function ended(r: JobRan, over = false): string {
  const took = r.ms === undefined || r.ms < 100 ? "" : r.ms < 60_000 ? `${(r.ms / 1000).toFixed(1)} s` : `${Math.round(r.ms / 60_000)} min`;
  if (r.full) return "stopped: it filled its folder, or the disk";
  if (r.late) return `stopped, out of time${took ? ` after ${took}` : ""}`;
  if (r.code === undefined) return over ? "ended with the job" : r.p ? "left running" : "running";
  return r.code === 0 ? took || "done" : `failed (${r.code ?? "stopped"})${took ? `, ${took}` : ""}`;
}

/** The last things its person told it, oldest first, and whether each has reached it. */
export function heard(j: JobView): { said: string; state: string }[] {
  const late = j.status !== "running" || !!j.wrapping;
  const next = (t: { to?: string; helped?: true }) => (!atWork(j) ? "reaches it at its next step" : t.to ? "reaches it when its helpers are done" : t.helped ? "its helpers have it; it does when they are done" : "reaches its helpers at their next step");
  return (j.told ?? [])
    .slice(-3)
    .map((t) => ({
      said: t.card ? "You changed its card" : t.to ? `Your answer: ${t.text}` : `You said: ${t.text}`,
      state: t.taken ? "taken in" : late ? "came too late" : next(t),
    }));
}

/** What came of a question, as whoever was asked reads it; null while it may still be answered. */
export function cameOf(q: JobAsked, j: Pick<JobView, "status" | "told">): string | null {
  // Kept at the same moment (src/worker/lib/jobs.ts tell): whether a step had it.
  const unheard = q.answer && j.status !== "running" && j.told?.some((t) => t.to && t.at === q.answer!.at && !t.taken);
  if (q.answer) return `You answered: ${q.answer.text}${unheard ? " (too late: it ended before it had that)" : ""}`;
  if (q.over === "skipped") return "You chose to go on without an answer.";
  if (q.over === "late") return "No answer came in time, and it went on without one.";
  return j.status === "running" ? null : "It ended before this was answered.";
}

/** A result's words without the line that names its files (src/worker/lib/jobs.ts finish), where each is there to save. */
export const beside = (a: { text: string; made?: readonly unknown[] }): string => (a.made?.length ? a.text.replace(/\n\nIn Jobs to download: [^\n]*$/, "") : a.text);

/** A question's alert (src/worker/lib/jobs.ts askAlert): the question, and its choices. */
export function askOf(text: string): { question: string; choices: string[] } {
  const [question = "", list] = text.split("\n\n- ");
  return { question, choices: list ? list.split("\n- ") : [] };
}

/** The same, said aloud: whose question it is first, so that it is never heard as Jarvis's own. */
export function askSaid(title: string, text: string): string {
  const { question, choices } = askOf(text);
  return `Your background job asks, about ${title.replace(/^A question: /, "")}. ${question}${choices.length ? ` ${choices.join(", ")}.` : ""}`;
}

/** A card's list as it is typed, a line each. */
export const linesOf = (typed: string): string[] => typed.split("\n").map((l) => l.trim()).filter(Boolean);
