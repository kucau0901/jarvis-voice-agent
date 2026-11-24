import type { Job } from "./jobs.ts";

/**
 * What keeps a long job (lib/jobs.ts) within bounds, and honest about it.
 *
 * A job used to fail at its 25th step and lose everything it had found. Out of
 * its budget it now gets one more call, with no tools, to write what it has
 * (Job.cut): what is delivered is said to be part done, never done.
 */

/** Web searches an ordinary job makes before it is told to write what it has. */
export const MAX_SEARCHES = 40;
/** Dollars of the API key one ordinary job may use. Nothing, on the ChatGPT plan. */
export const KEY_DOLLARS = 2;

export interface Limits {
  maxMs: number;
  maxSteps: number;
}

/** What a job has run out of, as its person is told; null while it has not. `cost`, its dollars so far at OpenAI's prices. */
export function outOf(j: Job, limits: Limits, cost: number | null, now: number): string | null {
  if (now - j.createdAt - (j.waited ?? 0) > limits.maxMs) return `it ran for its ${limits.maxMs / 60_000} minutes`;
  if (j.steps >= limits.maxSteps) return `it took its ${limits.maxSteps} steps`;
  // Research has a month's limit of its own, and is asked for at its price.
  if (j.engine === "research") return null;
  if ((j.usage?.searches ?? 0) >= MAX_SEARCHES) return `it made its ${MAX_SEARCHES} web searches`;
  if (cost !== null && cost >= KEY_DOLLARS) return `it used $${KEY_DOLLARS} of the API key`;
  return null;
}

/** What a call asked for when the job was already out of its budget is told. */
export const NOT_RUN = "Not run: this job has used up what it had for tools.";
