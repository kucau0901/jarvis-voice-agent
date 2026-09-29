import type { Env } from "../types.ts";
import { whoOf, type Principal } from "../lib/auth.ts";
import { err, json, publicOrigin, readObject } from "../lib/http.ts";
import { stateFetch, stateStub } from "../lib/state-client.ts";
import { deliver, makeAlert, parseOrder } from "../lib/alerts.ts";
import { cleanLabel } from "../lib/live.ts";
import { OWNER } from "../lib/context.ts";
import { TICKET_MS, TICKET_SHAPE } from "../lib/state-host.ts";
import { pushEndpointAllowed } from "../lib/webpush.ts";

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


/** What a screen is called in the panel and in "shown on …". A device is its own name. */
function identity(principal: Principal, label: unknown, fallback: string) {
  return principal.kind === "device"
    ? { who: whoOf(principal), label: cleanLabel(principal.name, "a device") }
    : { who: whoOf(principal), label: cleanLabel(label, fallback) };
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
    const b = await readObject(req, MAX_BODY);
    if (!b) return err(400, "body must be a small JSON object");
    const ticket = await state.mintTicket(identity(principal, b.label, "a screen"));
    return json({ ticket, expiresIn: TICKET_MS / 1000 });
  }

  if (p === "/api/v1/push") {
    if (req.method === "GET") return json({ publicKey: await state.vapidPublicKey() });
    const b = await readObject(req, MAX_BODY);
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
      // resync: the app re-sending this browser's notifications on its own
      // (src/app/alerts.ts syncPush), which must not undo the owner removing it.
      const rec = await state.addPushSub(
        { endpoint, p256dh, auth, subject, ...identity(principal, b.label, "a browser") },
        Date.now(),
        { resync: b.resync === true },
      );
      if (!rec) return json({ ok: false, removed: true, error: "removed in Settings → Alerts; turn notifications on again here to undo" }, { status: 409 });
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
    const b = await readObject(req, MAX_BODY);
    if (!b) return err(400, "body must be a small JSON object");
    const alert = makeAlert(b, "api", Date.now(), env.JARVIS_PERSON);
    if (!alert) return err(400, "text is required");
    const d = await deliver(env, state, alert);
    return json({ id: alert.id, deliveredBy: d.deliveredBy, attempts: d.attempts }, { status: d.deliveredBy ? 200 : 502 });
  }

  // /api/v1/alerts
  if (req.method !== "GET") return err(405, "method not allowed");
  const id = url.searchParams.get("id") ?? "";
  const found = id ? await state.findAlert(id) : null;
  // Someone's own alerts only, admins included: each person's are theirs alone (docs/family.md).
  const alert = found && (found.for ?? OWNER) === (env.JARVIS_PERSON ?? OWNER) ? found : null;
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
    // The owner's choice: that browser re-sending it on its own does not undo it.
    return json({ ok: await state.removePushSub(id, true) });
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
    // Each person's alerts are theirs alone, admins included (docs/family.md): someone
    // else's shows when and how it went, not what it said.
    recent: deliveries.slice(0, 10).map((d) =>
      (d.alert.for ?? OWNER) === (env.JARVIS_PERSON ?? OWNER)
        ? d
        : { ...d, alert: { id: d.alert.id, at: d.alert.at, source: d.alert.source, for: d.alert.for }, hidden: true },
    ),
  });
}
