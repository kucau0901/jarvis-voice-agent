import type { Env } from "../types.ts";
import type { Prefs, Reach, Space } from "./hub.ts";
import type { Access } from "./access.ts";

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

/**
 * Whose person a stored creator or subscriber is: a member's id, or one of
 * their devices ("u_x~d_y", deviceWho); else the first person (the owner
 * key, "voice", and the first person's devices).
 */
export const personOfWho = (who: string): string => /^(u_[a-z0-9]+)(~|$)/.exec(who)?.[1] ?? OWNER;

/**
 * How a device is named where it makes, subscribes or opens things: its own
 * id for the first person's, as always; its owner's id before it for a
 * member's, so what it makes and receives is theirs.
 */
export const deviceWho = (id: string, owner?: string): string => (owner && owner !== OWNER ? `${owner}~${id}` : id);

/** The family's shared memory book. */
export const familyBook = (space: Pick<Space, "id">): string => `fam:${space.id}`;

/** A person's own storage name, or "" for the first person's, which keeps the name it always had. */
export const bookOf = (person: string | undefined): string => (!person || person === OWNER ? "" : person);

/** A car as a request carries it: which, whose, how far, and its key. */
export interface CarKey {
  id: string;
  name: string;
  level: "own" | "see" | "drive";
  mine: boolean;
  vin: string;
  token: string;
}

/**
 * The cars a request may reach, keys filled in: the family car's from the
 * settings, anyone else's from where they were added. The first is the one
 * used when no car is named: their own, else one they may control, else one
 * they may check.
 */
function carKeys(env: Env, reach: readonly Reach[]): CarKey[] {
  const out: CarKey[] = [];
  for (const r of reach) {
    const token = r.token ?? env.TESSIE_TOKEN?.trim();
    const vin = r.vin ?? env.TESSIE_VIN?.trim();
    if (!token || !vin) continue;
    out.push({ id: r.id, name: r.name, level: r.level, mine: r.level === "own", vin, token });
  }
  const rank = (c: CarKey) => (c.level === "own" ? 0 : c.level === "drive" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function withPerson(
  env: Env,
  o: { person: string; name?: string | null; space?: Space | null; prefs?: Prefs; cars?: readonly Reach[]; haToken?: string; access?: Access },
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
  /*
   * Cars: only those this person may reach. Without a family (no list), the
   * first person has the car in the settings, as before. Anyone else's
   * default is their own, else one shared with them; with none, no car.
   */
  // Their own Home Assistant user, if they gave one: the house answers them as themselves.
  if (o.haToken) out.HA_TOKEN = o.haToken;
  // A guest's pass: the things in the house they may work, and no others (tools/pass.ts).
  if (o.access?.allow?.length) out.JARVIS_PASS = JSON.stringify(o.access.allow);
  if (o.cars || o.person !== OWNER) {
    const keys = carKeys(env, o.cars ?? []);
    out.JARVIS_CARS = JSON.stringify(keys);
    out.TESSIE_TOKEN = keys[0]?.token ?? "";
    out.TESSIE_VIN = keys[0]?.vin ?? "";
  }
  return out;
}

/** The cars a request carries (withPerson). */
export function carsOf(env: Env): CarKey[] {
  try {
    const v = JSON.parse(env.JARVIS_CARS ?? "null") as CarKey[] | null;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
