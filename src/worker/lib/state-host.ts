import type { Env } from "../types";
import type { Turn } from "./history.ts";
import {
  applyChanges as applySettingChanges,
  type Changes,
  type SavedSettings,
} from "./settings.ts";
import {
  applyChanges,
  applyRefChanges,
  readDoc,
  readRefDoc,
  type Changeset,
  type MemoryDoc,
  type RefChangeset,
  type RefDoc,
} from "./memory.ts";
import { generateVapid, type VapidKeys } from "./webpush.ts";
import { cosine, fromB64, type Near } from "./embeddings.ts";
import type { Alert, Delivery, LiveResult, PushTarget } from "./alerts.ts";
import type { LiveClient } from "./live.ts";
import type { Routine, RoutineInput } from "./routines.ts";
import type { Grant } from "./scopes.ts";

/**
 * Everything behind the one Durable Object, as plain code.
 *
 * Why an object at all: on the Workers free plan, KV allows 1,000 writes a day,
 * and a memory save, a daily device counter and a few caches all spend from it.
 * One busy device could exhaust it, after which memory saves fail silently
 * until 08:00 Malaysia time. KV is also eventually consistent and has no
 * compare-and-swap, so two sessions could still interleave a read and a write.
 * A SQLite-backed Durable Object — the only kind the free plan offers — allows
 * 100,000 rows written a day, and runs one request at a time: a changeset is
 * applied to the current document with nothing able to slip in between.
 *
 * Kept free of `cloudflare:workers` so Node can test it with a Map standing in
 * for storage. src/worker/state.ts is the thin class that hosts it.
 */

/** The part of DurableObjectStorage this uses. */
export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

const MEM = "mem";
const REF = "ref";
/** Present once memory has been copied out of KV. */
const MIGRATED = "migrated:v1";
/** Where memory lived before, kept in KV untouched as a backup. */
const KV_MEM = "mem:v1";
const KV_REF = "mem:ref:v1";

/**
 * The last few exchanges with a device that sends one message at a time.
 *
 * The Even glasses never send a transcript, only the latest thing said, so
 * "turn it off" arrives with nothing for "it" to refer to. Enough turns to
 * resolve that; short enough that a question an hour later starts fresh.
 */
export const THREAD_MAX_TURNS = 6;
export const THREAD_IDLE_MS = 5 * 60_000;
const threadKey = (key: string) => `thread:${key}`;
/** Everything saved in the settings panel (lib/settings.ts). */
const SETTINGS = "settings:v1";

/*
 * Alerts (lib/alerts.ts): the key pair push services know Jarvis by, the
 * devices that turned notifications on, the last few alerts and where each
 * went, and one-time tickets for opening a live socket.
 */
const VAPID = "vapid:v1";
const PUSH = "push:";
const DELIVERIES = "alerts:log";
const TICKET = "ticket:";
/** Long enough to open a socket after asking for one; short enough that a ticket seen in a log is useless. */
export const TICKET_MS = 60_000;
export const DELIVERY_LOG_MAX = 30;
/** Each is one push per alert. Beyond this the least recently working is dropped. */
export const MAX_PUSH_SUBS = 20;
/** In a row. A subscription refused this often is not coming back. */
const PUSH_GIVE_UP = 10;

export interface PushRecord extends PushTarget {
  /** "owner" or the device id that subscribed, so revoking the device ends its notifications. */
  who: string;
  createdAt: number;
  okAt?: number;
  failures: number;
}

/**
 * Meaning vectors, one per fact (lib/embeddings.ts): kept here beside memory
 * and compared here, so a search never ships them anywhere. `h` says which
 * text and model made the vector, so an edited fact is embedded again.
 */
