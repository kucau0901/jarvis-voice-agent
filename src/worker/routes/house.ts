import type { Env } from "../types.ts";
import { isAdmin, personOf, type Principal } from "../lib/auth.ts";
import { err, json, readObject } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";
import { haConfig } from "../lib/ha.ts";
import { parseBatch } from "../lib/house.ts";

/**
 * Jarvis's component in Home Assistant (the jarvis-home-assistant repository), pushing what changes in the house
 * (lib/house.ts). Both need the `home` scope, and are the house's: the owner key, an admin, or the first person's
 * devices, as house-wide events are (routes/routines.ts /api/v1/trigger). A member's device could otherwise tell
 * Jarvis the front door opened.
 *
 *   GET  /api/v1/house/watch    {version, entities}: the things Jarvis watches, which the component listens to
 *   POST /api/v1/house/events   {changes: [{id, from, to}]}: what changed, in a batch; → {version, changed}, the
 *                               watch list's version, to ask again when it moved, and how many were changes to Jarvis
 */

const MAX_BODY = 32 * 1024;

export async function handleHouse(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/v1/house/watch" && p !== "/api/v1/house/events") return null;
  if (!isAdmin(principal) && !(principal.kind === "device" && personOf(principal) === "owner")) {
    return err(403, "the house's changes come from the owner's devices or an admin's");
  }
  if (!haConfig(env)) return err(404, "Home Assistant is not set up here");
  const state = stateStub(env);
  if (!state) return err(503, "the house needs the STATE Durable Object");

  if (p === "/api/v1/house/watch") {
    if (req.method !== "GET") return err(405, "GET only");
    const w = await state.houseWatchList(Date.now());
    return typeof w === "string" ? err(502, w) : json(w);
  }
  if (req.method !== "POST") return err(405, "POST only");
  const batch = parseBatch(await readObject(req, MAX_BODY));
  if (!batch) return err(400, "send {changes: [{id, from, to}]}");
  return json(await state.houseEvents(batch, Date.now()));
}
