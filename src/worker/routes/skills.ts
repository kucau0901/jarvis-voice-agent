import type { Env } from "../types.ts";
import { err, json, readObjectOrEmpty } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";

/**
 * Settings → Skills (lib/skills.ts), for the owner key and admins:
 *   GET    /api/skills          {skills}: each with hasKey, never the key
 *   PUT    /api/skills          {id, key}: its key, never shown again
 *   DELETE /api/skills?id=      one removed, with its key
 *
 * Added and changed by asking Jarvis (tools/skills.ts), never here: what a
 * skill is for is the person's own words.
 */
export async function handleSkills(req: Request, env: Env): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "skills need the STATE Durable Object");
  if (req.method === "GET") return json({ skills: await state.skillsList() });
  if (req.method === "PUT") {
    const body = await readObjectOrEmpty(req);
    if (typeof body.id !== "string") return err(400, "id is required");
    const s = await state.skillKey(body.id, body.key, Date.now());
    return typeof s === "string" ? err(400, s) : json({ skill: s });
  }
  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    return (await state.skillRemove(id)) ? json({ ok: true }) : err(404, "no such skill");
  }
  return err(405, "method not allowed");
}
