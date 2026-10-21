import type { Env } from "../types.ts";
import { sha256Hex } from "./devices.ts";
import { SCOPES, type Grant } from "./scopes.ts";

/**
 * Asking Jarvis by Telegram (routes/telegram.ts): the family's bot, which
 * already sends alerts (lib/alerts.ts), now answers too, as Hark is to answer
 * by text message. Telegram posts each message to TELEGRAM_PATH, under
 * /api/v1/ so Cloudflare Access lets it through; it cannot send a key, so
 * the proof is the secret token Telegram puts on every update, which is made
 * from the owner key and the bot's token together: the bot's token alone
 * cannot forge one.
 */

export const TELEGRAM_PATH = "/api/v1/telegram";
/** As much of a reply as one Telegram message holds. */
const MAX_REPLY = 4096;
const MAX_TEXT = 4000;

/**
 * What a message from Telegram may reach: the person's own, less Hermes
 * (never granted by default, and a Telegram account is easier to take than a
 * passkey) and the screen (there is none).
 */
export const TELEGRAM_REACH: readonly Grant[] = SCOPES.filter((s) => s !== "hermes" && s !== "screen");

/** The secret Telegram is told to send with each update, and checked against. 64 hex characters, as Telegram allows. */
export const webhookSecret = (env: Pick<Env, "JARVIS_SHARED_SECRET" | "TELEGRAM_BOT_TOKEN">): Promise<string> =>
  sha256Hex(`telegram-webhook\n${env.JARVIS_SHARED_SECRET ?? ""}\n${env.TELEGRAM_BOT_TOKEN ?? ""}`);

export interface Update {
  id: number;
  /** The private chat it came from: the person's own chat number. */
  chat: string;
  text: string;
  /** Forwarded from someone else: their words, not the person's. */
  forwarded: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/**
 * A message someone sent the bot in their own private chat; null for
 * anything else. Groups, channels, edits, buttons and other bots are never
 * taken: in a group anyone could speak for whoever gave its number.
 */
export function readUpdate(body: unknown): Update | null {
  if (!isObj(body) || typeof body.update_id !== "number" || !isObj(body.message)) return null;
  const m = body.message;
  const chat = isObj(m.chat) ? m.chat : null;
  const from = isObj(m.from) ? m.from : null;
  if (!chat || !from || chat.type !== "private" || typeof chat.id !== "number" || from.id !== chat.id || from.is_bot === true) return null;
  return {
    id: body.update_id,
    chat: String(chat.id),
    text: typeof m.text === "string" ? m.text.slice(0, MAX_TEXT) : "",
    forwarded: "forward_origin" in m || "forward_from" in m || "forward_date" in m,
  };
}

/**
 * How a message is asked. The person's own words may go to Home
 * Assistant's Assist first, and alone may save a specialty (ownWords() in
 * lib/router.ts); a forwarded message is someone else's words, so neither.
 */
export const askOptions = (u: Pick<Update, "forwarded">) => ({
  assist: !u.forwarded,
  ...(u.forwarded ? { assistAsk: "" } : {}),
  origin: { id: "telegram", label: "Telegram" },
});

/** A message to a chat, plain text (no markup for an answer to break), cut to what Telegram holds; why not, when it was not sent. */
export async function sendTelegram(env: Pick<Env, "TELEGRAM_BOT_TOKEN">, chat: string, text: string, signal = AbortSignal.timeout(10_000)): Promise<string | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return "no bot token is set";
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: text.slice(0, MAX_REPLY), disable_notification: false }),
    signal,
  });
  if (r.ok) return null;
  const why = ((await r.json().catch(() => null)) as { description?: string } | null)?.description ?? "";
  return `Telegram answered ${r.status}${why ? `: ${why.slice(0, 200)}` : ""}`;
}

/** Telegram told to post this bot's messages to `url`, with the secret; why not, when it would not. */
export async function setWebhook(env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "JARVIS_SHARED_SECRET">, url: string): Promise<string | null> {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, secret_token: await webhookSecret(env), allowed_updates: ["message"], drop_pending_updates: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => e as Error);
  if (r instanceof Error) return r.message;
  const b = (await r.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  return r.ok && b?.ok ? null : `Telegram said: ${b?.description ?? r.status}`;
}

/** Telegram told to stop posting this bot's messages here. */
export async function deleteWebhook(token: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

/** Whether Telegram is sending this bot's messages here, for Settings → Alerts' test: one line. */
export async function webhookSaid(env: Pick<Env, "TELEGRAM_BOT_TOKEN">, url: string): Promise<string> {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const info = ((await r?.json().catch(() => null)) as { result?: { url?: string; last_error_message?: string } } | null)?.result;
  if (!info) return "Asking on Telegram: Telegram could not be asked how it is set up.";
  if (info.url !== url) return "Asking on Telegram: the bot is not sending its messages here; choose on for Ask Jarvis on Telegram and save.";
  return info.last_error_message ? `Asking on Telegram: set up, but Telegram last said: ${info.last_error_message.slice(0, 160)}` : "Asking on Telegram: set up.";
}
