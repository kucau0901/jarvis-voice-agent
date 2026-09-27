import type { Env } from "../types";
import type { Prefs, Space } from "./hub.ts";

/**
 * Who a request is for, laid over the environment every route already reads.
 *
 * Before families, everything Jarvis kept — memory, the Google and Spotify
 * links, the shared conversation, alerts, usage — was the one owner's, under
 * fixed names. Now each is per person, and the environment carries whose:
 * JARVIS_PERSON. The first person (who claimed the hub; the owner key and
 * devices act as them) is "owner", so what was kept before keeps its names and
 * nothing moves. Everyone else is their own id.
 *
 * Their own choices ride along too: voice, language, and where their Telegram
 * messages go — never the first person's chat for anyone else.
 *
 * Plain functions, so Node can test them.
 */

export const OWNER = "owner";

/**
 * Who a job or routine made by asking belongs to: the person asking. The
 * first person's are "voice", as they always were.
 */
export const voiceWho = (env: { JARVIS_PERSON?: string }): string =>
  env.JARVIS_PERSON && env.JARVIS_PERSON !== OWNER ? env.JARVIS_PERSON : "voice";

/** Whether a stored creator is this person's (the first person owns "voice", "owner" and the devices'). */
export const isTheirs = (who: string, person: string | undefined): boolean => personOfWho(who) === (person || OWNER);

/** Whose person a stored creator or subscriber is: a member's id, else the first person (the owner key, a device). */
export const personOfWho = (who: string): string => (/^u_[a-z0-9]+$/.test(who) ? who : OWNER);

/** The family's shared memory book. */
export const familyBook = (space: Pick<Space, "id">): string => `fam:${space.id}`;

/** A person's own storage name, or "" for the first person's, which keeps the name it always had. */
export const bookOf = (person: string | undefined): string => (!person || person === OWNER ? "" : person);

export function withPerson(
  env: Env,
  o: { person: string; name?: string | null; space?: Space | null; prefs?: Prefs },
): Env {
  const out: Env = { ...env, JARVIS_PERSON: o.person };
  if (o.name) out.JARVIS_PERSON_NAME = o.name;
  if (o.space) {
    out.JARVIS_AGENT_NAME = o.space.agentName;
    out.JARVIS_FAMILY = familyBook(o.space);
  }
  const p = o.prefs ?? {};
  if (p.voice) out.VOICE_TTS_VOICE = p.voice;
  if (p.style) out.VOICE_STYLE = p.style;
  if (p.language) out.LOCALE = p.language;
  // A member's messages go to their own chat, or nowhere: never the first person's.
  if (o.person !== OWNER) out.TELEGRAM_CHAT_ID = p.telegram ?? "";
  else if (p.telegram) out.TELEGRAM_CHAT_ID = p.telegram;
  return out;
}
