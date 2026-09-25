import type { Storage } from "./state-host.ts";
import type { Grant } from "./scopes.ts";
import { makeAlert, type Alert, type Delivery } from "./alerts.ts";

/**
 * Background jobs: things that take minutes, answered later.
 *
 * Every other answer has to finish while a screen waits — Cloudflare ends the
 * work about thirty seconds after the reply, and the router gets six steps.
 * "Research the best dashcams under RM800 and send me a comparison" needs
 * dozens of steps; a question to Hermes takes one to four minutes and was
 * lost if the car's tab closed. A job is started, answered at once ("on
 * it"), and run from the Durable Object's alarm; the result arrives as an
 * alert (lib/alerts.ts) and waits in the Jobs panel.
 *
 * Two engines:
 *   jarvis  the router, run in OpenAI's background mode: each step runs on
 *           OpenAI's side, and between steps the object runs whatever tools
 *           it asked for. Many steps, many minutes, no screen needed.
 *   hermes  one question to the user's Hermes agent, however long it takes.
 *
 * A job READS but does not ACT (routes/jobs.ts picks its tools): nobody is
 * watching it, and it reads things written by others — web pages, mail — so
 * it must not be able to send, delete, unlock or switch anything. It says
 * what it would do instead, and the user can ask for it.
 *
 * Kept free of runtime imports beyond the alert helpers, so Node tests it.
 */

export type JobEngine = "jarvis" | "hermes";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  title: string;
  /** The brief, complete on its own: the job never sees the conversation. */
  task: string;
  engine: JobEngine;
  status: JobStatus;
  /** "owner", a device id, or "voice". */
  createdBy: string;
  grants: Grant[];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** When the alarm should next look at it. */
  nextAt?: number;
  /** jarvis: the background response now running at OpenAI. */
  responseId?: string;
  steps: number;
  /** Tries of a hermes question: a retry after an interruption, never a loop. */
  attempts: number;
  /** One or two sentences, said aloud when it is done. */
  summary?: string;
  /** The whole result. */
  result?: string;
  error?: string;
  deliveredBy?: string | null;
  usage?: { input: number; cached: number; output: number };
}

/** One look at a running jarvis job, as the engine reports it. */
export type Step =
  | { kind: "wait"; usage?: Job["usage"] }
  | { kind: "continued"; responseId: string; usage?: Job["usage"] }
  | { kind: "done"; text: string; usage?: Job["usage"] }
  | { kind: "failed"; error: string };

export interface JobDeps {
  /** Start a jarvis job's first step; its response id, or why it could not start. */
  start(job: Job): Promise<{ responseId: string } | { error: string }>;
  /** Look at the running step; run any tools it asked for and start the next. */
  poll(job: Job): Promise<Step>;
  /** Stop a running step at OpenAI. Best effort. */
  cancel(job: Job): Promise<void>;
  /** Ask Hermes, waiting as long as it takes. */
  hermes(job: Job): Promise<{ ok: boolean; text: string }>;
  deliver(alert: Alert): Promise<Delivery>;
}

const J = "job:";
const DAY = "jobs:day";

export const MAX_RUNNING = 3;
export const DAILY_JOBS = 30;
export const KEEP_JOBS = 30;
/** A router job that has run this many steps is stopped: something is looping. */
export const MAX_STEPS = 25;
/** And this long, whatever it is doing. */
export const MAX_JOB_MS = 20 * 60_000;
export const MAX_TASK = 4000;
/** Kept whole in the Jobs panel; the alert carries only the summary. */
export const MAX_RESULT = 20_000;
/** How long to wait before looking again: quickly at first, then less often. */
const BACKOFF_S = [4, 6, 10, 15, 20, 30];

/* ---------- what a job may use ------------------------------------------------ */

/** Jarvis's own tools that only read. Anything that sends, books, switches or remembers is left out. */
const READ_TOOLS = new Set([
  "recall", "car_state", "directions", "place_info", "look_at_camera",
  "mail_check", "mail_search", "contacts_lookup", "calendar_check", "routine_list",
]);

/**
 * An MCP tool is taken only if its name says it reads and nothing in it says
 * it writes. Measured against Home Assistant's: ha_get_state, ha_get_history,
 * ha_search, ha_get_overview, ha_list_floors_areas, ha_get_todo,
 * ha_config_get_calendar_events in; ha_call_service, ha_bulk_control,
 * ha_set_todo_item, ha_eval_template out. An unrecognised name is left out:
 * the safe way to be wrong.
 */
const WRITES = /(set|call|control|create|update|delete|remove|send|write|turn|toggle|eval|run|exec|bulk|start|stop|lock|open|close|move|add|play|pause|arm)/;
const READS = /(^|_)(get|list|search|find|query|read|history|overview|lookup|state|todo)(_|$)/;

