import type { Env } from "../types.ts";
import { err, json, publicOrigin, readObject, readObjectOrEmpty } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";
import { looksLikeToken, sha256Hex } from "../lib/devices.ts";
import { deliver } from "../lib/alerts.ts";
import { REPLY_PREFIX } from "../lib/skills.ts";

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
    // Where Jarvis is reached from, kept with the key: its reply addresses point there (tools/skills.ts askSkill).
    const s = await state.skillKey(body.id, body.key, Date.now(), publicOrigin(env, new URL(req.url).origin));
    return typeof s === "string" ? err(400, s) : json({ skill: s });
  }
  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    return (await state.skillRemove(id)) ? json({ ok: true }) : err(404, "no such skill");
  }
  return err(405, "method not allowed");
}

/** As much of an answer as is read: its words are cut to an alert's 1,500 anyway. */
const MAX_BODY = 16 * 1024;

/**
 *   POST /api/v1/bot/<jrp1_…>   {text, title?, speak?, expiresAt?}: a skill's answer to one request
 *
 * Before the gate (index.ts), as a page's link is: the address is the proof.
 * Each request Jarvis sends a skill carries one (replyUrl), made for it; it
 * only ever writes, under the skill's name, to whoever asked, for a day and a
 * few answers (lib/skills.ts Skills.answer), so a bot answers later with no
 * token of Jarvis's. Every refusal of the address is the same 404. Answered
 * as POST /api/v1/notify is: where it went.
 */
export async function handleBot(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).pathname.slice("/api/v1/bot/".length);
  // Its shape first: nothing malformed reaches storage.
  if (!looksLikeToken(token, REPLY_PREFIX)) return err(404, "no such address");
  if (req.method !== "POST") return err(405, "POST only");
  const state = stateStub(env);
  if (!state) return err(404, "no such address");
  const b = await readObject(req, MAX_BODY);
  if (!b) return err(400, "body must be a small JSON object");
  const r = await state.skillAnswer(await sha256Hex(token), b, Date.now());
  if ("refused" in r) return err(r.refused, r.why);
  const d = await deliver(env, state, r.alert);
  return json({ ok: true, id: r.alert.id, deliveredBy: d.deliveredBy, attempts: d.attempts }, { status: d.deliveredBy ? 200 : 502 });
}
