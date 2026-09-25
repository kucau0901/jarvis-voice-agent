import type { Env } from "../types";
import { MAX_PAYLOAD, sendPush, type Subscription, type VapidKeys } from "./webpush.ts";

/**
 * How Jarvis reaches you when it speaks first.
 *
 * No one channel reaches everyone. An open Jarvis screen is best — it can say
 * the thing aloud — but screens come and go, and the car's browser tab cannot
 * run in the background at all. So an alert walks an ordered list and stops at
 * the first channel that gets it to you:
 *
 *   live      an open Jarvis screen that is actually being looked at
 *   push      a notification on each device where it was switched on (built in)
 *   telegram  a bot message                               (optional)
 *   ntfy      an ntfy topic, hosted or your own           (optional)
 *   webhook   a signed POST to anything — Node-RED, IFTTT, n8n, your code
 *   homeassistant  a Home Assistant notify service        (optional)
 *
 * Only an OpenAI key is needed for the first two, so a fresh deployment can
 * speak first with nothing else configured. An urgent alert, and the settings
 * panel's Test, go to every channel instead of stopping at the first.
 *
 * Kept free of runtime imports beyond fetch and WebCrypto, so Node tests it.
 */

export const CHANNELS = ["live", "push", "telegram", "ntfy", "webhook", "homeassistant"] as const;
export type Channel = (typeof CHANNELS)[number];
export const DEFAULT_ORDER = CHANNELS.join(",");

export interface Alert {
  id: string;
  at: number;
  title: string;
  text: string;
  /** Meant to be heard, not just read: a screen that can speak says it aloud. */
  speak: boolean;
  /** Every channel, not the first that works. */
  urgent: boolean;
  /** What raised it — shown in the panel, and useful in a webhook. */
  source: "test" | "api" | "note" | "routine";
}

export interface Attempt {
  channel: Channel;
  ok: boolean;
  detail: string;
}

export interface Delivery {
  alert: Alert;
  attempts: Attempt[];
  /** The channel that got it through, or null if none did. */
  deliveredBy: Channel | null;
}

/* ---------- the list ------------------------------------------------------- */

const KNOWN = new Set<string>(CHANNELS);

/** Unknown names and repeats are dropped; nothing usable means the default order. */
export function parseOrder(v: string | undefined): Channel[] {
  const out: Channel[] = [];
  for (const raw of (v ?? "").split(",")) {
    const c = raw.trim().toLowerCase();
    if (KNOWN.has(c) && !out.includes(c as Channel)) out.push(c as Channel);
  }
  return out.length ? out : [...CHANNELS];
}

export function validateOrder(v: string): string | null {
  const names = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return "must name at least one channel";
  for (const n of names) if (!KNOWN.has(n)) return `has "${n}", which is not one of ${DEFAULT_ORDER}`;
  return null;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newAlertId(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(12))) s += ALPHABET[b & 31];
  return s;
}

/** Build an alert from untrusted input, with the limits applied. */
export function makeAlert(
  input: { title?: unknown; text?: unknown; speak?: unknown; urgent?: unknown },
  source: Alert["source"],
  now = Date.now(),
): Alert | null {
  const text = typeof input.text === "string" ? input.text.trim().slice(0, 1500) : "";
  if (!text) return null;
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : "Jarvis";
  return {
    id: newAlertId(),
    at: now,
    title,
    text,
    speak: input.speak !== false,
    urgent: input.urgent === true,
    source,
  };
}

/* ---------- what the Durable Object provides -------------------------------- */

export interface PushTarget extends Subscription {
  id: string;
  /** The site's own address, for the VAPID contact. */
  subject: string;
  label: string;
}

export interface LiveResult {
  /** Screens with Jarvis open. */
  open: number;
  /** Of those, how many are in front of someone. */
  visible: number;
  /** The screen that confirmed it had it, if one did. */
  acked: string | null;
}

/**
 * The Durable Object's side, as an interface: the Worker passes its stub, the
 * object itself passes itself (for routines), the tests pass a fake.
 */
