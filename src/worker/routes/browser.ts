import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { asViewEvents, browserInput, browserScreen, dialWebSocket, type BrowserDeps } from "../lib/browser.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { passwordOk, seal, siteOf } from "../lib/vault.ts";

/** A drag's worth of events is small; typed text is capped by lib/browser.ts. */
const BODY_MAX = 32_768;

/**
 * The browser Jarvis drives, under a person's own hands (lib/browser.ts): for
 * what Jarvis never does itself, signing in and passing a human check. Both
 * need the `browser` scope (lib/scopes.ts).
 *
 *   GET  /api/browser/screen   { jpeg, width, height, url, title }: what it shows now
 *   POST /api/browser/input    { events: [...] }: taps, drags, typing, keys, an address to open
 *   GET    /api/browser/logins        the sign-ins you saved: { logins: [{ id, origin, user, at }] }, never a password
 *   POST   /api/browser/logins        { site, user, password }: save one for that site (lib/vault.ts)
 *   DELETE /api/browser/logins?id=    remove one
 *
 * Saved sign-ins are a person's own: never a device's to see or change.
 *
 * What is typed here goes to the browser and nowhere else: it is not logged,
 * kept, or shown to a model.
 */
export async function handleBrowser(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (!env.BROWSER_URL) return err(404, "no browser is set up: Settings → Browser");
  if (new URL(req.url).pathname === "/api/browser/logins") return logins(req, env, principal);
  const deps: BrowserDeps = {
    base: env.BROWSER_URL,
    fetch: (url, init) => fetch(url, init),
    dial: dialWebSocket,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    signal: AbortSignal.timeout(20_000),
  };
  const { pathname } = new URL(req.url);
  try {
    if (pathname === "/api/browser/screen") {
      if (req.method !== "GET") return err(405, "GET only");
      return json(await browserScreen(deps), { headers: { "cache-control": "no-store" } });
    }
    if (req.method !== "POST") return err(405, "POST only");
    const body = await readObject(req, BODY_MAX);
    const events = asViewEvents(body?.events);
    if (typeof events === "string") return err(400, events);
    const refused = await browserInput(deps, events);
    return refused ? err(400, refused) : json({ ok: true });
  } catch (e) {
    // The browser's own words (it is off, it hung up): never what was typed. Not 502:
    // a proxy in front (Cloudflare) answers that with a page of its own, and the words are lost.
    return err(503, e instanceof Error ? e.message : String(e));
  }
}

async function logins(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (principal.kind === "device") return err(403, "that is for a person, not a device");
  const state = stateStub(env);
  if (!state) return err(503, "saved sign-ins need the STATE Durable Object");
  const me = personOf(principal);
  if (req.method === "GET") return json({ logins: await state.vaultList(me) }, { headers: { "cache-control": "no-store" } });
  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    return (await state.vaultRemove(me, id)) ? json({ ok: true }) : err(404, "no such saved sign-in");
  }
  if (req.method !== "POST") return err(405, "GET, POST or DELETE");
  const body = await readObject(req, BODY_MAX);
  const origin = siteOf(typeof body?.site === "string" ? body.site : "");
  if (!origin) return err(400, "site must be the site's address, like https://hr.example.com");
  if (typeof body?.user !== "string" || !body.user.trim()) return err(400, "user must be the login name");
  if (!passwordOk(body.password)) return err(400, "password must be given, and no longer than 500 characters");
  // Sealed here, before it is stored: what is kept does not open without the owner key.
  const saved = await state.vaultSave(me, { origin, user: body.user, sealed: await seal(env.JARVIS_SHARED_SECRET, me, origin, body.password) });
  return typeof saved === "string" ? err(400, saved) : json({ login: saved });
}
