import type { Env } from "./types";
import { err } from "./lib/http";
import { authorize, type Principal } from "./lib/auth";
import { allows, requiredScope, WILDCARD, type Grant } from "./lib/scopes";
import { preflight, withCors } from "./lib/cors";
import * as limits from "./lib/limits";
import { handleProbe } from "./routes/probe";
import { handleSession, VOICES } from "./routes/session";
import { handleDiag } from "./routes/diag";
import { handleDelegate } from "./routes/delegate";
import { handleTts } from "./routes/tts";
import { handleMcp } from "./routes/mcp";
import { handleMemory } from "./routes/memory";
import { handleMap } from "./routes/map";
import { handleCamera } from "./routes/camera";
import { handleSpotify } from "./routes/spotify";
import { handleGoogle } from "./routes/google";
import { handleV1 } from "./routes/v1";
import { handleRouter } from "./routes/router";
import { handleSettings } from "./routes/settings";
import { withSettings } from "./lib/settings-store";
import { handleAlertsAdmin, isTicketedSocket, openTicketedSocket } from "./routes/alerts";

// The Durable Object class must be exported from the entry for the runtime to find it.
export { JarvisState } from "./state";

const grantsOf = (p: Principal): readonly Grant[] => (p.kind === "owner" ? [WILDCARD] : p.scopes);

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

    const auth = await authorize(req, env, ctx);
    if (!auth.ok) return withCors(auth.response, origin, env);
    const principal = auth.principal;

    /*
     * From here on, every route sees the Worker's environment with the settings
     * saved in the panel layered on top (lib/settings.ts). Read only after
     * authorisation, so an unauthenticated request never costs a storage read.
     * The name is kept as `env` deliberately: nothing downstream changed.
     */
    const raw = env;
    env = await withSettings(raw);

    /*
     * One enforcement point, not twelve.
     *
     * Every route's requirement comes from a single pure function that mirrors
     * the prefix-then-exact matching in route() below and defaults to "owner"
     * for anything it does not recognise. Scattering the checks across handlers
     * would guarantee the next route added forgets one; here, forgetting means
     * the route is closed to devices, which is the safe direction to fail in.
     */
    if (principal.kind !== "owner") {
      const need = requiredScope(url.pathname, req.method);
      if (need === "owner") return withCors(err(403, "owner credential required"), origin, env);
      if (need !== "any" && !allows(principal.scopes, need)) {
        return withCors(
          err(403, `this device is not granted "${need}"`, { need, has: principal.scopes }),
          origin,
          env,
        );
      }

      const verdict = await limits.check(env, principal.id);
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
      if (!verdict.counted) ctx.waitUntil(limits.charge(env, principal.id));
    }

    try {
      // The settings route alone needs the Worker's own environment, to tell a
      // value saved in the panel from one the deployment supplies.
      if (url.pathname === "/api/settings" || url.pathname === "/api/settings/test") {
        return withCors(await handleSettings(req, raw), origin, env);
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
  if (url.pathname.startsWith("/api/mcp")) return await handleMcp(req, env);
  if (url.pathname.startsWith("/api/memory")) return await handleMemory(req, env);
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
      return await handleDelegate(req, env, ctx, grantsOf(principal));
    case "/api/tts":
      return await handleTts(req, env);
    case "/api/camera":
      return await handleCamera(req, env);
    case "/api/map":
      return await handleMap(req, env);
    case "/api/diag":
      return await handleDiag(req, env);
    case "/api/router":
    case "/api/router/test":
      return await handleRouter(req, env);
    case "/api/alerts":
      return await handleAlertsAdmin(req, env);
    case "/api/health":
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { "content-type": "application/json" },
      });
    default:
      return err(404, `no route for ${url.pathname}`);
  }
}
