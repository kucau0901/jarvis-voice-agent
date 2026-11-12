import type { Env } from "../types.ts";
import { makeAlert, type Alert } from "./alerts.ts";
import { ALONE_PER_DAY, saysOf, TOLD_PER_DAY, type Component, type Components, type PinnedTool } from "./components.ts";
import { OWNER } from "./context.ts";
import { redact } from "./http.ts";
import { tidy, wellFormed } from "./quote.ts";

/**
 * What a component reports (docs/components.md): events posted to its own
 * address at Jarvis (routes/components.ts handleReport), taken here with no
 * model anywhere. Each event, one its approved manifest declares:
 *
 *   - starts the routines people made for it (`school:leave_filed`), handed
 *     its words in one line written here, inside quotes it cannot close;
 *   - at level notice, is told to the people who ticked "tell me", under the
 *     component's name;
 *   - may suggest up to three actions, each one of its own approved acting
 *     tools: put to one person as a card to approve, or, for a tool the
 *     owner set to run by itself, done after the reply and told.
 *
 * Who hears any of it is who it is shared with, who still holds
 * `components`, and, when the event names people (`to`), only those. What a
 * component says here is data from start to finish: it names no person but
 * by the id an admin mapped, no tool but its own, and nothing it writes is
 * read as an instruction.
 */

export const MAX_BODY = 32 * 1024;
export const MAX_EVENTS = 10;
export const MAX_TEXT = 500;
export const MAX_ACTIONS = 3;
export const MAX_ARGS = 2048;
const MAX_TO = 20;
/** Event ids remembered for the day, so one sent again is taken once. */
const MAX_SEEN = 200;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const AS = /^[A-Za-z0-9._@:-]{1,64}$/;

export type Level = "info" | "notice";

/** One event, as it was read: nothing in it is trusted further than its shape. */
interface Read {
  type: string;
  says: string;
  text: string;
  level: Level;
  to?: string[];
  id?: string;
  actions: { tool: PinnedTool; args: Record<string, unknown>; says: string }[];
}

/** A call the owner lets run by itself, to make once the component has its reply (tools/components.ts runSuggested). */
export interface Suggested {
  part: { id: string; label: string; name: string; url: string; key?: string };
  tool: PinnedTool;
  args: Record<string, unknown>;
  /** Who is told what came of it. */
  tell: string[];
}

export interface ReportReply {
  ok: true;
  name: string;
  /** Events taken, the ones sent before among them. */
  taken: number;
  refused: { index: number; error: string }[];
}

