import type { Env } from "../types.ts";
import { err, json, publicOrigin, readObject, readObjectOrEmpty } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";
import { looksLikeToken, sha256Hex } from "../lib/devices.ts";
import { deliver, type Alert, type AlertState } from "../lib/alerts.ts";
import { ADDRESS_PREFIX, BOT_REACH, botGrants, REPLY_PREFIX, skillAlert } from "../lib/skills.ts";
import { credentialOf, personOf, type Principal } from "../lib/auth.ts";
import { personView } from "../lib/hub-client.ts";
import { allowedNow } from "../lib/access.ts";
import { localeOf } from "../lib/locale.ts";
import { allows } from "../lib/scopes.ts";
import { OWNER } from "../lib/context.ts";
import * as limits from "../lib/limits.ts";
import { handleAsk, handleChatCompletions, handleMcp } from "./v1.ts";

/**
 * Settings → Skills (lib/skills.ts), for the owner key and admins:
 *   GET    /api/skills          {skills, reach}: each with hasKey, never the key; what an address may be ticked to reach
 *   PUT    /api/skills          {id, key}: its key, never shown again
 *   PATCH  /api/skills          {id, address: true, reach?}: an address of its own for its bot, as whoever makes it,
 *                               its token shown once; {id, address: false}: stopped; {id, reach}: ticked again
 *   DELETE /api/skills?id=      one removed, with its key and its address
 *
 * Added and changed by asking Jarvis (tools/skills.ts), never here: what a
 * skill is for is the person's own words.
 */
