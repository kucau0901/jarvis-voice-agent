import type { Env } from "../types.ts";
import type { Storage } from "./state-host.ts";
import type { Alert } from "./alerts.ts";
import { jobTool } from "./jobs.ts";
import { narrow, SCOPES, type Grant } from "./scopes.ts";
import { calledService } from "../tools/mcp.ts";
import type { Tool, ToolContext, ToolOutput } from "../tools/registry.ts";
import { localeOf } from "./locale.ts";
import { WATCH_ERRORS_SLOW, WATCH_EVERY_MS, WATCH_SLOW_MS } from "./scheduler.ts";
import {
  dueAt,
  isStaged,
  LATER_PARAM,
  MAX_HOME,
  MAX_STAGED,
  parseLater,
  PRESENCE,
  presenceRead,
  presenceTemplate,
  untilOf,
  whenInline,
  type Asked,
  type Check,
  type Release,
  type Staged,
} from "./later.ts";

/**
 * Approvals (docs/DESIGN.md, "Read; propose, never act"): a background job reads but
 * never acts, so what it would do is PROPOSED instead, exactly that one tool
 * call, and done only by the person's tap (routes/proposals.ts). A job is
 * handed its write tools as held copies (held()): the same name and
 * arguments, whose run files the call here rather than making it. How risky
 * a call is, code works out from the tool and its arguments (weigh()), never
 * the model, when it is filed and again when it is approved. Approving runs
 * the stored call once, with no model, with no more than the job had, its
 * maker still may, and the approver may (runGrants()): the tap claims it, and
 * the object's alarm makes the call (tick(), lib/approval.ts), so a slow one
 * finishes whether or not the screen that approved it stays. The decided
 * record is the audit: who, when, by a tap or a standing permission, and what
 * came of it.
 *
 * Jobs propose, and so does a brief (lib/brief.ts), whose cards code
 * chooses: an invitation to answer, old promotions to archive. A brief's
 * card has a subject (`about`), and its X is remembered (propgone), so the
 * next brief does not offer it again; a job's "Not now" is not. A call may
 * also be staged for later (lib/later.ts): kept apart (propstage:) until
 * its time, then put to them as a card like any other. Routines otherwise
 * act as they always have, and nothing here stands in front of what is
 * asked for directly.
 */

/** Undone with another call (lock after unlock is not one: an unlocked car has been open); or not. */
export type Risk = "reversible" | "irreversible";

/** A call, as code reads it: how risky, in words for the card, and the kind of thing it is for a standing permission. */
export interface Weighed {
  risk: Risk;
  says: string;
  /** Only for a reversible call: one narrow kind ("car_command:lock"), which a standing permission names. */
  category?: string;
  /** The card's button, one word or two ("Lock", "Send"); absent, "Approve". */
  verb?: string;
  /** What a brief's card is about ("rsvp:<event>", "inbox:promotions"): offered once, and not again once dismissed. */
  about?: string;
  /** When it stops making sense, if before a day is out (an invitation, at its start): it waits no longer. */
  until?: number;
}

export type ProposalState = "pending" | "running" | "done" | "failed" | "declined" | "expired" | "withdrawn";

