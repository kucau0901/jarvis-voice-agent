import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { asViewEvents, browserInput, browserScreen, dialWebSocket, type BrowserDeps } from "../lib/browser.ts";

/** A drag's worth of events is small; typed text is capped by lib/browser.ts. */
const BODY_MAX = 32_768;

/**
 * The browser Jarvis drives, under a person's own hands (lib/browser.ts): for
 * what Jarvis never does itself, signing in and passing a human check. Both
 * need the `browser` scope (lib/scopes.ts).
 *
 *   GET  /api/browser/screen   { jpeg, width, height, url, title }: what it shows now
 *   POST /api/browser/input    { events: [...] }: taps, drags, typing, keys, an address to open
 *
 * What is typed here goes to the browser and nowhere else: it is not logged,
 * kept, or shown to a model.
 */
export async function handleBrowser(req: Request, env: Env): Promise<Response> {
  if (!env.BROWSER_URL) return err(404, "no browser is set up: Settings → Browser");
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
