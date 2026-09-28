import type { Storage } from "./state-host.ts";
import { makeAlert, type Alert, type Delivery } from "./alerts.ts";
import { whenSaid } from "./routines.ts";

/**
 * Jarvis as go-between: "remind Aisyah to buy ice cream when she gets home,
 * about five", "ask Mum if she wants anything from the shop", "tell everyone
 * dinner is at eight".
 *
 * A relay is one such message, from one person to another. It waits until it
 * is due — a time, and if asked, until they are home (their Home Assistant
 * person), and never in their quiet time — then reaches them on their own screens, phones and Telegram, and
 * appears in the two people's conversation (lib/chat.ts). A reminder waits for
 * Done (or Can't); a question for an answer; either comes back to whoever
 * asked. Unanswered, it nudges once after half an hour, and after an hour
 * tells the sender it has not been answered. A day after it was due, it is let
 * go.
 *
 * "everyone" makes one relay per person, sharing a group; when all have
 * answered, the sender hears the answers together.
 *
 * Run from the Durable Object's alarm, like routines and jobs. Pure but for
 * its deps, so Node tests it.
 */

export type RelayKind = "tell" | "remind" | "ask";
type RelayStatus = "waiting" | "sent" | "done" | "declined" | "answered" | "expired" | "cancelled";

export interface Relay {
  id: string;
  /** For "everyone": the relays asked together. */
  group?: string;
  kind: RelayKind;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  /** What to tell them, written for them. */
  text: string;
  /** Not before this moment. */
  after?: number;
  /** Not until they are home: their Home Assistant person entity. */
  home?: string;
  status: RelayStatus;
  createdAt: number;
  sentAt?: number;
  answeredAt?: number;
  answer?: string;
  nudged?: boolean;
  toldSender?: boolean;
  /** A chore's points, earned on Done (lib/routines.ts). */
  points?: number;
  /** Unanswered, the whole family is told, not only the sender: a check-in, medicine. */
  escalate?: boolean;
  /** The routine that made it. */
  routine?: string;
  /** How long they have to answer (minutes): nudged halfway, then the sender (or family) is told. */
  answerMin?: number;
  /** When the alarm next looks at it; none once there is nothing more to do. */
  nextCheck?: number;
}

export interface RelayDeps {
  deliver(alert: Alert): Promise<Delivery>;
  /** Whether a Home Assistant person is home now; null if it cannot be told. */
  isHome(entity: string): Promise<boolean | null>;
  /** Add a line to the two people's conversation (lib/chat.ts). */
  post(between: [string, string], msg: { from: string; name: string; text: string; relay?: { id: string; kind: RelayKind; to: string } }): Promise<void>;
  /** A passed-on message has its answer: say so where it was posted. */
  markPosted(between: [string, string], relayId: string, note: string): Promise<void>;
  /** For saying when something later will go. */
  timeZone?: string;
  /** The family's time to answer, in minutes (Settings: RELAY_ANSWER_MIN). */
  answerMin?: number;
  /** A chore done: its points to them. */
  award?(person: string, points: number): Promise<void>;
  /** Everyone in the family, for a check-in nobody answered. */
  family?(): Promise<string[]>;
  /**
   * When someone's quiet time ends, if they are in it now (a child at night,
   * a helper off duty): nothing reaches them before it, so it waits too.
   */
  quietUntil?(person: string): Promise<number | null>;
}

/** How long someone has to answer, unless said otherwise: nudged halfway, the sender told at the end. */
const ANSWER_MIN = 60;
export const FOLLOW_MS = (ANSWER_MIN / 2) * 60_000;
/** Half the time to answer, for a relay: when the nudge goes. */
const halfOf = (r: Relay) => ((r.answerMin ?? ANSWER_MIN) / 2) * 60_000;
export const GIVE_UP_MS = 24 * 3600_000;
const HOME_CHECK_MS = 60_000;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_OPEN_EACH = 50;
const MAX_TEXT = 500;

const R = "relay:";
const newId = () => `r_${Math.random().toString(36).slice(2, 10)}`;

const isOpen = (r: Relay) => r.status === "waiting" || (r.status === "sent" && r.kind !== "tell");

/** What the sender is told when an answer comes, under the answerer's name. */
function answerLine(r: Relay): string {
  if (r.status === "done") return `Done: ${r.text}`;
  if (r.status === "declined") return `Can't: ${r.text}${r.answer ? `\n“${r.answer}”` : ""}`;
  return `${r.answer ?? ""}\n(You asked: ${r.text})`;
}

