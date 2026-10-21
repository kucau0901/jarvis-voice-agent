import type { Env } from "../types.ts";
import { allows, type Grant } from "./scopes.ts";
import { stateStub } from "./state-client.ts";
import { asked, matching } from "./conversation.ts";
import { memoryFor, search, tokenise } from "./memory.ts";
import { findMail, type MailFound } from "../tools/gmail.ts";

/**
 * Chat's search box (routes/search.ts): what you and Jarvis said, what it
 * remembers and your mail, looked through at once and grouped, as Hark's
 * search has them. By words only: no model, no embeddings, nothing counted as
 * a use of a fact, so it costs nothing and is the same on the ChatGPT plan or
 * a key. Each section only for whoever may read it: memory with
 * `memory.read`, mail with `mail`; a section they may not search is null, one
 * with nothing found is empty.
 */

export const MAX_MESSAGES = 8;
export const MAX_FACTS = 5;
export const MAX_MAIL = 5;
const MESSAGE_TEXT = 300;
/** Gmail answering slowly is left out rather than waited for. */
const MAIL_WAIT_MS = 5_000;

export interface MessageHit {
  id: string;
  at: number;
  role: "user" | "assistant";
  text: string;
  routine?: string;
  job?: string;
}
export interface FactHit {
  id: string;
  text: string;
  kind: string;
  /** In the family's shared book rather than their own. */
  family?: boolean;
}
export type Hit = { kind: "message"; hit: MessageHit } | { kind: "fact"; hit: FactHit } | { kind: "mail"; hit: MailFound };

export interface Found {
  q: string;
  top: Hit | null;
  messages: MessageHit[];
  memory: FactHit[] | null;
  mail: MailFound[] | null;
  /** Why mail could not be searched, when it could not. */
  mailNote?: string;
}

/** The one to show first: a fact or message with every word, then the first mail. Taken out of its group. */
export function topHit(f: Omit<Found, "top" | "q">, everyWordIn: { fact: boolean; message: boolean }): Hit | null {
  if (f.memory?.length && everyWordIn.fact) return { kind: "fact", hit: f.memory.shift()! };
  if (f.messages.length && everyWordIn.message) return { kind: "message", hit: f.messages.shift()! };
  if (f.mail?.length) return { kind: "mail", hit: f.mail.shift()! };
  return null;
}

export async function searchAll(env: Env, grants: readonly Grant[], person: string, q: string, now: number): Promise<Found> {
  const state = stateStub(env);
  const words = asked(q);

  const messages = async () => {
    const found = matching(state ? await state.conversationOf(person, now) : [], q).slice(0, MAX_MESSAGES);
    return {
      all: found.length > 0 && found[0]!.n === words.length,
      hits: found.map(({ s }): MessageHit => ({
        id: s.id,
        at: s.at,
        role: s.role,
        text: s.text.length > MESSAGE_TEXT ? `${s.text.slice(0, MESSAGE_TEXT)}…` : s.text,
        ...(s.routine ? { routine: s.routine.id } : {}),
        ...(s.job ? { job: s.job.id } : {}),
      })),
    };
  };

  const memory = async () => {
    if (!allows(grants, "memory.read")) return null;
    const store = memoryFor(env, grants);
    await store.load();
    const own = await store.allFacts();
    const shared = store.family ? await store.family.allFacts() : [];
    const ids = new Set(shared.map((f) => f.id));
    // search() alone: MemoryStore.search would embed the words with a key, and count a use.
    const hits = search([...own, ...shared], q, MAX_FACTS);
    const terms = tokenise(q);
    return {
      all: hits.length > 0 && terms.every((t) => hits[0]!.fact.keys.includes(t)),
      hits: hits.map(({ fact }): FactHit => ({ id: fact.id, text: fact.text, kind: fact.kind, ...(ids.has(fact.id) ? { family: true } : {}) })),
    };
  };

  const mail = async (): Promise<MailFound[] | string | null> => {
    if (!allows(grants, "mail") || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return findMail(env, q, MAX_MAIL, AbortSignal.timeout(MAIL_WAIT_MS));
  };

  const [m, f, g] = await Promise.all([messages(), memory(), mail()]);
  const found: Omit<Found, "top" | "q"> = {
    messages: m.hits,
    memory: f?.hits ?? null,
    mail: typeof g === "string" ? [] : g,
    ...(typeof g === "string" ? { mailNote: g } : {}),
  };
  const top = topHit(found, { fact: !!f?.all, message: m.all });
  return { q, top, ...found };
}
