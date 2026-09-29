import type { Env } from "./types.ts";
import { err, json } from "./lib/http.ts";
import { authorize, grantsOf, isAdmin, personOf, type Principal } from "./lib/auth.ts";
import { OWNER, withPerson } from "./lib/context.ts";
import { allowedNow } from "./lib/access.ts";
import { localeOf } from "./lib/locale.ts";
import { personView } from "./lib/hub-client.ts";
import { allows, requiredScope } from "./lib/scopes.ts";
import { preflight, withCors } from "./lib/cors.ts";
import * as limits from "./lib/limits.ts";
import { handleProbe } from "./routes/probe.ts";
import { handleSession, VOICES } from "./routes/session.ts";
import { handleDiag } from "./routes/diag.ts";
import { handleDelegate } from "./routes/delegate.ts";
import { handleTts } from "./routes/tts.ts";
import { handleMcp } from "./routes/mcp.ts";
import { handleMemory } from "./routes/memory.ts";
import { handleMap } from "./routes/map.ts";
import { handleCamera } from "./routes/camera.ts";
import { handleSpotify } from "./routes/spotify.ts";
import { handleGoogle } from "./routes/google.ts";
import { handleV1 } from "./routes/v1.ts";
import { handleRouter } from "./routes/router.ts";
import { handleSettings } from "./routes/settings.ts";
import { withSettings } from "./lib/settings-store.ts";
import { JARVIS_VERSION, handleVersion } from "./routes/version.ts";
import { handleUsage } from "./routes/usage.ts";
import { handleAlertsAdmin, isTicketedSocket, openTicketedSocket } from "./routes/alerts.ts";
import { handleAuth, handleHub } from "./routes/hub.ts";
import { handleFamily } from "./routes/family.ts";

// The Durable Object class must be exported from the entry for the runtime to find it.
export { JarvisState } from "./state.ts";

/**
 * Who this request is for (lib/context.ts): a member from their sign-in; the
 * owner key and devices as the first person. Never fails a request: without
 * the family's details it runs as it always did.
 */
async function forPerson(env: Env, p: Principal): Promise<Env> {
  const person = personOf(p);
  // Their cars (and, for the owner key and devices, who the first person is), kept a little while per isolate.
  const v = await personView(env, person).catch(() => null);
  if (p.kind === "member" && p.place) {
    return withPerson(env, { person, name: p.name, space: p.place.space, prefs: p.place.prefs, cars: v?.space ? v.cars : undefined, haToken: v?.haToken, haTokenFor: v?.haTokenFor, access: p.place.access });
  }
  // The owner key, and devices: the first person's, or for a member's own device, that member's.
  return withPerson(env, { person, name: v?.name, space: v?.space, prefs: v?.prefs, cars: v?.space ? v.cars : undefined, haToken: v?.haToken, haTokenFor: v?.haTokenFor, access: v?.access });
}

/** What someone outside their hours may still do (lib/access.ts). */
const ACCESS_ALWAYS = new Set(["/api/hub/me", "/api/hub/signout", "/api/hub/unlock", "/api/health"]);

