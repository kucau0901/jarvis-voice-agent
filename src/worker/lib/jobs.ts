import type { Storage } from "./state-host.ts";
import type { Grant } from "./scopes.ts";
import { sourcesOf } from "./links.ts";
import { emptied, parseTablePlan, tableOf, tableResult } from "./research-table.ts";
import { makeAlert, type Alert, type Delivery } from "./alerts.ts";
import { personOfWho } from "./context.ts";
import { tidy } from "./quote.ts";
import type { UsageEntry } from "./usage.ts";
import { clearChain } from "./job-chain.ts";

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
 * A job READS but does not ACT on its own (routes/jobs.ts picks its tools):
 * nobody is watching it, and it reads things written by others — web pages,
 * mail — so nothing it has can send, delete, unlock or switch anything. Its
 * tools that act are held copies (lib/proposals.ts held()): a call files a
 * proposal for the person's tap, or runs once for a reversible kind they let
 * jobs do without asking. Its mail is only drafted, and sending it proposed
 * (lib/mail-draft.ts).
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

/**
 * What a job may look at, settled when it is started: its person's own things
 * (mail, calendar, memory, the house, the car), or the web. Never both: what is
 * looked up on the web leaves by the words of the search, and a page or a mail
 * it reads may ask for exactly that. Research is the web's.
 */
export type Reach = "private" | "web";
export const reachOf = (j: Pick<Job, "engine" | "reach">): Reach => (j.engine === "research" ? "web" : (j.reach ?? "private"));
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
  /**
   * research into a table (lib/research-table.ts): a team that fills rows. Its
   * columns once planned, and how many rows it came back with; the rows are
   * kept apart (jobtable:<id>), to download.
   */
  table?: { columns?: string[]; rows?: number };
  /** An ordinary job's: its person's own things, or the web (reachOf). */
  reach?: Reach;
  /** Waiting for the owner's ChatGPT plan, at its limit: since when, and until when (lib/openai-auth.ts PlanParked). */
  parked?: { since: number; until: number };
  /** How long it has waited so, which its time limit does not count. */
  waited?: number;
  /** Moved to the API key by its person's tap, rather than wait. */
  onKey?: true;
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
  /** The plan is at its limit: nothing was asked, and it goes on from here then. */
  | { kind: "parked"; until: number }
  | { kind: "failed"; error: string };

/** A step started: its response id, the plan to wait for, or why it could not start. */
export type Started = { responseId: string } | { parked: number } | { error: string };

/** `stop`, where a step streams here for minutes (the ChatGPT plan, Hermes): aborted when the person stops the job. */
export interface JobDeps {
  /** Start a jarvis job's first step, or team `team`'s of a research team; its response id, or why it could not start. */
  start(job: Job, team?: number, stop?: AbortSignal): Promise<Started>;
  /** research: start the check of a written report, continuing from `after`; its response id, or why not. */
  check(job: Job, after: string, stop?: AbortSignal): Promise<Started>;
  /** research as a team: start planning the teams' angles; its response id, or why not. */
  plan(job: Job, stop?: AbortSignal): Promise<Started>;
  /** research as a team: start merging the teams' reports into one; its response id, or why not. */
  merge(job: Job, stop?: AbortSignal): Promise<Started>;
  /** Look at the running step (team `team`'s, of a research team); run any tools it asked for and start the next. */
  poll(job: Job, team?: number, stop?: AbortSignal): Promise<Step>;
  /** Stop a running step at OpenAI. Best effort. */
  cancel(job: Job): Promise<void>;
  /** Ask Hermes, waiting as long as it takes; `reference`, a research report handed over with the question. */
  hermes(job: Job, reference?: string, stop?: AbortSignal): Promise<{ ok: boolean; text: string; late?: boolean }>;
  deliver(alert: Alert): Promise<Delivery>;
  /** Research jobs allowed a month (RESEARCH_MONTHLY_LIMIT); 0 turns them off. */
  researchLimit?: number;
  /** Why research cannot run on this deployment at all, e.g. web search withheld. */
  researchBlocked?: string | null;
  /** A finished job, for Settings → Usage. */
  record?(e: UsageEntry): Promise<void>;
  /** A finished job, for the next question like it (lib/episodes.ts). */
  episode?(j: Job): Promise<void>;
}

