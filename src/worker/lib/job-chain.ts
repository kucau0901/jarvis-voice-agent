import type OpenAI from "openai";
import type { Storage } from "./state-host.ts";

/**
 * A job's exchange on the ChatGPT plan (routes/jobs.ts). The plan's route keeps
 * nothing, so every step sends the whole of it; it is kept here a row a step,
 * what was added and what came back, for the life of the job. It used to be a
 * whole copy at every step, kept two hours: a job of sixty steps would have
 * kept sixty copies, and one answered by its person the next morning would have
 * found its exchange gone.
 *
 * What a step adds is kept BEFORE it is asked. Cut short (an update, a
 * restart), the job is looked at again: a row with no answer is asked again as
 * it was, its tools not run a second time, and one that was answered is taken
 * as it stands. A step cut short MAX_TRIES times is given up on: something in
 * it stops the object each time.
 *
 * A chain has a name of its own in its job: the job itself, a research team's
 * three, its plan and its merge. A step's id names its chain and its row.
 */

type Items = OpenAI.Responses.ResponseInput;

/** A step's answer, as much of it as a look reads. */
export type Answered = Pick<OpenAI.Responses.Response, "model" | "status" | "output" | "output_text" | "usage" | "error" | "incomplete_details">;

interface Row {
  at: number;
  /** What this step added: the whole first question, then tool outputs. */
  input: Items;
  answer?: Answered;
  /** Times it was asked. */
  tries: number;
}

export const MAX_TRIES = 5;

const rows = (job: string) => `jobitem:${job}:`;
const key = (job: string, chain: string, n: number) => `${rows(job)}${chain}:${String(n).padStart(4, "0")}`;

/** A step's id: its chain and row, as "plan_m.3". */
export const stepId = (chain: string, n: number): string => `plan_${chain}.${n}`;
export function stepOf(id: string | undefined): { chain: string; n: number } | null {
  const m = /^plan_([a-z0-9]+)\.(\d+)$/.exec(id ?? "");
  return m ? { chain: m[1]!, n: Number(m[2]) } : null;
}

/** The exchange is the job's: gone with it, or once it has ended. Not under "job:", which is the jobs themselves. */
export async function clearChain(storage: Storage, job: string): Promise<void> {
  for (const k of (await storage.list({ prefix: rows(job) })).keys()) await storage.delete(k);
}

export class JobChain {
  private storage: Storage;
  private job: string;
  constructor(storage: Storage, job: string) {
    this.storage = storage;
    this.job = job;
  }

  /** Every item so far, through the answer of row `n`. */
  async exchange(chain: string, n: number): Promise<Items> {
    const all = await this.storage.list<Row>({ prefix: `${rows(this.job)}${chain}:` });
    const out: Items = [];
    for (let i = 0; i <= n; i++) {
      const row = all.get(key(this.job, chain, i));
      if (!row) throw new Error("its exchange on the ChatGPT plan is no longer kept");
      out.push(...row.input, ...((row.answer?.output ?? []) as unknown as Items));
    }
    return out;
  }

  /** A step's answer; null when there is none. */
  async answer(id: string): Promise<Answered | null> {
    const s = stepOf(id);
    return s ? ((await this.storage.get<Row>(key(this.job, s.chain, s.n)))?.answer ?? null) : null;
  }

  /** What the step after `n` (or the first, -1) was about to ask, if it was cut short: asked again as it is, or already answered. */
  async next(chain: string, n: number): Promise<{ input: Items; answered: boolean } | null> {
    const row = await this.storage.get<Row>(key(this.job, chain, n + 1));
    return row ? { input: row.input, answered: !!row.answer } : null;
  }

  /** A step about to be asked: kept first. Why not, when it has been cut short too often. */
  async asking(chain: string, n: number, input: Items, now: number): Promise<string | null> {
    const k = key(this.job, chain, n);
    const before = await this.storage.get<Row>(k);
    const tries = (before?.tries ?? 0) + 1;
    if (tries > MAX_TRIES) return `it was interrupted ${MAX_TRIES} times at the same step`;
    await this.storage.put(k, { at: now, input: before?.input ?? input, tries } satisfies Row);
    return null;
  }

  /** A step that cannot be asked yet: kept, so what its tools gave is not asked of them again. */
  async keep(chain: string, n: number, input: Items, now: number): Promise<void> {
    const k = key(this.job, chain, n);
    if (!(await this.storage.get<Row>(k))) await this.storage.put(k, { at: now, input, tries: 0 } satisfies Row);
  }

  /** The plan refused it (its limit): not a time it was asked. */
  async refused(chain: string, n: number): Promise<void> {
    const k = key(this.job, chain, n);
    const row = await this.storage.get<Row>(k);
    if (row) await this.storage.put(k, { ...row, tries: Math.max(0, row.tries - 1) } satisfies Row);
  }

  /** Its answer, kept; not if the job was ended meanwhile and its rows are gone. */
  async answered(chain: string, n: number, r: Answered): Promise<void> {
    const k = key(this.job, chain, n);
    const row = await this.storage.get<Row>(k);
    if (!row) return;
    const { model, status, output, output_text, usage, error, incomplete_details } = r;
    await this.storage.put(k, { ...row, answer: { model, status, output, output_text, usage, error, incomplete_details } } satisfies Row);
  }
}

/* ---------- calls that must not be made twice ---------------------------------- */

const callsKey = (job: string) => `${rows(job)}calls`;

/**
 * Of a step's calls, those a run cut short had already begun: never made again
 * by themselves, since they may have been. Only for what acts with nobody
 * asked (a component's tool the owner lets run alone, tools/components.ts):
 * what reads may be read again, and a proposal filed twice is one card
 * (lib/proposals.ts). Marks `ids` as begun.
 */
export async function beginCalls(storage: Storage, job: string, step: string, ids: readonly string[]): Promise<Set<string>> {
  const was = await storage.get<{ step: string; ids: string[] }>(callsKey(job));
  if (was?.step === step) return new Set(was.ids);
  await storage.put(callsKey(job), { step, ids: [...ids] });
  return new Set();
}

export const INTERRUPTED = "Jarvis was restarted while this was being done: it may or may not have happened. Check before doing it again, or say so in your answer.";
