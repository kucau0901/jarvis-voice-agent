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
  /** The stronger model, for hard work. */
  mode?: "thorough";
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
  told?: { at: number; text: string; taken?: true; to?: string; card?: true }[];
}

/** What it is doing this moment. */
export function nowDoing(j: JobView): string {
  if (j.waiting) return j.waiting.for === "you" ? "Waiting for your answer" : "Waiting for the ChatGPT plan";
  if (j.wrapping) return `Writing what it has: ${j.wrapping}`;
  const on = [...new Set((j.doing ?? []).map((t) => (t === "web_search" ? "Searching the web" : doing(t))))];
  return on.length ? on.join(", ") : "Thinking";
}

/** How far it has got down its list; null with none. A dropped line is settled, and is not counted as done. */
export function progress(j: JobView): string | null {
  const of = (j.todo ?? []).filter((t) => t.state !== "dropped").length;
  return of ? `${(j.todo ?? []).filter((t) => t.state === "done").length} of ${of}` : null;
}

/** What it may look at, do and take. */
export function powers(j: JobView): string {
  const looks =
    j.reach === "web"
      ? "Searches the web, and has nothing of yours but what it was asked."
      : "Reads your own things, as far as you may: mail, calendar, memory, house, car and cameras. Does not search the web.";
  const takes = j.limits ? ` Up to ${j.limits.minutes} minutes and ${j.limits.steps} steps, ${j.limits.going} while its list moves.` : "";
  return `${looks} Never acts: what it would do, it proposes.${j.mode === "thorough" ? " On the stronger model." : ""}${takes}`;
}

/** The last things its person told it, oldest first, and whether each has reached it. */
export function heard(j: JobView): { said: string; state: string }[] {
  const late = j.status !== "running" || !!j.wrapping;
  return (j.told ?? [])
    .slice(-3)
    .map((t) => ({
      said: t.card ? "You changed its card" : t.to ? `Your answer: ${t.text}` : `You said: ${t.text}`,
      state: t.taken ? "taken in" : late ? "came too late" : "reaches it at its next step",
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
