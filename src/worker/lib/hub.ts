import { sha256Hex } from "./devices.ts";
import { WILDCARD, saneGrants, type Grant } from "./scopes.ts";
import type { StoredKey } from "./webauthn.ts";
import type { Storage } from "./state-host.ts";

/**
 * Who uses this Jarvis: people, the families (spaces) they belong to, and how
 * they sign in.
 *
 * Jarvis began as one person's assistant behind one key. A family shares it:
 * each person signs in with their own passkey, one of them is the admin, and
 * everyone else's reach is what their role allows. The deployment's owner key
 * still works, as the way in when every passkey is lost; it is how the first
 * admin is made ("claiming" the hub).
 *
 * Signing in:
 *   invite    an admin makes a link; whoever opens it names themselves and
 *             adds a passkey on their phone. A link can also be made for an
 *             existing member who lost theirs: it adds a passkey to them.
 *   passkey   Face ID, a fingerprint or the phone's PIN (lib/webauthn.ts).
 *   pairing   a screen that cannot hold a passkey well (the car, a shared
 *             tablet) shows a short code; a signed-in phone approves it.
 *
 * Nothing secret is stored readable: sessions, invites and pairing polls are
 * random tokens kept only as SHA-256 digests, as device tokens are.
 *
 * Kept in the Durable Object's storage under `hub:`; free of Worker globals,
 * so Node tests it.
 */

export type Role = "admin" | "adult" | "child" | "guest";
export const ROLES: readonly Role[] = ["admin", "adult", "child", "guest"];

/**
 * What each role reaches until an admin changes it.
 *
 * Memory, mail, the calendar, Spotify, alerts and routines are each person's
 * own (lib/context.ts): an adult has all of theirs, and changes what the
 * family shares; a child their memory, calendar, alerts and routines. Cars
 * are reached only as far as their owner shares them ("see" or "drive"), so
 * the car scopes are only the ceiling. Hermes stays the admin's, and a guest
 * only asks. An admin can widen or narrow anyone, as with a device.
 */
export const ROLE_SCOPES: Readonly<Record<Role, readonly Grant[]>> = {
  admin: [WILDCARD],
  adult: ["ask", "home", "voice", "screen", "memory.read", "memory.write", "family", "mail", "calendar", "media", "alerts", "routines", "car.read", "car.control"],
  child: ["ask", "voice", "screen", "memory.read", "memory.write", "calendar", "alerts", "routines", "car.read", "car.control"],
  guest: ["ask", "voice"],
};

export interface Space {
  id: string;
  /** "The Rahman family". */
  name: string;
  /** What the family calls its assistant: "Jarvis", or any name they like. */
  agentName: string;
  createdAt: number;
}

export interface User {
  id: string;
  name: string;
  createdAt: number;
}

/**
 * A PIN for screens several people share (the family car): switching into
 * someone's profile there asks for it. Kept as a PBKDF2 hash; wrong guesses
 * are counted, and five in a row wait a quarter of an hour.
 */
interface PinRecord {
  salt: string;
  hash: string;
  fails?: number;
  waitUntil?: number;
}

/**
 * What each person chooses for themselves, laid over the family's settings
 * when they ask (lib/context.ts): their voice, their language, and where
 * their Telegram messages go.
 */
export interface Prefs {
  voice?: string;
  style?: string;
  language?: string;
  telegram?: string;
}

/** A user as stored: the PIN never leaves this file. */
interface StoredUser extends User {
  pin?: PinRecord;
  prefs?: Prefs;
  /**
   * Their own Home Assistant user's token, if they gave one: the house then
   * answers them as themselves, so Home Assistant's logbook says who did
   * it, and its own rules for that user apply. Never leaves the Worker.
   */
  haToken?: string;
}

/*
 * Cars (Tessie), each with an owner and shares. The car set up in Settings
 * is the first person's, "family", as it always was: only its name and
 * shares are kept here, its token stays a setting. Anyone else adds their own
 * in Family → You, and shares it: "see" (where it is, the battery) or "drive"
 * (climate, locks, navigation too).
 */
export type CarLevel = "see" | "drive";
export const FAMILY_CAR = "family";

interface StoredCar {
  id: string;
  /** Whose: "owner" for the first person, else a member's id. */
  owner: string;
  name: string;
  vin: string;
  /** The Tessie token. Never leaves the Worker. */
  token: string;
  shares: Record<string, CarLevel>;
  createdAt: number;
}

/** A car someone may reach, as a request is given it: with the key, for the Worker only. */
export interface Reach {
  id: string;
  name: string;
  owner: string;
  level: "own" | CarLevel;
  /** Absent for the family car, whose token is a setting. */
  vin?: string;
  token?: string;
}

/** A car as the app shows it: no token. */
export interface CarView {
  id: string;
  name: string;
  owner: string;
  ownerName: string;
  level: "own" | CarLevel;
  vinHint?: string;
  /** For the owner: who it is shared with, and how far. */
  shares?: Record<string, CarLevel>;
}

/** A person as a request made on their behalf needs them (hub.ts personView). */
export interface PersonView {
  space: Space | null;
  name: string | null;
  prefs: Prefs;
  /** The cars they may reach, with the keys, for the Worker only. */
  cars: Reach[];
  /** Their own Home Assistant token, for the Worker only. */
  haToken?: string;
}