const VEC = "vec:";
interface StoredVec {
  h: string;
  v: string;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const randomId = (n: number) => {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += ALPHABET[b & 31];
  return s;
};
export const TICKET_SHAPE = /^[0-9a-hjkmnp-tv-z]{32}$/;

async function endpointId(endpoint: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ThreadRecord {
  turns: Turn[];
  at: number;
}

export class StateHost {
  private storage: Storage;
  private env: Env;
  private migrating: Promise<void> | null = null;

  constructor(storage: Storage, env: Env) {
    this.storage = storage;
    this.env = env;
  }

  /**
   * Copy memory out of KV, once.
   *
   * If KV cannot be read this THROWS rather than starting empty: an object that
   * began from nothing would be authoritative from then on, and every saved
   * fact would be gone. Failing this request and retrying the next is far
   * cheaper. KV's copy is left where it is, as a backup.
   */
  ready(): Promise<void> {
    this.migrating ??= this.migrate().catch((e) => {
      this.migrating = null;
      throw e;
    });
    return this.migrating;
  }

  private async migrate(): Promise<void> {
    if (await this.storage.get(MIGRATED)) return;
    const [hot, cold] = await Promise.all([
      this.env.CONFIG.get(KV_MEM, "json"),
      this.env.CONFIG.get(KV_REF, "json"),
    ]);
    await this.storage.put(MEM, readDoc(hot));
    await this.storage.put(REF, readRefDoc(cold));
    await this.storage.put(MIGRATED, Date.now());
  }

  async loadMemory(): Promise<MemoryDoc> {
    await this.ready();
    return readDoc(await this.storage.get(MEM));
  }

  async loadReference(): Promise<RefDoc> {
    await this.ready();
    return readRefDoc(await this.storage.get(REF));
  }

  /**
   * Apply a store's changes to memory as it is now, and return the result.
   *
   * Nothing between the read and the write here yields to another request —
   * storage calls do not open a Durable Object's input gate — so this is the
   * compare-and-swap KV never had.
   */
  async applyMemory(
    cs: Changeset | null,
    rcs: RefChangeset | null,
  ): Promise<{ doc?: MemoryDoc; ref?: RefDoc }> {
    await this.ready();
    const out: { doc?: MemoryDoc; ref?: RefDoc } = {};
    if (rcs) {
      out.ref = applyRefChanges(readRefDoc(await this.storage.get(REF)), rcs);
      await this.storage.put(REF, out.ref);
    }
    if (cs) {
      out.doc = applyChanges(readDoc(await this.storage.get(MEM)), cs);
      await this.storage.put(MEM, out.doc);
    }
    return out;
  }

  /**
   * Count one device request against its daily allowance, atomically.
   *
   * Replaces a KV read plus a KV write on EVERY device request — the single
   * biggest spender of the free plan's 1,000 writes. One record per device,
   * reset when the day changes, so nothing accumulates.
   */
  async consume(deviceId: string, cap: number, day: string): Promise<{ ok: boolean; n: number }> {
    const key = `spend:${deviceId}`;
    const rec = await this.storage.get<{ day: string; n: number }>(key);
    const n = rec?.day === day ? rec.n : 0;
    if (n >= cap) return { ok: false, n };
    await this.storage.put(key, { day, n: n + 1 });
    return { ok: true, n: n + 1 };
  }

  /**
   * A device's recent exchanges, or nothing once it has been idle too long.
   *
   * Does not wait on `ready()`: the thread has nothing to do with memory, and a
   * KV hiccup during migration should not cost a follow-up its context.
   */
  async loadThread(key: string, now = Date.now()): Promise<Turn[]> {
    const rec = await this.storage.get<ThreadRecord>(threadKey(key));
    if (!rec || now - rec.at > THREAD_IDLE_MS) return [];
    return rec.turns;
  }

  /**
   * Add turns and keep the newest few, as one read and one write.
   *
   * Atomic for the same reason `consume` is: two answers landing together
   * cannot drop each other's turns. An idle thread is replaced rather than
   * extended, and the record is overwritten in place, so it never grows.
   */
  /**
   * The settings saved in the panel. Not behind `ready()`: settings have
   * nothing to do with memory, and every request reads them.
   */
  async getSettings(): Promise<SavedSettings> {
    return (await this.storage.get<SavedSettings>(SETTINGS)) ?? {};
  }

  /** Apply validated changes atomically, and return the result. */
  async putSettings(changes: Changes, now = Date.now()): Promise<SavedSettings> {
    const next = applySettingChanges(await this.getSettings(), changes, now);
    await this.storage.put(SETTINGS, next);
    return next;
  }

  async appendThread(key: string, turns: Turn[], now = Date.now()): Promise<Turn[]> {
    const rec = await this.storage.get<ThreadRecord>(threadKey(key));
    const prior = rec && now - rec.at <= THREAD_IDLE_MS ? rec.turns : [];
    const next = [...prior, ...turns].slice(-THREAD_MAX_TURNS);
    await this.storage.put(threadKey(key), { turns: next, at: now });
    return next;
  }

  /* ---------- meaning (lib/embeddings.ts) ---------------------------------- */

  /** Which of these facts have no vector, or one made from different text. */
  async vectorsNeeded(items: { id: string; hash: string }[]): Promise<string[]> {
    const have = await this.storage.list<StoredVec>({ prefix: VEC });
    return items.filter((i) => have.get(VEC + i.id)?.h !== i.hash).map((i) => i.id);
  }

  /**
   * Store any new vectors, then rank facts by closeness to the question.
   *
   * `ids` is every fact there is. When the caller read all of memory
   * successfully, `prune` removes the vectors of facts no longer in it; it is
   * off after a failed read, or a storage blip would wipe good vectors.
   */
  async searchVectors(
    query: string,
    put: { id: string; hash: string; v: string }[],
    ids: string[],
    k: number,
    prune: boolean,
  ): Promise<Near[]> {
    for (const p of put) await this.storage.put(VEC + p.id, { h: p.hash, v: p.v } satisfies StoredVec);
    const keep = new Set(ids);
    const q = fromB64(query);
    const out: Near[] = [];
    for (const [key, s] of await this.storage.list<StoredVec>({ prefix: VEC })) {
      const id = key.slice(VEC.length);
      if (!keep.has(id)) {
        if (prune) await this.storage.delete(key);
        continue;
      }
      out.push({ id, score: cosine(q, fromB64(s.v)) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, k)));
  }

  /* ---------- alerts ------------------------------------------------------- */

  /** Made on first use and kept: a new pair would orphan every existing subscription. */
  async vapid(): Promise<VapidKeys> {
    const have = await this.storage.get<VapidKeys>(VAPID);
    if (have) return have;
    const made = await generateVapid();
    await this.storage.put(VAPID, made);
    return made;
  }

  async vapidPublicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  async listPushSubs(): Promise<PushRecord[]> {
    return [...(await this.storage.list<PushRecord>({ prefix: PUSH })).values()];
  }

  /** Subscribing again from the same browser replaces its record rather than adding one. */
  async addPushSub(
    input: Omit<PushRecord, "id" | "createdAt" | "failures" | "okAt">,
    now = Date.now(),
  ): Promise<PushRecord> {
    const id = await endpointId(input.endpoint);
    const all = await this.listPushSubs();
    if (!all.some((s) => s.id === id) && all.length >= MAX_PUSH_SUBS) {
      const stalest = all.sort((a, b) => (a.okAt ?? a.createdAt) - (b.okAt ?? b.createdAt))[0]!;
      await this.storage.delete(PUSH + stalest.id);
    }
    const rec: PushRecord = { ...input, id, createdAt: now, failures: 0 };
    await this.storage.put(PUSH + id, rec);
    return rec;
  }

  /** By id (the panel) or by endpoint (the browser that owns it, turning notifications off). */
  async removePushSub(idOrEndpoint: string): Promise<boolean> {
    const id = idOrEndpoint.startsWith("https:") ? await endpointId(idOrEndpoint) : idOrEndpoint;
    return this.storage.delete(PUSH + id);
  }

  async pushTargets(): Promise<{ vapid: VapidKeys; subs: PushTarget[] }> {
    const subs = await this.listPushSubs();
    if (!subs.length) return { vapid: { publicKey: "", privateJwk: {} }, subs: [] };
    return {
      vapid: await this.vapid(),
      subs: subs.map(({ id, endpoint, p256dh, auth, subject, label }) => ({ id, endpoint, p256dh, auth, subject, label })),
    };
  }

  async pushResults(results: { id: string; ok: boolean; gone: boolean }[], now = Date.now()): Promise<void> {
    for (const r of results) {
      const rec = await this.storage.get<PushRecord>(PUSH + r.id);
      if (!rec) continue;
      if (r.gone || (!r.ok && rec.failures + 1 >= PUSH_GIVE_UP)) {
        await this.storage.delete(PUSH + r.id);
        continue;
      }
      await this.storage.put(PUSH + r.id, r.ok ? { ...rec, okAt: now, failures: 0 } : { ...rec, failures: rec.failures + 1 });
    }
  }

  /** A revoked device stops getting notifications along with everything else. */
  async forgetPushFor(who: string): Promise<number> {
    let n = 0;
    for (const s of await this.listPushSubs()) {
      if (s.who === who && (await this.storage.delete(PUSH + s.id))) n++;
    }
    return n;
  }

  async logDelivery(d: Delivery): Promise<void> {
    const log = (await this.storage.get<Delivery[]>(DELIVERIES)) ?? [];
    await this.storage.put(DELIVERIES, [d, ...log].slice(0, DELIVERY_LOG_MAX));
  }

  async deliveries(): Promise<Delivery[]> {
    return (await this.storage.get<Delivery[]>(DELIVERIES)) ?? [];
  }

  /** For a notification that was tapped: it carries only the id. */
  async findAlert(id: string): Promise<Alert | null> {
    return (await this.deliveries()).find((d) => d.alert.id === id)?.alert ?? null;
  }

  /**
   * A browser cannot put a header on a WebSocket, so it asks for a ticket over
   * an authenticated request and opens the socket with that. Single use, and
   * short-lived, because it travels in a URL.
   */
  async mintTicket(client: Pick<LiveClient, "who" | "label">, now = Date.now()): Promise<string> {
    for (const [k, t] of await this.storage.list<{ exp: number }>({ prefix: TICKET })) {
      if (t.exp < now) await this.storage.delete(k);
    }
    const id = randomId(32);
    await this.storage.put(TICKET + id, { who: client.who, label: client.label, exp: now + TICKET_MS });
    return id;
  }

  async takeTicket(id: string, now = Date.now()): Promise<Pick<LiveClient, "who" | "label"> | null> {
    if (!TICKET_SHAPE.test(id)) return null;
    const t = await this.storage.get<{ who: string; label: string; exp: number }>(TICKET + id);
    if (!t) return null;
    await this.storage.delete(TICKET + id);
    return t.exp >= now ? { who: t.who, label: t.label } : null;
  }
}

/** Routines, which the object runs from its alarm (lib/scheduler.ts, state.ts). */
export interface RoutineApi {
  listRoutines(): Promise<Routine[]>;
  addRoutine(input: RoutineInput, by: { who: string; grants: readonly Grant[] }): Promise<Routine | string>;
  updateRoutine(id: string, patch: { enabled?: boolean; name?: string }): Promise<Routine | string>;
  removeRoutine(id: string): Promise<boolean>;
  runRoutine(id: string): Promise<Routine | string>;
  fireEvent(event: string, data?: string): Promise<string[]>;
}

/** What the object adds itself, because it holds the sockets (state.ts). */
export interface LiveApi {
  broadcast(alert: Alert, waitMs: number): Promise<LiveResult>;
  liveClients(): Promise<LiveClient[]>;
  /** Close a device's open screens and drop its notifications, when it is revoked or narrowed. */
  forgetDevice(who: string): Promise<void>;
}

/** What a Worker can call on the object. */
export type StateApi = Pick<
  StateHost,
  | "loadMemory"
  | "loadReference"
  | "applyMemory"
  | "consume"
  | "loadThread"
  | "appendThread"
  | "getSettings"
  | "putSettings"
  | "vectorsNeeded"
  | "searchVectors"
  | "vapidPublicKey"
  | "listPushSubs"
  | "addPushSub"
  | "removePushSub"
  | "pushTargets"
  | "pushResults"
  | "logDelivery"
  | "deliveries"
  | "findAlert"
  | "mintTicket"
> &
  LiveApi &
  RoutineApi;
