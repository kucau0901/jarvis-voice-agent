import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.ts";
import { StateHost } from "./lib/state-host.ts";
import type { Changeset, RefChangeset } from "./lib/memory.ts";
import type { Turn } from "./lib/history.ts";
import type { Changes } from "./lib/settings.ts";
import { LiveHub, type LiveClient, type LiveSocket } from "./lib/live.ts";
import type { Alert, Delivery } from "./lib/alerts.ts";
import type { PushRecord } from "./lib/state-host.ts";
import { deliver } from "./lib/alerts.ts";
import { effectiveEnv } from "./lib/settings.ts";
import { localeOf } from "./lib/locale.ts";
import { upcomingEvents } from "./lib/leave.ts";
import { Scheduler, type SchedulerDeps } from "./lib/scheduler.ts";
import type { RoutineInput } from "./lib/routines.ts";
import { narrow, type Grant } from "./lib/scopes.ts";
import { askForRoutine, travelFor } from "./routes/routines.ts";
import { Jobs } from "./lib/jobs.ts";
import { jobEngine } from "./routes/jobs.ts";
import type { UsageEntry } from "./lib/usage.ts";
import type { SharedTurn } from "./lib/shared.ts";
import { haConfig, renderTemplate, truthy } from "./lib/ha.ts";
import { HUB_METHODS, HubHost } from "./lib/hub.ts";
import { Relays, type Relay, type RelayDeps, type RelayKind } from "./lib/relays.ts";
import { Chat, dmId, type ChatMessage } from "./lib/chat.ts";
import { personOfWho, withPerson } from "./lib/context.ts";
import { nextAllowed } from "./lib/access.ts";

/** Chore points, per person (lib/relays.ts award). */
const POINTS = "chore:points";
/** Alerts kept for someone's quiet time (lib/alerts.ts). */
const HELD = "held:";

/**
 * The Durable Object. Memory, settings and push live in lib/state-host.ts,
 * where Node can test them; this class adds the sockets, the alarm (routines,
 * jobs, relays and held alerts), the family's chat and the hub's RPC.
 *
 * SQLite-backed (see the `new_sqlite_classes` migration in
 * wrangler.example.jsonc), because that is the only kind the Workers free
 * plan allows.
 */