export function jobTool(t: { name: string }): boolean {
  if (READ_TOOLS.has(t.name)) return true;
  const i = t.name.indexOf("__");
  if (i < 0) return false;
  const own = t.name.slice(i + 2).toLowerCase();
  return !WRITES.test(own) && READS.test(own);
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const newJobId = () => {
  let s = "j";
  for (const b of crypto.getRandomValues(new Uint8Array(9))) s += ALPHABET[b & 31];
  return s;
};

/**
 * The SUMMARY: line the job was asked for, or failing that its first two
 * sentences. `whole` is everything, summary included, for when it is short
 * enough to send as it is.
 */
export function splitResult(text: string): { summary: string; result: string; whole: string } {
  const t = text.trim();
  const m = /^\s*\**\s*summary\s*\**\s*:\s*\**\s*(.+?)\s*(?:\n+|$)([\s\S]*)$/i.exec(t);
  if (m) {
    const summary = m[1]!.trim();
    const rest = (m[2] ?? "").trim();
    return { summary, result: rest || summary, whole: rest ? `${summary}\n\n${rest}` : summary };
  }
  const sentences = t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  return { summary: sentences.slice(0, 2).join(" ").slice(0, 400), result: t, whole: t };
}

/** Longer than this, the alert carries the summary and points at the Jobs panel. */
const ALERT_WHOLE = 700;

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export class Jobs {
  private storage: Storage;
  private deps: () => Promise<JobDeps>;

  constructor(storage: Storage, deps: () => Promise<JobDeps>) {
    this.storage = storage;
    this.deps = deps;
  }

  async list(who?: string): Promise<Job[]> {
    const all = [...(await this.storage.list<Job>({ prefix: J })).values()].sort((a, b) => b.createdAt - a.createdAt);
    return who ? all.filter((j) => j.createdBy === who) : all;
  }

  get(id: string): Promise<Job | undefined> {
    return this.storage.get<Job>(J + id);
  }

  private save(j: Job): Promise<void> {
    return this.storage.put(J + j.id, j);
  }

  async create(
    input: { title?: unknown; task?: unknown; engine?: unknown },
    by: { who: string; grants: readonly Grant[] },
    now = Date.now(),
  ): Promise<Job | string> {
    const task = clean(input.task, MAX_TASK);
    if (!task) return "a job needs a task: what to find out or work through";
    const engine: JobEngine = input.engine === "hermes" ? "hermes" : "jarvis";
    const all = await this.list();
    if (all.filter((j) => j.status === "running").length >= MAX_RUNNING) {
      return `${MAX_RUNNING} jobs are already running; wait for one to finish`;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const day = (await this.storage.get<{ day: string; n: number }>(DAY)) ?? { day: today, n: 0 };
    const n = day.day === today ? day.n : 0;
    if (n >= DAILY_JOBS) return `the limit of ${DAILY_JOBS} jobs a day has been reached`;
    await this.storage.put(DAY, { day: today, n: n + 1 });

    const job: Job = {
      id: newJobId(),
      title: clean(input.title, 80) || task.split(/[.?!\n]/)[0]!.slice(0, 80),
      task,
      engine,
      status: "running",
      createdBy: by.who,
      grants: [...by.grants],
      createdAt: now,
      updatedAt: now,
      nextAt: now,
      steps: 0,
      attempts: 0,
    };
    await this.save(job);
    await this.prune();
    return job;
  }

  async cancel(id: string, now = Date.now()): Promise<Job | string> {
    const j = await this.get(id);
    if (!j) return "no such job";
    if (j.status !== "running") return j;
    j.status = "cancelled";
    j.finishedAt = j.updatedAt = now;
    delete j.nextAt;
    await this.save(j);
    if (j.responseId) await (await this.deps()).cancel(j).catch(() => {});
    return j;
  }

  async remove(id: string): Promise<boolean> {
    const j = await this.get(id);
    if (!j) return false;
    if (j.status === "running") await this.cancel(id);
    return this.storage.delete(J + id);
  }

  async nextWake(now = Date.now()): Promise<number | null> {
    let next: number | undefined;
    for (const j of await this.list()) {
      if (j.status === "running" && j.nextAt !== undefined && (next === undefined || j.nextAt < next)) next = j.nextAt;
    }
    return next === undefined ? null : Math.max(next, now);
  }

  /** Advance every job that is due. Hermes last: it can hold the alarm for minutes. */
  async tick(now = Date.now()): Promise<void> {
    const due = (await this.list()).filter((j) => j.status === "running" && (j.nextAt ?? 0) <= now + 1000);
    if (!due.length) return;
    const deps = await this.deps();
    for (const j of due.sort((a, b) => (a.engine === "hermes" ? 1 : 0) - (b.engine === "hermes" ? 1 : 0))) {
      try {
        await (j.engine === "hermes" ? this.advanceHermes(j, deps, now) : this.advanceJarvis(j, deps, now));
      } catch (e) {
        await this.finish(j, deps, now, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async advanceJarvis(j: Job, deps: JobDeps, now: number): Promise<void> {
    if (now - j.createdAt > MAX_JOB_MS) {
      await deps.cancel(j).catch(() => {});
      return this.finish(j, deps, now, { error: `it ran for over ${MAX_JOB_MS / 60_000} minutes and was stopped` });
    }
    if (!j.responseId) {
      const s = await deps.start(j);
      if ("error" in s) return this.finish(j, deps, now, { error: s.error });
      j.responseId = s.responseId;
      j.steps = 1;
      j.nextAt = now + BACKOFF_S[0]! * 1000;
      j.updatedAt = now;
      return this.save(j);
    }
    const step = await deps.poll(j);
    if (step.kind !== "failed" && step.usage) {
      j.usage = {
        input: (j.usage?.input ?? 0) + step.usage.input,
        cached: (j.usage?.cached ?? 0) + step.usage.cached,
        output: (j.usage?.output ?? 0) + step.usage.output,
      };
    }
    if (step.kind === "wait") {
      const waited = Math.round((now - j.updatedAt) / 1000);
      const next = BACKOFF_S.find((s) => s > waited) ?? BACKOFF_S[BACKOFF_S.length - 1]!;
      j.nextAt = now + next * 1000;
      // updatedAt is when the current step started, so the wait grows while it runs.
      return this.save(j);
    }
    if (step.kind === "continued") {
      if (j.steps + 1 > MAX_STEPS) {
        await deps.cancel({ ...j, responseId: step.responseId }).catch(() => {});
        return this.finish(j, deps, now, { error: `it took more than ${MAX_STEPS} steps and was stopped` });
      }
      j.responseId = step.responseId;
      j.steps += 1;
      j.updatedAt = now;
      j.nextAt = now + BACKOFF_S[0]! * 1000;
      return this.save(j);
    }
    if (step.kind === "done") return this.finish(j, deps, now, { text: step.text });
    return this.finish(j, deps, now, { error: step.error });
  }

  private async advanceHermes(j: Job, deps: JobDeps, now: number): Promise<void> {
    // An alarm cut short mid-question (a deploy) is retried once, not forever.
    if (j.attempts >= 2) return this.finish(j, deps, now, { error: "Hermes was interrupted twice" });
    j.attempts += 1;
    j.nextAt = now + 10 * 60_000; // recorded first: while asking, nothing else should pick it up
    j.updatedAt = now;
    await this.save(j);
    const r = await deps.hermes(j);
    return this.finish(j, deps, Date.now(), r.ok ? { text: r.text } : { error: r.text });
  }

  private async finish(j: Job, deps: JobDeps, now: number, out: { text: string } | { error: string }): Promise<void> {
    const cur = await this.get(j.id);
    if (!cur || cur.status !== "running") return; // cancelled or removed while it ran
    const done = { ...cur, ...j, finishedAt: now, updatedAt: now };
    delete done.nextAt;
    let alert: Alert;
    if ("text" in out && out.text.trim()) {
      const { summary, result, whole } = splitResult(out.text);
      done.status = "done";
      done.summary = summary;
      done.result = result.slice(0, MAX_RESULT);
      alert = makeAlert(
        {
          title: j.engine === "hermes" ? "Hermes answered" : `Done: ${j.title}`,
          text: whole.length <= ALERT_WHOLE ? whole : `${summary}\n\nThe full result is in Jobs.`,
        },
        "job",
        now,
      )!;
    } else {
      done.status = "failed";
      done.error = "error" in out ? out.error.slice(0, 500) : "it finished without an answer";
      alert = makeAlert({ title: `Could not finish: ${j.title}`, text: done.error, speak: false }, "job", now)!;
    }
    await this.save(done); // before delivering: a retried alarm must not tell the user twice
    const d = await deps.deliver(alert).catch(() => null);
    done.deliveredBy = d?.deliveredBy ?? null;
    await this.save(done);
  }

  /** Keep the newest KEEP_JOBS finished ones. */
  private async prune(): Promise<void> {
    const finished = (await this.list()).filter((j) => j.status !== "running");
    for (const j of finished.slice(KEEP_JOBS)) await this.storage.delete(J + j.id);
  }
}
