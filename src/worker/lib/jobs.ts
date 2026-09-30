import type { Storage } from "./state-host.ts";
import type { Grant } from "./scopes.ts";
import { makeAlert, type Alert, type Delivery } from "./alerts.ts";
import { personOfWho } from "./context.ts";
import { tidy } from "./quote.ts";
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
 *   hermes  one question to the user's Hermes agent, however long it takes;
 *           with it, when they ask, one of their finished research reports
 *           (`from`), quoted as reference (routes/jobs.ts). Never on its own.
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
 *
 * Research as a team (`team`, asked for in so many words): one job whose
 * TEAMS teams each research the brief from an angle planned for it, in chains
 * of their own, sharing findings as they go; one call merges their reports,
 * and the merged report is checked like any other (lib/research-team.ts).
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
  /** research as a team: its teams, their angles and what they shared. Absent on every other job. */
  team?: TeamRun;
  /** hermes: the creator's own finished research job it hands over, read when Hermes is asked. */
  from?: string;
}

/** A page the web search cited: what a report's Sources list is made of. */
export type Cited = { url: string; title?: string };

/** What one team of a research team looks into: planned for the question, or one of TEAM_ANGLES. */
export type TeamAngle = { name: string; brief: string };

/** One team of a research team: its own chain of background responses, from its own angle. */
export interface TeamChain {
  state: "working" | "reported" | "stopped";
  /** Its response running at OpenAI, while working. */
  responseId?: string;
  /** When that response started: the wait between looks grows from here. */
  updatedAt: number;
  /** When to look again, while working. */
  nextAt?: number;
  /** Responses in its chain; past TEAM_MAX_STEPS it is stopped. */
  steps: number;
  /** Looks at OpenAI in a row that threw; the third stops it. */
  fails: number;
  /** How much of the board it has been told. */
  seen: number;
  /** What it wrote, and the pages it cited: kept until the merge has them. */
  report?: string;
  cited?: Cited[];
  /** Why it stopped without a report. */
  why?: string;
}

/**
 * Research as a team: the angles once planned (absent while planning), a chain
 * for each, and the board of what the teams shared (share_findings).
 */
export interface TeamRun {
  angles?: TeamAngle[];
  chains: TeamChain[];
  board: { team: number; text: string }[];
  /** While planning: looks at the plan that threw. At the second, the fixed angles are used. */
  planFails?: number;
}

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
  /** `shared`: what a team passed to share_findings in this hop. */
  | { kind: "continued"; responseId: string; usage?: Job["usage"]; shared?: string[] }
  | { kind: "done"; text: string; cited?: Cited[]; usage?: Job["usage"] }
  | { kind: "failed"; error: string };

