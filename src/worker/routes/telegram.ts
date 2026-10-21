import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { safeEqual, whoOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { hubStub, personView } from "../lib/hub-client.ts";
import { OWNER } from "../lib/context.ts";
import { allowedNow } from "../lib/access.ts";
import { localeOf } from "../lib/locale.ts";
import { allows, narrow } from "../lib/scopes.ts";
import { canAsk } from "../lib/openai-auth.ts";
import { asQuotedData } from "../lib/quote.ts";
import * as limits from "../lib/limits.ts";
import { askOptions, readUpdate, sendTelegram, TELEGRAM_REACH, webhookSecret, type Update } from "../lib/telegram.ts";
import { collectWithDeadline, priorTurns, recordTurns, TIMEOUT_TEXT } from "./v1.ts";

/**
 *   POST /api/v1/telegram   Telegram's webhook: a message to the family's bot (lib/telegram.ts)
 *
 * Before the gate (index.ts): Telegram cannot send a key, so its secret
 * header is the proof, checked before anything else is. It is told at once
 * the message arrived, and answered within the half minute a Worker may go on
 * working after that, as the person whose chat it is: their scopes less
 * Hermes and the screen, their hours, a device's limits, and what was said
 * before in this chat as a device's thread. Longer work goes to a job, whose
 * result comes as an alert, Telegram among them. Off unless TELEGRAM_ASK is.
 */

/** How long the answer may take, inside the runtime's half minute: memory is saved before it is cut off. */
const WAIT_S = 20;
const STOP_MS = 27_000;

export async function handleTelegram(req: Request, env: Env, ctx: ExecutionContext, asPerson: (env: Env, p: Principal) => Promise<Env>): Promise<Response> {
  if (env.TELEGRAM_ASK !== "1" || !env.TELEGRAM_BOT_TOKEN) return err(404, "no route here");
  if (req.method !== "POST") return err(405, "POST only");
  const given = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!given || !(await safeEqual(given, await webhookSecret(env)))) return err(401, "not from Telegram");
  const update = readUpdate(await readObject(req, 64 * 1024));
  const state = stateStub(env);
  // Not a person's own message, or Telegram trying one again: taken, and nothing done.
  if (!update || !state || !(await state.telegramSeen(update.id))) return json({ ok: true });
  ctx.waitUntil(answer(env, ctx, update, asPerson).catch((e) => console.warn("telegram:", e instanceof Error ? e.message : String(e))));
  return json({ ok: true });
}

async function answer(env: Env, ctx: ExecutionContext, u: Update, asPerson: (env: Env, p: Principal) => Promise<Env>): Promise<void> {
  const say = (text: string) => sendTelegram(env, u.chat, text);
  // Whose chat: by the number someone gave in Family → You, else the family's own chat setting for the first person.
  let person = (await hubStub(env)?.telegramPerson(u.chat).catch(() => null)) ?? null;
  if (!person && env.TELEGRAM_CHAT_ID === u.chat) person = OWNER;
  const view = person ? await personView(env, person).catch(() => null) : null;
  if (!person || !view?.scopes) {
    await say(`This chat is not linked to anyone in this Jarvis. Its number is ${u.chat}: put it in Family → You → Telegram, then ask again.`);
    return;
  }
  if (!u.text.trim()) {
    await say("Only words for now: send it as text.");
    return;
  }
  const hours = allowedNow(view.access, Date.now(), localeOf(env).timeZone);
  if (!hours.ok) {
    await say(`Not now: ${hours.why}`);
    return;
  }
  const grants = narrow(view.scopes, TELEGRAM_REACH);
  if (!allows(grants, "ask")) {
    await say("You may not ask Jarvis from here.");
    return;
  }
  const verdict = await limits.check(env, `telegram:${person}`);
  if (!verdict.ok) {
    await say(limits.limitMessage(verdict.reason));
    return;
  }
  if (!(await canAsk(env))) {
    await say("Jarvis has no ChatGPT plan or OpenAI key set up, so it cannot answer.");
    return;
  }
  // As the person's own device would: their data, their limits, a thread of its own.
  const principal: Principal = { kind: "device", id: "telegram", name: "Telegram", scopes: grants, ...(person === OWNER ? {} : { owner: person }), ...(view.access ? { access: view.access } : {}) };
  const env2 = await asPerson(env, principal);
  // Forwarded: someone else's words, which the person wants something done about.
  const text = u.forwarded ? `${asQuotedData("forwarded message", u.text, "SOMEONE ELSE")}\nThe user forwarded this.` : u.text;
  const thread = whoOf(principal);
  const turns = [...(await priorTurns(env2, thread)), { role: "user" as const, text }];
  const d = await collectWithDeadline(AbortSignal.timeout(STOP_MS), env2, ctx, turns, grants, WAIT_S, "telegram", askOptions(u));
  if (d.timedOut) {
    await say(`${TIMEOUT_TEXT} Or ask me to do it as a background job, and the result comes here.`);
    return;
  }
  await say(d.result.text || "I could not work out an answer to that.");
  if (d.result.ok) await recordTurns(env2, thread, text, d.result.text);
}
