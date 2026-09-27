import type { Storage } from "./state-host.ts";

/**
 * The family's conversations: one room everyone in the family shares, and a
 * direct conversation between any two of them. Jarvis takes part in the room
 * when it is named (routes/family.ts), and messages it passes on between
 * people (lib/relays.ts) appear in their direct conversation.
 *
 * People are named as everywhere else (lib/context.ts): "owner" for the first
 * person, a member's id otherwise; "agent" is Jarvis itself.
 *
 * Kept in the Durable Object: a few hundred messages a conversation, one
 * record each, and when each person last read each one.
 */

export const FAMILY_ROOM = "family";
export const AGENT = "agent";
export const KEEP = 300;
export const MAX_TEXT = 2000;

export interface ChatMessage {
  id: string;
  at: number;
  /** Who said it: a person, or "agent". */
  from: string;
  /** Their name when they said it. */
  name: string;
  text: string;
  /** A message Jarvis passed on (lib/relays.ts): what it is, so the app can offer Done or a reply. */
  relay?: { id: string; kind: "tell" | "remind" | "ask"; to: string };
}

/** Whether a message is to the assistant: its name, as a word, anywhere in it ("Jarvis, …", "@Friday"). */
export function namesAgent(text: string, agentName = "Jarvis"): boolean {
  const name = agentName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !!name && new RegExp(`(^|[^\\p{L}])@?${name}([^\\p{L}]|$)`, "iu").test(text);
}

/** The direct conversation between two people: the same whichever of them asks. */
export const dmId = (a: string, b: string): string => `dm:${[a, b].sort().join("|")}`;

/** Who may read a conversation: anyone in the family for the room, only its two for a direct one. */
export function mayRead(convo: string, person: string): boolean {
  if (convo === FAMILY_ROOM) return true;
  const m = /^dm:(.+)\|(.+)$/.exec(convo);
  return !!m && (m[1] === person || m[2] === person);
}

const K = {
  convo: (id: string) => `chat:c:${id}`,
  seen: (person: string) => `chat:seen:${person}`,
};

let n = 0;
const newId = () => `m_${Date.now().toString(36)}${(n++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;

export class Chat {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async post(convo: string, msg: Omit<ChatMessage, "id" | "at">, now = Date.now()): Promise<ChatMessage> {
    const text = msg.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, MAX_TEXT);
    const m: ChatMessage = { ...msg, text, id: newId(), at: now };
    const log = (await this.storage.get<ChatMessage[]>(K.convo(convo))) ?? [];
    log.push(m);
    await this.storage.put(K.convo(convo), log.slice(-KEEP));
    return m;
  }

  /** A conversation's messages, oldest first; with `since`, only newer ones. */
  async messages(convo: string, since = 0, limit = 100): Promise<ChatMessage[]> {
    const log = (await this.storage.get<ChatMessage[]>(K.convo(convo))) ?? [];
    return log.filter((m) => m.at > since).slice(-limit);
  }

  /** Change a passed-on message as its answer arrives, so the Done button goes away. */
  async markRelay(convo: string, relayId: string, note: string): Promise<void> {
    const log = (await this.storage.get<ChatMessage[]>(K.convo(convo))) ?? [];
    let changed = false;
    for (const m of log) {
      if (m.relay?.id === relayId && !m.text.endsWith(note)) {
        m.text = `${m.text}\n${note}`;
        changed = true;
      }
    }
    if (changed) await this.storage.put(K.convo(convo), log);
  }

  async seen(person: string, convo: string, at: number): Promise<void> {
    const s = (await this.storage.get<Record<string, number>>(K.seen(person))) ?? {};
    if ((s[convo] ?? 0) >= at) return;
    await this.storage.put(K.seen(person), { ...s, [convo]: at });
  }

  /**
   * A person's conversations: the family room, and one with each other
   * member, each with its last message and how many they have not read.
   */
  async convos(
    person: string,
    family: { id: string; name: string }[],
  ): Promise<{ id: string; title: string; last: ChatMessage | null; unread: number }[]> {
    const seen = (await this.storage.get<Record<string, number>>(K.seen(person))) ?? {};
    const one = async (id: string, title: string) => {
      const log = (await this.storage.get<ChatMessage[]>(K.convo(id))) ?? [];
      const after = seen[id] ?? 0;
      return { id, title, last: log[log.length - 1] ?? null, unread: log.filter((m) => m.at > after && m.from !== person).length };
    };
    const out = [await one(FAMILY_ROOM, "Family")];
    for (const p of family) if (p.id !== person) out.push(await one(dmId(person, p.id), p.name));
    return out;
  }
}
