import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { StateHost } from "./lib/state-host";
import type { Changeset, RefChangeset } from "./lib/memory";
import type { Turn } from "./lib/history";
import type { Changes } from "./lib/settings";
import { LiveHub, type LiveClient, type LiveSocket } from "./lib/live";
import type { Alert, Delivery } from "./lib/alerts";
import type { PushRecord } from "./lib/state-host";

/**
 * The Durable Object. Deliberately thin: everything it does lives in
 * lib/state-host.ts, where Node can test it.
 *
 * SQLite-backed (see the `new_sqlite_classes` migration in wrangler.jsonc),
 * because that is the only kind the Workers free plan allows.
 */
export class JarvisState extends DurableObject<Env> {
  private host: StateHost;
  private hub = new LiveHub();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new StateHost(ctx.storage, env);
    // Screens ping to keep their socket open through proxies. The runtime
    // answers these itself, so a hibernating object is not woken to say pong.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Nothing is served until memory has been copied out of KV. The KV read is
    // outside I/O, which would otherwise let a second request in half-way.
    ctx.blockConcurrencyWhile(() => this.host.ready());
  }

  loadMemory() {
    return this.host.loadMemory();
  }

  loadReference() {
    return this.host.loadReference();
  }

  applyMemory(cs: Changeset | null, rcs: RefChangeset | null) {
    return this.host.applyMemory(cs, rcs);
  }

  consume(deviceId: string, cap: number, day: string) {
    return this.host.consume(deviceId, cap, day);
  }

  loadThread(key: string) {
    return this.host.loadThread(key);
  }

  appendThread(key: string, turns: Turn[]) {
    return this.host.appendThread(key, turns);
  }

  getSettings() {
    return this.host.getSettings();
  }

  putSettings(changes: Changes) {
    return this.host.putSettings(changes);
  }

  /* ---------- live screens (lib/live.ts) ------------------------------------ */

  /**
   * Open a screen's socket. Reachable only through the Worker, which hands
   * over a ticket it issued after authenticating the caller; the ticket is the
   * whole of the check here, and it works once.
   */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const who = await this.host.takeTicket(new URL(req.url).searchParams.get("ticket") ?? "");
    if (!who) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernatable: the object can leave memory while the socket stays open.
    this.ctx.acceptWebSocket(server, [who.who]);
    const c: LiveClient = { ...who, visible: false, since: Date.now() };
    server.serializeAttachment(c);
    server.send(JSON.stringify({ type: "hello", label: c.label }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    this.hub.receive(this.wrap(ws), msg);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed, or a code that cannot be sent back (1005, 1006).
    }
  }

  private wrap(ws: WebSocket): LiveSocket {
    return {
      send: (d) => ws.send(d),
      client: () => (ws.deserializeAttachment() as LiveClient | null) ?? null,
      update: (c) => ws.serializeAttachment(c),
    };
  }

  private sockets(): LiveSocket[] {
    return this.ctx.getWebSockets().map((ws) => this.wrap(ws));
  }

  broadcast(alert: Alert, waitMs: number) {
    return this.hub.broadcast(this.sockets(), alert, waitMs);
  }

  liveClients() {
    return this.hub.clients(this.sockets());
  }

  async forgetDevice(who: string) {
    for (const ws of this.ctx.getWebSockets(who)) {
      try {
        ws.close(4001, "revoked");
      } catch {
        // already gone
      }
    }
    await this.host.forgetPushFor(who);
  }

  /* ---------- alerts' storage (lib/state-host.ts) ---------------------------- */

  vapidPublicKey() {
    return this.host.vapidPublicKey();
  }

  listPushSubs() {
    return this.host.listPushSubs();
  }

  addPushSub(input: Omit<PushRecord, "id" | "createdAt" | "failures" | "okAt">) {
    return this.host.addPushSub(input);
  }

  removePushSub(idOrEndpoint: string) {
    return this.host.removePushSub(idOrEndpoint);
  }

  pushTargets() {
    return this.host.pushTargets();
  }

  pushResults(results: { id: string; ok: boolean; gone: boolean }[]) {
    return this.host.pushResults(results);
  }

  logDelivery(d: Delivery) {
    return this.host.logDelivery(d);
  }

  deliveries() {
    return this.host.deliveries();
  }

  findAlert(id: string) {
    return this.host.findAlert(id);
  }

  mintTicket(client: Pick<LiveClient, "who" | "label">) {
    return this.host.mintTicket(client);
  }
}
