import { authHeaders } from "./key";
import { routeElement } from "./loud";

/**
 * This screen's end of alerts: a live socket to the Worker while the page is
 * open, and notifications for when it is not.
 *
 * The socket costs nothing while quiet — the Durable Object on the other end
 * hibernates — and it is how an alert reaches the car without a GPT-Live
 * session being open. Speaking the alert is the caller's business (main.ts):
 * through the session if one happens to be open, otherwise as a short clip.
 */

export interface Alert {
  id: string;
  at: number;
  title: string;
  text: string;
  speak: boolean;
  urgent: boolean;
  source: string;
}

/** What this screen is called in "shown on …" and in the list of devices. */
export function screenLabel(): string {
  const ua = navigator.userAgent;
  if (/Tesla/i.test(ua)) return "the car";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return matchMedia("(min-width: 700px)").matches ? "Android tablet" : "Android phone";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Linux/i.test(ua)) return "Linux computer";
  return "a browser";
}

const ORIGIN_KEY = "jarvis.origin";

/**
 * This screen, for the conversation shared across the user's devices
 * (src/worker/lib/shared.ts): a random id made once and kept, and the label
 * the model hears it by ("the car", "iPhone").
 */
export function originHere(): { id: string; label: string } {
  let id = "";
  try {
    id = localStorage.getItem(ORIGIN_KEY) ?? "";
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      id = `s_${crypto.getRandomValues(new Uint32Array(3)).reduce((a, n) => a + n.toString(36), "")}`;
      localStorage.setItem(ORIGIN_KEY, id);
    }
  } catch {
    // private mode: one id for this page's life
    id ||= `s_${Math.random().toString(36).slice(2, 14)}`;
  }
  return { id, label: screenLabel() };
}

const BACKOFF_S = [1, 2, 5, 10, 30, 60];
/** Under the idle timeouts of the proxies in between. The runtime answers without waking anything. */
const PING_MS = 25_000;

export class LiveLink {
  private key: string;
  private onAlert: (a: Alert) => void;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private stopped = true;

  constructor(key: string, onAlert: (a: Alert) => void) {
    this.key = key;
    this.onAlert = onAlert;
    addEventListener("visibilitychange", () => this.presence());
    addEventListener("online", () => {
      if (!this.stopped && !this.ws) {
        this.attempt = 0;
        void this.connect();
      }
    });
  }

  start(key = this.key): void {
    this.key = key;
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close(1000, "stopped");
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ws) return;
    let ticket: string;
    try {
      const r = await fetch("/api/v1/events/ticket", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ label: screenLabel() }),
      });
      // A key without the alerts scope, or no key at all: nothing to retry.
      if (r.status === 401 || r.status === 403) {
        this.stopped = true;
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      ticket = ((await r.json()) as { ticket: string }).ticket;
    } catch {
      this.again();
      return;
    }

    const url = new URL("/api/v1/events", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.presence();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS) as unknown as number;
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      let msg: { type?: string; alert?: Alert };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type !== "alert" || !msg.alert) return;
      // Confirm only if someone can see it: a hidden tab saying "got it" would
      // stop the alert reaching the phone in your pocket.
      const visible = document.visibilityState === "visible";
      ws.send(JSON.stringify({ type: "ack", id: msg.alert.id, visible }));
      this.onAlert(msg.alert);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      // 4001: this device was revoked. Anything else is the network.
      if (e.code === 4001) this.stopped = true;
      if (!this.stopped) this.again();
    };
  }

  private again(): void {
    if (this.stopped) return;
    const wait = BACKOFF_S[Math.min(this.attempt++, BACKOFF_S.length - 1)]! * 1000;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), wait) as unknown as number;
  }

  private presence(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "presence", visible: document.visibilityState === "visible" }));
  }
}

/* ---------- notifications ---------------------------------------------------- */

export type PushState = "on" | "off" | "blocked" | "unsupported" | "needs-install";