/** Everything about one sign-in that a request needs to know. */
export interface Place {
  space: Space;
  /** The person who claimed the hub: what Jarvis kept before families is theirs. */
  first: boolean;
  prefs: Prefs;
}

export const PIN_SHAPE = /^\d{4,8}$/;
export const PIN_TRIES = 5;
export const PIN_WAIT_MS = 15 * 60_000;
const PIN_ITERATIONS = 100_000;

export interface Member {
  space: string;
  user: string;
  role: Role;
  /** Set by an admin; without it, the role's. */
  scopes?: Grant[];
  addedAt: number;
  addedBy: string;
}

export interface Passkey extends StoredKey {
  user: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface Invite {
  id: string;
  digest: string;
  space: string;
  role: Role;
  /** Who it is for, as the admin wrote it; they may change it. */
  name: string;
  /** For an existing member: the link adds a passkey to them. */
  user?: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export interface Session {
  id: string;
  digest: string;
  user: string;
  space: string;
  /** "iPhone", "Tesla browser": what the screen said it was. */
  label: string;
  via: "passkey" | "pairing";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /**
   * On a screen several people share, the profile not in use is locked: it
   * does nothing until its PIN is given again. Only for people with a PIN.
   */
  locked?: boolean;
}

export interface Pairing {
  poll: string;
  code: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  approved?: { user: string; space: string; by: string; at: number };
}

export interface Challenge {
  challenge: string;
  purpose: "login" | "register";
  /** For registering: the invite's digest, or the signed-in user adding a passkey. */
  invite?: string;
  user?: string;
  exp: number;
}

/** A signed-in person, as auth needs them. */
export interface SignedIn {
  session: Omit<Session, "digest">;
  user: User & { hasPin: boolean };
  member: Member;
  scopes: Grant[];
  place: Place;
}

const shown = (u: StoredUser): User => ({ id: u.id, name: u.name, createdAt: u.createdAt });

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function pinHash(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PIN_ITERATIONS }, key, 256));
}

export const SESSION_TOKEN = "jss1_";
export const INVITE_TOKEN = "jin1_";
export const POLL_TOKEN = "jpp1_";
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** For pairing codes, read off a screen and typed on a phone: no I, O, 0 or 1. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const INVITE_MS = 7 * 86_400_000;
/** A session lasts this long after it was last used. */
export const SESSION_IDLE_MS = 180 * 86_400_000;
export const PAIRING_MS = 10 * 60_000;
export const CHALLENGE_MS = 5 * 60_000;
/** Challenges and pairings anyone can start: capped, so strangers cannot fill storage. */
const MAX_PENDING = 200;
const TOUCH_MS = 60 * 60_000;

const K = {
  meta: "hub:meta",
  space: (id: string) => `hub:space:${id}`,
  user: (id: string) => `hub:user:${id}`,
  member: (space: string, user: string) => `hub:member:${space}:${user}`,
  members: (space: string) => `hub:member:${space}:`,
  passkey: (id: string) => `hub:pk:${id}`,
  invite: (digest: string) => `hub:inv:${digest}`,
  session: (digest: string) => `hub:sess:${digest}`,
  pairing: (poll: string) => `hub:pair:${poll}`,
  car: (id: string) => `hub:car:${id}`,
  pairCode: (code: string) => `hub:paircode:${code}`,
  challenge: (c: string) => `hub:ch:${c}`,
};

function random(alphabet: string, n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  // Both alphabets have 32 symbols, so masking has no bias.
  for (const b of bytes) s += alphabet[b & 31];
  return s;
}

export const mintSecret = (prefix: string) => prefix + random(ALPHABET, 32);
const newId = (prefix: string) => prefix + random(ALPHABET, 10);

export const tokenShape = (prefix: string) => new RegExp(`^${prefix}[${ALPHABET}]{32}$`);
const SESSION_SHAPE = tokenShape(SESSION_TOKEN);
export const looksLikeSession = (s: string) => SESSION_SHAPE.test(s);

/** A name as shown to the family: one line, no control characters, short. */
export function cleanName(raw: unknown, max = 40): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export function scopesOf(m: Member): Grant[] {
  if (m.role === "admin") return [WILDCARD];
  return m.scopes ? [...m.scopes] : [...ROLE_SCOPES[m.role]];
}

type Fail = { error: string };
const fail = (error: string): Fail => ({ error });

export class HubHost {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /* ---------- the family ----------------------------------------------------- */

  private async meta(): Promise<{ space?: string; owner?: string }> {
    return (await this.storage.get<{ space?: string; owner?: string }>(K.meta)) ?? {};
  }

  /**
   * The first person: whoever claimed the hub with the owner key. What Jarvis
   * kept before there were families (memory, mail, routines, alerts) is
   * theirs, under the names it always had, so nothing has to move. Found once
   * — the admin the owner key invited — and remembered.
   */
  async firstPerson(): Promise<string | null> {
    const meta = await this.meta();
    if (meta.owner) return meta.owner;
    if (!meta.space) return null;
    const claimer = (await this.membersOf(meta.space))
      .filter((m) => m.addedBy === "owner" && m.role === "admin")
      .sort((a, b) => a.addedAt - b.addedAt)[0];
    if (!claimer) return null;
    await this.storage.put(K.meta, { ...meta, owner: claimer.user });
    return claimer.user;
  }

