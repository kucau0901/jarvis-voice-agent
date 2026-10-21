import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { searchAll } from "../lib/search.ts";

/**
 *   POST /api/hub/search   {q}: Chat's search box (lib/search.ts)
 *
 * A person's own, never a device's (the gate refuses devices everything under
 * /api/hub/). A POST, so what was searched for stays out of addresses and logs.
 */
export async function handleSearch(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (req.method !== "POST") return err(405, "POST only");
  if (!stateStub(env)) return err(503, "search needs the STATE Durable Object");
  const body = await readObject(req, 2048);
  const q = typeof body?.q === "string" ? body.q.trim() : "";
  if (q.length < 2 || q.length > 200) return err(400, "say what to look for: 2 to 200 characters");
  return json(await searchAll(env, grantsOf(principal), personOf(principal), q, Date.now()));
}
