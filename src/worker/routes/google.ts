import type { Env } from "../types";
import { err, escapeHtml, HTML_PAGE_HEADERS } from "../lib/http";
import { withSettings } from "../lib/settings-store";
import {
  beginAuth,
  call,
  consumeState,
  exchangeCode,
  explain,
  googleConfig,
  isLinked,
  unlink,
} from "../lib/google";

/**
 * Linking Gmail, once.
 *
 * `/api/google/callback` is the second /api/ route not behind the shared secret,
 * for the same unavoidable reason as Spotify's: it arrives as a redirect from
 * Google's servers, which cannot carry our header. What stands in for it is the
 * `state` value — minted by an authenticated /auth call, held in KV for fifteen
 * minutes, good for one use. Without a matching state the callback refuses to
 * exchange anything.
 *
 * This is the shape to copy for a new OAuth integration rather than widening
 * the auth gate. It is copied deliberately and should stay copied.
 */

const page = (title: string, body: string, ok: boolean): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{background:#0b0d11;color:#e8ecf3;font:16px/1.6 system-ui,-apple-system,sans-serif;
      display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
 .c{max-width:32rem} h1{font-size:1.4rem;margin:0 0 .6rem;color:${ok ? "#4ade80" : "#f87171"}}
 p{margin:.4rem 0;color:#9aa6b8} code{color:#e8ecf3}
</style>
<div class="c"><h1>${title}</h1>${body}</div>`,
    { status: ok ? 200 : 400, headers: HTML_PAGE_HEADERS },
  );

export async function handleGoogle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  /* The redirect back from Google. Unauthenticated by necessity. */
  if (url.pathname === "/api/google/callback") {
    const denied = url.searchParams.get("error");
    if (denied) {
      // Attacker-controlled: anyone can craft this link. It was once echoed
      // raw, on the app's own origin, next to the stored owner key.
      return page("Not linked", `<p>Google said: <code>${escapeHtml(denied)}</code></p>`, false);
    }

    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code) return page("Not linked", "<p>Google sent no authorisation code.</p>", false);

    if (!(await consumeState(env, state))) {
      return page(
        "Not linked",
        "<p>That link has expired or was already used. Start again from the app.</p>",
        false,
      );
    }

    // Settings are read only now, after the single-use state has proven this
    // redirect was started by the owner: a stranger's request never reaches
    // storage. They may hold the client credentials, saved in the panel.
    const live = await withSettings(env);
    const cfg = googleConfig(live, url.origin);
    if (!cfg) return page("Not linked", "<p>Google is not configured any more.</p>", false);
    const r = await exchangeCode(live, cfg, code);
    if (!r.ok) return page("Not linked", `<p>${escapeHtml(r.detail)}</p>`, false);

    return page(
      "Gmail linked",
      "<p>Jarvis can read and send your mail now. You can close this tab.</p>",
      true,
    );
  }

  const cfg = googleConfig(env, url.origin);

  if (!cfg) {
    return err(503, "Gmail is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }

  /* Everything below this point is behind the shared secret (see index.ts). */

  if (url.pathname === "/api/google/auth") {
    const authUrl = await beginAuth(env, cfg);
    /*
     * Returned rather than redirected, so the caller decides where it opens.
     * Do this from a phone, not the car: the consent screen needs a Google
     * sign-in, and the app is unverified, so it shows a "Google hasn't verified
     * this app" interstitial that has to be clicked through under Advanced.
     * That is expected for a single-user app and does not mean anything failed.
     */
    return new Response(
      JSON.stringify({
        url: authUrl,
        redirectUri: cfg.redirectUri,
        note:
          "Open on a phone or laptop. The unverified-app warning is expected — " +
          "choose Advanced, then continue.",
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (url.pathname === "/api/google/unlink") {
    await unlink(env);
    return new Response(JSON.stringify({ ok: true, linked: false }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/api/google/status") {
    if (!(await isLinked(env))) {
      return new Response(JSON.stringify({ linked: false }), {
        headers: { "content-type": "application/json" },
      });
    }

    /*
     * A live call, not just "a refresh token exists in KV". The interesting
     * failures — a token revoked by a password change, or expired because the
     * consent screen is still in Testing — are invisible until something uses
     * it, and this endpoint exists precisely to find out.
     *
     * A THROWN failure is kept separate from an HTTP one. Refreshing the access
     * token happens before the request goes out, so NeedsRelink arrives as an
     * exception with no status at all — and `explain()` only speaks for a
     * response. Folding the two together reported `problem: null` alongside
     * `working: false`, which is the "failed with no reason given" this
     * codebase refuses to do anywhere else.
     */
    let status = 0;
    let body: unknown = null;
    let thrown: string | null = null;
    try {
      const r = await call(env, cfg, "/users/me/profile");
      status = r.status;
      body = r.body;
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }

    const p = body as { emailAddress?: string; messagesTotal?: number } | null;

    return new Response(
      JSON.stringify(
        {
          linked: true,
          working: status === 200,
          account: p?.emailAddress ?? null,
          messagesTotal: p?.messagesTotal ?? null,
          problem: thrown ?? explain({ status, body }),
        },
        null,
        2,
      ),
      { headers: { "content-type": "application/json" } },
    );
  }

  return err(404, `no route for ${url.pathname}`);
}
