import type OpenAI from "openai";
import type { Job } from "./jobs.ts";
import type { Storage } from "./state-host.ts";
import { jobRows } from "./job-chain.ts";
import { asksSaid, listed, untold } from "./job-tools.ts";
import { fenced, tidy } from "./quote.ts";

/**
 * A job that outgrows one conversation. At about 200,000 tokens it is asked,
 * once, for a short note of what code does not know (what it decided, what is
 * open, what it has not checked), and goes on in a new conversation from a
 * checkpoint made by code: its person's every word as they said it, its card
 * and checklist, everything it asked its tools, what it proposed, ran and
 * gave. Nothing is thrown away: each answer its tools gave is kept as long as
 * the job works, and read again by its number (lib/job-results.ts).
 *
 * The note is the model's, made from all it read, so it goes back between marks
 * as the job's own and unchecked, never as its person's or Jarvis's. Without
 * one (the call failed) the checkpoint does by itself.
 */

/** A step's input at which it goes on in a new conversation, and how many of those a job may have. */
export const FRESH_AT = 200_000;
export const MAX_FRESH = 3;
const MAX_NOTES = 8_000;
const MAX_ACTS = 200;
const SHOWN_ACTS = 120;
const MAX_ARGS = 160;

/**
 * One call it made: what was asked, and the number its answer is read again by (none for a picture, or a web search,
 * whose pages are not kept). `acted`: it does something, rather than read; `cut`: whether it did was never learned.
 */
export interface Act {
  name: string;
  args: string;
  n?: number;
  acted?: true;
  cut?: true;
}

type Used = { input: number; searches?: number };
/** How long a step's conversation was. What its searches read is counted again at each turn the model took inside it. */
export const contextOf = (u: Used): number => u.input / (1 + (u.searches ?? 0));
/** OpenAI's word for a conversation longer than its model takes, however it came. */
export const tooLong = (e: unknown): boolean => {
  const { code, message } = (e && typeof e === "object" ? e : {}) as { code?: unknown; message?: unknown };
  return code === "context_length_exceeded" || (typeof message === "string" && /context (?:window|length)/i.test(message));
};

/** What a step looked up by itself, as acts: its searches and the pages it opened. */
export function searchActs(output: readonly unknown[]): Act[] {
  return output.flatMap((o) => {
    const { type, action } = (o && typeof o === "object" ? o : {}) as { type?: unknown; action?: { query?: unknown; url?: unknown } | null };
    if (type !== "web_search_call") return [];
    const what = [action?.query, action?.url].find((x): x is string => typeof x === "string" && !!x);
    return what ? [{ name: "web_search", args: what }] : [];
  });
}

const actsKey = (job: string) => `${jobRows(job)}acts`;

/** What only changes or reads back its own record: not work done. */
export const OWN_CALLS: ReadonlySet<string> = new Set(["job_plan", "job_tick", "ask_person", "read_result", "specialty_read"]);

/** A step's calls, as they were answered: kept for the checkpoint. */
export async function noteActs(kept: Storage, job: string, acts: readonly Act[]): Promise<void> {
  if (!acts.length) return;
  const all = (await kept.get<Act[]>(actsKey(job))) ?? [];
  const every = [...all, ...acts.map((a) => ({ ...a, args: tidy(a.args).slice(0, MAX_ARGS) }))];
  // What only read is let go first: what was done is never forgotten.
  let spare = Math.max(0, every.length - MAX_ACTS);
  await kept.put(actsKey(job), every.filter((a) => a.acted || spare-- <= 0));
}

/** Begins what a job is asked when it is to go on in a new conversation, so a step cut short is known for one (routes/jobs.ts). */
export const NOTES_HEAD = "THIS CONVERSATION IS FULL";
export const NOTES_ASK =
  `${NOTES_HEAD}\n` +
  "The job goes on in a new one, where code gives you the user's task and everything they told you, your card and checklist, " +
  "the list of all you asked your tools with each answer to read again by its number, and what you proposed, ran and gave. " +
  "What you read on the web is not kept: whatever of it you will need, write here with its address. " +
  "Write now, for yourself there, only what that does not hold, in under 5,000 characters of plain text:\n" +
  "FOUND: what your answer will rest on, each with its figure or words, its date, and the result or page it came from.\n" +
  "DECIDED: what you decided, and why.\n" +
  "OPEN: what is not settled, and what you were about to do.\n" +
  "UNVERIFIED: what you took from one place, or have not checked.\n" +
  "No tools, and not the answer itself.";

export const GOES_ON =
  "THIS JOB GOES ON HERE\n" +
  "It outgrew one conversation and goes on in this one. What is in your record above was done: do not start again, do not set the " +
  "card again, and do not propose again what is listed as proposed. Read an answer again with read_result, by its number, where you " +
  "need its words: take no figure from your notes that they mark as unverified without looking. Go on with what is open.";

/** What it did, kept by code, and its notes: between marks, as its own. */
export async function record(kept: Storage, job: Job, notes: string, proposed: readonly string[]): Promise<string> {
  const acts = (await kept.get<Act[]>(actsKey(job.id))) ?? [];
  const reads = acts.filter((a) => !a.acted);
  const shown = reads.slice(-SHOWN_ACTS);
  const did = acts.filter((a) => a.acted);
  const line = (a: Act) => `- ${a.name} ${a.args}${a.cut ? " → cut short: it may or may not have happened" : a.n ? ` → result ${a.n}` : ""}`;
  const parts = [
    job.card ? `CARD\nOutcome: ${job.card.outcome}${job.card.limits.length ? `\nLimits: ${job.card.limits.join("; ")}` : ""}${job.card.assumptions.length ? `\nAssumed: ${job.card.assumptions.join("; ")}` : ""}` : "",
    job.todo?.length ? `CHECKLIST\n${listed(job.todo)}` : "",
    job.asked?.length ? `YOU ASKED THE USER\n${job.asked.map((q, i) => `${i + 1}. ${asksSaid([q])} — ${q.answer ? "answered" : q.over ? "no answer came" : "not answered yet"}`).join("\n")}` : "",
    did.length ? `YOU DID\n${did.map(line).join("\n")}` : "",
    shown.length ? `YOU LOOKED AT${reads.length > shown.length ? ` (the last ${shown.length})` : ""}\n${shown.map(line).join("\n")}` : "",
    proposed.length ? `YOU PROPOSED\n${proposed.map((p) => `- ${p}`).join("\n")}` : "",
    job.files?.length ? `YOU GAVE THE USER\n${job.files.map((f) => `- ${f.name}`).join("\n")}` : "",
    notes ? `YOUR NOTES (UNVERIFIED)\n${notes.slice(0, MAX_NOTES)}` : "",
  ];
  return fenced("record", "YOUR OWN RECORD OF THIS JOB, NOT THE USER'S WORDS; IT MAY HOLD WHAT A PAGE OR A MAIL SAID", parts.filter(Boolean).join("\n\n"));
}

/** Everything its person told it, as they said it, whether it had it or not. */
export const everythingTold = (job: Pick<Job, "told">): OpenAI.Responses.ResponseInput => untold({ told: (job.told ?? []).map(({ taken: _, ...t }) => t) });
