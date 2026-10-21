import type { Storage } from "./state-host.ts";
import type { Alert } from "./alerts.ts";
import { jobTool } from "./jobs.ts";
import { narrow, SCOPES, type Grant } from "./scopes.ts";
import { calledService } from "../tools/mcp.ts";
import type { Tool, ToolContext, ToolOutput } from "../tools/registry.ts";

/**
 * Approvals (docs/DESIGN.md, "Read; propose, never act"): a background job reads but
 * never acts, so what it would do is PROPOSED instead, exactly that one tool
 * call, and done only by the person's tap (routes/proposals.ts). A job is
 * handed its write tools as held copies (held()): the same name and
 * arguments, whose run files the call here rather than making it. How risky
 * a call is, code works out from the tool and its arguments (weigh()), never
 * the model, when it is filed and again when it is approved. Approving runs
 * the stored call once, with no model, with no more than the job had, its
 * maker still may, and the approver may (runGrants()). The decided record is
 * the audit: who, when, by a tap or a standing permission, and what came of it.
 *
 * Only jobs propose: routines act as they always have, and nothing here
 * stands in front of what is asked for directly.
 */

/** Undone with another call (lock after unlock is not one: an unlocked car has been open); or not. */
export type Risk = "reversible" | "irreversible";

/** A call, as code reads it: how risky, in words for the card, and the kind of thing it is for a standing permission. */
export interface Weighed {
  risk: Risk;
  says: string;
  /** Only for a reversible call: one narrow kind ("car_command:lock"), which a standing permission names. */
  category?: string;
}

export type ProposalState = "pending" | "running" | "done" | "failed" | "declined" | "expired" | "withdrawn";

export interface Proposal {
  id: string;
  /** Who started the job, as stored (lib/context.ts), and whose proposal it is. */
  who: string;
  person: string;
  /** What proposed it. Copied, since only the newest jobs are kept. */
  from: { kind: "job"; id: string; title: string };
  /** The call in words, as code renders it, and why it is asked for, written by code too. */
  says: string;
  why: string;
  /** What the call would send, as the job wrote it, shown whole on its card: an email's words. Shown only, never run. */
  body?: string;
  action: { tool: string; args: Record<string, unknown> };
  risk: Risk;
  category?: string;
  /** What the job could reach when it proposed this: an approval never runs with more. Never sent to a screen. */
  grants: Grant[];
  createdAt: number;
  expires: number;
  state: ProposalState;
  by?: "tap" | "standing";
  decidedAt?: number;
  outcome?: { ok: boolean; text: string };
}

/** As a screen sees one: neither the grants it would run with nor whose sign-in started it. */
export type ProposalView = Omit<Proposal, "grants" | "who">;

/** Long enough to be seen the next day, not so long that it runs on a world that has moved on. */
export const DECIDE_MS = 24 * 3_600_000;
export const PER_JOB = 5;
export const PENDING_MAX = 20;
const KEEP = 100;
const KEEP_MS = 30 * 86_400_000;
/** A run that never finished (the request died): failed, never run again. */
const STUCK_MS = 5 * 60_000;
const MAX_ARGS = 4096;
/** A call is shown whole or not filed: cut short, its last words could be the ones that matter ("…unlock"). */
const MAX_SAYS = 300;
const MAX_BODY = 4000;
export const PROPOSAL_ID = /^a[0-9a-hjkmnp-tv-z]{20}$/;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const key = (person: string, id: string) => `prop:${person}:${id}`;
const prefix = (person: string) => `prop:${person}:`;
/** The kinds of reversible call a person lets their jobs make without asking ("car_command:lock"). Not under prop:, so never listed with them. */
const allowKey = (person: string) => `propallow:${person}`;
const MAX_ALLOWED = 20;

/** Arguments compared whatever order the model wrote them in. */
export const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** Pending past its time is expired; running too long, failed: read so, and saved so when next written. */
function settled(p: Proposal, now: number): Proposal {
  if (p.state === "pending" && now >= p.expires) return { ...p, state: "expired", decidedAt: p.expires };
  if (p.state === "running" && now - (p.decidedAt ?? p.createdAt) > STUCK_MS) return { ...p, state: "failed", outcome: { ok: false, text: "It did not finish: it was not run again." } };
  return p;
}

