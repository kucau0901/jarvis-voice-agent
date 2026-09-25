import type { Env } from "../types";
import type { Principal } from "../lib/auth";
import { err, json, publicOrigin } from "../lib/http";
import { stateFetch, stateStub } from "../lib/state-client";
import { deliver, makeAlert, parseOrder } from "../lib/alerts";
import { cleanLabel } from "../lib/live";
import { TICKET_MS, TICKET_SHAPE } from "../lib/state-host";
import { pushEndpointAllowed } from "../lib/webpush";

/**
 * The alerts surface (lib/alerts.ts). Every path here needs the `alerts`
 * scope (lib/scopes.ts) except the owner's overview at /api/alerts.
 *
 *   GET    /api/v1/events          WebSocket: an open screen, to receive alerts
 *   POST   /api/v1/events/ticket   a one-time ticket for a browser's WebSocket
 *   GET    /api/v1/push            the key a browser subscribes with
 *   POST   /api/v1/push            turn notifications on for this browser
 *   DELETE /api/v1/push            and off
 *   POST   /api/v1/notify          send an alert: text, optional title, urgent
 *   GET    /api/v1/alerts?id=      one recent alert, for a tapped notification
 */

const MAX_BODY = 8 * 1024;

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** What a screen is called in the panel and in "shown on …". A device is its own name. */
function identity(principal: Principal, label: unknown, fallback: string) {
  return principal.kind === "owner"
    ? { who: "owner", label: cleanLabel(label, fallback) }
    : { who: principal.id, label: cleanLabel(principal.name, "a device") };
}

const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

/**
 * A browser's socket, opened with a ticket instead of a header. Runs BEFORE
 * authorisation (index.ts), like the OAuth callbacks: the ticket is the
 * credential, and the Durable Object checks and spends it.
 */
export function isTicketedSocket(req: Request, url: URL): boolean {
  return url.pathname === "/api/v1/events" && isUpgrade(req) && TICKET_SHAPE.test(url.searchParams.get("ticket") ?? "");
}

export function openTicketedSocket(req: Request, env: Env): Promise<Response> {
  return stateFetch(env, req);
}

/** Null when the path is not one of these, so the caller can go on to its 404. */
export async function handleAlertApi(
  req: Request,
  env: Env,
  url: URL,
  principal: Principal,
): Promise<Response | null> {
  const state = stateStub(env);
  const p = url.pathname;
  if (
    !["/api/v1/events", "/api/v1/events/ticket", "/api/v1/push", "/api/v1/notify", "/api/v1/alerts"].includes(p)
  ) {
    return null;
  }
  if (!state) return err(503, "alerts need the STATE Durable Object");

  // A client that CAN send a header — firmware, another server — opens its
  // socket directly; it is issued a ticket here and handed straight on.
  if (p === "/api/v1/events") {
    if (!isUpgrade(req)) return err(426, "this is a WebSocket; browsers get a ticket from /api/v1/events/ticket first");
    const ticket = await state.mintTicket(identity(principal, url.searchParams.get("label"), "a client"));
    const u = new URL(req.url);
    u.searchParams.set("ticket", ticket);
    return stateFetch(env, new Request(u.toString(), req));
  }

  if (p === "/api/v1/events/ticket") {
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await body(req);
    if (!b) return err(400, "body must be a small JSON object");
    const ticket = await state.mintTicket(identity(principal, b.label, "a screen"));
    return json({ ticket, expiresIn: TICKET_MS / 1000 });
  }

  if (p === "/api/v1/push") {
    if (req.method === "GET") return json({ publicKey: await state.vapidPublicKey() });
    const b = await body(req);
    if (!b) return err(400, "body must be a small JSON object");

    if (req.method === "POST") {
      const sub = b.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
      const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
      const p256dh = typeof sub?.keys?.p256dh === "string" ? sub.keys.p256dh : "";
      const auth = typeof sub?.keys?.auth === "string" ? sub.keys.auth : "";
      if (!pushEndpointAllowed(endpoint)) return err(400, "subscription.endpoint is not a known push service");
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
        return err(400, "subscription.keys must hold p256dh and auth, base64url");
      }
      // Apple refuses a push whose VAPID contact is not https: or mailto:.
      const subject = publicOrigin(env, url.origin);
      const rec = await state.addPushSub({
        endpoint, p256dh, auth, subject, ...identity(principal, b.label, "a browser"),
      });
      return json({ ok: true, id: rec.id, label: rec.label }, { status: 201 });
    }

    if (req.method === "DELETE") {
      const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
      if (!endpoint) return err(400, "endpoint is required");
      // Knowing the endpoint is proof of being that browser; nobody else has it.
      return json({ ok: await state.removePushSub(endpoint) });
    }
    return err(405, "method not allowed");
  }

  if (p === "/api/v1/notify") {
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await body(req);
    if (!b) return err(400, "body must be a small JSON object");
    const alert = makeAlert(b, "api");
    if (!alert) return err(400, "text is required");
    const d = await deliver(env, state, alert);
    return json({ id: alert.id, deliveredBy: d.deliveredBy, attempts: d.attempts }, { status: d.deliveredBy ? 200 : 502 });
  }

  // /api/v1/alerts
  if (req.method !== "GET") return err(405, "method not allowed");
  const id = url.searchParams.get("id") ?? "";
  const alert = id ? await state.findAlert(id) : null;
  return alert ? json({ alert }) : err(404, "no such recent alert");
}

/** The owner's overview for the settings panel, and removing a device's notifications. */
export async function handleAlertsAdmin(req: Request, env: Env): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "alerts need the STATE Durable Object");
  const url = new URL(req.url);

  if (req.method === "DELETE") {
    const id = url.searchParams.get("sub") ?? "";
    if (!/^[0-9a-f]{16}$/.test(id)) return err(400, "sub must be a subscription id");
    return json({ ok: await state.removePushSub(id) });
  }
  if (req.method !== "GET") return err(405, "method not allowed");

  const [subs, live, deliveries] = await Promise.all([state.listPushSubs(), state.liveClients(), state.deliveries()]);
  return json({
    order: parseOrder(env.ALERT_ORDER),
    // Never the keys or the full endpoint: which push service is enough to tell them apart.
    push: subs.map((s) => ({
      id: s.id, label: s.label, who: s.who, service: new URL(s.endpoint).hostname,
      createdAt: s.createdAt, okAt: s.okAt, failures: s.failures,
    })),
    live,
    recent: deliveries.slice(0, 10),
  });
}
