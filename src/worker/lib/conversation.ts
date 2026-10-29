import type { Storage } from "./state-host.ts";
import type { Alert } from "./alerts.ts";
import { tidy } from "./quote.ts";
import { PAGE_ID } from "./pages.ts";

/**
 * Each person's conversation with Jarvis, kept so it is still there when the
 * app opens again, as Hark's chat is: what they typed or said aloud (Live and
 * push-to-talk) and Jarvis's answers, which the app sends as each is
 * finished (src/app/conversation.ts), and what their alerts said (routines,
 * jobs, reminders, the house), put here as each is delivered (lib/alerts.ts). The last 200 of the past 30 days; Clear chat
 * empties it on every screen of theirs.
 *
 * Kept is not what the model reads: a question goes with only the last
 * twenty turns of the past three hours (src/app/history.ts), so a long chat
 * costs no more to ask in than a short one. Older parts are read back only
 * when the person refers to them, by the look_back tool
 * (tools/conversation.ts); what lasts longer than a month is memory's.
 *
 * One record per person, as the family's conversations are (lib/chat.ts).
 * A stored value may be 2 MB; MAX_CHARS keeps one well under it.
 */

export interface Said {
  /** Made by the screen that said it, so a question can point at the answer it replies to; a routine's is its alert's. */
  id: string;
  at: number;
  role: "user" | "assistant";
  text: string;
  /** What was attached to a question, by name: the files themselves are kept nowhere (src/app/attach.ts). */
  files?: string[];
  /** The answer a question replied to (src/app/reply.ts). */
  replyTo?: string;
  /** The routine that said it: its id, to open it, and its name. Only the server says this. */
  routine?: { id: string; name: string };
  /** The background job it is the result of: its id, to open it in Jobs, and its alert's title. Only the server says this. */
  job?: { id: string; name: string };
  /** Any other alert that said it (lib/alerts.ts): where it came from and its title, read as "Title: text". Only the server says this. */
  alert?: { source: Alert["source"]; title: string };
  /** An answer's cited pages, drawn as cards under it (src/app/ui/rich.ts). */
  links?: { url: string; title: string }[];
  /** A page the answer made (lib/pages.ts), drawn as a card under it (src/app/pageCard.ts). */
  page?: { id: string; title: string };
  /** What the job it is the result of proposed (lib/proposals.ts): their cards, drawn under it. Only the server says this. */
  proposals?: string[];
}

export const KEEP = 200;
export const KEEP_MS = 30 * 24 * 3_600_000;
/** As much of one message as is kept: what the router is given of one turn (lib/history.ts). */
export const MAX_TEXT = 4000;
/** All of one person's kept words: a letter may take two bytes stored. */
export const MAX_CHARS = 400_000;
/** At most this many in one request: a question and its answer, or a few rows spoken. */
export const MAX_POSTED = 10;
const MAX_FILES = 4;
const MAX_NAME = 120;
const MAX_LINKS = 6;
const MAX_URL = 500;
const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** An answer's links as a screen sent them: web pages over https only, each title tidied. */
function linksOf(raw: unknown): { url: string; title: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { url: string; title: string }[] = [];
  for (const l of raw.slice(0, MAX_LINKS)) {
    const { url, title } = (l && typeof l === "object" ? l : {}) as { url?: unknown; title?: unknown };
    if (typeof url !== "string" || url.length > MAX_URL) continue;
    try {
      if (new URL(url).protocol === "https:") out.push({ url, title: typeof title === "string" ? tidy(title).slice(0, MAX_NAME) : "" });
    } catch {
      // not an address: left out
    }
  }
  return out;
}

const key = (person: string) => `conversation:${person}`;

/** One message a screen sent, made safe to keep, at `at`; null when it is not one. */
export function asSaid(raw: unknown, at: number): Said | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id) || (r.role !== "user" && r.role !== "assistant") || typeof r.text !== "string") return null;
  const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string" && !!f.trim()).slice(0, MAX_FILES).map((f) => f.trim().slice(0, MAX_NAME)) : [];
  const text = r.text.trim().slice(0, MAX_TEXT);
  // A question may be only what was attached to it.
  if (!text && !files.length) return null;
  const links = r.role === "assistant" ? linksOf(r.links) : [];
  const p = r.page && typeof r.page === "object" ? (r.page as { id?: unknown; title?: unknown }) : null;
  const page = r.role === "assistant" && typeof p?.id === "string" && PAGE_ID.test(p.id) && typeof p.title === "string" ? { id: p.id, title: tidy(p.title).slice(0, MAX_NAME) } : null;
  return {
    id: r.id,
    at,
    role: r.role,
    text,
    ...(files.length && r.role === "user" ? { files } : {}),
    ...(typeof r.replyTo === "string" && ID.test(r.replyTo) && r.role === "user" ? { replyTo: r.replyTo } : {}),
    ...(links.length ? { links } : {}),
    ...(page ? { page } : {}),
  };
}

/**
 * A question asked on glasses through the Even app ("Hey Even",
 * routes/v1.ts) and its answer, as kept in the person's conversation: Chat
 * shows them, and what is said next on any screen of theirs follows on. Both
 * ids grow from `id`, one made for the exchange.
 */
export function exchangeSaid(id: string, asked: string, answered: string, at: number): Said[] {
  return [asSaid({ id: `${id}_q`, role: "user", text: asked }, at), asSaid({ id: `${id}_a`, role: "assistant", text: answered }, at)].filter(
    (s): s is Said => !!s,
  );
}

/** What one message takes of the person's MAX_CHARS: its words, and its links. */
const size = (s: Said) => s.text.length + (s.links ?? []).reduce((n, l) => n + l.url.length + l.title.length, 0);