export class Relays {
  private storage: Storage;
  private deps: () => Promise<RelayDeps>;

  constructor(storage: Storage, deps: () => Promise<RelayDeps>) {
    this.storage = storage;
    this.deps = deps;
  }

  async list(): Promise<Relay[]> {
    return [...(await this.storage.list<Relay>({ prefix: R })).values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<Relay | null> {
    return (await this.storage.get<Relay>(R + id)) ?? null;
  }

  private save(r: Relay): Promise<void> {
    return this.storage.put(R + r.id, r);
  }

  /** One relay to each of `to`, due now or later; sent at once if due. */
  async create(
    input: {
      kind: RelayKind;
      from: string;
      fromName: string;
      to: { person: string; name: string; home?: string }[];
      text: string;
      after?: number;
      whenHome?: boolean;
      points?: number;
      escalate?: boolean;
      routine?: string;
      answerMin?: number;
    },
    now = Date.now(),
  ): Promise<Relay[] | string> {
    const deps0 = await this.deps();
    const answerMin = Math.round(input.answerMin ?? deps0.answerMin ?? ANSWER_MIN);
    if (!Number.isFinite(answerMin) || answerMin < 2 || answerMin > 1440) return "the time to answer is 2 minutes to a day";
    const text = input.text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
    if (!text) return "there is nothing to pass on";
    if (!input.to.length) return "nobody to pass it on to";
    if (input.after !== undefined && (!Number.isFinite(input.after) || input.after > now + 30 * 24 * 3600_000)) return "that time is too far off";
    const open = (await this.list()).filter((r) => r.from === input.from && isOpen(r)).length;
    if (open + input.to.length > MAX_OPEN_EACH) return `there are already ${open} messages waiting to be answered; let some be answered first`;
    const group = input.to.length > 1 ? newId() : undefined;
    const made: Relay[] = [];
    for (const t of input.to) {
      // In their quiet time, it is due when that ends: said so now, and not waited on before.
      const quiet = (await deps0.quietUntil?.(t.person).catch(() => null)) ?? null;
      const after = Math.max(input.after ?? 0, quiet ?? 0);
      const r: Relay = {
        id: newId(),
        ...(group ? { group } : {}),
        kind: input.kind,
        from: input.from,
        fromName: input.fromName,
        to: t.person,
        toName: t.name,
        text,
        ...(after > now ? { after } : {}),
        ...(input.whenHome && t.home ? { home: t.home } : {}),
        ...(input.points ? { points: input.points } : {}),
        ...(input.escalate ? { escalate: true } : {}),
        ...(input.routine ? { routine: input.routine } : {}),
        ...(answerMin !== ANSWER_MIN ? { answerMin } : {}),
        status: "waiting",
        createdAt: now,
        nextCheck: after > now ? after : now,
      };
      await this.save(r);
      made.push(r);
    }
    // Due now and not waiting for anyone to get home: send straight away.
    await this.tick(now, made.map((r) => r.id));
    const out = await Promise.all(made.map(async (r) => (await this.get(r.id)) ?? r));
    // Later: in their conversation at once, so both can see it is coming, and a reminder tells them quietly.
    const deps = await this.deps();
    for (const r of out.filter((x) => x.status === "waiting")) await this.announce(r, deps, now);
    return out;
  }

  /** Something passed on for later: said now, in their conversation, and for a reminder, to them. */
  private async announce(r: Relay, deps: RelayDeps, now: number): Promise<void> {
    const at = r.after ? whenSaid(r.after, deps.timeZone ?? "UTC") : "";
    const when = [at, r.home ? (at ? "or once you are home, whichever is later" : "once you are home") : ""].filter(Boolean).join(", ");
    const what = r.kind === "ask" ? "A question" : r.kind === "remind" ? "A reminder" : "A message";
    await deps
      .post([r.from, r.to], { from: r.from, name: r.fromName, text: `${what} for ${when || "later"}: ${r.text}` })
      .catch(() => {});
    if (r.kind !== "remind") return;
    const a = makeAlert({ title: `${r.fromName} will remind you`, text: `${when || "Later"}: ${r.text}`, speak: false }, "relay", now, r.to);
    if (a) await deps.deliver(a).catch(() => null);
  }

  /** The recipient answers: done, can't, or words. The sender hears it. */
  async answer(id: string, by: string, a: { status: "done" | "declined" | "answered"; answer?: string }, now = Date.now()): Promise<Relay | string> {
    const r = await this.get(id);
    if (!r || r.to !== by) return "no such message for this person";
    if (!isOpen(r) && r.status !== "sent") return `that was already ${r.status}`;
    if (r.status === "sent" && r.kind === "tell") return "that needed no answer";
    const answer = a.answer?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT) || undefined;
    if (a.status === "answered" && !answer) return "an answer needs some words";
    const done: Relay = { ...r, status: a.status, answeredAt: now, ...(answer ? { answer } : {}) };
    delete done.nextCheck;
    await this.save(done);
    const deps = await this.deps();
    const line = answerLine(done);
    const note = a.status === "done" ? "✓ done" : a.status === "declined" ? "✗ can't" : "↩ answered";
    await deps.markPosted([r.from, r.to], r.id, note).catch(() => {});
    await deps.post([r.from, r.to], { from: r.to, name: r.toName, text: answer ?? (a.status === "done" ? "Done." : "I can't."), relay: undefined }).catch(() => {});
    const alert = makeAlert({ title: r.toName, text: line, speak: true }, "relay", now, r.from);
    if (alert) await deps.deliver(alert).catch(() => null);
    // A chore done earns its points.
    if (done.status === "done" && r.points) await deps.award?.(r.to, r.points).catch(() => {});
    await this.closeGroup(done, deps, now);
    return done;
  }

  /** Everyone asked together has answered: the sender hears them all at once. */
  private async closeGroup(r: Relay, deps: RelayDeps, now: number): Promise<void> {
    if (!r.group) return;
    const all = (await this.list()).filter((x) => x.group === r.group);
    if (all.some(isOpen)) return;
    const lines = all.map((x) => (x.status === "answered" ? `${x.toName}: ${x.answer}` : `${x.toName}: ${x.status === "done" ? "done" : x.status === "declined" ? "can't" : "no answer"}`));
    const alert = makeAlert({ title: "Everyone has answered", text: `${r.text}\n\n${lines.join("\n")}`, speak: true }, "relay", now, r.from);
    if (alert) await deps.deliver(alert).catch(() => null);
  }

  /** The sender takes it back, before it is answered. */
  async cancel(id: string, by: string): Promise<Relay | string> {
    const r = await this.get(id);
    if (!r || r.from !== by) return "no such message from this person";
    if (!isOpen(r)) return `that was already ${r.status}`;
    const c: Relay = { ...r, status: "cancelled" };
    delete c.nextCheck;
    await this.save(c);
    return c;
  }

  /** Someone left the family: nothing more is passed on to them, or waited on from them. */
  async forget(person: string): Promise<void> {
    for (const r of await this.list()) {
      if (!isOpen(r) || (r.to !== person && r.from !== person)) continue;
      const c: Relay = { ...r, status: "cancelled" };
      delete c.nextCheck;
      await this.save(c);
    }
  }

  /** What a person sent and was sent lately, newest first: for "did she get my message?" and their day. */
  async forPerson(person: string, now = Date.now()): Promise<{ sent: Relay[]; received: Relay[] }> {
    const recent = (await this.list()).filter((r) => now - r.createdAt < KEEP_MS);
    return { sent: recent.filter((r) => r.from === person), received: recent.filter((r) => r.to === person) };
  }

  /** What is waiting for this person to answer, sent to them already. */
  async awaiting(person: string): Promise<Relay[]> {
    return (await this.list()).filter((r) => r.to === person && r.status === "sent" && r.kind !== "tell");
  }

  async nextWake(now = Date.now()): Promise<number | null> {
    let next: number | null = null;
    for (const r of await this.list()) {
      if (r.nextCheck === undefined) continue;
      if (next === null || r.nextCheck < next) next = r.nextCheck;
    }
    return next === null ? null : Math.max(next, now);
  }

  /** Everything due: send what is due, nudge the unanswered, let go of the old. `only` limits it to some. */
  async tick(now = Date.now(), only?: string[]): Promise<void> {
    const deps = await this.deps();
    for (const r0 of await this.list()) {
      if (only && !only.includes(r0.id)) continue;
      if (r0.nextCheck === undefined || r0.nextCheck > now) {
        if (!only && !isOpen(r0) && now - r0.createdAt > KEEP_MS) await this.storage.delete(R + r0.id);
        continue;
      }
      try {
        await this.step(r0, deps, now);
      } catch (e) {
        console.warn("relay:", e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async step(r: Relay, deps: RelayDeps, now: number): Promise<void> {
    const due = r.after ?? r.createdAt;
    if (r.status === "waiting") {
      if (now - due > GIVE_UP_MS) {
        const gone: Relay = { ...r, status: "expired", nextCheck: undefined };
        await this.save(gone);
        const a = makeAlert({ title: "Not passed on", text: `${r.toName} was not home, so this never reached them: ${r.text}` }, "relay", now, r.from);
        if (a) await deps.deliver(a).catch(() => null);
        await this.closeGroup(gone, deps, now);
        return;
      }
      if (r.home) {
        const home = await deps.isHome(r.home).catch(() => null);
        if (home !== true) {
          await this.save({ ...r, nextCheck: now + HOME_CHECK_MS });
          return;
        }
      }
      // Not while they are in their quiet time: sent, and waited on, from when it ends.
      const quiet = (await deps.quietUntil?.(r.to).catch(() => null)) ?? null;
      if (quiet && quiet > now) {
        await this.save({ ...r, nextCheck: quiet });
        return;
      }
      await this.send(r, deps, now, false);
      return;
    }
    if (r.status !== "sent" || r.kind === "tell" || !r.sentAt) {
      await this.save({ ...r, nextCheck: undefined });
      return;
    }
    if (now - r.sentAt > GIVE_UP_MS) {
      const gone: Relay = { ...r, status: "expired", nextCheck: undefined };
      await this.save(gone);
      // Asked with everyone: the others' answers still come back, with this one as no answer.
      await this.closeGroup(gone, deps, now);
      return;
    }
    if (!r.nudged && now - r.sentAt >= halfOf(r)) {
      await this.send({ ...r, nudged: true }, deps, now, true);
      return;
    }
    if (r.nudged && !r.toldSender && now - r.sentAt >= 2 * halfOf(r)) {
      if (r.escalate) {
        // A check-in or medicine nobody answered: the whole family hears, on every channel.
        const everyone = (await deps.family?.().catch(() => null)) ?? [r.from];
        for (const who of new Set([r.from, ...everyone].filter((p) => p !== r.to))) {
          const a = makeAlert({ title: `No answer from ${r.toName}`, text: `${r.toName} hasn't answered in ${(r.answerMin ?? ANSWER_MIN) >= 120 ? `${Math.round((r.answerMin ?? ANSWER_MIN) / 60)} hours` : `${r.answerMin ?? ANSWER_MIN} minutes`}: ${r.text}`, speak: true, urgent: true }, "relay", now, who);
          if (a) await deps.deliver(a).catch(() => null);
        }
      } else {
        const a = makeAlert({ title: "No answer yet", text: `${r.toName} hasn't answered: ${r.text}`, speak: false }, "relay", now, r.from);
        if (a) await deps.deliver(a).catch(() => null);
      }
      await this.save({ ...r, toldSender: true, nextCheck: r.sentAt + GIVE_UP_MS });
    }
  }

  /** To the recipient, and into their conversation with the sender. */
  private async send(r: Relay, deps: RelayDeps, now: number, nudge: boolean): Promise<void> {
    const title =
      r.kind === "ask" ? `${r.fromName} asks` : r.kind === "remind" ? `Reminder from ${r.fromName}` : `From ${r.fromName}`;
    const text = nudge ? `Still waiting: ${r.text}` : r.text;
    const alert = makeAlert({ title, text, speak: true }, "relay", now, r.to);
    if (alert) {
      alert.relay = { id: r.id, kind: r.kind };
      await deps.deliver(alert).catch(() => null);
    }
    if (!nudge) {
      await deps
        .post([r.from, r.to], { from: r.from, name: r.fromName, text: r.kind === "ask" ? `Asks: ${r.text}` : r.kind === "remind" ? `Reminder: ${r.text}` : r.text, relay: { id: r.id, kind: r.kind, to: r.to } })
        .catch(() => {});
    }
    const sentAt = nudge ? r.sentAt! : now;
    const closed = r.kind === "tell";
    await this.save({
      ...r,
      status: "sent",
      sentAt,
      ...(closed ? { nextCheck: undefined } : { nextCheck: nudge ? sentAt + 2 * halfOf(r) : sentAt + halfOf(r) }),
    });
  }
}