export interface Proposal {
  id: string;
  /** Who started the job, as stored (lib/context.ts), and whose proposal it is. */
  who: string;
  person: string;
  /** What proposed it: a job, or one run of a brief (its routine's name). Copied, since only the newest jobs are kept. */
  from: { kind: "job"; id: string; title: string } | { kind: "brief"; id: string; title: string; routine: string };
  /** The call in words, as code renders it, and why it is asked for, written by code too. */
  says: string;
  why: string;
  /** What the call would send, as the job wrote it, shown whole on its card: an email's words. Shown only, never run. */
  body?: string;
  action: { tool: string; args: Record<string, unknown> };
  risk: Risk;
  category?: string;
  verb?: string;
  about?: string;
  /** Put back (undo): the record this one undoes, and on that one, this one's id. */
  undoes?: string;
  undone?: string;
  /** Staged for later (lib/later.ts): when it was to be put to them, kept once it is. */
  release?: Release;
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
/** How long an approved call may take: as long as waking the car may (tools/tessie.ts), and then some. */
export const RUN_MS = 120_000;
/**
 * An approved call the alarm has not started this long after the tap is not
 * made: the world it was approved for has moved on. A tap made while the
 * alarm is busy (a job's step, a Hermes question) waits for it to finish;
 * an alarm is stopped after fifteen minutes, and tried again a few seconds
 * later, so only an alarm that keeps failing comes to this.
 */
export const START_MS = 20 * 60_000;
/**
 * A run that never finished (cut short by a deploy): failed, never run again.
 * Started within START_MS of the tap and stopped after RUN_MS, a run still
 * going never reads so.
 */
export const STUCK_MS = START_MS + RUN_MS + 3 * 60_000;
const MAX_ARGS = 4096;
/** A call is shown whole or not filed: cut short, its last words could be the ones that matter ("…unlock"). */
const MAX_SAYS = 300;
/**
 * What a job's email can be, so one already drafted is never refused here:
 * mail_send's longest (4,000) with the household's footer (200), and its
 * subject above it, which a reply takes from the mail it answers.
 */
const MAX_BODY = 8_000;
export const PROPOSAL_ID = /^a[0-9a-hjkmnp-tv-z]{20}$/;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const key = (person: string, id: string) => `prop:${person}:${id}`;
const prefix = (person: string) => `prop:${person}:`;
/** The kinds of reversible call a person lets their jobs make without asking ("car_command:lock"). Not under prop:, so never listed with them. */
const allowKey = (person: string) => `propallow:${person}`;
/** What a brief is not to offer again: subject to when that lapses. Not under prop: either. */
const goneKey = (person: string) => `propgone:${person}`;
/** How long an X on a brief's card is remembered; the most remembered, the soonest to lapse going first. */
export const GONE_MS = 30 * 86_400_000;
const MAX_GONE = 200;
/** A subject a brief tried lately (approved, whatever came of it) is not offered again for a week. */
export const TRIED_MS = 7 * 86_400_000;
/** How long Put back is offered once something is done. */
export const UNDO_MS = 7 * 86_400_000;
/**
 * A brief's card this near its end is let go for a fresh one on the same
 * subject, when the fresh one would outlast it: yesterday's, from a daily
 * brief, has moments left. One with more, from a brief earlier the same day,
 * is that card again; so is one a fresh one would not outlast, as an
 * invitation's filed within a day of its start, whose card then ends at that
 * start whichever card it is.
 */
export const LAPSING_MS = 2 * 3_600_000;
/** Errands for later (lib/later.ts), until they are put to their person. Not under prop: either, so nothing lists or approves them. */
const STAGE = "propstage:";
const stageKey = (person: string, id: string) => `${STAGE}${person}:${id}`;
/** A staged record as the card it becomes: when it was for kept, the rest of its staging not. */
const putAway = ({ stagedAt: _s, until: _u, check: _c, ...p }: Staged): Proposal => p;
/** Approved by a tap and not yet run by the alarm (tick), with what the run may use. Not under prop: either. */
const RUN = "proprun:";
const runKey = (person: string, id: string) => `${RUN}${person}:${id}`;
interface Queued {
  person: string;
  id: string;
  grants: Grant[];
  /** When it was tapped. */
  at: number;
}
/** What making approved calls needs (state.ts): the call made as its person (lib/approval.ts carryOut), and what came of it. */
export interface ProposalDeps {
  carryOut(p: Proposal, grants: readonly Grant[]): Promise<{ ok: boolean; text: string }>;
  /** Putting staged errands to their person when their time comes (lib/later.ts); without it they wait. */
  later?: LaterDeps;
}

/** What putting an errand to its person needs (state.ts), each as that person. */
export interface LaterDeps {
  timeZone: string;
  /** Its event as their calendar has it now: its start, "gone" (cancelled, declined, deleted), or null when it could not be read. */
  eventOf(person: string, id: string): Promise<{ start: number } | "gone" | null>;
  /** Their Home Assistant person (Family), and the house's templates; null without them. */
  presenceOf(person: string): Promise<string | null>;
  renderTemplate: ((template: string) => Promise<string>) | null;
  /** What it may reach now (reachNow): null once its person has left. */
  reach(p: Proposal): Promise<readonly Grant[] | null>;
  /** Why it would no longer run as its card says (lib/approval.ts notAsShown); null when it would. */
  check(p: Proposal): Promise<string | null>;
  /** "Ready now": the card, to its person (state.ts makes the alert). */
  announce(p: Proposal): Promise<unknown>;
}
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

/** As if never put back: its Put back did not work. */
const notUndone = ({ undone: _u, ...p }: Proposal): Proposal => p;

/** A new record's call and where it came from, as a filing gives them: its state and times are the caller's. */
function recordOf(input: ProposalInput, body: string | undefined): Omit<Proposal, "createdAt" | "expires" | "state"> {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const title = input.from.title.slice(0, 120);
  return {
    id: "a" + [...bytes].map((b) => ALPHABET[b % 32]).join(""),
    who: input.who,
    person: input.person,
    from: { ...input.from, title },
    says: input.weighed.says,
    ...(body ? { body } : {}),
    why: `From your ${input.from.kind} “${title}”`,
    action: input.action,
    risk: input.weighed.risk,
    ...(input.weighed.risk === "reversible" && input.weighed.category ? { category: input.weighed.category } : {}),
    ...(input.weighed.verb ? { verb: input.weighed.verb } : {}),
    ...(input.weighed.about ? { about: input.weighed.about } : {}),
    grants: [...input.grants],
  };
}

/** Why an errand for later was not needed after all. */
function lapsedSaid(r: Release): string {
  if ("home" in r) return `Not needed: you did not ${r.home === "arrive" ? "get home" : "leave home"} within three days.`;
  if ("event" in r) return `Not put to you: “${r.event.title}” had begun.`;
  return "Not put to you: its time had passed.";
}

/** A proposal as an alert carries it, for its card (lib/alerts.ts). */
export const cardOf = (p: Proposal): NonNullable<Alert["proposals"]>[number] => ({ id: p.id, risk: p.risk, says: p.says, ...(p.verb ? { verb: p.verb } : {}) });

export interface ProposalInput {
  who: string;
  person: string;
  from: Proposal["from"];
  action: Proposal["action"];
  weighed: Weighed;
  grants: readonly Grant[];
  body?: string;
  /** What the card shows, fetched only when it is filed anew (a brief's sample of the mail it would archive). */
  detail?: () => Promise<string | null>;
  /** Not now: put to them later, at this (lib/later.ts). */
  release?: Release;
}

export class Proposals {
  private storage: Storage;
  /** Filings one at a time: two identical calls in one step must see each other (add). */
  private filing: Promise<unknown> = Promise.resolve();
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** All of one person's, newest first, as they stand now: one whose Put back did not work can be put back again. */
  async list(person: string, now: number): Promise<Proposal[]> {
    const all = [...(await this.storage.list<Proposal>({ prefix: prefix(person) })).values()].map((p) => settled(p, now));
    const failed = new Set(all.filter((p) => p.state === "failed").map((p) => p.id));
    return all.map((p) => (p.undone && failed.has(p.undone) ? notUndone(p) : p)).sort((a, b) => b.createdAt - a.createdAt);
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
  add(input: ProposalInput, now: number): Promise<Proposal | string> {
    const run = this.filing.then(() => this.addNow(input, now));
    this.filing = run.catch(() => {});
    return run;
  }

  private async addNow(input: ProposalInput, now: number): Promise<Proposal | string> {
    if (JSON.stringify(input.action.args).length > MAX_ARGS) return "That is too long to propose.";
    const tooLong = "That is too long to show the user whole, so it was not filed: say in your answer what you would do.";
    if (input.weighed.says.length > MAX_SAYS || (input.body?.length ?? 0) > MAX_BODY) return tooLong;
    if (input.release) return this.stageNow(input, input.release, now, tooLong);
    const mine = await this.list(input.person, now);
    const same = canonical(input.action.args);
    const again = mine.find((p) => p.from.id === input.from.id && p.action.tool === input.action.tool && canonical(p.action.args) === same);
    // One already done without asking is never run again: only words come back, never the record held() would run.
    if (again) {
      if (again.by !== "standing") return again;
      if (again.state === "done") return `Already done without asking earlier: ${again.says}. Do not file it again.`;
      if (again.state === "running") return `The same call is already being made without asking: ${again.says}. Do not file it again, and do not say it was done unless that call's result says so.`;
      return `Tried without asking earlier, and it did not work: ${again.says}${again.outcome?.text ? ` (${again.outcome.text})` : ""}. It is not tried again from this job: do not file it again, and say in your answer that it was not done.`;
    }
    if (mine.filter((p) => p.from.id === input.from.id).length >= PER_JOB) return `At most ${PER_JOB} proposals from one job: say the rest in the answer.`;
    // A brief's subject: dismissed, not offered again for a while; waiting already, that card again; tried lately, not again yet.
    const about = input.weighed.about;
    const expires = Math.min(now + DECIDE_MS, input.weighed.until ?? Infinity);
    let lapsing: Proposal | undefined;
    if (about) {
      if (((await this.gone(input.person))[about] ?? 0) > now) return "Dismissed: not offered again for now.";
      // Waiting: that card again, unless it is all but out of time (LAPSING_MS) and a fresh one would outlast it
      // (an invitation's card filed within a day of its start ends at that start, whichever card it is).
      const waiting = mine.find((p) => p.about === about && p.state === "pending");
      if (waiting && (waiting.expires - now > LAPSING_MS || waiting.expires >= expires)) return waiting;
      lapsing = waiting;
      if (mine.some((p) => p.about === about && (p.state === "running" || p.state === "done" || p.state === "failed") && now - (p.decidedAt ?? p.createdAt) < TRIED_MS)) return "Tried lately: not offered again yet.";
    }
    // Allowed without asking: a reversible call of a kind the person said their jobs may make, and only that.
    const standing = input.weighed.risk === "reversible" && !!input.weighed.category && (await this.allowed(input.person)).includes(input.weighed.category);
    if (!standing && mine.filter((p) => p.state === "pending" && p !== lapsing).length >= PENDING_MAX) return `${PENDING_MAX} proposals are already waiting for the user: say this one in the answer.`;
    const body = input.body ?? ((await input.detail?.().catch(() => null)) || undefined);
    if ((body?.length ?? 0) > MAX_BODY) return tooLong;
    const p: Proposal = {
      ...recordOf(input, body),
      createdAt: now,
      expires,
      ...(standing ? { state: "running", by: "standing", decidedAt: now } : { state: "pending" }),
    };
    // The one it replaces let go only now (refused above, it would still be waiting), as it is now:
    // the sample's fetch let other things in, and a tap on that card meanwhile is the person's answer.
    if (lapsing) {
      const still = await this.storage.get<Proposal>(key(input.person, lapsing.id));
      if (still?.state !== "pending") return "Answered meanwhile: not filed again.";
      await this.storage.put(key(input.person, lapsing.id), { ...still, state: "expired", decidedAt: now });
    }
    await this.storage.put(key(p.person, p.id), p);
    await this.prune(input.person, now);
    return p;
  }

  /**
   * A call to be put to them later (lib/later.ts): kept apart, never allowed
   * without asking. The same call from the same job again is the one staged.
   * A brief's (its subject set) is one for each event: dismissed, refused;
   * staged for that event already, that one; put to them for it, not again.
   */
  private async stageNow(input: ProposalInput, release: Release, now: number, tooLong: string): Promise<Proposal | string> {
    const mine = await this.later(input.person);
    const same = canonical(input.action.args);
    const again = mine.find((s) => s.from.id === input.from.id && s.action.tool === input.action.tool && canonical(s.action.args) === same);
    if (again) return again;
    const about = input.weighed.about;
    if (about) {
      if (((await this.gone(input.person))[about] ?? 0) > now) return "Dismissed: not offered again for now.";
      const event = "event" in release ? release.event.id : null;
      const forIt = (r?: Release) => !!r && "event" in r && r.event.id === event;
      const staged = mine.find((s) => s.about === about && forIt(s.release));
      if (staged) return staged;
      if ((await this.list(input.person, now)).some((p) => p.about === about && forIt(p.release))) return "Already put to them for that event.";
    }
    if (mine.length >= MAX_STAGED) return `${MAX_STAGED} errands already wait for later: say this one in the answer.`;
    if ("home" in release && [...(await this.storage.list<Staged>({ prefix: STAGE })).values()].filter((s) => "home" in s.release).length >= MAX_HOME) {
      return `${MAX_HOME} errands in the household already wait for someone to get home or leave: say this one in the answer.`;
    }
    const body = input.body ?? ((await input.detail?.().catch(() => null)) || undefined);
    if ((body?.length ?? 0) > MAX_BODY) return tooLong;
    const until = untilOf(release, now);
    const s: Staged = {
      ...recordOf(input, body),
      createdAt: now,
      expires: until,
      state: "pending",
      release,
      stagedAt: now,
      until,
      ...("home" in release ? { check: { next: now, errors: 0 } } : {}),
    };
    await this.storage.put(stageKey(s.person, s.id), s);
    return s;
  }

  /** One person's errands for later, the soonest first. */
  async later(person: string): Promise<Staged[]> {
    const all = [...(await this.storage.list<Staged>({ prefix: stageKey(person, "") })).values()];
    return all.sort((a, b) => (dueAt(a.release) ?? a.until) - (dueAt(b.release) ?? b.until));
  }

  /**
   * Approved by a tap: pending to running, once, before anything is done,
   * and queued for the alarm (tick) with what it may run with (runGrants);
   * why not, when it is not pending.
   */
  async claim(person: string, id: string, scopesNow: readonly Grant[] | null | undefined, approver: readonly Grant[], now: number): Promise<Proposal | string> {
    const p = await this.get(person, id, now);
    if (!p) return "No such proposal.";
    if (p.state !== "pending") {
      if (p.state === "expired") await this.storage.put(key(person, id), p);
      return p.state === "expired" ? "It has expired." : p.state === "declined" ? "It was declined." : p.state === "withdrawn" ? (p.outcome?.text ?? "Its job was cancelled.") : "It was approved already.";
    }
    const grants = runGrants(p.grants, scopesNow, approver);
    if (!grants) return "Whoever it was for is no longer in the family.";
    // Queued first: cut short between the two, it is still waiting, and tick lets the entry go.
    await this.storage.put(runKey(person, id), { person, id, grants, at: now } satisfies Queued);
    const running: Proposal = { ...p, state: "running", by: "tap", decidedAt: now };
    await this.storage.put(key(person, id), running);
    return running;
  }

  /** At once, while an approved call waits to be made; else the soonest an errand for later is due, looked at, or not needed. */
  async nextWake(now = Date.now()): Promise<number | null> {
    if ((await this.storage.list({ prefix: RUN })).size) return now;
    let next: number | null = null;
    for (const s of (await this.storage.list<Staged>({ prefix: STAGE })).values()) {
      for (const t of [dueAt(s.release), s.check?.next, s.until]) if (typeof t === "number" && (next === null || t < next)) next = t;
    }
    return next === null ? null : Math.max(next, now);
  }

  /** Make every approved call that waits, one at a time, in the order they were tapped: the last tap has the last word. */
  async tick(deps: ProposalDeps, now = Date.now()): Promise<void> {
    const queued = [...(await this.storage.list<Queued>({ prefix: RUN })).values()].sort((a, b) => a.at - b.at);
    const began = Date.now();
    // Each weighed against the clock as it is when its turn comes, after the calls before it.
    for (const q of queued) await this.carry(q, deps, now + Date.now() - began);
    // Then the errands for later whose time has come, through the filing chain, as a brief's filings are.
    if (deps.later) {
      const later = deps.later;
      const run = this.filing.then(() => this.releaseNow(later, now + Date.now() - began));
      this.filing = run.catch(() => {});
      await run;
    }
  }

  /**
   * Each errand for later as its time comes: past it, not needed; due (a
   * time, an event's lead, home reached or left), put to them once it still
   * stands: its event read again (moved once, it waits for the new time;
   * cancelled or moved again, withdrawn), its person still in the family, its
   * call still as its card says, and its subject not dismissed since.
   */
  private async releaseNow(deps: LaterDeps, now: number): Promise<void> {
    const all = [...(await this.storage.list<Staged>({ prefix: STAGE })).values()];
    const arrived = await this.lookHome(all.filter((s) => "home" in s.release && now < s.until && (s.check?.next ?? 0) <= now), deps, now);
    for (const s of all) {
      if (now >= s.until) {
        await this.settleStaged(s, "expired", lapsedSaid(s.release), now);
        continue;
      }
      const due = dueAt(s.release);
      if (due === null ? arrived.has(s.id) : now >= due) await this.put(s, deps, now);
    }
  }

  /** One Home Assistant look at everyone waited on: whose arrival (or leaving) it sees. */
  private async lookHome(homes: Staged[], deps: LaterDeps, now: number): Promise<Set<string>> {
    const seen = new Set<string>();
    const looked: { s: Staged; entity: string }[] = [];
    for (const s of homes) {
      const entity = deps.renderTemplate ? await deps.presenceOf(s.person).catch(() => null) : null;
      if (entity && PRESENCE.test(entity)) looked.push({ s, entity });
      else await this.settleStaged(s, "withdrawn", "Not put to you: Home Assistant cannot say where you are (your Home Assistant person, in Family).", now);
    }
    const template = presenceTemplate(looked.map(({ s, entity }) => ({ id: s.id, entity })));
    if (!template || !deps.renderTemplate) return seen;
    const read = await deps.renderTemplate(template).then(presenceRead, () => null);
    for (const { s } of looked) {
      const home = read?.get(s.id);
      const was = s.check ?? { next: now, errors: 0 };
      // A failed look waits a little longer each time, as a watch does (lib/scheduler.ts).
      const check: Check =
        home === undefined
          ? { ...was, errors: was.errors + 1, next: now + (was.errors + 1 >= WATCH_ERRORS_SLOW ? WATCH_SLOW_MS : WATCH_EVERY_MS) }
          : { next: now + WATCH_EVERY_MS, errors: 0, was: home };
      // Arriving is home now after away; leaving, away after home. The first look only learns which they are.
      const want = "home" in s.release && s.release.home === "arrive";
      if (home !== undefined && was.was === !want && home === want) seen.add(s.id);
      const still = await this.storage.get<Staged>(stageKey(s.person, s.id));
      if (still) await this.storage.put(stageKey(s.person, s.id), { ...still, check });
    }
    return seen;
  }

  /** Due: put to them as a card, if it still stands; written before it is said, so a retried alarm never says it twice. */
  private async put(s: Staged, deps: LaterDeps, now: number): Promise<void> {
    const r = s.release;
    if ("event" in r) {
      const ev = await deps.eventOf(s.person, r.event.id).catch(() => null);
      if (ev === "gone") return this.settleStaged(s, "withdrawn", `Not needed: “${r.event.title}” was cancelled, or you declined it.`, now);
      if (ev && Math.abs(ev.start - r.event.start) > 60_000) {
        if (r.event.moved) return this.settleStaged(s, "withdrawn", `Not put to you: “${r.event.title}” moved again.`, now);
        // Moved once: it waits for the new time.
        const still = await this.storage.get<Staged>(stageKey(s.person, s.id));
        if (still) await this.storage.put(stageKey(s.person, s.id), { ...still, release: { event: { ...r.event, start: ev.start, moved: true } }, until: ev.start, expires: ev.start });
        return;
      }
    }
    if (!(await deps.reach(s).catch(() => null))) return this.settleStaged(s, "withdrawn", "Not put to you: whoever it was for is no longer in the family.", now);
    const unlike = await deps.check(s).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (unlike) return this.settleStaged(s, "withdrawn", `It changed before it was needed: ${unlike}`, now);
    if (s.about && ((await this.gone(s.person))[s.about] ?? 0) > now) {
      await this.storage.delete(stageKey(s.person, s.id));
      return;
    }
    // As it is now (X'd meanwhile, it is gone); and once only: a card already filed from it (a retried alarm) is not filed or said again.
    const still = await this.storage.get<Staged>(stageKey(s.person, s.id));
    if (!still) return;
    if (await this.storage.get<Proposal>(key(s.person, s.id))) {
      await this.storage.delete(stageKey(s.person, s.id));
      return;
    }
    const card: Proposal = { ...putAway(still), state: "pending", createdAt: now, expires: Math.min(now + DECIDE_MS, still.until) };
    await this.storage.put(key(card.person, card.id), card);
    await this.storage.delete(stageKey(card.person, card.id));
    await deps.announce(card).catch((e: unknown) => console.warn("errand not announced:", e instanceof Error ? e.message : String(e)));
    await this.prune(card.person, now);
  }

  /** An errand that will not be put to them: kept as a decided card says, with why. */
  private async settleStaged(s: Staged, state: "expired" | "withdrawn", text: string, now: number): Promise<void> {
    const still = await this.storage.get<Staged>(stageKey(s.person, s.id));
    if (!still) return;
    await this.storage.put(key(s.person, s.id), { ...putAway(still), state, decidedAt: now, outcome: { ok: false, text } });
    await this.storage.delete(stageKey(s.person, s.id));
  }

  private async carry(q: Queued, deps: ProposalDeps, now: number): Promise<void> {
    // Off the queue before anything is done: a run cut short (a deploy) is never made twice, and reads as failed (settled).
    await this.storage.delete(runKey(q.person, q.id));
    const p = await this.storage.get<Proposal>(key(q.person, q.id));
    if (p?.state !== "running") return;
    const outcome =
      now - q.at > START_MS
        ? { ok: false, text: "It could not be started in time, so nothing was done." }
        : await deps.carryOut(p, q.grants).catch((e: unknown) => ({ ok: false, text: `That failed: ${e instanceof Error ? e.message : String(e)}` }));
    await this.finish(q.person, q.id, outcome, now);
  }

  /**
   * Not now; on a brief's card, not again either (its subject is remembered,
   * from the record, never the request). An errand for later declined is not
   * wanted at all: no longer waiting, kept as declined.
   */
  async decline(person: string, id: string, now: number): Promise<Proposal | string> {
    const p = await this.get(person, id, now);
    if (!p) {
      const s = PROPOSAL_ID.test(id) ? await this.storage.get<Staged>(stageKey(person, id)) : undefined;
      if (!s) return "No such proposal.";
      const declined: Proposal = { ...putAway(s), state: "declined", by: "tap", decidedAt: now };
      await this.storage.put(key(person, id), declined);
      await this.storage.delete(stageKey(person, id));
      if (s.about) await this.remember(person, s.about, now);
      return declined;
    }
    if (p.state !== "pending") return p.state === "declined" ? "It was declined already." : "It is not waiting any more.";
    const declined: Proposal = { ...p, state: "declined", by: "tap", decidedAt: now };
    await this.storage.put(key(person, id), declined);
    if (p.about) await this.remember(person, p.about, now);
    return declined;
  }

  /** A subject a brief is not to offer again for GONE_MS; the soonest to lapse going first past MAX_GONE. */
  private async remember(person: string, about: string, now: number): Promise<void> {
    const kept = Object.entries({ ...(await this.gone(person)), [about]: now + GONE_MS }).filter(([, until]) => until > now);
    await this.storage.put(goneKey(person), Object.fromEntries(kept.sort((a, b) => b[1] - a[1]).slice(0, MAX_GONE)));
  }

  /** What a brief is not to offer again, and until when. */
  private async gone(person: string): Promise<Record<string, number>> {
    return (await this.storage.get<Record<string, number>>(goneKey(person))) ?? {};
  }

  /**
   * Put back: the call that undoes one done by a tap within UNDO_MS, built
   * by code from the stored record (`inverse`: its tool's own undo, or null
   * for one there is none for), claimed as tapped and queued as an approval
   * is (claim). Once only.
   */
  async undo(
    person: string,
    id: string,
    inverse: (p: Proposal) => { action: Proposal["action"]; weighed: Weighed } | null,
    scopesNow: readonly Grant[] | null | undefined,
    approver: readonly Grant[],
    now: number,
  ): Promise<Proposal | string> {
    const p = await this.get(person, id, now);
    if (!p) return "No such proposal.";
    const back = p.state === "done" && p.by === "tap" && now - (p.decidedAt ?? p.createdAt) < UNDO_MS ? inverse(p) : null;
    // Put back already, unless that did not work (finished failed, or cut short and read as failed).
    const used = !!p.undone && (await this.get(person, p.undone, now))?.state !== "failed";
    if (!back || used) return used ? "It was put back already." : "That cannot be put back.";
    const grants = runGrants(p.grants, scopesNow, approver);
    if (!grants) return "Whoever it was for is no longer in the family.";
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const u: Proposal = {
      ...p,
      id: "a" + [...bytes].map((b) => ALPHABET[b % 32]).join(""),
      says: back.weighed.says,
      action: back.action,
      risk: back.weighed.risk,
      ...(back.weighed.verb ? { verb: back.weighed.verb } : {}),
      undoes: p.id,
      createdAt: now,
      expires: now + DECIDE_MS,
      state: "running",
      by: "tap",
      decidedAt: now,
    };
    delete u.body;
    delete u.category;
    delete u.about;
    delete u.outcome;
    delete u.undone;
    // Queued, then marked: cut short between, a second tap queues it again, which puts back what is back already.
    await this.storage.put(key(person, u.id), u);
    await this.storage.put(runKey(person, u.id), { person, id: u.id, grants, at: now } satisfies Queued);
    await this.storage.put(key(person, id), { ...p, undone: u.id });
    return u;
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
  /** `timeZone`: for saying when its errands for later are put to them. */
  async attach(alert: Alert, person: string, now: number, timeZone: string): Promise<Alert> {
    if (!alert.job) return alert;
    const theirs = (await this.list(person, now)).filter((p) => p.from.id === alert.job).reverse();
    const later = (await this.later(person)).filter((s) => s.from.id === alert.job);
    if (!theirs.length && !later.length) return alert;
    const lines = theirs.map((p) =>
      p.state === "pending"
        ? `Waiting for your OK in Jarvis: ${p.says}`
        : p.by === "standing"
          ? `${p.state === "done" ? "Done without asking (you allow it)" : "Tried without asking (you allow it), and it did not work"}: ${p.says}${p.outcome?.text ? ` (${p.outcome.text})` : ""}`
          : `${p.says}: ${p.state}`,
    );
    // An errand for later has no card yet: it is said, and its card comes when it is put to them.
    for (const s of later) lines.push(`Later (${whenInline(s.release, timeZone)}), Jarvis will ask: ${s.says}`);
    return { ...alert, text: `${alert.text}\n\n${lines.join("\n")}`, ...(theirs.length ? { proposals: theirs.map(cardOf) } : {}) };
  }

  /** A job cancelled or removed: what it proposed and is still waiting, or waits for later, is not to be done. */
  async withdrawJob(person: string, jobId: string, now: number): Promise<void> {
    for (const p of await this.list(person, now)) {
      if (p.from.id === jobId && p.state === "pending") await this.storage.put(key(person, p.id), { ...p, state: "withdrawn", decidedAt: now });
    }
    for (const s of await this.later(person)) if (s.from.id === jobId) await this.settleStaged(s, "withdrawn", "Its job was cancelled.", now);
  }

  /**
   * What one run (of a brief) filed and still waits, gone: its maker could no
   * longer reach anything by the time it was done. One tapped meanwhile stays,
   * the audit of that tap (an approval then fails, as its maker cannot reach it).
   */
  async forgetRun(person: string, from: string, now: number): Promise<void> {
    for (const p of await this.list(person, now)) if (p.from.id === from && p.state === "pending") await this.storage.delete(key(person, p.id));
    for (const s of await this.later(person)) if (s.from.id === from) await this.storage.delete(stageKey(person, s.id));
  }

  /** Someone left the family: nothing of theirs waits, and nothing is kept. */
  async forget(person: string): Promise<void> {
    for (const pre of [prefix(person), runKey(person, ""), stageKey(person, "")]) {
      for (const k of (await this.storage.list({ prefix: pre })).keys()) await this.storage.delete(k);
    }
    await this.storage.delete(allowKey(person));
    await this.storage.delete(goneKey(person));
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
  const shown = (k: string, v: unknown) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`;
  // Everything it would send is on the card: the service and its entities first, then every other argument.
  const obj = args.data && typeof args.data === "object" && !Array.isArray(args.data) ? (args.data as Record<string, unknown>) : null;
  // Entity ids shown as names only when they are plain names; anything else stays where it was, shown as it is.
  const names = (v: unknown): string[] | null => (v == null ? [] : typeof v === "string" ? [v] : Array.isArray(v) && v.every((e) => typeof e === "string") ? v : null);
  const top = names(args.entity_id);
  const { entity_id: inData, ...data } = obj ?? {};
  const low = names(inData);
  if (obj && low === null) data.entity_id = inData;
  const entity = [...(top ?? []), ...(low ?? [])].join(", ");
  // Left out of the rest only what the service and its entities already say: a domain the service does not take
  // (a dotted service) and data written as text (which a server may read) are shown as they are.
  const usesDomain = typeof args.domain === "string" && typeof args.service === "string" && !args.service.includes(".");
  const said = new Set(svc ? ["service", ...(usesDomain ? ["domain"] : []), ...(top !== null ? ["entity_id"] : []), ...(obj ? ["data"] : [])] : []);
  const rest = Object.entries(args).filter(([k]) => !said.has(k)).map(([k, v]) => shown(k, v));
  if (svc && obj && Object.keys(data).length) rest.push(shown("data", data));
  const says = svc
    ? `${server} (${name.slice(i + 2)}): ${svc}${entity ? ` ${entity}` : ""}${rest.length ? `, ${rest.join(", ")}` : ""}`
    : `${server} (${name.slice(i + 2)}): ${rest.join(", ")}`;
  // Whole: one too long to show is refused when filed (Proposals.add), never shown cut short.
  return { risk: "irreversible", says: says.trim() };
}

/** How risky this call of this tool is; null when it cannot be proposed at all. */
export function weigh(tool: Pick<Tool, "name" | "propose">, args: Record<string, unknown>, env: Env): Weighed | null {
  if (tool.propose) return tool.propose(args, env);
  return classify(tool.name, args);
}

/** Whether a job may be handed this tool to propose with: Jarvis's own that say how, and an MCP tool that writes. */
export const proposable = (t: Pick<Tool, "name" | "propose">): boolean => !!t.propose || (t.name.includes("__") && !jobTool(t));

export const PROPOSE_ONLY = "PROPOSE ONLY: calling this does not do it; it asks the user, who approves with a tap. ";

/**
 * How a held tool's call is filed (routes/jobs.ts): the proposal, or why it
 * was not; and how one allowed without asking is finished once run.
 */
export type File = (action: Proposal["action"], weighed: Weighed, ctx: ToolContext, body?: string, later?: Asked) => Promise<Proposal | string>;
export type Finish = (p: Proposal, outcome: { ok: boolean; text: string }, ctx: ToolContext) => Promise<unknown>;

/** What the job model is told of a call it proposed. */
export function filed(p: Proposal | string, timeZone = "UTC"): string {
  if (typeof p === "string") return p;
  if (isStaged(p)) {
    return `NOT done: it waits for later (${whenInline(p.release, timeZone)}), when Jarvis asks the user for their OK as "${p.says}". Do not file it again; say in your answer that it will be put to them then.`;
  }
  if (p.state === "pending") return `NOT done: filed for the user's OK as "${p.says}". It waits up to 24 hours for their tap. Do not file it again; say in your answer that it is waiting for them.`;
  return `Already filed earlier as "${p.says}" (${p.state}). Do not file it again.`;
}

/** A held tool's arguments with `later` added (lib/later.ts), unless it has one of its own; null when it cannot take it. */
function withLater(parameters: Tool["parameters"]): Tool["parameters"] | null {
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object" || "later" in props) return null;
  const required = (parameters as { required?: unknown }).required;
  return { ...parameters, properties: { ...props, later: LATER_PARAM }, required: [...(Array.isArray(required) ? required : []), "later"] };
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
    // With `later`, it can be put to them at a time, before an event, or when they get home or leave (lib/later.ts).
    const later = withLater(t.parameters);
    return [{
      name: t.name,
      description: PROPOSE_ONLY + (later ? "Give later to have it put to them then instead of now. " : "") + t.description,
      parameters: later ?? t.parameters,
      ...(t.scope ? { scope: t.scope } : {}),
      ...(t.strict === false ? { strict: false } : {}),
      ...(t.propose ? { propose: t.propose } : {}),
      pace: "fast",
      async run(given, ctx): Promise<ToolOutput> {
        // `later` is when, never part of the call: not weighed, not stored, not run.
        const { later: asked, ...rest } = given;
        const args = later ? rest : given;
        const tz = localeOf(ctx.env).timeZone;
        const when = later ? parseLater(asked, tz, Date.now()) : null;
        if (typeof when === "string") return `Not filed: ${when}.`;
        const w = weigh(t, args, ctx.env);
        if (!w) return "That cannot be proposed from a job: say in your answer what you would do.";
        const shown = t.detail ? await t.detail(args, ctx).catch(() => null) : null;
        const p = await file({ tool: t.name, args }, w, ctx, shown ?? undefined, when ?? undefined);
        if (typeof p === "string" || p.state !== "running" || p.by !== "standing") return filed(p, tz);
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