export const viewOf = ({ grants: _g, who: _w, ...v }: Proposal): ProposalView => v;

export interface ProposalInput {
  who: string;
  person: string;
  from: Proposal["from"];
  action: Proposal["action"];
  weighed: Weighed;
  grants: readonly Grant[];
  body?: string;
}

export class Proposals {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** All of one person's, newest first, as they stand now. */
  async list(person: string, now: number): Promise<Proposal[]> {
    const all = await this.storage.list<Proposal>({ prefix: prefix(person) });
    return [...all.values()].map((p) => settled(p, now)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(person: string, id: string, now: number): Promise<Proposal | null> {
    if (!PROPOSAL_ID.test(id)) return null;
    const p = await this.storage.get<Proposal>(key(person, id));
    return p ? settled(p, now) : null;
  }

  /**
   * A call filed for the person's tap; why not, in words. The same call
   * from the same job again is the one already filed, whatever became of
   * it: a step tried again never files, or runs, a second.
   */
  async add(input: ProposalInput, now: number): Promise<Proposal | string> {
    if (JSON.stringify(input.action.args).length > MAX_ARGS) return "That is too long to propose.";
    if (input.weighed.says.length > MAX_SAYS || (input.body?.length ?? 0) > MAX_BODY) return "That is too long to show the user whole, so it was not filed: say in your answer what you would do.";
    const mine = await this.list(input.person, now);
    const same = canonical(input.action.args);
    const again = mine.find((p) => p.from.id === input.from.id && p.action.tool === input.action.tool && canonical(p.action.args) === same);
    // One already done without asking is never run again: only words come back, never the record held() would run.
    if (again) return again.by === "standing" ? `Already done without asking earlier: ${again.says} (${again.state}). Do not file it again.` : again;
    if (mine.filter((p) => p.from.id === input.from.id).length >= PER_JOB) return `At most ${PER_JOB} proposals from one job: say the rest in the answer.`;
    // Allowed without asking: a reversible call of a kind the person said their jobs may make, and only that.
    const standing = input.weighed.risk === "reversible" && !!input.weighed.category && (await this.allowed(input.person)).includes(input.weighed.category);
    if (!standing && mine.filter((p) => p.state === "pending").length >= PENDING_MAX) return `${PENDING_MAX} proposals are already waiting for the user: say this one in the answer.`;
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const p: Proposal = {
      id: "a" + [...bytes].map((b) => ALPHABET[b % 32]).join(""),
      who: input.who,
      person: input.person,
      from: { kind: "job", id: input.from.id, title: input.from.title.slice(0, 120) },
      says: input.weighed.says,
      ...(input.body ? { body: input.body } : {}),
      why: `From your job “${input.from.title.slice(0, 120)}”`,
      action: input.action,
      risk: input.weighed.risk,
      ...(input.weighed.risk === "reversible" && input.weighed.category ? { category: input.weighed.category } : {}),
      grants: [...input.grants],
      createdAt: now,
      expires: now + DECIDE_MS,
      ...(standing ? { state: "running", by: "standing", decidedAt: now } : { state: "pending" }),
    };
    await this.storage.put(key(p.person, p.id), p);
    await this.prune(input.person, now);
    return p;
  }

  /** Approved by a tap: pending to running, once, before anything is done; why not, when it is not pending. */
  async claim(person: string, id: string, now: number): Promise<Proposal | string> {
    const p = await this.get(person, id, now);
    if (!p) return "No such proposal.";
    if (p.state !== "pending") {
      if (p.state === "expired") await this.storage.put(key(person, id), p);
      return p.state === "expired" ? "It has expired." : p.state === "declined" ? "It was declined." : p.state === "withdrawn" ? "Its job was cancelled." : "It was approved already.";
    }
    const running: Proposal = { ...p, state: "running", by: "tap", decidedAt: now };
    await this.storage.put(key(person, id), running);
    return running;
  }

  async decline(person: string, id: string, now: number): Promise<Proposal | string> {
    const p = await this.get(person, id, now);
    if (!p) return "No such proposal.";
    if (p.state !== "pending") return p.state === "declined" ? "It was declined already." : "It is not waiting any more.";
    const declined: Proposal = { ...p, state: "declined", by: "tap", decidedAt: now };
    await this.storage.put(key(person, id), declined);
    return declined;
  }

  /** What came of a run: the audit. */
  async finish(person: string, id: string, outcome: { ok: boolean; text: string }, now: number): Promise<Proposal | null> {
    const p = await this.storage.get<Proposal>(key(person, id));
    if (!p || p.state !== "running") return null;
    const done: Proposal = { ...p, state: outcome.ok ? "done" : "failed", outcome: { ok: outcome.ok, text: outcome.text.slice(0, MAX_SAYS) }, decidedAt: p.decidedAt ?? now };
    await this.storage.put(key(person, id), done);
    return done;
  }

  /** The kinds the person lets their jobs make without asking. */
  async allowed(person: string): Promise<string[]> {
    return (await this.storage.get<string[]>(allowKey(person))) ?? [];
  }

  /**
   * Let jobs make this kind of call without asking: only from one the
   * person approved with a tap and that ran, and only a reversible kind.
   * The kind is the record's, never one a request names.
   */
  async allow(person: string, id: string, now: number): Promise<string | null> {
    const p = await this.get(person, id, now);
    if (!p) return "No such proposal.";
    if (p.state !== "done" || p.by !== "tap" || p.risk !== "reversible" || !p.category) return "Only a reversible kind of thing, once you have approved it, can be allowed without asking.";
    const had = await this.allowed(person);
    if (!had.includes(p.category)) await this.storage.put(allowKey(person), [...had, p.category].slice(-MAX_ALLOWED));
    return null;
  }

  /** Asking again for that kind. */
  async disallow(person: string, category: string): Promise<boolean> {
    const had = await this.allowed(person);
    if (!had.includes(category)) return false;
    await this.storage.put(allowKey(person), had.filter((c) => c !== category));
    return true;
  }

  /** A job's result, with what it proposed: on the alert, for its cards, and in its words, for every channel. */
  async attach(alert: Alert, person: string, now: number): Promise<Alert> {
    if (!alert.job) return alert;
    const theirs = (await this.list(person, now)).filter((p) => p.from.id === alert.job).reverse();
    if (!theirs.length) return alert;
    const lines = theirs.map((p) =>
      p.state === "pending"
        ? `Waiting for your OK in Jarvis: ${p.says}`
        : p.by === "standing"
          ? `${p.state === "done" ? "Done without asking (you allow it)" : "Tried without asking (you allow it), and it did not work"}: ${p.says}${p.outcome?.text ? ` (${p.outcome.text})` : ""}`
          : `${p.says}: ${p.state}`,
    );
    return { ...alert, text: `${alert.text}\n\n${lines.join("\n")}`, proposals: theirs.map((p) => ({ id: p.id, risk: p.risk, says: p.says })) };
  }

  /** A job cancelled or removed: what it proposed and is still waiting is not to be done. */
  async withdrawJob(person: string, jobId: string, now: number): Promise<void> {
    for (const p of await this.list(person, now)) {
      if (p.from.id === jobId && p.state === "pending") await this.storage.put(key(person, p.id), { ...p, state: "withdrawn", decidedAt: now });
    }
  }

  /** Someone left the family: nothing of theirs waits, and nothing is kept. */
  async forget(person: string): Promise<void> {
    const all = await this.storage.list({ prefix: prefix(person) });
    for (const k of all.keys()) await this.storage.delete(k);
    await this.storage.delete(allowKey(person));
  }

  /** The decided are kept a month, the newest hundred; the pending until decided. */
  private async prune(person: string, now: number): Promise<void> {
    const decided = (await this.list(person, now)).filter((p) => p.state !== "pending" && p.state !== "running");
    for (const [i, p] of decided.entries()) {
      if (i >= KEEP || now - (p.decidedAt ?? p.createdAt) > KEEP_MS) await this.storage.delete(key(person, p.id));
    }
  }
}

/* ---------- what a job is handed ------------------------------------------- */

/**
 * A call of a Home Assistant or other MCP tool, as code reads it. Every one
 * that writes is irreversible here: Jarvis keeps no list of which of the
 * house's services can be undone, and Home Assistant decides what one does.
 * One that only reads is not proposed: a job reads already.
 */
export function classify(name: string, args: Record<string, unknown>): Weighed | null {
  const i = name.indexOf("__");
  if (i < 0 || jobTool({ name })) return null;
  const server = name.slice(0, i);
  const svc = calledService(args);
  const data = args.data && typeof args.data === "object" ? (args.data as Record<string, unknown>) : {};
  const entity = [args.entity_id, data.entity_id].flat().filter((e): e is string => typeof e === "string").join(", ");
  const says = svc
    ? `${server}: ${svc}${entity ? ` ${entity}` : ""}`
    : `${server}: ${name.slice(i + 2)} ${Object.entries(args).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")}`;
  // Whole: one too long to show is refused when filed (Proposals.add), never shown cut short.
  return { risk: "irreversible", says: says.trim() };
}

/** How risky this call of this tool is; null when it cannot be proposed at all. */
export function weigh(tool: Pick<Tool, "name" | "propose">, args: Record<string, unknown>): Weighed | null {
  if (tool.propose) return tool.propose(args);
  return classify(tool.name, args);
}

/** Whether a job may be handed this tool to propose with: Jarvis's own that say how, and an MCP tool that writes. */
export const proposable = (t: Pick<Tool, "name" | "propose">): boolean => !!t.propose || (t.name.includes("__") && !jobTool(t));

export const PROPOSE_ONLY = "PROPOSE ONLY: calling this does not do it; it asks the user, who approves with a tap. ";

/**
 * How a held tool's call is filed (routes/jobs.ts): the proposal, or why it
 * was not; and how one allowed without asking is finished once run.
 */
export type File = (action: Proposal["action"], weighed: Weighed, ctx: ToolContext, body?: string) => Promise<Proposal | string>;
export type Finish = (p: Proposal, outcome: { ok: boolean; text: string }, ctx: ToolContext) => Promise<unknown>;

/** What the job model is told of a call it proposed. */
export function filed(p: Proposal | string): string {
  if (typeof p === "string") return p;
  if (p.state === "pending") return `NOT done: filed for the user's OK as "${p.says}". It waits up to 24 hours for their tap. Do not file it again; say in your answer that it is waiting for them.`;
  return `Already filed earlier as "${p.says}" (${p.state}). Do not file it again.`;
}

/**
 * A job's tools: those that read as they are; each that writes, a copy with
 * the same name and arguments whose run files the call instead (`file`);
 * any other, left out. The real run is never among a job's tools, so no step
 * can reach it.
 */
export function held(tools: readonly Tool[], file: File, finish: Finish): Tool[] {
  return tools.flatMap((t): Tool[] => {
    if (jobTool(t)) return [t];
    if (!proposable(t)) return [];
    return [{
      name: t.name,
      description: PROPOSE_ONLY + t.description,
      parameters: t.parameters,
      ...(t.scope ? { scope: t.scope } : {}),
      ...(t.strict === false ? { strict: false } : {}),
      ...(t.propose ? { propose: t.propose } : {}),
      pace: "fast",
      async run(args, ctx): Promise<ToolOutput> {
        const w = weigh(t, args);
        if (!w) return "That cannot be proposed from a job: say in your answer what you would do.";
        const p = await file({ tool: t.name, args }, w, ctx);
        if (typeof p === "string" || p.state !== "running" || p.by !== "standing") return filed(p);
        // Allowed without asking: done now, once, and said so; done only if the tool says it was.
        try {
          let ok = false;
          const out = await t.run(args, { ...ctx, done: () => void (ok = true) });
          const text = typeof out === "string" ? out : out.text;
          await finish(p, { ok, text }, ctx);
          return ok ? `Done without asking (the user allows this kind): ${text}` : `Tried without asking, and it did not work: ${text}`;
        } catch (e) {
          const text = `That failed: ${e instanceof Error ? e.message : String(e)}`;
          await finish(p, { ok: false, text }, ctx);
          return text;
        }
      },
    }];
  });
}

/** What an approval may run with: the job's, no more than its maker may now, nor than the one approving, and never Hermes or a screen. */
const REACH: readonly Grant[] = SCOPES.filter((s) => s !== "hermes" && s !== "screen");
export function runGrants(stored: readonly Grant[], scopesNow: readonly Grant[] | null | undefined, approver: readonly Grant[]): Grant[] | null {
  if (!scopesNow) return null;
  return narrow(narrow(narrow(stored, scopesNow), approver), REACH);
}
