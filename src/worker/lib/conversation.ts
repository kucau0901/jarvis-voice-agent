import type { Storage } from "./state-host.ts";
import type { Alert } from "./alerts.ts";

/**
 * Each person's conversation with Jarvis, kept so it is still there when the
 * app opens again, as Hark's chat is: what they typed or said aloud (Live and
 * push-to-talk) and Jarvis's answers, which the app sends as each is
 * finished (src/app/conversation.ts), and what their routines said, put here
 * as it is delivered (state.ts). The last 200 of the past 30 days; Clear chat
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
const ID = /^[A-Za-z0-9_-]{6,64}$/;

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
  return {
    id: r.id,
    at,
    role: r.role,
    text,
    ...(files.length && r.role === "user" ? { files } : {}),
    ...(typeof r.replyTo === "string" && ID.test(r.replyTo) && r.role === "user" ? { replyTo: r.replyTo } : {}),
  };
}

/** The log as kept: the newest KEEP of the past KEEP_MS, within MAX_CHARS. */
export function trimmed(log: readonly Said[], now: number): Said[] {
  const kept = log.filter((s) => now - s.at <= KEEP_MS).slice(-KEEP);
  let chars = kept.reduce((n, s) => n + s.text.length, 0);
  while (chars > MAX_CHARS) chars -= kept.shift()!.text.length;
  return kept;
}

/** What a routine said (lib/scheduler.ts), as kept in its maker's conversation; null for any other alert. */
export function routineSaid(a: Pick<Alert, "id" | "at" | "title" | "text" | "routine">): Said | null {
  return a.routine ? { id: a.id, at: a.at, role: "assistant", text: a.text.slice(0, MAX_TEXT), routine: { id: a.routine, name: a.title } } : null;
}

/** What a background job came back with (lib/jobs.ts), as kept in its starter's conversation; null for any other alert. */
export function jobSaid(a: Pick<Alert, "id" | "at" | "title" | "text" | "job">): Said | null {
  return a.job ? { id: a.id, at: a.at, role: "assistant", text: a.text.slice(0, MAX_TEXT), job: { id: a.job, name: a.title } } : null;
}

const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** As much as a look back returns: enough to answer from, not the month. */
export const FOUND = 12;
const FOUND_TEXT = 600;

/**
 * What look_back finds (tools/conversation.ts): the messages with most of the
 * words asked about, or a day's latest when no words are given, each with the
 * question it answers or the answer it got. Oldest first, each shortened.
 */
export function lookBack(log: readonly Said[], words: string, day: string | null, dayOf: (at: number) => string): Said[] {
  const ws = new Set(wordsOf(words).filter((w) => w.length >= 2));
  if (words.trim() && !ws.size) return [];
  const on = log.map((s, i) => ({ s, i })).filter(({ s }) => !day || dayOf(s.at) === day);
  const best = ws.size
    ? on
        // A word asked about is the start of one said: "insur" finds "insurance", "AC" is not in "each".
        .map((x) => ({ ...x, n: [...ws].filter((w) => wordsOf(x.s.text).some((t) => t.startsWith(w))).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || b.i - a.i)
    : on.reverse();
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

  /** Cleared, by them (Clear chat), or as they leave the family. */
  async clear(person: string): Promise<void> {
    await this.storage.delete(key(person));
  }
}