export interface AlertState {
  broadcast(alert: Alert, waitMs: number): Promise<LiveResult>;
  pushTargets(): Promise<{ vapid: VapidKeys; subs: PushTarget[] }>;
  pushResults(results: { id: string; ok: boolean; gone: boolean }[]): Promise<void>;
  logDelivery(d: Delivery): Promise<void>;
}

/** How long a visible screen has to say it got the alert before the next channel is tried. */
export const LIVE_WAIT_MS = 4_000;

/* ---------- delivery ------------------------------------------------------- */

export interface DeliverOptions {
  /** Not to open screens: "send this to my phone", asked from the screen in front of you. */
  skipLive?: boolean;
  /** Every configured channel, reporting each — the panel's Test. */
  every?: boolean;
}

export async function deliver(
  env: Env,
  state: AlertState,
  alert: Alert,
  opts: DeliverOptions = {},
): Promise<Delivery> {
  const every = opts.every || alert.urgent;
  const attempts: Attempt[] = [];
  let deliveredBy: Channel | null = null;

  for (const channel of parseOrder(env.ALERT_ORDER)) {
    if (channel === "live" && opts.skipLive) continue;
    let a: Attempt | null;
    try {
      a = await SEND[channel](env, state, alert);
    } catch (e) {
      a = { channel, ok: false, detail: `failed: ${brief(e instanceof Error ? e.message : String(e))}` };
    }
    if (!a) continue; // not set up
    attempts.push(a);
    if (a.ok && !deliveredBy) deliveredBy = channel;
    if (a.ok && !every) break;
  }

  const d: Delivery = { alert, attempts, deliveredBy };
  await state.logDelivery(d).catch(() => {});
  return d;
}

type Sender = (env: Env, state: AlertState, alert: Alert) => Promise<Attempt | null>;

const timeout = () => AbortSignal.timeout(10_000);

/** An error body can echo what was sent, token and all; keep a little, and no URLs. */
const brief = (s: string) => s.replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").trim().slice(0, 160);