export class JarvisState extends DurableObject<Env> {
  private host: StateHost;
  /** Who uses this Jarvis and how they sign in (lib/hub.ts). */
  private people: HubHost;
  private hub = new LiveHub();
  private scheduler: Scheduler;
  private jobs: Jobs;
  /** Messages passed on between the family (lib/relays.ts), and their conversations (lib/chat.ts). */
  private relays: Relays;
  private chat: Chat;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new StateHost(ctx.storage, env);
    this.people = new HubHost(ctx.storage);
    this.scheduler = new Scheduler(ctx.storage, () => this.schedulerDeps());
    this.chat = new Chat(ctx.storage);
    this.relays = new Relays(ctx.storage, () => this.relayDeps());
    this.jobs = new Jobs(ctx.storage, async () => {
      const env = await this.localEnv();
      // Each job runs as whoever started it: their memory, their mail (lib/context.ts).
      return jobEngine(env, (alert) => deliver(env, this, alert), (job) => this.personEnv(env, job.createdBy));
    });
    // Screens ping to keep their socket open through proxies. The runtime
    // answers these itself, so a hibernating object is not woken to say pong.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Nothing is served until memory has been copied out of KV. The KV read is
    // outside I/O, which would otherwise let a second request in half-way.
    ctx.blockConcurrencyWhile(() => this.host.ready());
  }

  loadMemory(book?: string) {
    return this.host.loadMemory(book);
  }

  /** The environment as `who` would have it (lib/context.ts), for a routine or a job they made. */
  private async personEnv(env: Env, who: string): Promise<Env> {
    const person = personOfWho(who);
    const v = await this.people.personView(person).catch(() => null);
    return withPerson(env, { person, name: v?.name, space: v?.space, prefs: v?.prefs, cars: v?.space ? v.cars : undefined, haToken: v?.haToken, access: v?.access });
  }

  /** When someone's quiet time ends, if they are in it now (lib/access.ts). */
  async quietUntil(person: string): Promise<number | null> {
    if (person === "owner") return null;
    const v = await this.people.personView(person).catch(() => null);
    if (!v?.access?.hours) return null;
    return nextAllowed(v.access, Date.now(), localeOf(await this.localEnv()).timeZone);
  }

  /** Keep an alert for someone in their quiet time; the alarm delivers it when it ends. */
  async hold(alert: Alert, until: number): Promise<void> {
    await this.ctx.storage.put(HELD + alert.id, { alert, until });
    await this.rearm();
  }

  /** Held alerts whose quiet time is over: delivered now (and held again if it is not, after all). */
  private async releaseHeld(): Promise<void> {
    const now = Date.now();
    const held = await this.ctx.storage.list<{ alert: Alert; until: number }>({ prefix: HELD });
    const due = [...held.entries()].filter(([, h]) => h.until <= now);
    if (!due.length) return;
    const env = await this.localEnv();
    for (const [k, h] of due) {
      await this.ctx.storage.delete(k);
      // Past its use while it waited (its quiet time grew longer, say): let go, not delivered late.
      if (h.alert.expiresAt !== undefined && h.alert.expiresAt <= now) continue;
      await deliver(env, this, h.alert).catch(() => null);
    }
  }

  /** Someone's own Telegram chat, for their alerts (lib/alerts.ts): "owner" is the first person's. */
  async chatFor(person: string): Promise<string | null> {
    const id = person === "owner" ? await this.people.firstPerson() : person;
    return id ? ((await this.people.prefsOf(id)).telegram ?? null) : null;
  }

  /** The people and their sign-ins: one RPC method for the listed few (lib/hub.ts). */
  hubCall(method: string, args: unknown[]): Promise<unknown> {
    if (!(HUB_METHODS as readonly string[]).includes(method)) throw new Error(`no hub method ${method}`);
    const fn = (this.people as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!;
    return fn.apply(this.people, args);
  }

  loadReference(book?: string) {
    return this.host.loadReference(book);
  }

  applyMemory(cs: Changeset | null, rcs: RefChangeset | null, book?: string) {
    return this.host.applyMemory(cs, rcs, book);
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

  vectorsNeeded(items: { id: string; hash: string }[], book?: string) {
    return this.host.vectorsNeeded(items, book);
  }

  searchVectors(query: string, put: { id: string; hash: string; v: string }[], ids: string[], k: number, prune: boolean, book?: string) {
    return this.host.searchVectors(query, put, ids, k, prune, book);
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

  /**
   * Someone left the family (routes/hub.ts): their routines stop, rotas go on
   * without them, and messages to or from them are no longer waited on.
   */
  async forgetMember(person: string): Promise<void> {
    await this.scheduler.forget(person);
    await this.relays.forget(person);
    await this.rearm();
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

  /* ---------- routines (lib/scheduler.ts) ------------------------------------- */

  /**
   * The Worker's environment as the panel has configured it, for work the
   * object does on its own. Anything that reaches the object through
   * stateStub(env) — memory, alerts — gets this object itself: a plain call,
   * not a request from the object to itself.
   */
  private async localEnv(): Promise<Env> {
    const eff = effectiveEnv(this.env, await this.host.getSettings());
    const self = this;
    return { ...eff, STATE: { idFromName: () => ({}), get: () => self } as unknown as DurableObjectNamespace };
  }

  private async schedulerDeps(): Promise<SchedulerDeps> {
    const env = await this.localEnv();
    const ha = haConfig(env);
    return {
      timeZone: localeOf(env).timeZone,
      deliver: (alert) => deliver(env, this, alert),
      // A routine runs as whoever made it: their memory, their calendar (lib/context.ts).
      ask: async (prompt, grants, routine) => {
        // No further than its maker may reach now: something an admin took from them is taken from their routines too.
        const view = await this.people.personView(personOfWho(routine.createdBy)).catch(() => null);
        if (view && !view.scopes) return { ok: false, text: "whoever made it is no longer in the family" };
        const now = view?.scopes ? narrow(grants, view.scopes) : grants;
        return askForRoutine(await this.personEnv(env, routine.createdBy), prompt, now, routine);
      },
      events: async (now, person) => upcomingEvents(await this.personEnv(env, person), now),
      travel: async (destination, person) => travelFor(await this.personEnv(env, person), destination),
      renderTemplate: ha ? (template) => renderTemplate(ha, template) : null,
      // A chore, a check-in or medicine: passed on to whoever's turn it is.
      relay: async (r, to) => {
        if (r.action.kind !== "relay") return "not a routine that passes things on";
        const from = personOfWho(r.createdBy);
        const fromName = (await this.people.personView(from).catch(() => null))?.name ?? "Someone at home";
        const home = (await this.people.familyPeople()).find((p) => p.person === to.person)?.presence;
        const made = await this.relays.create({
          kind: r.action.relay,
          from,
          fromName,
          to: [{ person: to.person, name: to.name, ...(home ? { home } : {}) }],
          text: r.action.text,
          ...(r.action.points ? { points: r.action.points } : {}),
          ...(r.action.escalate ? { escalate: true } : {}),
          ...(r.action.answerMin ? { answerMin: r.action.answerMin } : {}),
          routine: r.id,
        });
        return typeof made === "string" ? made : null;
      },
    };
  }

  /** Point the one alarm at whatever is due first: a routine, a job, a relay or a held alert. */
  private async rearm(): Promise<void> {
    const held = [...(await this.ctx.storage.list<{ until: number }>({ prefix: HELD })).values()].map((h) => h.until);
    const wakes = [...(await Promise.all([this.scheduler.nextWake(), this.jobs.nextWake(), this.relays.nextWake()])), ...held].filter(
      (t): t is number => t !== null,
    );
    const at = wakes.length ? Math.min(...wakes) : null;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    // Each catches per item, so this only throws on a storage failure — and then
    // the runtime retries, which is what is wanted.
    await this.scheduler.tick();
    await this.jobs.tick();
    await this.relays.tick();
    await this.releaseHeld();
    await this.rearm();
  }

  /* ---------- the family's messages (lib/relays.ts, lib/chat.ts) ------------------- */

  private async relayDeps(): Promise<RelayDeps> {
    const env = await this.localEnv();
    const ha = haConfig(env);
    return {
      deliver: (alert) => deliver(env, this, alert),
      // Home, by their Home Assistant person; unknown without the house.
      isHome: async (entity) => {
        if (!ha || !/^(person|device_tracker)\.[a-z0-9_]+$/.test(entity)) return null;
        return truthy(await renderTemplate(ha, `{{ is_state('${entity}', 'home') }}`));
      },
      post: async (between, msg) => void (await this.chat.post(dmId(between[0], between[1]), msg)),
      markPosted: (between, id, note) => this.chat.markRelay(dmId(between[0], between[1]), id, note),
      timeZone: localeOf(env).timeZone,
      answerMin: Number(env.RELAY_ANSWER_MIN) || undefined,
      award: async (person, points) => {
        const tally = (await this.ctx.storage.get<Record<string, number>>(POINTS)) ?? {};
        await this.ctx.storage.put(POINTS, { ...tally, [person]: (tally[person] ?? 0) + points });
      },
      // A check-in nobody answered is for the family: not a guest or a helper.
      family: async () => (await this.people.familyPeople()).filter((p) => p.role !== "guest").map((p) => p.person),
      quietUntil: (person) => this.quietUntil(person),
    };
  }

  /**
   * Pass something on: `to` is a family member's name ("Aisyah", or just
   * her first name) or "everyone". Returns what was made, or why not.
   */
  async relayCreate(input: {
    kind: RelayKind;
    from: string;
    fromName: string;
    to: string;
    text: string;
    after?: number;
    whenHome?: boolean;
    answerMin?: number;
  }): Promise<{ relays: Relay[]; noHome: string[] } | string> {
    const family = await this.people.familyPeople();
    if (!family.some((p) => p.person === input.from)) return "only a member of the family can pass things on";
    const want = input.to.trim().toLowerCase();
    const others = family.filter((p) => p.person !== input.from);
    // Everyone is everyone who takes part in messages: a guest cannot answer, so is never waited for.
    const to = ["everyone", "everybody", "all", "the family"].includes(want)
      ? others.filter((p) => p.chat)
      : others.filter((p) => p.name.toLowerCase() === want || p.name.toLowerCase().split(/\s+/)[0] === want).slice(0, 1);
    if (!to.length) return `nobody in the family is called "${input.to}". The family: ${others.map((p) => p.name).join(", ") || "only you so far"}`;
    const mute = to.find((p) => !p.chat);
    if (mute && input.kind !== "tell") return `${mute.name} cannot answer messages here (they are a guest), so cannot be reminded or asked; tell them instead`;
    const made = await this.relays.create(
      { ...input, to: to.map((p) => ({ person: p.person, name: p.name, ...(p.presence ? { home: p.presence } : {}) })) },
      Date.now(),
    );
    await this.rearm();
    if (typeof made === "string") return made;
    // Asked for "when home", but without their Home Assistant person: it goes by the time alone.
    const noHome = input.whenHome ? to.filter((p) => !p.presence).map((p) => p.name) : [];
    return { relays: made, noHome };
  }

  async relayAnswer(id: string, by: string, a: { status: "done" | "declined" | "answered"; answer?: string }) {
    const r = await this.relays.answer(id, by, a);
    await this.rearm();
    return r;
  }

  async relayCancel(id: string, by: string) {
    const r = await this.relays.cancel(id, by);
    await this.rearm();
    return r;
  }

  relaysFor(person: string) {
    return this.relays.forPerson(person);
  }

  relaysAwaiting(person: string) {
    return this.relays.awaiting(person);
  }

  chatPost(convo: string, msg: Omit<ChatMessage, "id" | "at">) {
    return this.chat.post(convo, msg);
  }

  chatMessages(convo: string, since = 0) {
    return this.chat.messages(convo, since);
  }

  chatConvos(person: string, family: { id: string; name: string }[]) {
    return this.chat.convos(person, family);
  }

  chatSeen(person: string, convo: string, at: number) {
    return this.chat.seen(person, convo, at);
  }

  familyPeople() {
    return this.people.familyPeople();
  }

  /* ---------- background jobs (lib/jobs.ts) ------------------------------------- */

  listJobs() {
    return this.jobs.list();
  }

  getJob(id: string) {
    return this.jobs.get(id);
  }

  async createJob(input: { title?: unknown; task?: unknown; engine?: unknown }, by: { who: string; grants: readonly Grant[] }) {
    const j = await this.jobs.create(input, by);
    await this.rearm();
    return j;
  }

  async cancelJob(id: string) {
    const j = await this.jobs.cancel(id);
    await this.rearm();
    return j;
  }

  async removeJob(id: string) {
    const ok = await this.jobs.remove(id);
    await this.rearm();
    return ok;
  }

  listRoutines() {
    return this.scheduler.list();
  }

  async addRoutine(input: RoutineInput, by: { who: string; grants: readonly Grant[] }) {
    // Passed on to people named by the family's names: who they are, found here.
    if (Array.isArray(input.passTo) && input.passTo.some((x) => typeof x === "string")) {
      const family = await this.people.familyPeople();
      const to: { person: string; name: string }[] = [];
      for (const n of input.passTo as unknown[]) {
        const want = String(n).trim().toLowerCase();
        const p = family.find((x) => x.name.toLowerCase() === want || x.name.toLowerCase().split(/\s+/)[0] === want);
        if (!p) return `nobody in the family is called "${String(n)}". The family: ${family.map((x) => x.name).join(", ")}`;
        if (!p.chat) return `${p.name} cannot answer messages here (they are a guest), so cannot be given a chore or a check-in`;
        to.push({ person: p.person, name: p.name });
      }
      input = { ...input, passTo: to };
    }
    const r = await this.scheduler.add(input, by);
    await this.rearm();
    return r;
  }

  /** Chore points, each person's, with their names (lib/relays.ts award). */
  async choresPoints(): Promise<{ person: string; name: string; points: number }[]> {
    const tally = (await this.ctx.storage.get<Record<string, number>>(POINTS)) ?? {};
    const family = await this.people.familyPeople();
    return family.filter((p) => p.chat).map((p) => ({ person: p.person, name: p.name, points: tally[p.person] ?? 0 })).sort((a, b) => b.points - a.points);
  }

  async resetPoints(): Promise<void> {
    await this.ctx.storage.delete(POINTS);
  }

  async updateRoutine(id: string, patch: { enabled?: boolean; name?: string }) {
    const r = await this.scheduler.update(id, patch);
    await this.rearm();
    return r;
  }

  async removeRoutine(id: string) {
    const ok = await this.scheduler.remove(id);
    await this.rearm();
    return ok;
  }

  async runRoutine(id: string) {
    const r = await this.scheduler.queue(id);
    await this.rearm();
    return r;
  }

  async fireEvent(event: string, data?: string, only?: string) {
    const started = await this.scheduler.fireEvent(event, data, Date.now(), only);
    if (started.length) await this.rearm();
    return started;
  }

  /* ---------- alerts' storage (lib/state-host.ts) ---------------------------- */

  vapidPublicKey() {
    return this.host.vapidPublicKey();
  }

  listPushSubs() {
    return this.host.listPushSubs();
  }

  addPushSub(input: Omit<PushRecord, "id" | "createdAt" | "failures" | "okAt">, now = Date.now(), opts?: { resync?: boolean }) {
    return this.host.addPushSub(input, now, opts);
  }

  removePushSub(idOrEndpoint: string, byOwner = false) {
    return this.host.removePushSub(idOrEndpoint, byOwner);
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

  appendShared(turns: SharedTurn[], now = Date.now(), book = "") {
    return this.host.appendShared(turns, now, book);
  }

  recentShared(origin: string, now = Date.now(), book = "") {
    return this.host.recentShared(origin, now, book);
  }

  recordUsage(e: UsageEntry, day: string) {
    return this.host.recordUsage(e, day);
  }

  usageReport(today: string, person?: string) {
    return this.host.usageReport(today, person);
  }

  mintTicket(client: Pick<LiveClient, "who" | "label">) {
    return this.host.mintTicket(client);
  }
}
