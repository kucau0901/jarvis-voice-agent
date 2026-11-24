import type OpenAI from "openai";
import type { Tool } from "../tools/registry.ts";
import type { Job } from "./jobs.ts";
import { asQuotedData, tidy } from "./quote.ts";

/**
 * What an ordinary job says of its own work while it works, for whoever
 * started it to watch (src/app/ui/JobLive.ts): its card, which they may
 * change, and its checklist, which is the job's. Offered to jobs alone
 * (routes/jobs.ts), never in ALL: no question in the conversation carries them.
 *
 * The card is set once, by the job; from then on only its person changes it.
 * What they change reaches the job as their own message, with the words they
 * typed and no others: a line the job wrote may have come from a page it read,
 * and repeating it as theirs would make it an instruction. What they strike
 * out goes quoted.
 */

/** What a job set out to do, as its person sees it. */
export interface JobCard {
  outcome: string;
  limits: string[];
  assumptions: string[];
}

export interface Todo {
  text: string;
  state: "open" | "doing" | "done" | "dropped";
  /** Why it was dropped. */
  why?: string;
}

/** What its person told it while it worked; `taken` once a step had it. */
export interface Told {
  at: number;
  text: string;
  taken?: true;
}

/** What a step says of itself while it runs, kept at once (lib/jobs.ts note): on the plan a step takes minutes. */
export interface Said {
  card?: JobCard;
  todo?: Todo[];
  /** The tools it is running now; none, and it is thinking. */
  doing?: string[];
}

const MAX_OUTCOME = 240;
const MAX_LINE = 160;
const MAX_NOTES = 4;
const MAX_TODO = 12;
export const MAX_TOLD = 10;

const line = (v: unknown, max = MAX_LINE): string => (typeof v === "string" ? tidy(v).slice(0, max) : "");
const lines = (v: unknown, most: number): string[] => (Array.isArray(v) ? v : []).map((x) => line(x)).filter(Boolean).slice(0, most);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v : []).filter((n): n is number => Number.isInteger(n));

export const doneLines = (todo: readonly Todo[] | undefined): number => (todo ?? []).filter((t) => t.state === "done").length;
/** Lines neither done nor dropped, with their numbers. */
export const openLines = (todo: readonly Todo[] | undefined): { n: number; text: string }[] =>
  (todo ?? []).flatMap((t, i) => (t.state === "open" || t.state === "doing" ? [{ n: i + 1, text: t.text }] : []));

const listed = (todo: readonly Todo[]): string => todo.map((t, i) => `${i + 1}. [${t.state}] ${t.text}${t.why ? ` (${t.why})` : ""}`).join("\n");

