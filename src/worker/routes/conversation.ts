import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { asSaid, MAX_POSTED, MAX_TEXT, type Said } from "../lib/conversation.ts";

/**
 * Your conversation with Jarvis, kept (lib/conversation.ts): each person's
 * own, never a device's (the gate refuses devices everything under /api/hub/).
 *
 *   GET    /api/hub/conversation   {said}: yours, oldest first
 *   POST   /api/hub/conversation   {said: [{id, role, text, files?, replyTo?}]}: what was just said
 *   DELETE /api/hub/conversation   emptied, on every screen of yours
 */

const MAX_BODY = MAX_POSTED * (MAX_TEXT + 1024) * 2;

export async function handleConversation(req: Request, env: Env, principal: Principal): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "the conversation needs the STATE Durable Object");
  const me = personOf(principal);
  const now = Date.now();
  if (req.method === "GET") return json({ said: await state.conversationOf(me, now) });
  if (req.method === "DELETE") {
    await state.conversationClear(me);
    return json({ ok: true });
  }
  if (req.method !== "POST") return err(405, "method not allowed");
  const body = await readObject(req, MAX_BODY);
  if (!body || !Array.isArray(body.said) || body.said.length > MAX_POSTED) return err(400, `expected {said: [up to ${MAX_POSTED} messages]}`);
  const said = body.said.map((s) => asSaid(s, now)).filter((s): s is Said => !!s);
  await state.conversationAdd(me, said, now);
  return json({ kept: said.length });
}
