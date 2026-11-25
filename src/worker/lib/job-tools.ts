import type OpenAI from "openai";
import type { Tool } from "../tools/registry.ts";
import type { Job } from "./jobs.ts";
import { asQuotedData, tidy } from "./quote.ts";
import type { JobFile, Ran } from "./workshop.ts";

/**
 * What an ordinary job says of its own work while it works, for whoever
 * started it to watch (src/app/ui/JobLive.ts): its card, which they may
 * change, its checklist, which is the job's, and what it asks them. Offered to
 * jobs alone (routes/jobs.ts), never in ALL: no question in the conversation
 * carries them.
 *
 * The card is set once, by the job; from then on only its person changes it.
 * What they change reaches the job as their own message, with the words they
 * typed and no others: a line the job wrote may have come from a page it read,
 * and repeating it as theirs would make it an instruction. What they strike
 * out goes quoted.
 *
 * What it asks, it asks at most three times, and goes on with the rest. An
 * answer is only ever its person's: with nothing left to do it waits for one
 * (lib/jobs.ts Job.waits), a day, and no answer is made up for them.
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

/**
 * What its person told it while it worked; `taken` once a step had it. Their
 * answer to what it asked (`to`: "question 1"), or a change to its card. By
 * Jarvis: that they did not answer.
 */
export interface Told {
  at: number;
  text: string;
  taken?: true;
  to?: string;
  card?: true;
  by?: "jarvis";
}

/** A question a job put to its person: its answer, or that they went on without it, or never came. */
export interface Asked {
  id: string;
  at: number;
  text: string;
  choices: string[];
  answer?: { at: number; text: string };
  over?: "skipped" | "late";
}

export const openQuestions = (asked: readonly Asked[] | undefined): Asked[] => (asked ?? []).filter((q) => !q.answer && !q.over);
/** Questions as they are put, with their choices: the job's own words, for quoting. */
export const asksSaid = (asked: readonly Asked[]): string =>
  asked.map((q) => `${q.text}${q.choices.length ? ` (${q.choices.join(" / ")})` : ""}`).join("\n");

/** What a step says of itself while it runs, kept at once (lib/jobs.ts note): on the plan a step takes minutes. */
export interface Said {
  card?: JobCard;
  todo?: Todo[];
  /** The tools it is running now; none, and it is thinking. */
  doing?: string[];
  /** A question for its person. */
  ask?: { text: string; choices: string[] };
  /** A file made for its person, and a command it ran (lib/workshop-tools.ts). */
  file?: JobFile;
  ran?: Ran;
  /** A helper's: what it handed the job (lib/helper-files.ts). */
  handed?: { path: string; size: number };
}

export const MAX_ASKED = 3;
/** How long a job with nothing else to do waits for an answer. */
export const ASK_MS = 24 * 3_600_000;
/** What no job asks anyone for, English or Malay: what it read may want it. */
const SECRET = /\b(?:pass(?:word|code|phrase)s?|pin|otp|tac|cvv|cvc|codes?|kod|kata laluan|card numbers?|nombor kad)\b/i;
/** A link by its address, not its label: nobody presses what they cannot see. */
const shown = (v: unknown, max: number): string => line(typeof v === "string" ? v.replace(/\[([^\]\n]*)\]\((https?:[^)\s]*)\)/g, "$1 ($2)") : v, max);
const MAX_QUESTION = 300;
const MAX_CHOICES = 4;
const MAX_CHOICE = 80;
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

/** The tools, for one look at a job: what they are told is kept by `say`. */
export function workTools(job: Pick<Job, "card" | "todo" | "asked">, say: (s: Said) => Promise<void>): Tool[] {
  let card = job.card;
  const asked = (job.asked ?? []).map((q) => q.text);
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
          assumptions: { type: "array", items: { type: "string" }, description: "What you take for granted without asking, up to four. Empty if nothing." },
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
        if (!todo.length) return "There is no checklist yet.";
        await say({ todo: todo.map((t) => ({ ...t })) });
        return listed(todo);
      },
    },
    {
      name: "ask_person",
      pace: "fast",
      description:
        `Ask the user something only they can settle and that would change the result: which of two, how much, for whom. ` +
        `At most ${MAX_ASKED} times in a job, so ask what matters, with the choices where there are a few. Never for a password, a code or a card.`,
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "One short question, plain, that can be read on its own." },
          choices: { type: "array", items: { type: "string" }, description: "Two to four answers to choose from; empty when it is open." },
        },
        required: ["question", "choices"],
        additionalProperties: false,
      },
      async run(args) {
        const text = shown(args.question, MAX_QUESTION);
        if (!text) return "There was no question.";
        const choices = (Array.isArray(args.choices) ? args.choices : []).map((c) => shown(c, MAX_CHOICE)).filter(Boolean).slice(0, MAX_CHOICES);
        if ([text, ...choices].some((s) => SECRET.test(s))) return "Not asked: a job never asks for a password, a code or a card. Go on without it.";
        const n = asked.indexOf(text) + 1;
        if (!n && asked.length >= MAX_ASKED) return `You have asked ${MAX_ASKED} times, which is all there are. Go on with what you have, and put what you could not settle under MISSING.`;
        // Asked already: by a step that was cut short, and is run again.
        if (!n) {
          asked.push(text);
          await say({ ask: { text, choices: choices.length > 1 ? choices : [] } });
        }
        return (
          `Asked, as question ${n || asked.length}. Their answer comes as their message. Go on with whatever does not depend on it, and never ` +
          "assume it. With nothing else left to do, give your answer so far: the job then waits for theirs, and you go on with it."
        );
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

/** What its person told it that no step has had, as their own message; and, from Jarvis, what they did not answer. */
export function untold(job: Pick<Job, "told">): Items {
  const waiting = (job.told ?? []).filter((t) => !t.taken);
  const theirs = waiting.filter((t) => t.by !== "jarvis");
  const ours = waiting.filter((t) => t.by === "jarvis");
  return [
    ...(theirs.length ? [{ role: "user" as const, content: `While you work, I say:\n${theirs.map((t) => (t.to ? `My answer to your ${t.to}: ${t.text}` : t.text)).join("\n")}\nKeep what you have found that still holds, and go on from there.` }] : []),
    ...(ours.length ? [{ role: "developer" as const, content: ours.map((t) => t.text).join("\n") }] : []),
  ];
}

/** Questions by their numbers in the job: "question 2", "questions 1 and 3". */
export const numbered = (asked: readonly Asked[], which: readonly Asked[]): string => {
  const n = which.map((q) => asked.findIndex((a) => a.id === q.id) + 1);
  return n.length === 1 ? `question ${n[0]}` : `questions ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};

/** What a job is told of questions its person did not answer: never an answer. */
export const unanswered = (which: string, why: "skipped" | "late"): string =>
  `${why === "skipped" ? `The user chose to go on without answering ${which}.` : `No answer came to ${which}.`} Do not assume one: ` +
  "finish what can be finished without it, and say under MISSING what it leaves open.";

/** Told once, when a job answers with lines of its checklist neither done nor dropped: what is checkable, and nothing else. */
export const unfinished = (todo: readonly Todo[] | undefined): string =>
  "YOUR CHECKLIST IS NOT FINISHED\n" +
  "These lines are neither done nor dropped:\n" +
  `${openLines(todo).map((t) => `${t.n}. ${t.text}`).join("\n")}\n` +
  "Do what can still be done and tick it; tick what was done; drop what cannot be, with why. Then give your whole " +
  "answer again. Lines left open are shown to the user as not done.";