const J = "job:";
/** A table job's rows (Job.table), beside the job: not under "job:", which list() reads. */
const T = "jobtable:";
/** A person's jobs today, by person (lib/context.ts): one member cannot spend the family's day. */
const DAY = (person: string) => `jobs:day:${person}`;

/** Each a person's own: one member's jobs neither block nor prune another's. */
export const MAX_RUNNING = 3;
/** Running in the whole house at once, besides questions for Hermes: they share the owner's one plan with the family's own questions. */
export const HOUSE_RUNNING = 6;
/** Looked at at once, besides Hermes: on the plan each is a stream. */
export const MAX_IN_HAND = 3;
/** Tokens one person's jobs may use of the plan in a day: one member cannot use up what the house shares. */
export const DAILY_PLAN_TOKENS = 5_000_000;
const TOKENS = (person: string) => `jobs:tokens:${person}`;
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
/** Whether start_job was refused for the month's research cap (create, below), so typed chat can show it as a limit, not a failure. */
export const isResearchCap = (said: string): boolean => /research jobs (for this month have been used|are switched off)/.test(said);
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

/**
 * Jarvis's own tools that only read, as a job is handed them. Anything that
 * sends, books, switches or remembers is left out; so are some that only
 * read (music_state, family_messages), which say so themselves (`reads`,
 * tools/registry.ts) for a Home tile and are still not a job's.
 */