const isIos = () => /iPhone|iPad/i.test(navigator.userAgent);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    // iOS only offers push to a web app added to the Home Screen.
    return isIos() && !standalone() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/** Ask permission, subscribe, and register this browser with Jarvis. Must run inside a tap. */
export async function enablePush(key: string): Promise<void> {
  const state = await pushState();
  if (state === "needs-install") throw new Error("On iPhone and iPad, add Jarvis to the Home Screen first (Share → Add to Home Screen), open it from there, and turn notifications on in its settings.");
  if (state === "unsupported") throw new Error("This browser cannot receive notifications.");
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.");
  }
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch("/api/v1/push", { headers: authHeaders(key) });
  if (!res.ok) throw new Error(res.status === 403 ? "This key is not allowed to receive alerts." : `server said ${res.status}`);
  const serverKey = fromB64url(((await res.json()) as { publicKey: string }).publicKey);

  let sub = await reg.pushManager.getSubscription();
  // Made against a different key (a new deployment): it would never deliver.
  if (sub && !sameKey(sub.options.applicationServerKey, serverKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });

  const r = await fetch("/api/v1/push", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({ subscription: sub.toJSON(), label: screenLabel() }),
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `server said ${r.status}`);
}

/**
 * Tell Jarvis again about this browser's notifications, if they are on. Run
 * whenever Jarvis opens; prompts for nothing.
 *
 * A push service may replace a subscription, and Jarvis drops one a push
 * service reports gone. Either way the browser still believed notifications
 * were on while Jarvis no longer had it, and alerts stopped without a word.
 * If the owner removed this browser in Settings → Alerts, Jarvis says so (409)
 * and it is unsubscribed here too, so this screen shows notifications off.
 */
export async function syncPush(key: string): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.getRegistration();
    let sub = await reg?.pushManager.getSubscription();
    if (!reg || !sub) return;
    const res = await fetch("/api/v1/push", { headers: authHeaders(key) });
    if (!res.ok) return;
    const serverKey = fromB64url(((await res.json()) as { publicKey: string }).publicKey);
    // Made against a different key (a new deployment): it would never deliver.
    if (!sameKey(sub.options.applicationServerKey, serverKey)) {
      await sub.unsubscribe();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
    }
    const r = await fetch("/api/v1/push", {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ subscription: sub.toJSON(), label: screenLabel(), resync: true }),
    });
    if (r.status === 409) await sub.unsubscribe();
  } catch {
    // offline, or no push here: the next time Jarvis opens
  }
}

export async function disablePush(key: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/v1/push", {
    method: "DELETE",
    headers: authHeaders(key),
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe();
}

/* ---------- speaking one ---------------------------------------------------- */

const SPEAK_PREF = "jarvis.speakAlerts";

/** Per screen: the car may want alerts aloud, a desk may not. On unless turned off. */
export function speakHere(): boolean {
  try {
    return localStorage.getItem(SPEAK_PREF) !== "0";
  } catch {
    return true;
  }
}

export function setSpeakHere(on: boolean): void {
  try {
    localStorage.setItem(SPEAK_PREF, on ? "1" : "0");
  } catch {
    // private mode: the default stands
  }
}

/**
 * Say an alert without opening GPT-Live: one short clip, about a quarter of a
 * cent. Resolves false if the browser would not play it (no tap yet on this
 * page), so the card can offer a button instead.
 */
export async function speakAlert(key: string, a: Alert): Promise<boolean> {
  return speakText(key, a.title && a.title !== "Jarvis" ? `${a.title}. ${a.text}` : a.text);
}

/** One short clip of any text, as for an alert: typed chat's read-aloud option uses it too. */
export async function speakText(key: string, text: string): Promise<boolean> {
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ text, voice: "cedar" }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    // As loud as this screen asks for (loud.ts); otherwise it plays as it is.
    await routeElement(audio);
    await audio.play();
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotAllowedError") return false;
    // No voice scope or no network for the clip: the browser's own voice, if it has one.
    if ("speechSynthesis" in window) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      return true;
    }
    return false;
  }
}