export async function handleSkills(req: Request, env: Env, principal: Principal): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "skills need the STATE Durable Object");
  if (req.method === "GET") return json({ skills: await state.skillsList(), reach: BOT_REACH });
  if (req.method === "PUT") {
    const body = await readObjectOrEmpty(req);
    if (typeof body.id !== "string") return err(400, "id is required");
    // Where Jarvis is reached from, kept with the key: its reply addresses point there (tools/skills.ts askSkill).
    const s = await state.skillKey(body.id, body.key, Date.now(), publicOrigin(env, new URL(req.url).origin));
    return typeof s === "string" ? err(400, s) : json({ skill: s });
  }
  if (req.method === "PATCH") {
    const body = await readObjectOrEmpty(req);
    if (typeof body.id !== "string") return err(400, "id is required");
    const now = Date.now();
    if (body.address === true) {
      // Its bot asks as, and messages, whoever made it: the owner key's is the first person's.
      const made = await state.skillNewAddress(body.id, personOf(principal), body.reach, now);
      if (typeof made === "string") return err(400, made);
      const base = `${publicOrigin(env, new URL(req.url).origin)}/api/v1/bot`;
      return json({ skill: made.skill, token: made.token, base, url: `${base}/${made.token}` }, { status: 201 });
    }
    const s = body.address === false ? await state.skillDropAddress(body.id, now) : await state.skillReach(body.id, body.reach, now);
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
/** What a bot's own address serves, after it: itself, asking (as /api/v1/ask), MCP, and the OpenAI chat API. */
const SERVED = new Set(["", "ask", "mcp", "chat/completions"]);
const nowhere = () => err(404, "no such address");

/**
 *   POST /api/v1/bot/<jrp1_…>   {text, title?, speak?, expiresAt?}: a skill's answer to one request
 *   /api/v1/bot[/<jbt1_…>][/ask|/mcp|/chat/completions]   a skill's bot's own address
 *   POST /api/v1/bot[/<jbt1_…>]  {text, title?, speak?, expiresAt?}: a message of its own, to whoever made it
 *
 * Before the gate (index.ts), as a page's link is: the address is the proof.
 * Each request Jarvis sends a skill carries one (replyUrl), made for it; it
 * only ever writes, under the skill's name, to whoever asked, for a day and a
 * few answers (lib/skills.ts Skills.answer), so a bot answers later with no
 * token of Jarvis's. Every refusal of an address is the same 404. Answered
 * as POST /api/v1/notify is: where it went; or 202, held until Jarvis's own
 * reply to the question is in Chat (SETTLE_MS at most), so it shows after it.
 *
 * A bot's own address (Settings → Skills → Make its address), in the path or
 * as its Bearer credential, asks Jarvis as the person who made it, as a
 * device of theirs would: their hours, a device's limits, and no further
 * than what was ticked for it and they may now (lib/skills.ts botGrants),
 * which never holds `skills`. GET says whose address it is. A message of its
 * own (its routines' news) goes to them under its name, as an answer does,
 * held for their quiet hours as any alert is.
 */
export async function handleBot(req: Request, env: Env, ctx: ExecutionContext, asPerson: (env: Env, p: Principal) => Promise<Env>): Promise<Response> {
  const parts = new URL(req.url).pathname.slice("/api/v1/bot".length).split("/").filter(Boolean);
  if (parts[0]?.startsWith(REPLY_PREFIX)) return answered(req, env, parts);
  const inPath = parts[0]?.startsWith(ADDRESS_PREFIX) ? parts.shift()! : "";
  const token = inPath || credentialOf(req);
  const sub = parts.join("/");
  // Its shape first: nothing malformed reaches storage.
  if (!looksLikeToken(token, ADDRESS_PREFIX) || !SERVED.has(sub)) return nowhere();
  const state = stateStub(env);
  if (!state) return nowhere();
  const bot = await state.skillByAddress(await sha256Hex(token));
  // Whoever made it has left: it went with them.
  const view = bot ? await personView(env, bot.person).catch(() => null) : null;
  if (!bot || !view?.scopes) return nowhere();
  if (req.method === "GET" && !sub) return json({ ok: true, name: bot.name });
  if (req.method !== "POST") return err(405, "POST only");
  // A device's allowance, the bot's own, as the gate counts one (index.ts).
  const verdict = await limits.check(env, `b_${bot.id}`);
  if (!verdict.ok) {
    const headers = new Headers({ "content-type": "application/json" });
    if (verdict.retryAfter) headers.set("retry-after", String(verdict.retryAfter));
    return new Response(JSON.stringify({ ok: false, error: verdict.reason, text: limits.limitMessage(verdict.reason) }), { status: 429, headers });
  }
  if (!verdict.counted) ctx.waitUntil(limits.charge(env, `b_${bot.id}`));
  if (!sub) {
    // A message of its own, to whoever made its address: under its name, as an answer is (lib/skills.ts skillAlert).
    const b = await readObject(req, MAX_BODY);
    if (!b) return err(400, "body must be a small JSON object");
    const alert = skillAlert(bot, b, Date.now(), bot.person);
    if (!alert) return err(400, "text is required");
    return delivered(env, state, alert);
  }
  const hours = allowedNow(view.access, Date.now(), localeOf(env).timeZone);
  if (!hours.ok) return json({ error: hours.why, text: `Not now: ${hours.why}.`, outside: true }, { status: 403 });
  const grants = botGrants(bot.reach, view.scopes);
  if (!allows(grants, "ask")) return err(403, `${bot.name} may not ask Jarvis: tick it in Settings → Skills`, { need: "ask" });
  // As a device of theirs: their data, their memory as far as it was ticked, a thread of its own (routes/v1.ts botOf).
  const principal: Principal = {
    kind: "device",
    id: `b_${bot.id}`,
    name: bot.name,
    scopes: grants,
    skill: bot.id,
    ...(bot.person === OWNER ? {} : { owner: bot.person }),
    ...(view.access ? { access: view.access } : {}),
  };
  const env2 = await asPerson(env, principal);
  if (sub === "ask") return handleAsk(req, env2, ctx, grants, principal);
  if (sub === "mcp") return handleMcp(req, env2, ctx, grants, principal);
  return handleChatCompletions(req, env2, ctx, grants, principal);
}

/** A skill's answer at its request's reply address. */
async function answered(req: Request, env: Env, parts: string[]): Promise<Response> {
  const token = parts.length === 1 ? parts[0]! : "";
  // Its shape first: nothing malformed reaches storage.
  if (!looksLikeToken(token, REPLY_PREFIX)) return nowhere();
  if (req.method !== "POST") return err(405, "POST only");
  const state = stateStub(env);
  if (!state) return nowhere();
  const b = await readObject(req, MAX_BODY);
  if (!b) return err(400, "body must be a small JSON object");
  const r = await state.skillAnswer(await sha256Hex(token), b, Date.now());
  if ("refused" in r) return err(r.refused, r.why);
  if (r.holdUntil) {
    // Before Jarvis's own reply to the question: kept until that is in Chat (state.ts conversationAdd), so it shows after it.
    await state.hold(r.alert, r.holdUntil, true);
    return json({ ok: true, id: r.alert.id, heldUntil: r.holdUntil }, { status: 202 });
  }
  return delivered(env, state, r.alert);
}

/** Delivered, said as POST /api/v1/notify says it: where it went, or 202 held for its person's quiet hours. */
async function delivered(env: Env, state: AlertState, alert: Alert): Promise<Response> {
  const d = await deliver(env, state, alert);
  if (d.heldUntil) return json({ ok: true, id: alert.id, heldUntil: d.heldUntil }, { status: 202 });
  return json({ ok: true, id: alert.id, deliveredBy: d.deliveredBy, attempts: d.attempts }, { status: d.deliveredBy ? 200 : 502 });
}