const READ_TOOLS = new Set([
  "recall", "car_state", "directions", "place_info", "look_at_camera",
  "mail_check", "mail_search", "contacts_lookup", "calendar_check", "routine_list",
  "job_results", "time_in",
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

/**
 * Whether a tool only reads, for what runs it with nobody pressing anything
 * (a Home tile's reading, lib/panel-tiles.ts). What it says of itself comes
 * first (`reads`: Jarvis's own tools that only look something up, and a
 * component's as an admin classed it, lib/components.ts, whatever its name);
 * an MCP server's goes by its name, as above; anything else is taken to act.
 */
export function readsOnly(t: { name: string; reads?: boolean }): boolean {
  if (t.reads !== undefined) return t.reads;
  const i = t.name.indexOf("__");
  if (i < 0) return false;
  const own = t.name.slice(i + 2).toLowerCase();
  return !WRITES.test(own) && READS.test(own);
}

/** What a job on the web is handed besides its searches: nothing of its person's, and nothing that remembers. */
const WEB_TOOLS = new Set(["time_in", "place_info"]);
export const webTool = (t: { name: string }): boolean => WEB_TOOLS.has(t.name);

/** What a job is handed to read with: of Jarvis's own, those named above and no others; of the rest, what only reads. */
export function jobTool(t: { name: string; reads?: boolean }): boolean {
  return t.name.includes("__") ? readsOnly(t) : READ_TOOLS.has(t.name);
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
  const lines = sourcesOf(cited, 15).map((c) => `- ${c.title ? `${c.title}: ` : ""}${c.url}`);
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

export const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

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
export type TeamEvent = { started: string } | { step: Exclude<Step, { kind: "parked" }> } | { threw: string } | { stopped: string };

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

/** A job that was waiting for the plan and no longer is: how long it waited is not its time. */
function resumed(j: Job, now: number): Job {
  const { parked, ...rest } = j;
  return parked ? { ...rest, waited: (j.waited ?? 0) + Math.max(0, now - parked.since) } : j;
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
  /** The jobs being looked at now, and how to stop each: one look at a job at a time, whatever the alarm does meanwhile. */
  private live = new Map<string, { look: Promise<void>; stop: AbortController; hermes: boolean }>();
  /** When each running job is next to be looked at: read once, then kept as they are saved, so nothing lists every result to find out. */
  private due: Map<string, number> | null = null;

  constructor(storage: Storage, deps: () => Promise<JobDeps>) {
    this.storage = storage;
    this.deps = deps;
  }

  private async waiting(): Promise<Map<string, number>> {
    if (!this.due) {
      const due = new Map<string, number>();
      for (const j of await this.list()) if (j.status === "running") due.set(j.id, j.nextAt ?? 0);
      this.due ??= due;
    }
    return this.due;
  }

  async list(who?: string): Promise<Job[]> {
    const all = [...(await this.storage.list<Job>({ prefix: J })).values()].sort((a, b) => b.createdAt - a.createdAt);
    return who ? all.filter((j) => j.createdBy === who) : all;
  }

  get(id: string): Promise<Job | undefined> {
    return this.storage.get<Job>(J + id);
  }

  private async save(j: Job): Promise<void> {
    if (j.status === "running") this.due?.set(j.id, j.nextAt ?? 0);
    else this.due?.delete(j.id);
    await this.storage.put(J + j.id, j);
  }

  private async drop(id: string): Promise<boolean> {
    this.due?.delete(id);
    await clearChain(this.storage, id);
    await this.storage.delete(T + id);
    return this.storage.delete(J + id);
  }

  async create(
    input: { title?: unknown; task?: unknown; engine?: unknown; reach?: unknown; team?: unknown; from?: unknown; table?: unknown },
    by: { who: string; grants: readonly Grant[] },
    now = Date.now(),
  ): Promise<Job | string> {
    const task = clean(input.task, MAX_TASK);
    if (!task) return "a job needs a task: what to find out or work through";
    const engine: JobEngine = input.engine === "hermes" ? "hermes" : input.engine === "research" ? "research" : "jarvis";
    // First: what `from` names must not be pruned by this very create, after it was accepted.
    await this.prune(now);
    // Research handed to Hermes: only the caller's own, and finished. Other engines ignore it.
    let from: string | undefined;
    if (engine === "hermes" && input.from !== undefined && input.from !== null) {
      const src = typeof input.from === "string" && input.from ? await this.get(input.from) : undefined;
      if (!src || !ownResearch(src, by.who)) return "there is no finished research of yours with that id";
      from = src.id;
    }
    // Research as a team: a way of doing research, and one at a time. It takes one of the month's research jobs, the owner's choice.
    // Into a table: a research team that fills rows, so one too.
    const table = engine === "research" && input.table === true;
    const team = engine === "research" && (input.team === true || table);
    const all = await this.list();
    const person = personOfWho(by.who);
    if (all.filter((j) => j.status === "running" && personOfWho(j.createdBy) === person).length >= MAX_RUNNING) {
      return `${MAX_RUNNING} jobs are already running; wait for one to finish`;
    }
    if (team && all.some((j) => j.status === "running" && j.team)) return "a research team is already working; wait for it to finish";
    if (engine !== "hermes" && all.filter((j) => j.status === "running" && j.engine !== "hermes").length >= HOUSE_RUNNING) {
      return `${HOUSE_RUNNING} jobs are already running in the house; wait for one to finish`;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    if (engine !== "hermes" && (await this.tokensToday(person, now)) >= DAILY_PLAN_TOKENS) {
      return "today's share of the ChatGPT plan for background work has been used; it starts again tomorrow";
    }
    const day = (await this.storage.get<{ day: string; n: number }>(DAY(person))) ?? { day: today, n: 0 };
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
    await this.storage.put(DAY(person), { day: today, n: n + 1 });

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
      ...(engine === "jarvis" ? { reach: input.reach === "web" ? ("web" as const) : ("private" as const) } : {}),
      ...(team ? { team: newTeam(now) } : {}),
      ...(table ? { table: {} } : {}),
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
    delete j.parked;
    if (j.team) j.team = slimTeam(j.team);
    await this.save(j);
    // A step streaming here is let go at once, rather than paid for to its end.
    this.live.get(id)?.stop.abort();
    const deps = await this.deps();
    for (const id of running) await deps.cancel({ ...j, responseId: id }).catch(() => {});
    await clearChain(this.storage, id);
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
    return this.drop(id);
  }

  /** A table job's rows, with its columns; null for any other job, or one that came back as prose. */
  async table(id: string): Promise<{ columns: string[]; rows: string[][] } | null> {
    return (await this.storage.get<{ columns: string[]; rows: string[][] }>(T + id)) ?? null;
  }

  /** When the first job that is not already in hand is due; what is in hand keeps the object awake itself (state.ts going), and is followed by whatever waits its turn. */
  async nextWake(now = Date.now()): Promise<number | null> {
    let next: number | null = null;
    for (const [id, at] of await this.waiting()) if (!this.live.has(id) && (at > now || this.room()) && (next === null || at < next)) next = at;
    return next === null ? null : Math.max(next, now);
  }

  private room(): boolean {
    return [...this.live.values()].filter((l) => !l.hermes).length < MAX_IN_HAND;
  }

  /**
   * Start a look at every job that is due and not already in hand; each, as it
   * ends (never rejected). The object hands them to waitUntil (state.ts): a step
   * on the ChatGPT plan streams here for minutes, and a reminder, the house or
   * a tap waits for none of them. Cut short with the object (an update, a
   * restart), a job is due as it was, and the alarm takes it up again.
   */
  async begin(now = Date.now()): Promise<Promise<void>[]> {
    const ids = [...(await this.waiting())].filter(([id, at]) => at <= now + 1000 && !this.live.has(id)).map(([id]) => id);
    if (!ids.length) return [];
    const deps = await this.deps();
    const looks: Promise<void>[] = [];
    for (const id of ids) {
      const j = await this.stillRunning(id);
      const hermes = j?.engine === "hermes";
      if (!j || this.live.has(id) || (!hermes && !this.room())) continue;
      const stop = new AbortController();
      const look = (hermes ? this.advanceHermes(j, deps, now, stop.signal) : this.advanceJarvis(j, deps, now, stop.signal))
        .catch((e) => this.finish(j, deps, now, { error: e instanceof Error ? e.message : String(e) }))
        .catch((e) => console.error("job", id, e instanceof Error ? e.message : String(e)))
        .finally(() => this.live.delete(id));
      this.live.set(id, { look, stop, hermes });
      looks.push(look);
    }
    return looks;
  }

  /** Advance every job that is due, to the end of each look. */
  async tick(now = Date.now()): Promise<void> {
    await Promise.all(await this.begin(now));
  }

  /** Waiting for the plan: the job, and any team of it still working, due again when the plan is. */
  private async park(id: string, until: number, now: number): Promise<void> {
    const cur = await this.stillRunning(id);
    if (!cur) return;
    const team = cur.team && { ...cur.team, chains: cur.team.chains.map((c) => (c.state === "working" ? { ...c, nextAt: until } : c)) };
    await this.save({ ...cur, ...(team ? { team } : {}), parked: { since: cur.parked?.since ?? now, until }, nextAt: until });
  }

  /** Its person moved it to the API key rather than wait for the plan: due at once, there. */
  async useKey(id: string, now = Date.now()): Promise<Job | string> {
    const j = await this.stillRunning(id);
    if (!j) return "no such job running";
    const next = resumed(j, now);
    const team = next.team && { ...next.team, chains: next.team.chains.map((c) => (c.state === "working" ? { ...c, nextAt: now } : c)) };
    await this.save({ ...next, ...(team ? { team } : {}), onKey: true, nextAt: now });
    return { ...next, onKey: true };
  }

  private async tokensToday(person: string, now: number): Promise<number> {
    const t = await this.storage.get<{ day: string; n: number }>(TOKENS(person));
    return t?.day === new Date(now).toISOString().slice(0, 10) ? t.n : 0;
  }

  /** What a step used of the plan, counted to whoever started it. */
  private async countTokens(j: Job, u: JobUsage | undefined, now: number): Promise<void> {
    if (!u?.model?.startsWith("chatgpt:")) return;
    const person = personOfWho(j.createdBy);
    await this.storage.put(TOKENS(person), { day: new Date(now).toISOString().slice(0, 10), n: (await this.tokensToday(person, now)) + u.input + u.output });
  }

  private async advanceJarvis(j: Job, deps: JobDeps, now: number, stop: AbortSignal): Promise<void> {
    if (j.parked) {
      j = resumed(j, now);
      await this.save(j);
    }
    const { maxSteps } = limitsOf(j.engine);
    const maxMs = limitsOf(j.engine).maxMs + (j.draft ? RESEARCH_CHECK_MS : 0);
    if (now - j.createdAt - (j.waited ?? 0) > maxMs) {
      for (const id of responseIdsOf(j)) await deps.cancel({ ...j, responseId: id }).catch(() => {});
      return this.finish(j, deps, now, { error: `it ran for over ${maxMs / 60_000} minutes and was stopped` });
    }
    // Research as a team: while a team is working, the job is its teams.
    if (j.team?.chains.some((c) => c.state === "working")) return this.advanceTeams(j, deps, now, stop);
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
      const s = await (j.draft ? deps.check(j, j.draft.responseId, stop) : planning ? deps.plan(j, stop) : team ? deps.merge(j, stop) : deps.start(j, undefined, stop));
      if ("parked" in s) return this.park(j.id, s.parked, now);
      if ("error" in s) {
        if (stop.aborted) return;
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
      step = await deps.poll(j, undefined, stop);
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
    if (step.kind === "parked") return this.park(j.id, step.until, now);
    if (step.kind !== "failed") await this.countTokens(j, step.usage, now);
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
      if (planning && j.table) {
        // A plan that gives no columns makes it ordinary team research: a report, not a table.
        const plan = parseTablePlan(step.text, TEAMS);
        if (plan) return this.planned({ ...j, table: { columns: plan.columns } }, plan.angles, now);
        const { table: _, ...prose } = j;
        return this.planned(prose, TEAM_ANGLES, now);
      }
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
      // A check that answered with notes rather than the report would lose the report. A table's check
      // drops the rows no source backs, so it may come back much shorter: it is judged by still being a table.
      const cols = j.table?.columns;
      const draftTable = !!cols && tableOf(j.draft.text, cols) !== null;
      // Every row taken out: that is the check's answer, and the merge it rejected is not sent instead.
      const none = draftTable ? emptied(step.text) : null;
      if (none !== null) return this.finish({ ...j, draft: undefined }, deps, now, { text: `SUMMARY: ${none}\n\nThe check found no source for any row of the table, so none was kept.` });
      const gaveBack = draftTable && cols ? tableOf(step.text, cols) !== null : step.text.length >= j.draft.text.length / 2;
      if (!gaveBack) return this.finish(j, deps, now, { error: "the check did not give the report back" });
      // The check's own pages first: withSources keeps fifteen, and they back what is sent.
      return this.finish(j, deps, now, { text: step.text, cited: [...(step.cited ?? []), ...j.draft.cited] });
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
  private async advanceTeams(j: Job, deps: JobDeps, now: number, stop: AbortSignal): Promise<void> {
    const late = now - j.createdAt - (j.waited ?? 0) > TEAM_MS;
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
        const s = await deps.start(cur, t, stop);
        if (stop.aborted && "error" in s) return;
        if ("parked" in s) return this.park(cur.id, s.parked, now);
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
      const looked: { step: Step } | { threw: string } = await deps.poll(cur, t, stop).then(
        (step) => ({ step }),
        (x: unknown) => ({ threw: x instanceof Error ? x.message : String(x) }),
      );
      if ("step" in looked && looked.step.kind === "parked") return this.park(cur.id, looked.step.until, now);
      const e = looked as TeamEvent;
      if ("step" in e && e.step.kind !== "failed") await this.countTokens(cur, e.step.usage, now);
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

  private async advanceHermes(j: Job, deps: JobDeps, now: number, stop: AbortSignal): Promise<void> {
    // An alarm cut short mid-question (a deploy) is retried once, not forever.
    if (j.attempts >= 2) return this.finish(j, deps, now, { error: "Hermes was interrupted twice" });
    // Research handed over is read now: it may have been pruned or removed since the job was made.
    const reference = j.from ? (await this.get(j.from))?.result : undefined;
    if (j.from && !reference) return this.finish(j, deps, now, { error: "the research to hand over is no longer kept" });
    j.attempts += 1;
    j.nextAt = now + 10 * 60_000; // recorded first: cut short while asking, it is taken up again once Hermes has had its time
    j.updatedAt = now;
    await this.save(j);
    const r = await deps.hermes(j, reference, stop);
    return this.finish(j, deps, Date.now(), r.ok ? { text: r.text } : { error: r.text, ...(r.late ? { late: true } : {}) });
  }

  /** A job ended. A research report comes with its pages uncut (`cited`), so a table is read whole before it is shortened to send. */
  private async finish(j: Job, deps: JobDeps, now: number, out: { text: string; cited?: readonly Cited[] } | { error: string; late?: boolean }): Promise<void> {
    const cur = await this.get(j.id);
    if (!cur || cur.status !== "running") return; // cancelled or removed while it ran
    const done = { ...cur, ...j, finishedAt: now, updatedAt: now };
    delete done.nextAt;
    delete done.parked;
    if ("error" in out) {
      // The check never costs the report: if it did not finish, the report goes out as written.
      // Nor does the merge cost the teams' reports: unmerged, each goes out as it was written.
      const each = done.team ? unmerged(done.team) : null;
      if (done.draft) out = { text: done.draft.text, cited: done.draft.cited };
      else if (each && done.team) out = { text: each, cited: teamCited(done.team) };
    }
    delete done.draft;
    if (done.team) done.team = slimTeam(done.team);
    if ("text" in out) {
      // Into a table: its rows kept to download, the result their summary and the first of them.
      const columns = done.table?.columns;
      const t = columns ? tableOf(out.text, columns) : null;
      if (t && columns) {
        await this.storage.put(T + done.id, { columns, rows: t.rows });
        done.table = { columns, rows: t.rows.length };
        out = { text: tableResult(t, columns, withSources("", out.cited ?? [])) };
      } else if (out.cited) out = { text: withSources(out.text, out.cited) };
    }
    let alert: Alert;
    if ("text" in out && out.text.trim()) {
      const { summary, result, whole } = splitResult(out.text);
      done.status = "done";
      done.summary = summary;
      done.result = result.slice(0, MAX_RESULT);
      alert = {
        ...makeAlert(
          {
            title: j.engine === "hermes" ? "Hermes answered" : j.engine === "research" ? `Research done: ${j.title}` : `Done: ${j.title}`,
            text: whole.length <= ALERT_WHOLE ? whole : `${summary}\n\nThe full result is in Jobs.`,
          },
          "job",
          now,
          personOfWho(j.createdBy),
        )!,
        job: j.id,
      };
    } else {
      done.status = "failed";
      done.error = "error" in out ? out.error.slice(0, 500) : "it finished without an answer";
      // Hermes past the wait has not failed: it is still working, and says so itself when it is done.
      const title = "late" in out && out.late ? `Still working: ${j.title}` : `Could not finish: ${j.title}`;
      alert = { ...makeAlert({ title, text: done.error, speak: false }, "job", now, personOfWho(j.createdBy))!, job: j.id };
    }
    await this.save(done); // before delivering: a retried alarm must not tell the user twice
    await clearChain(this.storage, done.id);
    const d = await deps.deliver(alert).catch(() => null);
    done.deliveredBy = d?.deliveredBy ?? null;
    // Removed while it was being told (a push can take seconds): gone stays gone.
    if (await this.get(done.id)) await this.save(done);
    await deps.record?.(usageEntry(done, done.status === "done", now)).catch(() => {});
    // How it went, for next time (lib/episodes.ts): not Hermes still working past the wait, which has not failed.
    if (!("late" in out && out.late)) await deps.episode?.(done).catch(() => {});
  }

  /** Keep each person's newest KEEP_JOBS finished ones: one member's many never prune another's. */
  private async prune(now: number): Promise<void> {
    // Steps a version before the rows kept whole (lib/job-chain.ts), once no job can still be on one.
    for (const [k, s] of await this.storage.list<{ at: number }>({ prefix: "jobplan:" })) if (now - s.at > 2 * 3_600_000) await this.storage.delete(k);
    const kept = new Map<string, number>();
    for (const j of (await this.list()).filter((x) => x.status !== "running")) {
      const person = personOfWho(j.createdBy);
      const n = (kept.get(person) ?? 0) + 1;
      kept.set(person, n);
      if (n > KEEP_JOBS) await this.drop(j.id);
    }
  }
}
