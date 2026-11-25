import type OpenAI from "openai";
import type { Job } from "./jobs.ts";
import type { Storage } from "./state-host.ts";
import { jobRows } from "./job-chain.ts";
import { keepResult } from "./job-results.ts";
import { OWN_CALLS, noteActs, type Act } from "./job-checkpoint.ts";
import { sha256Hex } from "./devices.ts";
import { unquoted } from "./quote.ts";

/**
 * What keeps a long job (lib/jobs.ts) within bounds, and honest about it.
 *
 * A job used to fail at its 25th step and lose everything it had found. Out of
 * its budget it now gets one more call, with no tools, to write what it has
 * (Job.cut): what is delivered is said to be part done, never done. One that
 * goes round in a circle is told so, then refused, then treated as out of its
 * budget too (runGuarded).
 */

/** Web searches, and pages opened by them, an ordinary job makes before it is told to write what it has. */
export const MAX_SEARCHES = 60;
/** Dollars of the API key one ordinary job may use. Nothing, on the ChatGPT plan. */
export const KEY_DOLLARS = 2;

/** A line of its checklist ticked within this many steps: it is getting somewhere, and goes on past its steps (Limits.going). */
export const GOING_STEPS = 10;

export interface Limits {
  maxMs: number;
  maxSteps: number;
  /** Steps while its checklist moves. */
  going: number;
}

/** What a job has run out of, as its person is told; null while it has not. `cost`, its dollars so far at OpenAI's prices. */
export function outOf(j: Job, limits: Limits, cost: number | null, now: number): string | null {
  if (now - j.createdAt - (j.waited ?? 0) > limits.maxMs) return `it ran for its ${limits.maxMs / 60_000} minutes`;
  const moving = j.ticked !== undefined && j.steps - j.ticked < GOING_STEPS;
  if (j.steps >= (moving ? limits.going : limits.maxSteps)) return `it took its ${j.steps} steps`;
  // Research has a month's limit of its own, and is asked for at its price.
  if (j.engine === "research") return null;
  if (j.stuck) return "it kept asking the same thing and getting the same answer";
  if ((j.usage?.searches ?? 0) >= MAX_SEARCHES) return `it made its ${MAX_SEARCHES} web searches`;
  if (cost !== null && cost >= KEY_DOLLARS) return `it used $${KEY_DOLLARS} of the API key`;
  return null;
}

/** What a call asked for when the job was already out of its budget is told. */
export const NOT_RUN = "Not run: this job has used up what it had for tools.";

/* ---------- going round in a circle -------------------------------------------- */

/** The same call with the same answer this many times running: noted, then not made, then the job writes what it has. */
export const NOTE_AT = 3;
export const REFUSE_AT = 5;
export const STUCK_AT = 8;

/** What may rightly be asked again and answer the same: a program run after a change to it, and one waited for (lib/workshop-tools.ts). */
const AGAIN: ReadonlySet<string> = new Set(["run", "process"]);

type Call = OpenAI.Responses.ResponseFunctionToolCall;
type Items = OpenAI.Responses.ResponseInput;
type Seen = Record<string, { out: string; n: number }>;

const seenKey = (job: string) => `${jobRows(job)}seen`;

/** One call, whatever order its arguments came in. */
async function callKey(c: Call): Promise<string> {
  let args: unknown = c.arguments;
  try {
    args = Object.entries(JSON.parse(c.arguments || "{}") as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  } catch {
    // As it came: the tool says it was malformed.
  }
  return (await sha256Hex(`${c.name}\n${JSON.stringify(args)}`)).slice(0, 16);
}

/**
 * Run a step's calls, their answers kept and the long ones cut (lib/job-results.ts),
 * what was asked noted (lib/job-checkpoint.ts), keeping count of those that were made before and gave the same: the answer says so at
 * NOTE_AT, at REFUSE_AT the call is not made, and at STUCK_AT (`stuck`) the job
 * has nothing left to try. What a step found before its answer was lost (an
 * update) is found again, and counted again: counts are a nudge, not a record.
 */
export async function runGuarded(kept: Storage, job: string, calls: readonly Call[], run: (calls: Call[]) => Promise<Items>, does: (name: string) => boolean = () => false): Promise<{ outputs: Items; stuck: boolean }> {
  const seen = (await kept.get<Seen>(seenKey(job))) ?? {};
  const keys = await Promise.all(calls.map(callKey));
  const refused = keys.map((k) => (seen[k]?.n ?? 0) >= REFUSE_AT - 1);
  const ran = await run(calls.filter((_, i) => !refused[i]));
  const byId = new Map(ran.map((o) => ["call_id" in o ? o.call_id : "", o]));
  const outputs: Items = [];
  const acts: Act[] = [];
  for (const [i, c] of calls.entries()) {
    const k = keys[i]!;
    const before = seen[k];
    if (refused[i]) {
      seen[k] = { ...before!, n: before!.n + 1 };
      outputs.push({ type: "function_call_output", call_id: c.call_id, output: `Not made: you have asked exactly this ${before!.n} times and had the same answer each time. Try something else, or write what you have.` });
      continue;
    }
    const o = byId.get(c.call_id);
    if (!o) continue;
    // Compared without its fences, whose marker is new each time (lib/quote.ts), and before a long one is cut and numbered.
    const out = (await sha256Hex("output" in o ? (typeof o.output === "string" ? unquoted(o.output) : JSON.stringify(o.output)) : "")).slice(0, 16);
    const n = before?.out === out && !AGAIN.has(c.name) ? before.n + 1 : 1;
    seen[k] = { out, n };
    const own = OWN_CALLS.has(c.name);
    const { shown, n: at } = own ? { shown: o } : await keepResult(kept, job, o);
    if (!own) acts.push({ name: c.name, args: c.arguments, ...(at ? { n: at } : {}), ...(does(c.name) ? { acted: true as const } : {}) });
    outputs.push(
      n >= NOTE_AT && "output" in shown && typeof shown.output === "string"
        ? ({ ...shown, output: `${shown.output}\n\n(The same answer as the last ${n - 1} times you asked exactly this. Asking again will not change it.)` } as Items[number])
        : shown,
    );
  }
  await noteActs(kept, job, acts);
  await kept.put(seenKey(job), seen);
  return { outputs, stuck: keys.some((k) => (seen[k]?.n ?? 0) >= STUCK_AT) };
}