export interface JobDeps {
  /** Start a jarvis job's first step, or team `team`'s of a research team; its response id, or why it could not start. */
  start(job: Job, team?: number): Promise<{ responseId: string } | { error: string }>;
  /** research: start the check of a written report, continuing from `after`; its response id, or why not. */
  check(job: Job, after: string): Promise<{ responseId: string } | { error: string }>;
  /** research as a team: start planning the teams' angles; its response id, or why not. */
  plan(job: Job): Promise<{ responseId: string } | { error: string }>;
  /** research as a team: start merging the teams' reports into one; its response id, or why not. */
  merge(job: Job): Promise<{ responseId: string } | { error: string }>;
  /** Look at the running step (team `team`'s, of a research team); run any tools it asked for and start the next. */
  poll(job: Job, team?: number): Promise<Step>;
  /** Stop a running step at OpenAI. Best effort. */
  cancel(job: Job): Promise<void>;
  /** Ask Hermes, waiting as long as it takes; `reference`, a research report handed over with the question. */
  hermes(job: Job, reference?: string): Promise<{ ok: boolean; text: string }>;
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

/** Research as a team: how many teams, and the angles they take when planning them does not work. */
export const TEAMS = 3;
export const TEAM_ANGLES: readonly TeamAngle[] = [
  {
    name: "the record",
    brief: "What makers, official sources and published data say: specifications, prices in the user's currency, and what is available where they live, as of now.",
  },
  {
    name: "the people who use it",
    brief: "What happens in practice: independent tests and reviews, owners and users, forums, complaints, failures and recalls.",
  },
  {
    name: "the case against",
    brief: "Question the obvious answer: alternatives, the whole cost over time, hidden costs and conditions, and what is about to change.",
  },
];
/** The teams have this long from the start; those still working then are looked at once more and stopped, and the merge goes ahead. */
export const TEAM_MS = 35 * 60_000;
/** Responses a team's own chain may take. */
export const TEAM_MAX_STEPS = 12;
/** What a team may put on the board, and how long each finding may be. */
export const SHARES_PER_TEAM = 4;
export const FINDING_MAX = 500;

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

/** How long to wait before looking at a response again, from when it started: quickly at first, then less often. */
export function nextLook(updatedAt: number, now: number): number {
  const waited = Math.round((now - updatedAt) / 1000);
  return (BACKOFF_S.find((s) => s > waited) ?? BACKOFF_S[BACKOFF_S.length - 1]!) * 1000;
}

/* ---------- research handed to Hermes -------------------------------------------- */

/** Whether `j` is finished research of `who`'s person (their devices count as them): all that may be handed to Hermes. */
export const ownResearch = (j: Job, who: string): boolean =>
  j.engine === "research" && j.status === "done" && personOfWho(j.createdBy) === personOfWho(who);

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The finished research of `who`'s that `asked` names: the most recently
 * finished for "latest", else the most recently finished whose title has every
 * word asked for (each the start of one of its words). By when it finished,
 * not started: research runs for up to an hour, several at once, so "that
 * research" is the one just heard about. Not found: what to say, naming what
 * there is.
 */
export function researchFor(jobs: readonly Job[], who: string, asked: string): Job | string {
  const mine = jobs.filter((j) => ownResearch(j, who)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const want = wordsOf(asked);
  const hit =
    asked.trim().toLowerCase() === "latest"
      ? mine[0]
      : want.length
        ? mine.find((j) => {
            const has = wordsOf(j.title);
            return want.every((w) => has.some((h) => h.startsWith(w)));
          })
        : undefined;
  if (hit) return hit;
  return `No finished research matches '${asked}'. ${mine.length ? `There is: ${mine.map((j) => `"${j.title}"`).join(", ")}.` : "There is none."}`;
}

/* ---------- research as a team ------------------------------------------------ */

/** A research team's record: without angles while they are planned; given them, a working chain for each. */
export function newTeam(now: number, angles?: readonly TeamAngle[]): TeamRun {
  if (!angles) return { chains: [], board: [] };
  return {
    angles: angles.map((a) => ({ ...a })),
    chains: angles.map((): TeamChain => ({ state: "working", updatedAt: now, nextAt: now, steps: 0, fails: 0, seen: 0 })),
    board: [],
  };
}

/** The planned angles: exactly TEAMS of them, each a short name and a brief; null for anything else. */
export function parseAngles(text: string): TeamAngle[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const list = (v as { angles?: unknown } | null)?.angles;
  if (!Array.isArray(list) || list.length !== TEAMS) return null;
  const out: TeamAngle[] = [];
  for (const a of list) {
    const name = typeof a?.name === "string" ? tidy(a.name) : "";
    const brief = typeof a?.brief === "string" ? tidy(a.brief) : "";
    if (!name || !brief || name.length > 40 || brief.length > 400) return null;
    out.push({ name, brief });
  }
  return out;
}

/** How many more findings team `t` may put on the board. */
export const sharesLeft = (j: Job, t: number): number => Math.max(0, SHARES_PER_TEAM - j.team!.board.filter((b) => b.team === t).length);

/** What happened to one team's chain: it started, a look at it, a look that threw, or it was stopped. */
export type TeamEvent = { started: string } | { step: Step } | { threw: string } | { stopped: string };

/**
 * One event applied to team `t`: the job as it is after, with the step's
 * usage added and `nextAt` the earliest look any team needs (now, for the
 * merge, once none is working).
 */
export function teamStep(j: Job, t: number, e: TeamEvent, now: number): Job {
  const chains = j.team!.chains.map((c) => ({ ...c }));
  const c = chains[t]!;
  let board = j.team!.board;
  let usage = j.usage;
  const stop = (why: string) => {
    c.state = "stopped";
    c.why = why;
  };
  const next = (id: string) => Object.assign(c, { responseId: id, steps: c.steps + 1, updatedAt: now, nextAt: now + BACKOFF_S[0]! * 1000 });
  if ("started" in e) next(e.started);
  else if ("stopped" in e) stop(e.stopped);
  else if ("threw" in e) {
    c.fails += 1;
    if (c.fails >= 3) stop("OpenAI could not be reached, three times running");
    else c.nextAt = now + 30_000;
  } else {
    const s = e.step;
    if (s.kind !== "failed" && s.usage) usage = addUsage(usage, s.usage);
    c.fails = 0;
    if (s.kind === "wait") c.nextAt = now + nextLook(c.updatedAt, now);
    else if (s.kind === "continued") {
      if (s.shared) {
        // Posted up to the team's allowance; what it was told in reply is all it has now seen.
        const room = sharesLeft(j, t);
        const posts = s.shared.map((f) => tidy(f).slice(0, FINDING_MAX)).filter(Boolean).slice(0, room);
        board = [...board, ...posts.map((text) => ({ team: t, text }))];
        c.seen = board.length;
      }
      if (c.steps + 1 > TEAM_MAX_STEPS) stop(`it took more than ${TEAM_MAX_STEPS} steps`);
      else next(s.responseId);
    } else if (s.kind === "done") {
      c.state = "reported";
      c.report = s.text.slice(0, MAX_RESULT);
      c.cited = s.cited ?? [];
    } else stop(s.error);
  }
  if (c.state !== "working") {
    delete c.responseId;
    delete c.nextAt;
  }
  const looks = chains.filter((x) => x.state === "working").map((x) => x.nextAt ?? now);
  return { ...j, ...(usage ? { usage } : {}), team: { ...j.team!, chains, board }, nextAt: looks.length ? Math.min(...looks) : now, updatedAt: now };
}

/** Every response the job has running at OpenAI: its own, and each working team's. */
export function responseIdsOf(j: Job): string[] {
  return [j.responseId, ...(j.team?.chains ?? []).map((c) => c.responseId)].filter((id): id is string => !!id);
}

/** The pages the teams cited, taken in turn from each, so a list of fifteen has every team's. */
export function teamCited(team: TeamRun): Cited[] {
  const lists = team.chains.map((c) => c.cited ?? []);
  const out: Cited[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** When the reports could not be merged: each team's as it was written, under its angle; null if none reported. */
export function unmerged(team: TeamRun): string | null {
  const done = team.chains.flatMap((c, i) => (c.state === "reported" && c.report ? [{ report: c.report, i }] : []));
  if (!done.length) return null;
  return (
    `SUMMARY: ${splitResult(done[0]!.report).summary}\n\n` +
    "The teams' reports could not be merged or checked, so here is each as it was written." +
    done.map(({ report, i }) => `\n\nTeam ${i + 1}: ${team.angles?.[i]?.name ?? ""}\n${splitResult(report).result}`).join("")
  );
}

/** A team's record once what it wrote is kept elsewhere (the merge's chain, the result): what the panel counts. */
export function slimTeam(team: TeamRun): TeamRun {
  return {
    ...(team.angles ? { angles: team.angles } : {}),
    chains: team.chains.map(({ state, updatedAt, steps, fails, seen, why }) => ({ state, updatedAt, steps, fails, seen, ...(why ? { why } : {}) })),
    board: [],
  };
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
    input: { title?: unknown; task?: unknown; engine?: unknown; team?: unknown; from?: unknown },
    by: { who: string; grants: readonly Grant[] },
    now = Date.now(),
  ): Promise<Job | string> {
    const task = clean(input.task, MAX_TASK);
    if (!task) return "a job needs a task: what to find out or work through";
    const engine: JobEngine = input.engine === "hermes" ? "hermes" : input.engine === "research" ? "research" : "jarvis";
    // First: what `from` names must not be pruned by this very create, after it was accepted.
    await this.prune();
    // Research handed to Hermes: only the caller's own, and finished. Other engines ignore it.
    let from: string | undefined;
    if (engine === "hermes" && input.from !== undefined && input.from !== null) {
      const src = typeof input.from === "string" && input.from ? await this.get(input.from) : undefined;
      if (!src || !ownResearch(src, by.who)) return "there is no finished research of yours with that id";
      from = src.id;
    }
    // Research as a team: a way of doing research, and one at a time. It takes one of the month's research jobs, the owner's choice.
    const team = engine === "research" && input.team === true;
    const all = await this.list();
    if (all.filter((j) => j.status === "running").length >= MAX_RUNNING) {
      return `${MAX_RUNNING} jobs are already running; wait for one to finish`;
    }
    if (team && all.some((j) => j.status === "running" && j.team)) return "a research team is already working; wait for it to finish";
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
      ...(team ? { team: newTeam(now) } : {}),
      ...(from ? { from } : {}),
    };
    await this.save(job);
    return job;
  }

  async cancel(id: string, now = Date.now()): Promise<Job | string> {
    const j = await this.get(id);
    if (!j) return "no such job";
    if (j.status !== "running") return j;
    const running = responseIdsOf(j);
    j.status = "cancelled";
    j.finishedAt = j.updatedAt = now;
    delete j.nextAt;
    if (j.team) j.team = slimTeam(j.team);
    await this.save(j);
    const deps = await this.deps();
    for (const id of running) await deps.cancel({ ...j, responseId: id }).catch(() => {});
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
      for (const id of responseIdsOf(j)) await deps.cancel({ ...j, responseId: id }).catch(() => {});
      return this.finish(j, deps, now, { error: `it ran for over ${maxMs / 60_000} minutes and was stopped` });
    }
    // Research as a team: while a team is working, the job is its teams.
    if (j.team?.chains.some((c) => c.state === "working")) return this.advanceTeams(j, deps, now);
    const team = j.team;
    const planning = !!team && !team.angles;
    /*
     * Asking OpenAI is a wait during which the job can be cancelled or removed
     * (the Durable Object lets other requests in while it waits on the
     * network). So after each one the job is read again, and a job no longer
     * running is not saved over: that save used to undo the cancel, and the
     * job went on stepping, and spending.
     */
    if (!j.responseId) {
      if (team && !planning && !j.draft && !team.board.length && !team.chains.some((c) => c.state === "reported")) {
        const why = team.chains.map((c, i) => `team ${i + 1}: ${c.why ?? "no report"}`).join("; ");
        return this.finish(j, deps, now, { error: `none of the teams found anything (${why})` });
      }
      // A written report's check, and a team's plan and merge, start the way a job does, so they are cancelled the same way.
      const s = await (j.draft ? deps.check(j, j.draft.responseId) : planning ? deps.plan(j) : team ? deps.merge(j) : deps.start(j));
      if ("error" in s) {
        // Planning never costs the run: unplanned, the teams take the fixed angles.
        if (planning) {
          const cur = await this.stillRunning(j.id);
          return cur ? this.planned(cur, TEAM_ANGLES, now) : undefined;
        }
        if (j.engine === "research" && !j.draft && !team) await this.refundResearch(j.createdAt);
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
    let step: Step;
    try {
      step = await deps.poll(j);
    } catch (e) {
      if (!planning) throw e;
      // The plan could not be looked at: once more in 30 seconds, then the fixed angles.
      const cur = await this.stillRunning(j.id);
      if (!cur?.team) return;
      if (!cur.team.planFails) return this.save({ ...cur, team: { ...cur.team, planFails: 1 }, nextAt: now + 30_000 });
      // Saved before the plan is let go: a cancel while OpenAI is asked then finds this record, and nothing saves over it.
      await this.planned(cur, TEAM_ANGLES, now);
      await deps.cancel(cur).catch(() => {});
      return;
    }
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
      j.nextAt = now + nextLook(j.updatedAt, now);
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
      if (planning) return this.planned(j, parseAngles(step.text) ?? TEAM_ANGLES, now);
      if (!j.draft) {
        // Written (a team's, merged): checked against its sources before anyone is told. The next tick starts the check.
        j.draft = { text: step.text, cited: [...(step.cited ?? []), ...(team ? teamCited(team) : [])], responseId: polled };
        // The merge's chain holds what the teams wrote now; the record need not.
        if (j.team) j.team = slimTeam(j.team);
        delete j.responseId;
        j.updatedAt = j.nextAt = now;
        return this.save(j);
      }
      // A check that answered with notes rather than the report would lose the report.
      if (step.text.length < j.draft.text.length / 2) return this.finish(j, deps, now, { error: "the check did not give the report back" });
      // The check's own pages first: withSources keeps fifteen, and they back what is sent.
      return this.finish(j, deps, now, { text: withSources(step.text, [...(step.cited ?? []), ...j.draft.cited]) });
    }
    if (planning) return this.planned(j, TEAM_ANGLES, now);
    return this.finish(j, deps, now, { error: step.error });
  }

  /** A research team's angles are settled: each team starts from its own at the next look. */
  private planned(j: Job, angles: readonly TeamAngle[], now: number): Promise<void> {
    const next: Job = { ...j, team: newTeam(now, angles), updatedAt: now, nextAt: now };
    delete next.responseId;
    return this.save(next);
  }

  /**
   * Research as a team: each working team's chain in turn, the job read again
   * before each, so a team hears what one before it shared a moment ago. A
   * team that fails is stopped and the others go on; only team 1 failing to
   * start ends the run, as research that cannot start does, its slot given back.
   */
  private async advanceTeams(j: Job, deps: JobDeps, now: number): Promise<void> {
    const late = now - j.createdAt > TEAM_MS;
    const tooLong = { stopped: `it ran for over ${TEAM_MS / 60_000} minutes` };
    for (let t = 0; t < TEAMS; t++) {
      const cur = await this.stillRunning(j.id);
      if (!cur?.team) return;
      const c = cur.team.chains[t];
      if (c?.state !== "working") continue;
      if (!c.responseId) {
        if (late) {
          await this.save(teamStep(cur, t, tooLong, now));
          continue;
        }
        const s = await deps.start(cur, t);
        if ("error" in s && t === 0) {
          await this.refundResearch(cur.createdAt);
          return this.finish(cur, deps, now, { error: s.error });
        }
        const after = await this.stillRunning(j.id);
        if (!after) {
          if ("responseId" in s) await deps.cancel({ ...cur, responseId: s.responseId }).catch(() => {});
          return;
        }
        await this.save(teamStep(after, t, "error" in s ? { stopped: s.error } : { started: s.responseId }, now));
        continue;
      }
      // Past the teams' time each is looked at once more, due or not, so a report written since the last look is kept.
      if (!late && (c.nextAt ?? 0) > now + 1000) continue;
      const e: TeamEvent = await deps.poll(cur, t).then(
        (step) => ({ step }),
        (x: unknown) => ({ threw: x instanceof Error ? x.message : String(x) }),
      );
      const after = await this.stillRunning(j.id);
      if (!after) {
        // Stopped meanwhile: stop what this step started too, and keep what it spent.
        if ("step" in e && e.step.kind === "continued") await deps.cancel({ ...cur, responseId: e.step.responseId }).catch(() => {});
        const stopped = await this.get(j.id);
        const spent = "step" in e && e.step.kind !== "failed" ? e.step.usage : undefined;
        if (stopped && spent) await this.save({ ...stopped, usage: addUsage(stopped.usage, spent) });
        return;
      }
      let next = teamStep(after, t, e, now);
      // A team stopped here may leave a response running: the one it just started, or the one that could not be looked at.
      const left = next.team!.chains[t]!.responseId ?? ("threw" in e ? c.responseId : "step" in e && e.step.kind === "continued" ? e.step.responseId : undefined);
      if (late && next.team!.chains[t]!.state === "working") next = teamStep(next, t, tooLong, now);
      // Saved before that response is let go: a cancel while OpenAI is asked then finds this record, and nothing saves over it.
      await this.save(next);
      if (left && next.team!.chains[t]!.state === "stopped") await deps.cancel({ ...after, responseId: left }).catch(() => {});
    }
  }

  private async advanceHermes(j: Job, deps: JobDeps, now: number): Promise<void> {
    // An alarm cut short mid-question (a deploy) is retried once, not forever.
    if (j.attempts >= 2) return this.finish(j, deps, now, { error: "Hermes was interrupted twice" });
    // Research handed over is read now: it may have been pruned or removed since the job was made.
    const reference = j.from ? (await this.get(j.from))?.result : undefined;
    if (j.from && !reference) return this.finish(j, deps, now, { error: "the research to hand over is no longer kept" });
    j.attempts += 1;
    j.nextAt = now + 10 * 60_000; // recorded first: while asking, nothing else should pick it up
    j.updatedAt = now;
    await this.save(j);
    const r = await deps.hermes(j, reference);
    return this.finish(j, deps, Date.now(), r.ok ? { text: r.text } : { error: r.text });
  }

  private async finish(j: Job, deps: JobDeps, now: number, out: { text: string } | { error: string }): Promise<void> {
    const cur = await this.get(j.id);
    if (!cur || cur.status !== "running") return; // cancelled or removed while it ran
    const done = { ...cur, ...j, finishedAt: now, updatedAt: now };
    delete done.nextAt;
    if ("error" in out) {
      // The check never costs the report: if it did not finish, the report goes out as written.
      // Nor does the merge cost the teams' reports: unmerged, each goes out as it was written.
      const each = done.team ? unmerged(done.team) : null;
      if (done.draft) out = { text: withSources(done.draft.text, done.draft.cited) };
      else if (each && done.team) out = { text: withSources(each, teamCited(done.team)) };
    }
    delete done.draft;
    if (done.team) done.team = slimTeam(done.team);
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