/** The two tools, for one look at a job: what they are told is kept by `say`. */
export function workTools(job: Pick<Job, "card" | "todo">, say: (s: Said) => Promise<void>): Tool[] {
  let card = job.card;
  // Calls of one step run together, so each works from what the one before it left here.
  let todo = (job.todo ?? []).map((t) => ({ ...t }));
  return [
    {
      name: "job_plan",
      pace: "fast",
      description: "Set this job's card and its checklist, once, before anything else. The user sees both at once, and may change the card while you work.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", description: "What the user will have when you are done, in one sentence." },
          limits: { type: "array", items: { type: "string" }, description: "Limits you will keep to, up to four: a budget, an area, what is left out." },
          assumptions: { type: "array", items: { type: "string" }, description: "What you take for granted because nobody can be asked, up to four. Empty if nothing." },
          steps: { type: "array", items: { type: "string" }, description: "Two to eight short steps, in order: the checklist." },
        },
        required: ["outcome", "limits", "assumptions", "steps"],
        additionalProperties: false,
      },
      async run(args) {
        if (card) return "The card is set, and is the user's to change. Change the checklist with job_tick.";
        const outcome = line(args.outcome, MAX_OUTCOME);
        if (!outcome) return "The card needs an outcome.";
        card = { outcome, limits: lines(args.limits, MAX_NOTES), assumptions: lines(args.assumptions, MAX_NOTES) };
        todo = lines(args.steps, MAX_TODO).map((text) => ({ text, state: "open" as const }));
        await say({ card, todo });
        return `Set.\n${listed(todo)}`;
      },
    },
    {
      name: "job_tick",
      pace: "fast",
      description: "Update the checklist: lines done, the one being done now, lines added, and lines that cannot be done, with why.",
      parameters: {
        type: "object",
        properties: {
          done: { type: "array", items: { type: "integer" }, description: "Numbers of lines now done." },
          doing: { type: ["integer", "null"], description: "The line you are on now." },
          add: { type: "array", items: { type: "string" }, description: "New lines, for work the plan did not foresee." },
          dropped: {
            type: "array",
            items: {
              type: "object",
              properties: { line: { type: "integer" }, why: { type: "string" } },
              required: ["line", "why"],
              additionalProperties: false,
            },
            description: "Lines that cannot be done, each with why in a few words.",
          },
        },
        required: ["done", "doing", "add", "dropped"],
        additionalProperties: false,
      },
      async run(args) {
        todo.push(...lines(args.add, MAX_TODO - todo.length).map((text) => ({ text, state: "open" as const })));
        for (const d of Array.isArray(args.dropped) ? (args.dropped as { line?: unknown; why?: unknown }[]) : []) {
          const t = todo[Number(d?.line) - 1];
          if (t && t.state !== "done") Object.assign(t, { state: "dropped", why: line(d.why) || "not possible" });
        }
        for (const n of ints(args.done)) {
          const t = todo[n - 1];
          if (!t) continue;
          t.state = "done";
          delete t.why;
        }
        const now = todo[Number(args.doing) - 1];
        if (now && now.state !== "done") {
          for (const t of todo) if (t.state === "doing") t.state = "open";
          now.state = "doing";
          delete now.why;
        }
        if (!todo.length) return "There is no checklist: set one with job_plan.";
        await say({ todo: todo.map((t) => ({ ...t })) });
        return listed(todo);
      },
    },
  ];
}

/* ---------- what its person says while it works -------------------------------- */

/** The card as its person has it now, and their changes in words: what they typed as theirs, what they struck out quoted. */
export function changeCard(was: JobCard, input: { outcome?: unknown; limits?: unknown; assumptions?: unknown }): { card: JobCard; said: string } {
  const card: JobCard = {
    outcome: line(input.outcome, MAX_OUTCOME) || was.outcome,
    limits: input.limits === undefined ? was.limits : lines(input.limits, MAX_NOTES),
    assumptions: input.assumptions === undefined ? was.assumptions : lines(input.assumptions, MAX_NOTES),
  };
  const said: string[] = [];
  if (card.outcome !== was.outcome) said.push(`The outcome is now: ${card.outcome}`);
  for (const l of card.limits) if (!was.limits.includes(l)) said.push(`A limit: ${l}`);
  for (const a of card.assumptions) if (!was.assumptions.includes(a)) said.push(`Assume: ${a}`);
  const struck = [...was.limits.filter((l) => !card.limits.includes(l)), ...was.assumptions.filter((a) => !card.assumptions.includes(a))];
  if (struck.length) said.push(`These lines are off the card and no longer hold:\n${asQuotedData("struck out", struck.join("\n"), "YOU, ON THE CARD")}`);
  return { card, said: said.join("\n") };
}

type Items = OpenAI.Responses.ResponseInput;

/** What its person told it that no step has had, as their own message. */
export function untold(job: Pick<Job, "told">): Items {
  const waiting = (job.told ?? []).filter((t) => !t.taken);
  return waiting.length
    ? [{ role: "user", content: `While you work, I have changed what I want:\n${waiting.map((t) => t.text).join("\n")}\nKeep what you have found that still holds, and go on from there.` }]
    : [];
}

/** Told once, when a job answers with lines of its checklist neither done nor dropped: what is checkable, and nothing else. */
export const unfinished = (todo: readonly Todo[] | undefined): string =>
  "YOUR CHECKLIST IS NOT FINISHED\n" +
  "These lines are neither done nor dropped:\n" +
  `${openLines(todo).map((t) => `${t.n}. ${t.text}`).join("\n")}\n` +
  "Do what can still be done and tick it; tick what was done; drop what cannot be, with why. Then give your whole " +
  "answer again. Lines left open are shown to the user as not done.";
