import type { Storage } from "./state-host.ts";
import type { Grant } from "./scopes.ts";
import { makeAlert, type Alert, type Delivery } from "./alerts.ts";
import { personOfWho } from "./context.ts";
import type { UsageEntry } from "./usage.ts";

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

/**
 * "research": a job asked for as research in depth. OpenAI's deep-research
 * models were shut down on 23 July 2026, so it is Jarvis's own job loop with a
 * stronger model (RESEARCH_MODEL, GPT-6 Sol by default) thinking hard, more
 * steps and more time, told to write a report; its sources come from the web
 * search's own citations (withSources). Before anyone is told, the report is
 * checked against those sources in one more turn (RESEARCH_CHECK), and if the
 * check does not finish, the report goes out as written. Capped per month:
 * each costs one to two dollars.
 */
export type JobEngine = "jarvis" | "hermes" | "research";
type JobStatus = "running" | "done" | "failed" | "cancelled";

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
  /** Tokens over every step, and the model that spent them, for Settings → Usage. */
  usage?: JobUsage;
  /**
   * research: the report as written, the pages it cited, and the response that
   * wrote it, kept while it is checked (RESEARCH_CHECK): delivered if the check
   * does not finish. Gone once the job is.
   */
  draft?: { text: string; cited: Cited[]; responseId: string };
}

/** A page the web search cited: what a report's Sources list is made of. */
export type Cited = { url: string; title?: string };

export interface JobUsage {
  input: number;
  cached: number;
  output: number;
  /** Prompt-cache writes, charged above plain input. */
  written?: number;
  /** Web searches, charged by the call: most of what research costs besides tokens. */
  searches?: number;
  model?: string;
}

/** A step's usage added to the job's so far. */
export function addUsage(a: JobUsage | undefined, b: JobUsage): JobUsage {
  const model = b.model ?? a?.model;
  return {
    input: (a?.input ?? 0) + b.input,
    cached: (a?.cached ?? 0) + b.cached,
    output: (a?.output ?? 0) + b.output,
    written: (a?.written ?? 0) + (b.written ?? 0),
    searches: (a?.searches ?? 0) + (b.searches ?? 0),
    ...(model ? { model } : {}),
  };
}

/** A job as Settings → Usage counts it (lib/usage.ts): finished, failed or cancelled. */
export function usageEntry(j: Job, ok: boolean, now: number): UsageEntry {
  return {
    at: j.createdAt,
    surface: "job",
    by: j.engine === "hermes" ? "hermes" : (j.usage?.model ?? "unknown"),
    ok,
    ms: now - j.createdAt,
    input: j.usage?.input ?? 0,
    cached: j.usage?.cached ?? 0,
    written: j.usage?.written ?? 0,
    output: j.usage?.output ?? 0,
    searches: j.usage?.searches ?? 0,
    tools: [],
    ask: j.title.slice(0, 80),
    who: personOfWho(j.createdBy),
  };
}

/** One look at a running jarvis job, as the engine reports it. */
export type Step =
  | { kind: "wait"; usage?: Job["usage"] }
  | { kind: "continued"; responseId: string; usage?: Job["usage"] }
  | { kind: "done"; text: string; cited?: Cited[]; usage?: Job["usage"] }
  | { kind: "failed"; error: string };

export interface JobDeps {
  /** Start a jarvis job's first step; its response id, or why it could not start. */
  start(job: Job): Promise<{ responseId: string } | { error: string }>;
  /** research: start the check of a written report, continuing from `after`; its response id, or why not. */
  check(job: Job, after: string): Promise<{ responseId: string } | { error: string }>;
  /** Look at the running step; run any tools it asked for and start the next. */
  poll(job: Job): Promise<Step>;
  /** Stop a running step at OpenAI. Best effort. */
  cancel(job: Job): Promise<void>;
  /** Ask Hermes, waiting as long as it takes. */
  hermes(job: Job): Promise<{ ok: boolean; text: string }>;
  deliver(alert: Alert): Promise<Delivery>;
  /** Research jobs allowed a month (RESEARCH_MONTHLY_LIMIT); 0 turns them off. */
  researchLimit?: number;
  /** Why research cannot run on this deployment at all, e.g. web search withheld. */
  researchBlocked?: string | null;
  /** A finished job, for Settings → Usage. */
  record?(e: UsageEntry): Promise<void>;
}

const J = "job:";
const DAY = "jobs:day";

