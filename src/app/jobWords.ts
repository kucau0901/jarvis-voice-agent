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
  /** Waiting for the ChatGPT plan, at its limit, until then; `key`, when it may go on with the API key instead, and what it has used would have cost there. */
  waiting?: { for: "plan"; until: number; key?: { soFar: number | null } };
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
  /** What its person changed while it worked, and whether a step has had it. */
  told?: { at: number; text: string; taken?: true }[];
}

/** What it is doing this moment. */
export function nowDoing(j: JobView): string {
  if (j.waiting) return "Waiting for the ChatGPT plan";
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

/** Whether what its person last changed has reached it; null when nothing was changed. */
export function heard(j: JobView): string | null {
  const last = j.told?.at(-1);
  if (!last) return null;
  if (last.taken) return "Your change was taken in.";
  return j.status === "running" && !j.wrapping ? "Your change reaches it at its next step." : "Your last change came too late.";
}

/** A card's list as it is typed, a line each. */
export const linesOf = (typed: string): string[] => typed.split("\n").map((l) => l.trim()).filter(Boolean);
