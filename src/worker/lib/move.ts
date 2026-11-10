/**
 * Moving a whole Jarvis to another place: from Cloudflare to Docker, or one
 * server to the next.
 *
 * The new Jarvis pulls, a page at a time, everything the old one keeps: the
 * state object's entries and the settings store's (KV). That includes what
 * nothing else ever gives out: saved secrets, linked accounts' tokens, the
 * owner's ChatGPT plan. So the old one answers only to MOVE_KEY, a secret set
 * at deploy time for the move and removed after it, never to the owner key:
 * whoever holds only that still cannot read a secret (see `guarded()` in
 * lib/settings.ts). It travels server to server; no browser sees a page.
 *
 * Entries are copied as they are, by key, with no idea what each one is, so
 * a feature added later is moved without a line changed here.
 *
 * What the old Jarvis was given at deploy time is in no entry: a Worker's
 * secrets, which Cloudflare shows to nobody. Those that are settings go too,
 * read by the old one from its own environment, and the new one saves them as
 * settings (`deployed()`); its owner key and its bindings stay where they are.
 *
 * Free of `cloudflare:workers`, so Node tests it with Maps standing in.
 */
import { safeEqual } from "./auth.ts";
import { SETTINGS, type SavedSettings } from "./settings.ts";

/** Shorter than this and MOVE_KEY is treated as not set: it guards every secret Jarvis has. */
export const MOVE_KEY_MIN = 24;
/** Entries asked of the state object at once, and about how much of them goes in one page. */
const STATE_LIMIT = 64;
const PAGE_BYTES = 1_000_000;
/** KV values are read one request each, and a Worker on the free plan may make 50. */
const KV_LIMIT = 40;
/** KV refuses an expiry nearer than a minute away. */
const KV_SOONEST_S = 60;