export const MAX_RUNNING = 3;
export const DAILY_JOBS = 30;
export const KEEP_JOBS = 30;
/** A router job that has run this many steps is stopped: something is looping. */
export const MAX_STEPS = 25;
export const RESEARCH_MAX_STEPS = 40;
export const RESEARCH_MAX_MS = 45 * 60_000;
/** The check of a research report gets this long more, however late the report was written. */
export const RESEARCH_CHECK_MS = 10 * 60_000;
export const RESEARCH_MONTHLY_DEFAULT = 10;
const RESEARCH_MONTH = "jobs:research:month";
/** And this long, whatever it is doing. */
export const MAX_JOB_MS = 20 * 60_000;
const MAX_TASK = 4000;
/** Kept whole in the Jobs panel; the alert carries only the summary. */
const MAX_RESULT = 20_000;
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
/** How long, and how many steps, a job of each kind may take. */
export function limitsOf(engine: JobEngine): { maxMs: number; maxSteps: number } {
  return engine === "research"
    ? { maxMs: RESEARCH_MAX_MS, maxSteps: RESEARCH_MAX_STEPS }
    : { maxMs: MAX_JOB_MS, maxSteps: MAX_STEPS };
}

/**
 * A report with its sources listed at the end, from the web search's own
 * citations rather than the model's memory of them: each URL once, at most
 * fifteen, in the order first cited. Within MAX_RESULT, which finish() keeps:
 * a long report is shortened to make room for the list, rather than the list
 * being what is cut.
 */