/** What taking a report needs of the object it runs in (state.ts): the hub, the scheduler, the cards and the alerts. */
export interface ReportDeps {
  /** Today, for the day's counts (lib/usage.ts dayOf). */
  day: string;
  /** Whether a person holds `components` now: without it nothing of a component reaches them. */
  holds(person: string): Promise<boolean>;
  nameOf(person: string): Promise<string>;
  /** Start the routines these people made for an event (lib/scheduler.ts fireEvent). */
  fire(event: string, line: string, only: string[]): Promise<unknown>;
  /** A card for `person` to approve (lib/proposals.ts): what an alert carries of it, or why it was not filed. */
  card(person: string, from: { id: string; title: string }, action: { tool: string; args: Record<string, unknown> }, says: string): Promise<NonNullable<Alert["proposals"]>[number] | string>;
  tell(alert: Alert): Promise<unknown>;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Someone else's words on one line, with no quote of any kind left in them. */
const unquotable = (s: string, max: number) => wellFormed(tidy(s).replace(/["“”„«»]/g, "'").slice(0, max));

/**
 * What a routine is told of the event that started it: one line, written
 * here. The scheduler puts it between """ marks as data (lib/scheduler.ts
 * execute); with no quote left in the component's words, or in its name,
 * nothing in them can close those marks or the ones here.
 */
export function eventLine(name: string, says: string, text: string): string {
  const said = unquotable(text, MAX_TEXT);
  return `${unquotable(name, 60)} reports: ${unquotable(says, 120)}.${said ? ` In its own words: “${said}”` : ""}`;
}

/** One event read against what is approved; or why it is refused. */
function read(c: Component, raw: unknown): Read | string {
  if (!plain(raw)) return "an event is an object";
  const pinned = c.pinned && c.pinned.url === c.url ? c.pinned : null;
  const declared = typeof raw.type === "string" ? pinned?.events.find((e) => e.type === raw.type) : undefined;
  if (!declared) return "not an event its approved manifest declares";
  if (raw.level !== undefined && raw.level !== "info" && raw.level !== "notice" && raw.level !== "urgent") return 'level is "info", "notice" or "urgent"';
  if (raw.text !== undefined && typeof raw.text !== "string") return "text must be text";
  const text = wellFormed((raw.text ?? "").trim().slice(0, MAX_TEXT));
  // Urgent is told as a notice: an address that leaked must not reach every channel.
  const level: Level = raw.level === "notice" || raw.level === "urgent" ? "notice" : "info";
  if (level === "notice" && !text) return "text is required to tell anyone";
  if (raw.id !== undefined && (typeof raw.id !== "string" || !ID.test(raw.id))) return "id is up to 64 letters, digits and . _ : -";
  let to: string[] | undefined;
  if (raw.to !== undefined) {
    if (!Array.isArray(raw.to) || raw.to.length > MAX_TO || !raw.to.every((t): t is string => typeof t === "string" && AS.test(t))) return `to is up to ${MAX_TO} ids, as an admin mapped them`;
    to = raw.to;
  }
  const actions: Read["actions"] = [];
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.length > MAX_ACTIONS) return `at most ${MAX_ACTIONS} actions`;
    for (const a of raw.actions) {
      const tool = plain(a) && typeof a.tool === "string" ? pinned?.tools.find((t) => t.name === a.tool && !t.off && !t.reads) : undefined;
      if (!plain(a) || !tool) return "an action names one of its own approved tools that acts";
      const args = a.args ?? {};
      if (!plain(args) || JSON.stringify(args).length > MAX_ARGS) return `an action's args are an object of at most ${MAX_ARGS / 1024} KB`;
      // A card shows the call whole, and so does what is told of one done by itself (lib/proposals.ts MAX_SAYS).
      const says = saysOf(c.label, tool.name, args);
      if (!says) return "an action too long to show whole, or of a tool named like a look-up, cannot be suggested";
      actions.push({ tool, args, says });
    }
  }
  return { type: declared.type, says: declared.says, text, level, ...(to ? { to } : {}), ...(typeof raw.id === "string" ? { id: raw.id } : {}), actions };
}

/**
 * A report taken: what to answer the component, and the calls to make by
 * itself once it has that answer. Null for a body that is not a report at
 * all (the route's 400).
 */
export async function takeReport(parts: Components, c: Component, body: Record<string, unknown>, deps: ReportDeps, now: number): Promise<{ reply: ReportReply; alone: Suggested[] } | null> {
  const events = body.events;
  if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) return null;
  const reply: ReportReply = { ok: true, name: c.name, taken: 0, refused: [] };
  const alone: Suggested[] = [];
  const part = { id: c.id, label: c.label, name: c.name, url: c.url, ...(c.key ? { key: c.key } : {}) };

  for (const [index, raw] of events.entries()) {
    const e = read(c, raw);
    const refuse = (error: string) => void reply.refused.push({ index, error });
    if (typeof e === "string") {
      refuse(e);
      continue;
    }
    // Sent before today (a retry): taken then, and nothing is done twice.
    if (e.id && (await parts.seen(c.id, deps.day, e.id))) {
      reply.taken++;
      continue;
    }
    // Who it is for: shared with, still holding the ceiling, and named by the event if it names anyone.
    const hearing: { person: string; tell: boolean; use: boolean }[] = [];
    for (const [person, share] of Object.entries(c.shares)) {
      if (e.to && !(share.as && e.to.includes(share.as))) continue;
      if (await deps.holds(person)) hearing.push({ person, tell: share.tell === true, use: share.level === "use" });
    }
    const telling = hearing.filter((h) => h.tell).map((h) => h.person);

    // Each action: by itself where the owner said so and the day's limit allows, else a question for one person.
    const allowed = e.actions.filter((a) => a.tool.alone);
    const byItself = allowed.slice(0, await parts.left(c.id, deps.day, "acted", ALONE_PER_DAY));
    const asks = e.actions.filter((a) => !byItself.includes(a));
    if (asks.length && !telling.length) {
      refuse("it suggests something to approve, and nobody is told its reports: there is nobody to ask");
      continue;
    }
    // A question is told with its event, whatever its level.
    let told = e.level === "notice" || asks.length > 0;
    if (told && telling.length && !(await parts.count(c.id, deps.day, "told", TOLD_PER_DAY))) {
      if (asks.length) {
        refuse(`its people have been told ${TOLD_PER_DAY} things today: a question cannot be put to them`);
        continue;
      }
      // Past the day's limit, routines still hear it; people are not told.
      told = false;
    }
    if (e.id) await parts.saw(c.id, deps.day, e.id, MAX_SEEN);
    for (const _ of byItself) await parts.count(c.id, deps.day, "acted", ALONE_PER_DAY);
    reply.taken++;

    if (hearing.length) await deps.fire(`${c.label}:${e.type}`, eventLine(c.name, e.says, e.text), hearing.map((h) => h.person));

    // One person is asked: the first told who may use it. The others are told the question waits for them.
    const asker = asks.length ? hearing.find((h) => h.tell && h.use)?.person : undefined;
    const cards: NonNullable<Alert["proposals"]> = [];
    const notes: string[] = [];
    for (const [i, a] of asks.entries()) {
      if (!asker) {
        notes.push(`It suggested: ${a.says}. Nobody it tells may use it, so nothing waits.`);
        continue;
      }
      const from = { id: `component:${c.id}:${e.id ?? `${now}.${index}`}:${i}`, title: `Suggested by ${c.name}: ${e.says}`.slice(0, 120) };
      const card = await deps.card(asker, from, { tool: `${c.label}__${a.tool.name}`, args: a.args }, a.says);
      if (typeof card === "string") notes.push(`It suggested: ${a.says}. ${card}`);
      else cards.push(card);
    }
    if (told) {
      const waits = cards.length && asker ? await deps.nameOf(asker) : "";
      for (const person of telling) {
        const mine = person === asker;
        const lines = [
          ...(mine ? cards.map((k) => `Waiting for your OK in Jarvis: ${k.says}`) : cards.length ? [`A question about this waits for ${waits || "someone else"}, in their Jarvis.`] : []),
          ...notes,
        ];
        const made = makeAlert({ title: c.name, text: redact([e.text || e.says, ...lines].join("\n\n")) }, "api", now, person);
        if (made) await deps.tell({ ...made, skill: { id: c.id, name: c.name }, ...(mine && cards.length ? { proposals: cards } : {}) });
      }
    }
    // Told to the same people once it is done; to the owner, who allowed it, when nobody is.
    for (const a of byItself) alone.push({ part, tool: a.tool, args: a.args, tell: telling.length ? telling : [OWNER] });
  }
  return { reply, alone };
}

/**
 * The environment a routine on a component's event runs in: who it answers,
 * and nothing else about them, and no web search. What a component reports
 * can only move that same component (state.ts schedulerDeps ask).
 */
export const sealed = (env: Env): Env => ({ ...env, DISABLE_WEB_SEARCH: "1", JARVIS_CARS: "[]", JARVIS_PERSON_BIRTHDAY: undefined, JARVIS_PERSON_NICKNAME: undefined });