const SEND: Record<Channel, Sender> = {
  async live(_env, state, alert) {
    // Returns as soon as one visible screen confirms, and at once if none is visible.
    const r = await state.broadcast(alert, LIVE_WAIT_MS);
    if (!r.open) return null;
    if (r.acked) return { channel: "live", ok: true, detail: `shown on ${r.acked}` };
    const screens = `${r.open} screen${r.open === 1 ? "" : "s"} open`;
    return {
      channel: "live",
      ok: false,
      detail: r.visible ? `${screens}, none confirmed in time` : `${screens}, none in front of anyone`,
    };
  },

  async push(_env, state, alert) {
    const { vapid, subs } = await state.pushTargets();
    if (!subs.length) return null;
    const payload = pushPayload(alert);
    const results = await Promise.all(
      subs.map(async (s) => {
        try {
          const r = await sendPush(s, payload, vapid, s.subject, {
            urgency: alert.urgent ? "high" : "normal",
            signal: timeout(),
          });
          return { id: s.id, label: s.label, ...r };
        } catch {
          return { id: s.id, label: s.label, ok: false, status: 0, gone: false };
        }
      }),
    );
    await state.pushResults(results.map(({ id, ok, gone }) => ({ id, ok, gone })));
    const ok = results.filter((r) => r.ok);
    const gone = results.filter((r) => r.gone).length;
    const failed = results.filter((r) => !r.ok && !r.gone);
    const parts = [`${ok.length} of ${results.length} device${results.length === 1 ? "" : "s"} accepted`];
    if (gone) parts.push(`${gone} no longer subscribed, removed`);
    if (failed.length) parts.push(`refused: ${failed.map((f) => `${f.label} (${f.status || "no answer"})`).join(", ")}`);
    return { channel: "push", ok: ok.length > 0, detail: parts.join("; ") };
  },

  async telegram(env, _state, alert) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: alert.title === "Jarvis" ? alert.text : `${alert.title}\n\n${alert.text}`,
        disable_notification: false,
      }),
      signal: timeout(),
    });
    if (r.ok) return { channel: "telegram", ok: true, detail: "sent" };
    const why = ((await r.json().catch(() => null)) as { description?: string } | null)?.description ?? "";
    return { channel: "telegram", ok: false, detail: `Telegram answered ${r.status}${why ? `: ${brief(why)}` : ""}` };
  },

  async ntfy(env, _state, alert) {
    if (!env.NTFY_URL) return null;
    // JSON publishing, to the server's root with the topic inside: a title in a
    // header must be ASCII, and a title in the URL ends up in logs.
    const u = new URL(env.NTFY_URL);
    const topic = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!topic || topic.includes("/")) return { channel: "ntfy", ok: false, detail: "the ntfy address must end in a topic name" };
    const r = await fetch(`${u.origin}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        topic,
        title: alert.title,
        message: alert.text,
        priority: alert.urgent ? 5 : 3,
        tags: ["robot"],
      }),
      signal: timeout(),
    });
    await r.body?.cancel().catch(() => {});
    if (r.ok) return { channel: "ntfy", ok: true, detail: "sent" };
    return { channel: "ntfy", ok: false, detail: `ntfy answered ${r.status}${r.status === 401 || r.status === 403 ? " — the topic needs a token" : ""}` };
  },

  async webhook(env, _state, alert) {
    if (!env.ALERT_WEBHOOK_URL) return null;
    const body = JSON.stringify({ event: "alert", ...alert });
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Jarvis-Alerts/1" };
    if (env.ALERT_WEBHOOK_SECRET) headers["x-jarvis-signature"] = `sha256=${await hmacHex(env.ALERT_WEBHOOK_SECRET, body)}`;
    const r = await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers, body, signal: timeout() });
    await r.body?.cancel().catch(() => {});
    return r.ok
      ? { channel: "webhook", ok: true, detail: `accepted (${r.status})` }
      : { channel: "webhook", ok: false, detail: `answered ${r.status}` };
  },

  async homeassistant(env, _state, alert) {
    if (!env.HA_NOTIFY_SERVICE || !env.HA_BASE_URL || !env.HA_TOKEN) return null;
    // The Android Companion app reads a message of exactly "TTS" aloud; any
    // other notify service would just show those three letters, hence opt-in.
    const spoken = env.HA_NOTIFY_SPEAK === "1" && alert.speak;
    const r = await fetch(new URL(`/api/services/notify/${env.HA_NOTIFY_SERVICE}`, env.HA_BASE_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${env.HA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(
        spoken
          ? { message: "TTS", title: alert.title, data: { tts_text: alert.text, ttl: 0, priority: "high" } }
          : { message: alert.text, title: alert.title },
      ),
      signal: timeout(),
    });
    await r.body?.cancel().catch(() => {});
    if (r.ok) return { channel: "homeassistant", ok: true, detail: spoken ? "sent, to be spoken" : "sent" };
    return {
      channel: "homeassistant",
      ok: false,
      detail: `Home Assistant answered ${r.status}${r.status === 400 ? ` — is notify.${env.HA_NOTIFY_SERVICE} right?` : ""}`,
    };
  },
};

/** What the notification carries: enough to show, and the id to fetch the rest. */
export function pushPayload(alert: Alert): string {
  const base = { id: alert.id, title: alert.title, at: alert.at, speak: alert.speak };
  let text = alert.text;
  // Multi-byte text counts in bytes, so trim until it fits rather than guessing.
  while (new TextEncoder().encode(JSON.stringify({ ...base, text })).length > MAX_PAYLOAD) {
    text = text.slice(0, Math.floor(text.length * 0.9)) + "…";
  }
  return JSON.stringify({ ...base, text });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One line per channel, for the panel and for the router's reply. */
export function summarise(d: Delivery): string {
  if (!d.attempts.length) return "Nothing is set up to receive alerts yet.";
  return d.attempts.map((a) => `${a.ok ? "✓" : "✗"} ${a.channel}: ${a.detail}`).join("\n");
}
