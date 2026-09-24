import type { Env } from "../types";
import type { StateApi } from "./state-host.ts";

/**
 * The one Durable Object holding state that must not be lost to a race:
 * memory and the daily device counter. One instance, by a fixed name, so
 * every Worker everywhere reaches the same object.
 *
 * Null where the binding is absent — the Node tests, and any deployment
 * without it — and callers fall back to KV.
 */
export function stateStub(env: Env): StateApi | null {
  const ns = env.STATE;
  if (!ns) return null;
  return ns.get(ns.idFromName("jarvis")) as unknown as StateApi;
}
