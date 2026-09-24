import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { StateHost } from "./lib/state-host";
import type { Changeset, RefChangeset } from "./lib/memory";
import type { Turn } from "./lib/history";
import type { Changes } from "./lib/settings";

/**
 * The Durable Object. Deliberately thin: everything it does lives in
 * lib/state-host.ts, where Node can test it.
 *
 * SQLite-backed (see the `new_sqlite_classes` migration in wrangler.jsonc),
 * because that is the only kind the Workers free plan allows.
 */
export class JarvisState extends DurableObject<Env> {
  private host: StateHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new StateHost(ctx.storage, env);
    // Nothing is served until memory has been copied out of KV. The KV read is
    // outside I/O, which would otherwise let a second request in half-way.
    ctx.blockConcurrencyWhile(() => this.host.ready());
  }

  loadMemory() {
    return this.host.loadMemory();
  }

  loadReference() {
    return this.host.loadReference();
  }

  applyMemory(cs: Changeset | null, rcs: RefChangeset | null) {
    return this.host.applyMemory(cs, rcs);
  }

  consume(deviceId: string, cap: number, day: string) {
    return this.host.consume(deviceId, cap, day);
  }

  loadThread(key: string) {
    return this.host.loadThread(key);
  }

  appendThread(key: string, turns: Turn[]) {
    return this.host.appendThread(key, turns);
  }

  getSettings() {
    return this.host.getSettings();
  }

  putSettings(changes: Changes) {
    return this.host.putSettings(changes);
  }
}
