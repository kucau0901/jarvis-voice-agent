import type { Env } from "../types.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { err, json, readObject } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";

/**
 * A person's places, for their phone to watch (lib/spots.ts). Each caller's
 * own, with the `routines` scope: a place is only what a routine is set off
 * at, by "arrived:<slug>" or "left:<slug>" sent to /api/v1/trigger.
 *
 *   GET    /api/v1/places          {places: [{slug, name, lat, lng, radius, at}]}
 *   POST   /api/v1/places          {name, lat, lng, radius?}: keep one, or move the one of that name → {place}
 *   DELETE /api/v1/places?slug=    remove one
 */

const MAX_BODY = 4 * 1024;

export async function handleSpots(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  if (url.pathname !== "/api/v1/places") return null;
  const state = stateStub(env);
  if (!state) return err(503, "places need the STATE Durable Object");
  const person = personOf(principal);

  if (req.method === "GET") return json({ places: await state.spotsList(person) });
  if (req.method === "POST") {
    const b = await readObject(req, MAX_BODY);
    if (!b) return err(400, "send {name, lat, lng, radius?}");
    const kept = await state.spotSave(person, { name: b.name, lat: b.lat, lng: b.lng, radius: b.radius });
    return typeof kept === "string" ? err(400, kept) : json({ place: kept });
  }
  if (req.method === "DELETE") {
    const slug = url.searchParams.get("slug") ?? "";
    return (await state.spotRemove(person, slug)) ? json({ ok: true }) : err(404, "no such place");
  }
  return err(405, "GET, POST or DELETE");
}