  /**
   * A person as a request made on their behalf needs them: their name, their
   * family, their choices. "owner" is the first person — the owner key and
   * devices act as them — and gives what there is before anyone has claimed
   * the hub: no name, no family.
   */
  async personView(person: string): Promise<PersonView> {
    const meta = await this.meta();
    const space = meta.space ? await this.space(meta.space) : null;
    const id = person === "owner" ? await this.firstPerson() : person;
    const u = id ? await this.storedUser(id) : null;
    if (person !== "owner" && (!u || !space || !(await this.member(space.id, person)))) return { space: null, name: null, prefs: {}, cars: [] };
    return { space, name: u?.name ?? null, prefs: u?.prefs ?? {}, cars: await this.carsFor(person), ...(u?.haToken ? { haToken: u.haToken } : {}) };
  }

  private async membersOf(space: string): Promise<Member[]> {
    return [...(await this.storage.list<Member>({ prefix: K.members(space) })).values()];
  }

  /** Whether anyone can sign in yet, and what the family calls its assistant. */
  async status(): Promise<{ claimed: boolean; agentName: string | null; space: string | null }> {
    const { space } = await this.meta();
    if (!space) return { claimed: false, agentName: null, space: null };
    const s = await this.storage.get<Space>(K.space(space));
    const admins = (await this.membersOf(space)).filter((m) => m.role === "admin");
    return { claimed: admins.length > 0, agentName: s?.agentName ?? null, space };
  }

  async space(id: string): Promise<Space | null> {
    return (await this.storage.get<Space>(K.space(id))) ?? null;
  }

  /**
   * Make the first family, and an invite for its admin — the person holding
   * the owner key, who then adds their passkey as any new member would. Asked
   * again before that is done, it gives a fresh invite for the same family.
   */
  async claim(input: { name: unknown; spaceName: unknown; agentName: unknown }, now: number): Promise<{ token: string; space: Space } | Fail> {
    const name = cleanName(input.name);
    const spaceName = cleanName(input.spaceName, 60);
    const agentName = cleanName(input.agentName, 24) || "Jarvis";
    if (!name) return fail("your name is needed");
    if (!spaceName) return fail("the family's name is needed");
    if ((await this.status()).claimed) return fail("this Jarvis already has an admin; ask them for an invite");

    let { space: id } = await this.meta();
    let space = id ? await this.space(id) : null;
    if (!space) {
      id = newId("s_");
      space = { id, name: spaceName, agentName, createdAt: now };
      await this.storage.put(K.meta, { space: id });
    } else {
      space = { ...space, name: spaceName, agentName };
    }
    await this.storage.put(K.space(space.id), space);
    // Only the newest admin invite stands: an older link, never used, is void.
    for (const [k, inv] of await this.storage.list<Invite>({ prefix: "hub:inv:" })) {
      if (inv.space === space.id && inv.createdBy === "owner" && !inv.usedAt) await this.storage.delete(k);
    }
    const made = await this.createInvite(space.id, { role: "admin", name }, "owner", now);
    if ("error" in made) return made;
    return { token: made.token, space };
  }

  async renameSpace(id: string, patch: { name?: unknown; agentName?: unknown }): Promise<Space | Fail> {
    const s = await this.space(id);
    if (!s) return fail("no such family");
    const name = patch.name === undefined ? s.name : cleanName(patch.name, 60);
    const agentName = patch.agentName === undefined ? s.agentName : cleanName(patch.agentName, 24);
    if (!name || !agentName) return fail("a name cannot be empty");
    const next = { ...s, name, agentName };
    await this.storage.put(K.space(id), next);
    return next;
  }

  /* ---------- members -------------------------------------------------------- */

  async user(id: string): Promise<User | null> {
    const u = await this.storedUser(id);
    return u ? shown(u) : null;
  }

  private async storedUser(id: string): Promise<StoredUser | null> {
    return (await this.storage.get<StoredUser>(K.user(id))) ?? null;
  }

  async member(space: string, user: string): Promise<Member | null> {
    return (await this.storage.get<Member>(K.member(space, user))) ?? null;
  }

  /** Everyone in a family, with when they were last about. */
  async members(space: string): Promise<(Member & { name: string; scopesNow: Grant[]; passkeys: number; hasPin: boolean; lastSeenAt?: number })[]> {
    const ms = await this.membersOf(space);
    const keys = [...(await this.storage.list<Passkey>({ prefix: "hub:pk:" })).values()];
    const sessions = [...(await this.storage.list<Session>({ prefix: "hub:sess:" })).values()];
    const out = [];
    for (const m of ms) {
      const u = await this.storedUser(m.user);
      const seen = sessions.filter((s) => s.user === m.user).map((s) => s.lastSeenAt);
      out.push({
        ...m,
        name: u?.name ?? "?",
        hasPin: !!u?.pin,
        scopesNow: scopesOf(m),
        passkeys: keys.filter((k) => k.user === m.user).length,
        lastSeenAt: seen.length ? Math.max(...seen) : undefined,
      });
    }
    return out.sort((a, b) => a.addedAt - b.addedAt);
  }

  async renameUser(id: string, raw: unknown): Promise<User | Fail> {
    const u = await this.storedUser(id);
    const name = cleanName(raw);
    if (!u) return fail("no such person");
    if (!name) return fail("a name cannot be empty");
    const next = { ...u, name };
    await this.storage.put(K.user(id), next);
    return shown(next);
  }

