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

/**
 * Hand a request to the object's own fetch handler: only used to open a live
 * screen's WebSocket, which has to be accepted where the sockets are held.
 */
export function stateFetch(env: Env, req: Request): Promise<Response> {
  const ns = env.STATE;
  if (!ns) return Promise.resolve(new Response(JSON.stringify({ error: "live screens need the STATE Durable Object" }), { status: 503 }));
  return ns.get(ns.idFromName("jarvis")).fetch(req);
}
