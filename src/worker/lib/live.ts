import type { Alert, LiveResult } from "./alerts.ts";

/**
 * Open Jarvis screens, and getting an alert onto one that someone is looking at.
 *
 * Each open screen — the car's tab, a phone, a desktop, a device that keeps a
 * socket — holds one WebSocket to the Durable Object. The object uses the
 * hibernation API, so an idle socket costs nothing: the free plan's duration
 * allowance would be mostly spent keeping one ordinary connection (or an SSE
 * stream) open all day, whereas a hibernated object is evicted from memory
 * and woken only when a message arrives. Keep-alive pings are answered by the
 * runtime itself without waking it (state.ts).
 *
 * "Open" is not "seen": a desktop tab behind other windows is open. So each
 * screen reports whether it is visible, and a screen that is confirms each
 * alert it receives. An alert counts as delivered live only on that
 * confirmation; otherwise the next channel is tried. That confirmation is the
 * difference between reaching someone and writing into an empty room.
 *
 * Free of `cloudflare:workers`, so Node tests it with fake sockets.
 */

/** Who is on the other end of one socket. Kept as the socket's attachment, so it survives hibernation. */
export interface LiveClient {
  /** "owner" or a device id. Sockets are tagged with it, so a revoked device's screens can be closed. */
  who: string;
  /** How it describes itself: "car", "phone", or a device's name. */
  label: string;
  visible: boolean;
  since: number;
}

export interface LiveSocket {
  send(data: string): void;
  client(): LiveClient | null;
  update(c: LiveClient): void;
}

const MAX_LABEL = 40;

/** A client-supplied description, made safe to show and store. */
export function cleanLabel(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, MAX_LABEL) : "";
  return s || fallback;
}

export class LiveHub {
  /** Alerts waiting on a visible screen to confirm them. In memory only: the object is awake while it waits. */
  private waiting = new Map<string, (label: string) => void>();

  clients(sockets: LiveSocket[]): LiveClient[] {
    return sockets.map((s) => s.client()).filter((c): c is LiveClient => !!c);
  }

  /** Send to every open screen; resolve on the first visible one to confirm, or after `waitMs`. */
  broadcast(sockets: LiveSocket[], alert: Alert, waitMs: number): Promise<LiveResult> {
    const msg = JSON.stringify({ type: "alert", alert });
    let open = 0;
    let visible = 0;
    for (const s of sockets) {
      const c = s.client();
      if (!c) continue;
      try {
        s.send(msg);
      } catch {
        continue; // closing; the runtime will report it
      }
      open++;
      if (c.visible) visible++;
    }
    if (!visible || waitMs <= 0) return Promise.resolve({ open, visible, acked: null });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(alert.id);
        resolve({ open, visible, acked: null });
      }, waitMs);
      this.waiting.set(alert.id, (label) => {
        clearTimeout(timer);
        this.waiting.delete(alert.id);
        resolve({ open, visible, acked: label });
      });
    });
  }

  /** A message from a screen: its visibility changing, or a confirmation. */
  receive(sock: LiveSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string" || raw.length > 1000) return;
    let msg: { type?: unknown; visible?: unknown; id?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const c = sock.client();
    if (!c) return;

    if (msg.type === "presence" && typeof msg.visible === "boolean") {
      if (c.visible !== msg.visible) sock.update({ ...c, visible: msg.visible });
      return;
    }
    // Only a screen someone is looking at counts. A hidden one confirming would
    // stop the alert from going on to the phone in your pocket.
    if (msg.type === "ack" && typeof msg.id === "string" && msg.visible === true) {
      if (!c.visible) sock.update({ ...c, visible: true });
      this.waiting.get(msg.id)?.(c.label);
    }
  }
}