  /** A person's own choices; an empty value clears one. */
  async setPrefs(id: string, patch: Prefs): Promise<Prefs | Fail> {
    const u = await this.storedUser(id);
    if (!u) return fail("no such person");
    const next: Prefs = { ...u.prefs };
    for (const k of ["voice", "style", "language", "telegram"] as const) {
      const v = patch[k];
      if (v === undefined) continue;
      const clean = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, k === "style" ? 300 : 40) : "";
      if (clean) next[k] = clean;
      else delete next[k];
    }
    await this.storage.put(K.user(id), { ...u, prefs: next });
    return next;
  }

  /** Their own Home Assistant token, already checked with the house; null removes it. */
  async setHaToken(id: string, token: string | null): Promise<true | Fail> {
    const u = await this.storedUser(id);
    if (!u) return fail("no such person");
    const { haToken: _, ...rest } = u;
    await this.storage.put(K.user(id), token ? { ...rest, haToken: token } : rest);
    return true;
  }

  async hasHaToken(id: string): Promise<boolean> {
    return !!(await this.storedUser(id))?.haToken;
  }

  async prefsOf(id: string): Promise<Prefs> {
    return (await this.storedUser(id))?.prefs ?? {};
  }

  /* ---------- cars ------------------------------------------------------------- */

  private async storedCars(): Promise<StoredCar[]> {
    // The family car's record (its name and shares only) is not one of these.
    return [...(await this.storage.list<StoredCar>({ prefix: "hub:car:" })).entries()]
      .filter(([k, c]) => k !== K.car(FAMILY_CAR) && typeof c.vin === "string")
      .map(([, c]) => c);
  }

  /** The Settings car's name and shares; it belongs to the first person. */
  private async familyCar(): Promise<{ name: string; shares: Record<string, CarLevel> }> {
    const meta = await this.storage.get<{ name?: string; shares?: Record<string, CarLevel> }>(K.car(FAMILY_CAR));
    return { name: meta?.name || "the family car", shares: meta?.shares ?? {} };
  }

  /**
   * The cars `person` may reach: their own, whole, and those shared with
   * them, as far as they were shared. The family car (Settings) is listed
   * without its key, which the Worker fills from the settings.
   */
  async carsFor(person: string): Promise<Reach[]> {
    const out: Reach[] = [];
    const fam = await this.familyCar();
    const famLevel = person === "owner" ? "own" : fam.shares[person];
    if (famLevel) out.push({ id: FAMILY_CAR, name: fam.name, owner: "owner", level: famLevel });
    for (const c of await this.storedCars()) {
      const level = c.owner === person ? "own" : c.shares[person];
      if (level) out.push({ id: c.id, name: c.name, owner: c.owner, level, vin: c.vin, token: c.token });
    }
    return out;
  }

  /** The same, for the app: names and levels, the owner's shares, never a token. */
  async carsView(person: string): Promise<CarView[]> {
    const names = new Map<string, string>();
    const first = await this.firstPerson();
    const meta = await this.meta();
    if (meta.space) {
      for (const m of await this.membersOf(meta.space)) {
        const u = await this.storedUser(m.user);
        if (u) names.set(m.user === first ? "owner" : m.user, u.name);
      }
    }
    const fam = await this.familyCar();
    const reach = await this.carsFor(person);
    const stored = new Map((await this.storedCars()).map((c) => [c.id, c]));
    return reach.map((r) => {
      const c = stored.get(r.id);
      const shares = r.level === "own" ? (r.id === FAMILY_CAR ? fam.shares : c?.shares) : undefined;
      return {
        id: r.id,
        name: r.name,
        owner: r.owner,
        ownerName: names.get(r.owner) ?? "someone",
        level: r.level,
        ...(c ? { vinHint: `…${c.vin.slice(-4)}` } : {}),
        ...(shares ? { shares } : {}),
      };
    });
  }

  /** A person's own car, its token already checked with Tessie. */
  async addCar(owner: string, input: { name: unknown; vin: string; token: string }, now: number): Promise<CarView | Fail> {
    const name = cleanName(input.name, 40);
    if (!name) return fail("give the car a name, like \"Aisyah's car\"");
    const mine = (await this.storedCars()).filter((c) => c.owner === owner);
    if (mine.length >= 5) return fail("five cars each is plenty; remove one first");
    if ((await this.storedCars()).some((c) => c.vin === input.vin)) return fail("that car is already here; ask its owner to share it");
    const car: StoredCar = { id: newId("c_"), owner, name, vin: input.vin, token: input.token, shares: {}, createdAt: now };
    await this.storage.put(K.car(car.id), car);
    return (await this.carsView(owner)).find((c) => c.id === car.id)!;
  }

  /**
   * Rename a car or change who it is shared with: its owner only. A share is
   * to a member of the family, "see" or "drive"; null takes it away.
   */
  async updateCar(person: string, id: string, patch: { name?: unknown; shares?: Record<string, unknown> }): Promise<true | Fail> {
    const meta = await this.meta();
    const members = new Set<string>();
    const first = await this.firstPerson();
    if (meta.space) for (const m of await this.membersOf(meta.space)) members.add(m.user === first ? "owner" : m.user);
    const nextShares = (had: Record<string, CarLevel>) => {
      const out = { ...had };
      for (const [who, level] of Object.entries(patch.shares ?? {})) {
        if (who === person || !members.has(who)) continue;
        if (level === "see" || level === "drive") out[who] = level;
        else delete out[who];
      }
      return out;
    };
    const name = patch.name === undefined ? undefined : cleanName(patch.name, 40);
    if (name === "") return fail("a car needs a name");
    if (id === FAMILY_CAR) {
      if (person !== "owner") return fail("only its owner can change that car");
      const fam = await this.familyCar();
      await this.storage.put(K.car(FAMILY_CAR), { name: name ?? fam.name, shares: nextShares(fam.shares) });
      return true;
    }
    const c = await this.storage.get<StoredCar>(K.car(id));
    if (!c || c.owner !== person) return fail("only its owner can change that car");
    await this.storage.put(K.car(id), { ...c, name: name ?? c.name, shares: nextShares(c.shares) });
    return true;
  }

  async removeCar(person: string, id: string): Promise<true | Fail> {
    const c = await this.storage.get<StoredCar>(K.car(id));
    if (id === FAMILY_CAR || !c || c.owner !== person) return fail("only its owner can remove that car");
    await this.storage.delete(K.car(id));
    return true;
  }

  /** Someone leaves: their cars go, and nothing stays shared with them. */
  private async forgetCarsOf(person: string): Promise<void> {
    for (const c of await this.storedCars()) {
      if (c.owner === person) await this.storage.delete(K.car(c.id));
      else if (c.shares[person]) {
        const { [person]: _, ...rest } = c.shares;
        await this.storage.put(K.car(c.id), { ...c, shares: rest });
      }
    }
    const fam = await this.familyCar();
    if (fam.shares[person]) {
      const { [person]: _, ...rest } = fam.shares;
      await this.storage.put(K.car(FAMILY_CAR), { name: fam.name, shares: rest });
    }
  }

  /* ---------- PINs, for shared screens ------------------------------------------ */

  /** Set a PIN (4 to 8 digits), or with none, remove it: their locked screens open again. */
  async setPin(id: string, pin: unknown): Promise<true | Fail> {
    const u = await this.storedUser(id);
    if (!u) return fail("no such person");
    if (pin === null || pin === "" || pin === undefined) {
      const { pin: _, ...rest } = u;
      await this.storage.put(K.user(id), rest);
      return true;
    }
    if (typeof pin !== "string" || !PIN_SHAPE.test(pin)) return fail("a PIN is 4 to 8 digits");
    const salt = random(ALPHABET, 16);
    await this.storage.put(K.user(id), { ...u, pin: { salt, hash: await pinHash(pin, salt) } });
    return true;
  }

  /** Lock a session: switching to someone else on a shared screen. Does nothing for someone with no PIN. */
  async lockSession(digest: string): Promise<boolean> {
    const s = await this.storage.get<Session>(K.session(digest));
    if (!s) return false;
    const u = await this.storedUser(s.user);
    if (!u?.pin) return false;
    await this.storage.put(K.session(digest), { ...s, locked: true });
    return true;
  }

  /** Give a locked session back its use, with the PIN. Five wrong in a row wait fifteen minutes. */
  async unlockSession(digest: string, pin: unknown, now: number): Promise<true | Fail> {
    const s = await this.storage.get<Session>(K.session(digest));
    if (!s) return fail("this sign-in has ended");
    const u = await this.storedUser(s.user);
    if (!u) return fail("this person is no longer a member");
    if (!u.pin) {
      if (s.locked) await this.storage.put(K.session(digest), { ...s, locked: false });
      return true;
    }
    if (u.pin.waitUntil && u.pin.waitUntil > now) {
      return fail(`too many wrong PINs; try again in ${Math.ceil((u.pin.waitUntil - now) / 60_000)} minutes`);
    }
    const good = typeof pin === "string" && PIN_SHAPE.test(pin) && (await pinHash(pin, u.pin.salt)) === u.pin.hash;
    if (!good) {
      const fails = (u.pin.fails ?? 0) + 1;
      const pinNext = fails >= PIN_TRIES ? { ...u.pin, fails: 0, waitUntil: now + PIN_WAIT_MS } : { ...u.pin, fails };
      await this.storage.put(K.user(u.id), { ...u, pin: pinNext });
      return fail(fails >= PIN_TRIES ? "too many wrong PINs; try again in 15 minutes" : "that PIN is not right");
    }
    await this.storage.put(K.user(u.id), { ...u, pin: { salt: u.pin.salt, hash: u.pin.hash } });
    await this.storage.put(K.session(digest), { ...s, locked: false });
    return true;
  }

  /** Change a member's role or reach. The last admin cannot stop being one. */
  async updateMember(space: string, user: string, patch: { role?: unknown; scopes?: unknown }): Promise<Member | Fail> {
    const m = await this.member(space, user);
    if (!m) return fail("not a member");
    const next: Member = { ...m };
    if (patch.role !== undefined) {
      if (!isRole(patch.role)) return fail("unknown role");
      if (m.role === "admin" && patch.role !== "admin" && (await this.admins(space)) < 2) {
        return fail("a family needs an admin: make someone else admin first");
      }
      next.role = patch.role;
      // A new role starts from its own defaults.
      delete next.scopes;
    }
    if (patch.scopes !== undefined) {
      if (patch.scopes === null) delete next.scopes;
      else next.scopes = saneGrants(patch.scopes).filter((g) => g !== WILDCARD);
    }
    await this.storage.put(K.member(space, user), next);
    return next;
  }

  private async admins(space: string): Promise<number> {
    return (await this.membersOf(space)).filter((m) => m.role === "admin").length;
  }

  /**
   * Take someone out of the family: their sessions end and their passkeys go.
   * Only the last admin cannot be removed.
   */
  async removeMember(space: string, user: string): Promise<{ ended: string[] } | Fail> {
    const m = await this.member(space, user);
    if (!m) return fail("not a member");
    // Everything Jarvis kept before the family (memory, mail, routines) is theirs.
    if ((await this.firstPerson()) === user) return fail("the person who set up the family holds what Jarvis kept before it, so they cannot be removed");
    if (m.role === "admin" && (await this.admins(space)) < 2) return fail("the last admin cannot be removed");
    await this.storage.delete(K.member(space, user));
    await this.forgetCarsOf(user);
    const ended = await this.endSessionsOf(user);
    for (const [k, p] of await this.storage.list<Passkey>({ prefix: "hub:pk:" })) {
      if (p.user === user) await this.storage.delete(k);
    }
    await this.storage.delete(K.user(user));
    return { ended };
  }

  /* ---------- invites -------------------------------------------------------- */

  async createInvite(
    space: string,
    o: { role: unknown; name: unknown; user?: string },
    by: string,
    now: number,
  ): Promise<{ token: string; invite: Omit<Invite, "digest"> } | Fail> {
    if (!(await this.space(space))) return fail("no such family");
    let role: Role;
    let name: string;
    if (o.user) {
      // A new passkey for someone already here.
      const m = await this.member(space, o.user);
      const u = await this.user(o.user);
      if (!m || !u) return fail("not a member");
      role = m.role;
      name = u.name;
    } else {
      if (!isRole(o.role)) return fail("unknown role");
      role = o.role;
      name = cleanName(o.name);
    }
    const token = mintSecret(INVITE_TOKEN);
    const digest = await sha256Hex(token);
    const invite: Invite = {
      id: newId("i_"),
      digest,
      space,
      role,
      name,
      ...(o.user ? { user: o.user } : {}),
      createdBy: by,
      createdAt: now,
      expiresAt: now + INVITE_MS,
    };
    await this.storage.put(K.invite(digest), invite);
    const { digest: _, ...shown } = invite;
    return { token, invite: shown };
  }

  private async liveInvite(token: string, now: number): Promise<Invite | null> {
    if (!tokenShape(INVITE_TOKEN).test(token)) return null;
    const inv = await this.storage.get<Invite>(K.invite(await sha256Hex(token)));
    if (!inv || inv.usedAt || inv.expiresAt < now) return null;
    return inv;
  }

  /** What an invite is for, shown before the passkey is made. */
  async peekInvite(token: string, now: number): Promise<{ digest: string; spaceName: string; agentName: string; role: Role; name: string; existing: boolean } | null> {
    const inv = await this.liveInvite(token, now);
    if (!inv) return null;
    const s = await this.space(inv.space);
    if (!s) return null;
    return { digest: inv.digest, spaceName: s.name, agentName: s.agentName, role: inv.role, name: inv.name, existing: !!inv.user };
  }

  async invites(space: string, now: number): Promise<Omit<Invite, "digest">[]> {
    const all = [...(await this.storage.list<Invite>({ prefix: "hub:inv:" })).entries()];
    const out: Omit<Invite, "digest">[] = [];
    for (const [k, inv] of all) {
      // Spent and lapsed invites are tidied away a day after.
      if ((inv.usedAt ?? inv.expiresAt) < now - 86_400_000) {
        await this.storage.delete(k);
        continue;
      }
      if (inv.space !== space || inv.usedAt || inv.expiresAt < now) continue;
      const { digest: _, ...shown } = inv;
      out.push(shown);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async cancelInvite(space: string, id: string): Promise<boolean> {
    for (const [k, inv] of await this.storage.list<Invite>({ prefix: "hub:inv:" })) {
      if (inv.space === space && inv.id === id) {
        await this.storage.delete(k);
        return true;
      }
    }
    return false;
  }

  /**
   * Use an invite: the person (new, or existing for a replacement passkey)
   * gets the passkey just checked, and a session on this screen. One step, in
   * the Durable Object, so an invite cannot be used twice.
   */
  async redeemInvite(
    token: string,
    input: { name: unknown; key: StoredKey; label: unknown },
    now: number,
  ): Promise<{ token: string; user: User; space: Space } | Fail> {
    const r = await this.redeem(token, input, now);
    return "error" in r ? r : { ...r, user: shown(r.user) };
  }

  private async redeem(
    token: string,
    input: { name: unknown; key: StoredKey; label: unknown },
    now: number,
  ): Promise<{ token: string; user: StoredUser; space: Space } | Fail> {
    const inv = await this.liveInvite(token, now);
    if (!inv) return fail("this invite has been used or has expired; ask for a new one");
    const space = await this.space(inv.space);
    if (!space) return fail("the family this invite was for is gone");
    if (await this.storage.get(K.passkey(input.key.id))) return fail("that passkey is already registered");

    let user: StoredUser;
    if (inv.user) {
      const existing = await this.storedUser(inv.user);
      if (!existing || !(await this.member(inv.space, inv.user))) return fail("the member this invite was for has been removed");
      user = existing;
    } else {
      const name = cleanName(input.name) || inv.name;
      if (!name) return fail("your name is needed");
      user = { id: newId("u_"), name, createdAt: now };
      await this.storage.put(K.user(user.id), user);
      const member: Member = { space: inv.space, user: user.id, role: inv.role, addedAt: now, addedBy: inv.createdBy };
      await this.storage.put(K.member(inv.space, user.id), member);
    }
    await this.storage.put(K.invite(inv.digest), { ...inv, usedAt: now });
    const label = cleanName(input.label) || "a screen";
    const pk: Passkey = { ...input.key, user: user.id, label, createdAt: now };
    await this.storage.put(K.passkey(pk.id), pk);
    const session = await this.newSession(user.id, inv.space, label, "passkey", now);
    return { token: session, user, space };
  }

  /* ---------- passkeys -------------------------------------------------------- */

  async passkey(id: string): Promise<Passkey | null> {
    return (await this.storage.get<Passkey>(K.passkey(id))) ?? null;
  }

  async passkeysOf(user: string): Promise<Passkey[]> {
    return [...(await this.storage.list<Passkey>({ prefix: "hub:pk:" })).values()].filter((p) => p.user === user);
  }

  /** Another passkey for someone signed in (a second phone, a laptop). */
  async addPasskey(user: string, key: StoredKey, label: unknown, now: number): Promise<Passkey | Fail> {
    if (!(await this.user(user))) return fail("no such person");
    if (await this.storage.get(K.passkey(key.id))) return fail("that passkey is already registered");
    const pk: Passkey = { ...key, user, label: cleanName(label) || "a screen", createdAt: now };
    await this.storage.put(K.passkey(pk.id), pk);
    return pk;
  }

  /** The last one stays: without it, only an admin's invite gets them back in. */
  async removePasskey(user: string, id: string): Promise<true | Fail> {
    const pk = await this.passkey(id);
    if (!pk || pk.user !== user) return fail("not your passkey");
    if ((await this.passkeysOf(user)).length < 2) return fail("that is your only passkey; add another first");
    await this.storage.delete(K.passkey(id));
    return true;
  }

  /** A passkey sign-in that WebAuthn has checked: note its counter, open a session. */
  async signIn(keyId: string, counter: number, label: unknown, now: number): Promise<{ token: string; user: User } | Fail> {
    const pk = await this.passkey(keyId);
    if (!pk) return fail("this passkey is not registered here");
    const found = await this.firstMembership(pk.user);
    if (!found) return fail("this person is no longer a member");
    await this.storage.put(K.passkey(keyId), { ...pk, counter, lastUsedAt: now });
    const token = await this.newSession(pk.user, found.member.space, cleanName(label) || pk.label, "passkey", now);
    return { token, user: found.user };
  }

  private async firstMembership(user: string): Promise<{ user: User; member: Member } | null> {
    const u = await this.user(user);
    if (!u) return null;
    const { space } = await this.meta();
    const m = space ? await this.member(space, user) : null;
    return m ? { user: u, member: m } : null;
  }

  /* ---------- challenges ----------------------------------------------------- */

  async putChallenge(c: Omit<Challenge, "exp">, now: number): Promise<true | Fail> {
    const pending = await this.storage.list<Challenge>({ prefix: "hub:ch:" });
    let live = 0;
    for (const [k, ch] of pending) {
      if (ch.exp < now) await this.storage.delete(k);
      else live++;
    }
    if (live >= MAX_PENDING) return fail("too many sign-ins in progress; try again in a few minutes");
    await this.storage.put(K.challenge(c.challenge), { ...c, exp: now + CHALLENGE_MS });
    return true;
  }

  /** A challenge, once: taking it spends it. */
  async takeChallenge(challenge: string, now: number): Promise<Challenge | null> {
    const key = K.challenge(challenge);
    const c = await this.storage.get<Challenge>(key);
    if (!c) return null;
    await this.storage.delete(key);
    return c.exp < now ? null : c;
  }

  /* ---------- sessions --------------------------------------------------------- */

  private async newSession(user: string, space: string, label: string, via: Session["via"], now: number): Promise<string> {
    const token = mintSecret(SESSION_TOKEN);
    const digest = await sha256Hex(token);
    const s: Session = { id: newId("x_"), digest, user, space, label, via, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_IDLE_MS };
    await this.storage.put(K.session(digest), s);
    return token;
  }

  /** Who a session token belongs to, if it is still good. Sliding: use keeps it alive. */
  async lookupSession(digest: string, now: number): Promise<SignedIn | null> {
    const key = K.session(digest);
    const s = await this.storage.get<Session>(key);
    if (!s) return null;
    if (s.expiresAt < now) {
      await this.storage.delete(key);
      return null;
    }
    const [user, member] = await Promise.all([this.storedUser(s.user), this.member(s.space, s.user)]);
    if (!user || !member) {
      await this.storage.delete(key);
      return null;
    }
    let session = s;
    if (now - s.lastSeenAt > TOUCH_MS) {
      session = { ...s, lastSeenAt: now, expiresAt: now + SESSION_IDLE_MS };
      await this.storage.put(key, session);
    }
    const { digest: _, ...visible } = session;
    // Locked means something only while there is a PIN to open it with.
    const locked = !!session.locked && !!user.pin;
    const space = await this.space(s.space);
    if (!space) return null;
    return {
      session: { ...visible, locked },
      user: { ...shown(user), hasPin: !!user.pin },
      member,
      scopes: scopesOf(member),
      place: { space, first: (await this.firstPerson()) === user.id, prefs: user.prefs ?? {} },
    };
  }

  async sessionsOf(user: string): Promise<Omit<Session, "digest">[]> {
    const all = [...(await this.storage.list<Session>({ prefix: "hub:sess:" })).values()];
    return all
      .filter((s) => s.user === user)
      .map(({ digest: _, ...s }) => s)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** End one session, by its id (from a list) or its digest (signing out). Returns the digest ended. */
  async endSession(user: string, idOrDigest: string): Promise<string | null> {
    for (const [k, s] of await this.storage.list<Session>({ prefix: "hub:sess:" })) {
      if (s.user === user && (s.id === idOrDigest || s.digest === idOrDigest)) {
        await this.storage.delete(k);
        return s.digest;
      }
    }
    return null;
  }

  async endSessionsOf(user: string): Promise<string[]> {
    const ended: string[] = [];
    for (const [k, s] of await this.storage.list<Session>({ prefix: "hub:sess:" })) {
      if (s.user === user) {
        await this.storage.delete(k);
        ended.push(s.digest);
      }
    }
    return ended;
  }

  /* ---------- pairing a screen --------------------------------------------------- */

  /**
   * A screen asks to be signed in: it shows the code, and polls with the
   * token, which only it has. The code alone is useless without a signed-in
   * person approving it.
   */
  async startPairing(label: unknown, now: number): Promise<{ code: string; poll: string; expiresAt: number } | Fail> {
    let live = 0;
    for (const [k, p] of await this.storage.list<Pairing>({ prefix: "hub:pair:" })) {
      if (p.expiresAt < now) {
        await this.storage.delete(k);
        await this.storage.delete(K.pairCode(p.code));
      } else live++;
    }
    if (live >= MAX_PENDING) return fail("too many screens waiting to pair; try again in a few minutes");
    let code = random(CODE_ALPHABET, 6);
    while (await this.storage.get(K.pairCode(code))) code = random(CODE_ALPHABET, 6);
    const poll = mintSecret(POLL_TOKEN);
    const digest = await sha256Hex(poll);
    const p: Pairing = { poll: digest, code, label: cleanName(label) || "a screen", createdAt: now, expiresAt: now + PAIRING_MS };
    await this.storage.put(K.pairing(digest), p);
    await this.storage.put(K.pairCode(code), digest);
    return { code, poll, expiresAt: p.expiresAt };
  }

  /** A signed-in person says yes to a code: the screen becomes theirs (or, from an admin, a member's). */
  async approvePairing(rawCode: unknown, as: { user: string; space: string }, by: string, now: number): Promise<{ label: string } | Fail> {
    const code = typeof rawCode === "string" ? rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const digest = code.length === 6 ? await this.storage.get<string>(K.pairCode(code)) : undefined;
    const p = digest ? await this.storage.get<Pairing>(K.pairing(digest)) : undefined;
    if (!p || p.expiresAt < now) return fail("no screen is showing that code; check it, or start again on the screen");
    if (p.approved) return fail("that screen has already been approved");
    if (!(await this.member(as.space, as.user))) return fail("not a member");
    await this.storage.put(K.pairing(p.poll), { ...p, approved: { ...as, by, at: now } });
    return { label: p.label };
  }

  /** The screen, asking whether it has been approved yet. Once it has, its session is made and the pairing ends. */
  async pollPairing(poll: string, now: number): Promise<{ status: "waiting" } | { status: "expired" } | { status: "approved"; token: string; user: User }> {
    if (!tokenShape(POLL_TOKEN).test(poll)) return { status: "expired" };
    const digest = await sha256Hex(poll);
    const p = await this.storage.get<Pairing>(K.pairing(digest));
    if (!p || p.expiresAt < now) return { status: "expired" };
    if (!p.approved) return { status: "waiting" };
    await this.storage.delete(K.pairing(digest));
    await this.storage.delete(K.pairCode(p.code));
    const user = await this.user(p.approved.user);
    if (!user || !(await this.member(p.approved.space, p.approved.user))) return { status: "expired" };
    const token = await this.newSession(user.id, p.approved.space, p.label, "pairing", now);
    return { status: "approved", token, user };
  }
}

/**
 * What the Worker may call on the Durable Object (through its `hubCall`, one
 * RPC method rather than thirty wrappers). Listed, not discovered: the private
 * helpers — making a session for anyone, say — exist at run time too.
 */
export const HUB_METHODS = [
  "status",
  "space",
  "claim",
  "renameSpace",
  "user",
  "member",
  "members",
  "renameUser",
  "updateMember",
  "removeMember",
  "createInvite",
  "peekInvite",
  "invites",
  "cancelInvite",
  "redeemInvite",
  "passkey",
  "passkeysOf",
  "addPasskey",
  "removePasskey",
  "signIn",
  "putChallenge",
  "takeChallenge",
  "lookupSession",
  "firstPerson",
  "personView",
  "setPrefs",
  "setHaToken",
  "hasHaToken",
  "carsFor",
  "carsView",
  "addCar",
  "updateCar",
  "removeCar",
  "prefsOf",
  "setPin",
  "lockSession",
  "unlockSession",
  "sessionsOf",
  "endSession",
  "endSessionsOf",
  "startPairing",
  "approvePairing",
  "pollPairing",
] as const satisfies readonly (keyof HubHost)[];

export type HubApi = Pick<HubHost, (typeof HUB_METHODS)[number]>;