export function withSources(text: string, cited: readonly Cited[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of cited) {
    let url: string;
    try {
      const u = new URL(c.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      // Tracking tags make one page look like several.
      for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
      url = u.toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    lines.push(`- ${c.title?.trim() ? `${c.title.trim()}: ` : ""}${url}`);
    if (lines.length === 15) break;
  }
  if (!lines.length) return text;
  const list = `\n\nSources:\n${lines.join("\n")}`;
  const body = text.trimEnd();
  return body.length + list.length <= MAX_RESULT ? body + list : `${body.slice(0, MAX_RESULT - list.length - 1).trimEnd()}…${list}`;
}

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
    const engine: JobEngine = input.engine === "hermes" ? "hermes" : input.engine === "research" ? "research" : "jarvis";
    const all = await this.list();
    if (all.filter((j) => j.status === "running").length >= MAX_RUNNING) {
      return `${MAX_RUNNING} jobs are already running; wait for one to finish`;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const day = (await this.storage.get<{ day: string; n: number }>(DAY)) ?? { day: today, n: 0 };
    const n = day.day === today ? day.n : 0;
    if (n >= DAILY_JOBS) return `the limit of ${DAILY_JOBS} jobs a day has been reached`;
    if (engine === "research") {
      const deps = await this.deps();
      if (deps.researchBlocked) return deps.researchBlocked;
      const limit = deps.researchLimit ?? RESEARCH_MONTHLY_DEFAULT;
      const month = today.slice(0, 7);
      const used = (await this.storage.get<{ month: string; n: number }>(RESEARCH_MONTH)) ?? { month, n: 0 };
      const m = used.month === month ? used.n : 0;
      if (limit <= 0) return "research jobs are switched off in settings";
      if (m >= limit) return `the ${limit} research jobs for this month have been used; the limit is in Settings → OpenAI`;
      await this.storage.put(RESEARCH_MONTH, { month, n: m + 1 });
    }
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
    const deps = await this.deps();
    if (j.responseId) await deps.cancel(j).catch(() => {});
    // What it spent before it was stopped still counts in Settings → Usage.
    await deps.record?.(usageEntry(j, false, now)).catch(() => {});
    return j;
  }

  /** A research job that never started gives its monthly slot back. */
  private async refundResearch(createdAt: number): Promise<void> {
    const month = new Date(createdAt).toISOString().slice(0, 7);
    const used = await this.storage.get<{ month: string; n: number }>(RESEARCH_MONTH);
    if (used && used.month === month && used.n > 0) await this.storage.put(RESEARCH_MONTH, { month, n: used.n - 1 });
  }

  /** The job as stored now, if it is still running; null if it was cancelled or removed meanwhile. */
  private async stillRunning(id: string): Promise<Job | null> {
    const cur = await this.get(id);
    return cur && cur.status === "running" ? cur : null;
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
    const { maxSteps } = limitsOf(j.engine);
    const maxMs = limitsOf(j.engine).maxMs + (j.draft ? RESEARCH_CHECK_MS : 0);
    if (now - j.createdAt > maxMs) {
      await deps.cancel(j).catch(() => {});
      return this.finish(j, deps, now, { error: `it ran for over ${maxMs / 60_000} minutes and was stopped` });
    }
    /*
     * Asking OpenAI is a wait during which the job can be cancelled or removed
     * (the Durable Object lets other requests in while it waits on the
     * network). So after each one the job is read again, and a job no longer
     * running is not saved over: that save used to undo the cancel, and the
     * job went on stepping, and spending.
     */
    if (!j.responseId) {
      // A written report's check starts the way a job does, so it is cancelled the same way.
      const s = await (j.draft ? deps.check(j, j.draft.responseId) : deps.start(j));
      if ("error" in s) {
        if (j.engine === "research" && !j.draft) await this.refundResearch(j.createdAt);
        return this.finish(j, deps, now, { error: s.error });
      }
      const cur = await this.stillRunning(j.id);
      if (!cur) {
        await deps.cancel({ ...j, responseId: s.responseId }).catch(() => {});
        return;
      }
      return this.save({ ...cur, responseId: s.responseId, steps: cur.steps + 1, nextAt: now + BACKOFF_S[0]! * 1000, updatedAt: now });
    }
    const polled = j.responseId;
    const step = await deps.poll(j);
    const usage = step.kind !== "failed" && step.usage ? addUsage(j.usage, step.usage) : j.usage;
    const cur = await this.stillRunning(j.id);
    if (!cur) {
      // Stopped meanwhile: stop what this step started too, and keep what it spent.
      if (step.kind === "continued") await deps.cancel({ ...j, responseId: step.responseId }).catch(() => {});
      const stopped = await this.get(j.id);
      if (stopped && usage) await this.save({ ...stopped, usage });
      return;
    }
    j = { ...cur, ...(usage ? { usage } : {}) };
    if (step.kind === "wait") {
      const waited = Math.round((now - j.updatedAt) / 1000);
      const next = BACKOFF_S.find((s) => s > waited) ?? BACKOFF_S[BACKOFF_S.length - 1]!;
      j.nextAt = now + next * 1000;
      // updatedAt is when the current step started, so the wait grows while it runs.
      return this.save(j);
    }
    if (step.kind === "continued") {
      if (j.steps + 1 > maxSteps) {
        await deps.cancel({ ...j, responseId: step.responseId }).catch(() => {});
        return this.finish(j, deps, now, { error: `it took more than ${maxSteps} steps and was stopped` });
      }
      j.responseId = step.responseId;
      j.steps += 1;
      j.updatedAt = now;
      j.nextAt = now + BACKOFF_S[0]! * 1000;
      return this.save(j);
    }
    if (step.kind === "done") {
      if (j.engine !== "research") return this.finish(j, deps, now, { text: step.text });
      if (!j.draft) {
        // Written: checked against its sources before anyone is told. The next tick starts the check.
        j.draft = { text: step.text, cited: step.cited ?? [], responseId: polled };
        delete j.responseId;
        j.updatedAt = j.nextAt = now;
        return this.save(j);
      }
      // A check that answered with notes rather than the report would lose the report.
      if (step.text.length < j.draft.text.length / 2) return this.finish(j, deps, now, { error: "the check did not give the report back" });
      // The check's own pages first: withSources keeps fifteen, and they back what is sent.
      return this.finish(j, deps, now, { text: withSources(step.text, [...(step.cited ?? []), ...j.draft.cited]) });
    }
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
    // The check never costs the report: if it did not finish, the report goes out as written.
    if ("error" in out && done.draft) out = { text: withSources(done.draft.text, done.draft.cited) };
    delete done.draft;
    let alert: Alert;
    if ("text" in out && out.text.trim()) {
      const { summary, result, whole } = splitResult(out.text);
      done.status = "done";
      done.summary = summary;
      done.result = result.slice(0, MAX_RESULT);
      alert = makeAlert(
        {
          title: j.engine === "hermes" ? "Hermes answered" : j.engine === "research" ? `Research done: ${j.title}` : `Done: ${j.title}`,
          text: whole.length <= ALERT_WHOLE ? whole : `${summary}\n\nThe full result is in Jobs.`,
        },
        "job",
        now,
        personOfWho(j.createdBy),
      )!;
    } else {
      done.status = "failed";
      done.error = "error" in out ? out.error.slice(0, 500) : "it finished without an answer";
      alert = makeAlert({ title: `Could not finish: ${j.title}`, text: done.error, speak: false }, "job", now, personOfWho(j.createdBy))!;
    }
    await this.save(done); // before delivering: a retried alarm must not tell the user twice
    const d = await deps.deliver(alert).catch(() => null);
    done.deliveredBy = d?.deliveredBy ?? null;
    await this.save(done);
    await deps.record?.(usageEntry(done, done.status === "done", now)).catch(() => {});
  }

  /** Keep the newest KEEP_JOBS finished ones. */
  private async prune(): Promise<void> {
    const finished = (await this.list()).filter((j) => j.status !== "running");
    for (const j of finished.slice(KEEP_JOBS)) await this.storage.delete(J + j.id);
  }
}