/** What of the state object's storage a move uses. */
export interface MoveStorage {
  get(keys: string[]): Promise<Map<string, unknown>>;
  list(options: { startAfter?: string; limit?: number }): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface KvEntry {
  key: string;
  value: string;
  /** Seconds since 1970, as KV gives it. */
  expiration?: number;
  metadata?: unknown;
}

/** What of the settings store a move uses. */
export interface MoveKv {
  list(options: { cursor?: string; limit?: number }): Promise<{ keys: { name: string; expiration?: number; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expiration?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One page of the old Jarvis. `next` goes back as `after`; null once there is no more. */
export interface MovePage {
  version: string;
  state: [string, unknown][];
  kv: KvEntry[];
  next: string | null;
  /** With the last page: the settings the old Jarvis had from its deployment, by name. */
  settings?: Record<string, string>;
}

/**
 * The settings this Jarvis has from its deployment and nowhere else: set in
 * its environment and never saved in the panel, so no stored entry holds them.
 */
export function deployed(env: Record<string, unknown>, saved: SavedSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of SETTINGS) {
    const v = env[def.name];
    if (typeof v === "string" && v && !saved[def.name]) out[def.name] = v;
  }
  return out;
}

/** Whether `presented` is this Jarvis's move key. Never, where none is set. */
export async function moveKeyOk(env: { MOVE_KEY?: string }, presented: string | null): Promise<boolean> {
  const key = env.MOVE_KEY ?? "";
  if (key.length < MOVE_KEY_MIN || !presented) return false;
  return await safeEqual(presented, key);
}

/** Only what JSON carries unchanged: a page is JSON, and a value it would alter must stop the move, not be moved wrong. */
function carries(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(carries);
  if (typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  // JSON leaves out a property that is undefined, as reading it back would find it.
  return Object.values(v).every((x) => x === undefined || carries(x));
}

/** The state object's side (state.ts passes through to it). */
export class Move {
  private storage: MoveStorage;

  constructor(storage: MoveStorage) {
    this.storage = storage;
  }

  /** Entries after `after`, in key order; `next` is the last one's key while there may be more. */
  async page(after?: string): Promise<{ entries: [string, unknown][]; next: string | null }> {
    const got = [...(await this.storage.list({ ...(after !== undefined ? { startAfter: after } : {}), limit: STATE_LIMIT }))];
    const entries: [string, unknown][] = [];
    let bytes = 0;
    for (const [key, value] of got) {
      if (!carries(value)) throw new Error(`"${key}" holds something a move cannot carry`);
      bytes += JSON.stringify(value).length;
      entries.push([key, value]);
      if (bytes >= PAGE_BYTES) break;
    }
    const more = got.length === STATE_LIMIT || entries.length < got.length;
    return { entries, next: more && entries.length ? entries[entries.length - 1]![0] : null };
  }

  async put(entries: [string, unknown][]): Promise<void> {
    if (entries.length) await this.storage.put(Object.fromEntries(entries));
  }

  /** What is kept here under these keys: for checking a move, never for sending. */
  read(keys: string[]): Promise<Map<string, unknown>> {
    return keys.length ? this.storage.get(keys) : Promise.resolve(new Map());
  }

  /** Whether anything is kept here at all. */
  async holdsAnything(): Promise<boolean> {
    return (await this.storage.list({ limit: 1 })).size > 0;
  }

  async clear(): Promise<void> {
    await this.storage.deleteAll();
  }
}

/** What the old Jarvis's state object is asked (state.ts). */
export interface MoveOutDeps {
  version: string;
  statePage(after?: string): Promise<{ entries: [string, unknown][]; next: string | null }>;
  kv: MoveKv;
  /** `deployed()` of this Jarvis. */
  deployed(): Promise<Record<string, string>>;
}

/**
 * One page out. The state object's entries first, then KV's: `after` is
 * "s:<key>" within the first, "k:<cursor>" within the second.
 */
export async function movePage(deps: MoveOutDeps, after: string | null): Promise<MovePage> {
  if (after === null || after.startsWith("s:")) {
    const { entries, next } = await deps.statePage(after === null ? undefined : after.slice(2));
    return { version: deps.version, state: entries, kv: [], next: next === null ? "k:" : `s:${next}` };
  }
  if (!after.startsWith("k:")) throw new Error("not a place in a move");
  const cursor = after.slice(2);
  const listed = await deps.kv.list({ ...(cursor ? { cursor } : {}), limit: KV_LIMIT });
  const kv: KvEntry[] = [];
  for (const k of listed.keys) {
    const value = await deps.kv.get(k.name);
    // Gone between the listing and the read: it ran out.
    if (value === null) continue;
    kv.push({ key: k.name, value, ...(k.expiration ? { expiration: k.expiration } : {}), ...(k.metadata !== undefined && k.metadata !== null ? { metadata: k.metadata } : {}) });
  }
  const next = listed.list_complete || !listed.cursor ? null : `k:${listed.cursor}`;
  return { version: deps.version, state: [], kv, next, ...(next === null ? { settings: await deps.deployed() } : {}) };
}

/** What the new Jarvis needs to take a page in. */
export interface MoveInDeps {
  /** Fetch one page of the old Jarvis. */
  page(after: string | null): Promise<MovePage>;
  holdsAnything(): Promise<boolean>;
  clear(): Promise<void>;
  put(entries: [string, unknown][]): Promise<void>;
  /**
   * Save what the old Jarvis had from its deployment as settings here, as old
   * as a saved setting can be: a secret among them goes on being sent where
   * the old one sent it, and one saved in the panel since is no older than
   * the address it was saved for (`guarded()` in lib/settings.ts).
   */
  keep(settings: Record<string, string>): Promise<void>;
  /** Once everything is in: wake what is timed, and forget what was read before. */
  settle(): Promise<void>;
  kv: MoveKv;
  now: number;
}

export interface MoveStep {
  /** Entries taken in by this step. */
  state: number;
  kv: number;
  /** What to send as `after` for the next step; null when the move is done. */
  next: string | null;
  /** The old Jarvis's version. */
  version: string;
}

/**
 * One step of a move in: a page fetched and written. The first step (no
 * `after`) refuses a Jarvis that already holds something unless told to
 * replace it, and then empties it first; the last one settles.
 *
 * A step at a time, called again by the page that started it, so no request
 * runs long enough for a proxy to cut it, and each stays within what one
 * request may do.
 */
export async function moveStep(deps: MoveInDeps, after: string | null, replace: boolean): Promise<MoveStep | string> {
  // Asked first: a wrong address or key should fail before anything here is erased.
  const page = await deps.page(after);
  if (after === null) {
    if (await deps.holdsAnything()) {
      if (!replace) return "this Jarvis already holds data: say to replace it, and everything here is erased first";
      await deps.clear();
      for (let cursor: string | undefined; ; ) {
        const listed = await deps.kv.list({ ...(cursor ? { cursor } : {}) });
        for (const k of listed.keys) await deps.kv.delete(k.name);
        if (listed.list_complete || !listed.cursor) break;
        cursor = listed.cursor;
      }
    }
  }
  await deps.put(page.state);
  let kv = 0;
  for (const e of page.kv) {
    // About to run out: not worth carrying, and KV would refuse it.
    if (e.expiration !== undefined && e.expiration < deps.now / 1000 + KV_SOONEST_S) continue;
    await deps.kv.put(e.key, e.value, { ...(e.expiration !== undefined ? { expiration: e.expiration } : {}), ...(e.metadata !== undefined ? { metadata: e.metadata } : {}) });
    kv++;
  }
  // After every entry, the saved settings among them: these are only the names none of those hold.
  if (page.settings && Object.keys(page.settings).length) await deps.keep(page.settings);
  if (page.next === null) await deps.settle();
  return { state: page.state.length, kv, next: page.next, version: page.version };
}

/** What a check needs of the new Jarvis: to read, never to write. */
export interface MoveCheckDeps {
  page(after: string | null): Promise<MovePage>;
  read(keys: string[]): Promise<Map<string, unknown>>;
  saved(): Promise<SavedSettings>;
  kv: Pick<MoveKv, "get">;
  now: number;
}

export interface MoveChecked {
  /** Entries of this page that are here as the old Jarvis has them. */
  same: number;
  /** Names of those that are not here, and of those that are here but differ. Names only, never what they hold. */
  missing: string[];
  differ: string[];
  next: string | null;
  version: string;
}

/**
 * One step of checking a move: a page of the old Jarvis compared with what
 * is here, and nothing written. What the old one went on doing since the move
 * (a conversation, a count, a device last seen) shows as differing; a name
 * missing is what did not arrive.
 */
export async function moveCheck(deps: MoveCheckDeps, after: string | null): Promise<MoveChecked> {
  const page = await deps.page(after);
  const out: MoveChecked = { same: 0, missing: [], differ: [], next: page.next, version: page.version };
  const tell = (name: string, here: unknown, there: unknown) => {
    if (here === undefined || here === null) out.missing.push(name);
    else if (JSON.stringify(here) !== JSON.stringify(there)) out.differ.push(name);
    else out.same++;
  };
  const here = await deps.read(page.state.map(([k]) => k));
  for (const [key, value] of page.state) tell(key, here.get(key), value);
  for (const e of page.kv) {
    // Not carried by a move either: about to run out.
    if (e.expiration !== undefined && e.expiration < deps.now / 1000 + KV_SOONEST_S) continue;
    tell(`store: ${e.key}`, await deps.kv.get(e.key), e.value);
  }
  if (page.settings) {
    const saved = await deps.saved();
    for (const [name, value] of Object.entries(page.settings)) tell(`setting: ${name}`, saved[name]?.v, value);
  }
  return out;
}

/** A page as the old Jarvis sent it, or null if it is not one. */
export function asMovePage(v: unknown): MovePage | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<MovePage>;
  if (typeof p.version !== "string" || !Array.isArray(p.state) || !Array.isArray(p.kv)) return null;
  if (p.next !== null && typeof p.next !== "string") return null;
  if (!p.state.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string")) return null;
  if (!p.kv.every((e) => e && typeof e === "object" && typeof e.key === "string" && typeof e.value === "string")) return null;
  const settings: unknown = p.settings;
  if (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings) || !Object.values(settings).every((x) => typeof x === "string"))) return null;
  return { version: p.version, state: p.state, kv: p.kv, next: p.next, ...(settings !== undefined ? { settings: settings as Record<string, string> } : {}) };
}