/** What a locked profile may still do: say who it is, be unlocked, or be signed out. */
const LOCKED_MAY = new Set(["/api/hub/me", "/api/hub/unlock", "/api/hub/signout"]);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");

    // `run_worker_first: ["/api/*"]` means only these paths reach the Worker;
    // everything else is served straight from ./dist as a static asset.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    // Before authorisation, necessarily: a browser sends no custom headers on a
    // preflight, so demanding a credential here would 401 every preflight and
    // the real request would never be issued at all.
    // Allowed origins can be saved in the settings panel, so a preflight reads
    // them — through the per-isolate cache, so strangers sending OPTIONS cost
    // at most one storage read per isolate every few seconds.
    if (req.method === "OPTIONS") {
      const pre = preflight(req, await withSettings(env));
      if (pre) return pre;
    }

    // The /api/ routes that cannot carry the shared secret: each is a redirect
    // from a third party's servers. A single-use `state` value minted by an
    // authenticated /auth call stands in for the header — see routes/spotify.ts
    // and routes/google.ts. Adding an OAuth integration means copying that
    // shape, not widening the gate below.
    if (url.pathname === "/api/spotify/callback") {
      return withCors(await handleSpotify(req, env), origin, env);
    }
    if (url.pathname === "/api/google/callback") {
      return withCors(await handleGoogle(req, env), origin, env);
    }
    // A browser cannot put a header on a WebSocket, so an open screen presents
    // a one-time ticket it was issued over an authenticated request instead.
    // The Durable Object checks and spends it (routes/alerts.ts).
    if (isTicketedSocket(req, url)) return openTicketedSocket(req, env);
    // Signing in, which by its nature comes before a credential (routes/hub.ts).
    if (url.pathname.startsWith("/api/auth/")) {
      try {
        return withCors(await handleAuth(req, await withSettings(env)), origin, env);
      } catch (e) {
        console.error("auth", e instanceof Error ? e.stack : String(e));
        return withCors(err(500, "internal error"), origin, env);
      }
    }

    const auth = await authorize(req, env, ctx);
    if (!auth.ok) return withCors(auth.response, origin, env);
    const principal = auth.principal;

    // A profile locked on a shared screen does nothing until its PIN is given.
    // Letting go of this browser's notifications too: a locked profile's alerts must stop showing on a shared screen.
    const lettingGo = url.pathname === "/api/v1/push" && req.method === "DELETE";
    if (principal.kind === "member" && principal.locked && !LOCKED_MAY.has(url.pathname) && !lettingGo) {
      return withCors(err(423, "locked: enter this person's PIN", { locked: true }), origin, env);
    }

    /*
     * From here on, every route sees the Worker's environment with the settings
     * saved in the panel layered on top (lib/settings.ts). Read only after
     * authorisation, so an unauthenticated request never costs a storage read.
     * The name is kept as `env` deliberately: nothing downstream changed.
     */
    const raw = env;
    env = await withSettings(raw);

    /*
     * A guest's or a child's hours (lib/access.ts): outside them, Jarvis does
     * not answer them, from any screen or device of theirs. Saying who they
     * are and signing out always work.
     */
    const access = principal.kind === "member" ? principal.place?.access : principal.kind === "device" ? principal.access : undefined;
    if (access && !ACCESS_ALWAYS.has(url.pathname)) {
      const now = allowedNow(access, Date.now(), localeOf(env).timeZone);
      if (!now.ok) return withCors(json({ error: now.why, text: `Not now: ${now.why}.`, outside: true }, { status: 403 }), origin, env);
    }

    env = await forPerson(env, principal);

    /*
     * One enforcement point, not twelve.
     *
     * Every route's requirement comes from a single pure function that mirrors
     * the prefix-then-exact matching in route() below and defaults to "owner"
     * for anything it does not recognise. Scattering the checks across handlers
     * would guarantee the next route added forgets one; here, forgetting means
     * the route is closed to devices, which is the safe direction to fail in.
     */
    if (!isAdmin(principal)) {
      const scoped = principal as Exclude<Principal, { kind: "owner" }>;
      const need = requiredScope(url.pathname, req.method);
      if (need === "person" && scoped.kind === "device") {
        return withCors(err(403, "that is for a person, not a device"), origin, env);
      }
      if (need === "owner") {
        return withCors(err(403, scoped.kind === "member" ? "only a family admin can do that" : "owner credential required"), origin, env);
      }
      if (need !== "any" && need !== "person" && !allows(scoped.scopes, need)) {
        const who = scoped.kind === "member" ? "you are" : "this device is";
        return withCors(err(403, `${who} not granted "${need}"`, { need, has: scoped.scopes }), origin, env);
      }

      // A device's allowance: glasses and ESP32s call on their own, and a leaked
      // token is spent by nobody watching. A person signed in is not counted
      // this way: the app alone reads their chat every few seconds, and what
      // they spend shows, person by person, in Usage.
      const verdict = scoped.kind === "device" ? await limits.check(env, scoped.id) : ({ ok: true, counted: true } as const);
      if (!verdict.ok) {
        const message = limits.limitMessage(verdict.reason);
        const headers = new Headers({ "content-type": "application/json" });
        if (verdict.retryAfter) headers.set("retry-after", String(verdict.retryAfter));
        return withCors(
          new Response(
            JSON.stringify({ ok: false, error: verdict.reason, text: message }),
            { status: 429, headers },
          ),
          origin,
          env,
        );
      }
      // The Durable Object counts inside check(), atomically; only KV needs this.
      if (!verdict.counted) ctx.waitUntil(limits.charge(env, scoped.id));
    }

    try {
      // The settings route alone needs the Worker's own environment, to tell a
      // value saved in the panel from one the deployment supplies.
      if (url.pathname === "/api/settings" || url.pathname === "/api/settings/test") {
        return withCors(await handleSettings(req, raw, env.JARVIS_PERSON), origin, env);
      }
      return withCors(await route(req, env, ctx, url, principal), origin, env);
    } catch (e) {
      // Never surface an internal message to the car — it can carry credentials.
      console.error("unhandled", e instanceof Error ? e.stack : String(e));
      return withCors(err(500, "internal error"), origin, env);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  principal: Principal,
): Promise<Response> {
  if (url.pathname.startsWith("/api/v1/")) return await handleV1(req, env, ctx, principal);
  if (url.pathname.startsWith("/api/hub/chat") || url.pathname.startsWith("/api/hub/relays") || url.pathname === "/api/hub/points") {
    return (await handleFamily(req, env, ctx, principal))!;
  }
  if (url.pathname.startsWith("/api/hub/")) return await handleHub(req, env, principal);
  if (url.pathname.startsWith("/api/mcp")) return await handleMcp(req, env, personOf(principal) === OWNER);
  if (url.pathname.startsWith("/api/memory")) return await handleMemory(req, env, grantsOf(principal), principal.kind === "device");
  if (url.pathname.startsWith("/api/spotify")) return await handleSpotify(req, env);
  if (url.pathname.startsWith("/api/google")) return await handleGoogle(req, env);

  switch (url.pathname) {
    case "/api/probe":
      return await handleProbe(req, env);
    case "/api/session":
      return await handleSession(req, env);
    case "/api/voices":
      return new Response(JSON.stringify({ voices: VOICES, default: "cedar" }), {
        headers: { "content-type": "application/json" },
      });
    case "/api/delegate":
      return await handleDelegate(req, env, ctx, grantsOf(principal), principal);
    case "/api/tts":
      return await handleTts(req, env);
    case "/api/camera":
      return await handleCamera(req, env);
    case "/api/map":
      return await handleMap(req, env);
    case "/api/diag":
      return await handleDiag(env);
    case "/api/router":
    case "/api/router/test":
      return await handleRouter(req, env);
    case "/api/alerts":
      return await handleAlertsAdmin(req, env);
    case "/api/health":
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), version: JARVIS_VERSION }), {
        headers: { "content-type": "application/json" },
      });
    case "/api/version":
      return await handleVersion(env);
    case "/api/usage":
      return await handleUsage(req, env, isAdmin(principal));
    default:
      return err(404, `no route for ${url.pathname}`);
  }
}