/** The log as kept: the newest KEEP of the past KEEP_MS, within MAX_CHARS. */
export function trimmed(log: readonly Said[], now: number): Said[] {
  const kept = log.filter((s) => now - s.at <= KEEP_MS).slice(-KEEP);
  let chars = kept.reduce((n, s) => n + size(s), 0);
  while (chars > MAX_CHARS) chars -= size(kept.shift()!);
  return kept;
}

/**
 * What an alert said (lib/alerts.ts deliver), as kept in its person's
 * conversation: a routine's under the routine's name, a job's result under
 * its job, anything else under where it came from and its title. Its id is
 * the alert's, so one delivered again (held for quiet hours, then released)
 * is kept once. A family message (lib/chat.ts) is kept too, so it can be
 * answered by voice (tools/family.ts pass_on). Null for Settings → Test,
 * which is nobody's conversation.
 */
export function alertSaid(a: Pick<Alert, "id" | "at" | "title" | "text" | "source" | "routine" | "job" | "proposals">): Said | null {
  if (a.source === "test") return null;
  // What it proposed, by id, drawn as cards under it (lib/proposals.ts).
  const proposals = (a.proposals ?? []).map((p) => p.id);
  const from = a.routine ? { routine: { id: a.routine, name: a.title } } : a.job ? { job: { id: a.job, name: a.title } } : { alert: { source: a.source, title: a.title } };
  return { id: a.id, at: a.at, role: "assistant", text: a.text.slice(0, MAX_TEXT), ...from, ...(proposals.length ? { proposals } : {}) };
}

/** How long the same alert again is a repeat, not news: a door unlocked twice in a few minutes. */
export const REPEAT_MS = 15 * 60_000;

/** The name an alert's row is kept under, or null for a row nobody's alert said. */
const fromOf = (s: Said): string | null => s.alert?.title ?? s.routine?.name ?? s.job?.name ?? null;

/**
 * Whether an alert's row says again what one said a moment ago, with nothing
 * from the person since: the same words under the same name, within
 * REPEAT_MS. Their reply in between makes it news again.
 */
export function repeats(log: readonly Said[], s: Said): boolean {
  const from = fromOf(s);
  for (let i = log.length - 1; i >= 0; i--) {
    const o = log[i]!;
    if (o.role === "user" || s.at - o.at > REPEAT_MS) return false;
    if (from !== null && fromOf(o) === from && o.text === s.text) return true;
  }
  return false;
}

const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The words looked for: two letters at least, each once. */
export const asked = (words: string) => [...new Set(wordsOf(words).filter((w) => w.length >= 2))];

/**
 * The messages with any of `words`, those with most of them first, then the
 * newest: each with its place in the log and how many it has (look_back, and
 * Chat's search, lib/search.ts). Each message's words are read once.
 */
export function matching(log: readonly Said[], words: string): { s: Said; i: number; n: number }[] {
  const ws = asked(words);
  if (!ws.length) return [];
  return log
    .map((s, i) => {
      const said = wordsOf(s.text);
      // A word asked about is the start of one said: "insur" finds "insurance", "AC" is not in "each".
      return { s, i, n: ws.filter((w) => said.some((t) => t.startsWith(w))).length };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.i - a.i);
}

/** As much as a look back returns: enough to answer from, not the month. */
export const FOUND = 12;
const FOUND_TEXT = 600;

/**
 * What look_back finds (tools/conversation.ts): the messages with most of the
 * words asked about, or a day's latest when no words are given, each with the
 * question it answers or the answer it got. Oldest first, each shortened.
 */
export function lookBack(log: readonly Said[], words: string, day: string | null, dayOf: (at: number) => string): Said[] {
  const ws = asked(words);
  if (words.trim() && !ws.length) return [];
  const best = ws.length
    ? matching(log, words).filter(({ s }) => !day || dayOf(s.at) === day)
    : log.map((s, i) => ({ s, i })).filter(({ s }) => !day || dayOf(s.at) === day).reverse();
  const picked = new Set<number>();
  for (const { s, i } of best) {
    if (picked.size >= FOUND) break;
    picked.add(i);
    const pair = s.role === "user" ? i + 1 : i - 1;
    if (log[pair] && log[pair]!.role !== s.role) picked.add(pair);
  }
  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => log[i]!)
    .map((s) => (s.text.length > FOUND_TEXT ? { ...s, text: `${s.text.slice(0, FOUND_TEXT)}…` } : s));
}

export class Conversation {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** A person's conversation, oldest first. */
  async list(person: string, now: number): Promise<Said[]> {
    return trimmed((await this.storage.get<Said[]>(key(person))) ?? [], now);
  }

  /** Messages said, kept after the rest; one kept already (sent again) is not kept twice. */
  async add(person: string, said: Said[], now: number): Promise<void> {
    const log = (await this.storage.get<Said[]>(key(person))) ?? [];
    const have = new Set(log.map((s) => s.id));
    const fresh = said.filter((s) => !have.has(s.id) && !!have.add(s.id));
    if (fresh.length) await this.storage.put(key(person), trimmed([...log, ...fresh], now));
  }

  /** An alert's row (alertSaid), kept after the rest; false when it repeats what was just said there, and is not kept. */
  async addAlert(person: string, said: Said, now: number): Promise<boolean> {
    const log = (await this.storage.get<Said[]>(key(person))) ?? [];
    // Kept already: delivered again, after quiet hours.
    if (log.some((s) => s.id === said.id)) return true;
    const kept = trimmed(log, now);
    if (repeats(kept, said)) return false;
    await this.storage.put(key(person), trimmed([...kept, said], now));
    return true;
  }

  /** Cleared, by them (Clear chat), or as they leave the family. */
  async clear(person: string): Promise<void> {
    await this.storage.delete(key(person));
  }
}
