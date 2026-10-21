import type { Env } from "../types.ts";
import { err, json, publicOrigin, HTML_PAGE_HEADERS } from "../lib/http.ts";
import { isAdmin, personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { PAGE_ID, SHARE_TOKEN, VIEW_TOKEN } from "../lib/pages.ts";
import { renderPage } from "../lib/page-template.ts";

/**
 * Pages Jarvis made (lib/pages.ts, tools/page.ts).
 *
 *   GET    /api/v1/p/<id>?k=<token>   the page itself: before any sign-in, the token its proof
 *   GET    /api/page?id=              {title, at, viewUrl, shareUrl|null}: one of yours
 *   POST   /api/page/share {id}       {shareUrl}: shared for anyone with the link (admins only)
 *   DELETE /api/page/share?id=        not shared any more
 *
 * The page is served on the app's own origin, beside the stored owner key, so
 * its policy sandboxes it (an origin of its own) and allows no script at all:
 * never loosen it to allow-same-origin or allow-scripts. Every refusal is the
 * same 404, so a guess learns nothing.
 */

const PAGE_HEADERS = {
  ...HTML_PAGE_HEADERS,
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
};

export async function handlePage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return err(405, "GET only");
  const url = new URL(req.url);
  const id = url.pathname.slice("/api/v1/p/".length);
  const token = url.searchParams.get("k") ?? "";
  // Shapes first, so a guess costs nothing.
  const state = stateStub(env);
  const page = state && PAGE_ID.test(id) && (VIEW_TOKEN.test(token) || SHARE_TOKEN.test(token)) ? await state.pageOpen(id, token, Date.now()) : null;
  if (!page) return new Response("No such page.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(req.method === "HEAD" ? null : renderPage(page), { headers: PAGE_HEADERS });
}

export async function handlePageMeta(req: Request, env: Env, principal: Principal): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "pages need the STATE Durable Object");
  const url = new URL(req.url);
  const me = personOf(principal);
  const now = Date.now();
  const base = `${publicOrigin(env, url.origin)}/api/v1/p/`;
  if (url.pathname === "/api/page/share") {
    if (req.method === "POST") {
      // Public is the owner's call, as Hark's Share is: what a page says can come from mail or a calendar.
      if (!isAdmin(principal)) return err(403, "only those who run the house may share a page");
      const b = (await req.json().catch(() => null)) as { id?: unknown } | null;
      const id = typeof b?.id === "string" ? b.id : "";
      const token = PAGE_ID.test(id) ? await state.pageShare(me, id, now) : null;
      return token ? json({ shareUrl: `${base}${id}?k=${token}` }) : err(404, "no such page");
    }
    // Stopping is anyone's for a page of their own: someone who is no longer an admin can still take back a link.
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      return PAGE_ID.test(id) && (await state.pageUnshare(me, id, now)) ? json({ ok: true }) : err(404, "not shared");
    }
    return err(405, "POST or DELETE");
  }
  if (req.method !== "GET") return err(405, "GET only");
  const id = url.searchParams.get("id") ?? "";
  const page = PAGE_ID.test(id) ? await state.pageMine(me, id, now) : null;
  const view = page ? await state.pageView(me, id, now) : null;
  if (!page || !view) return err(404, "no such page");
  return json({ title: page.title, at: page.at, viewUrl: `${base}${id}?k=${view}`, shared: !!page.share, canShare: isAdmin(principal) });
}
