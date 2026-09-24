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
>;
