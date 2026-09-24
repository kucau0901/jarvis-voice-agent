import type { Env } from "../types";
import { err, escapeHtml, HTML_PAGE_HEADERS } from "../lib/http";
import { withSettings } from "../lib/settings-store";
import {
  beginAuth,
  call,
  consumeState,
  exchangeCode,
  explain,
  isLinked,
  spotifyConfig,
  unlink,
} from "../lib/spotify";

/**
 * Linking Spotify, once.
 *
 * `/api/spotify/callback` is the single /api/ route not behind the shared
 * secret — it arrives as a redirect from Spotify's servers, which cannot carry
 * our header. What stands in for it is the `state` value: minted by an
 * authenticated /auth call, held in KV for fifteen minutes, and good for one
 * use. Without a matching state the callback refuses to exchange anything.
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

export async function handleSpotify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  /* The redirect back from Spotify. Unauthenticated by necessity. */
  if (url.pathname === "/api/spotify/callback") {
    const denied = url.searchParams.get("error");
    if (denied) {
      // Attacker-controlled: anyone can craft this link. It was once echoed
      // raw, on the app's own origin, next to the stored owner key.
      return page("Not linked", `<p>Spotify said: <code>${escapeHtml(denied)}</code></p>`, false);
    }

    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code) return page("Not linked", "<p>Spotify sent no authorisation code.</p>", false);

    if (!(await consumeState(env, state))) {
      // Either a replay, an expired link, or someone else's redirect.
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
    const cfg = spotifyConfig(live, url.origin);
    if (!cfg) return page("Not linked", "<p>Spotify is not configured any more.</p>", false);
    const r = await exchangeCode(live, cfg, code);
    if (!r.ok) return page("Not linked", `<p>${escapeHtml(r.detail)}</p>`, false);

    return page(
      "Spotify linked",
      "<p>Jarvis can see your music now. You can close this tab.</p>",
      true,
    );
  }

  const cfg = spotifyConfig(env, url.origin);

  if (!cfg) {
    return err(
      503,
      "Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
    );
  }

  /* Everything below this point is behind the shared secret (see index.ts). */

  if (url.pathname === "/api/spotify/auth") {
    const authUrl = await beginAuth(env, cfg);
    // Returned rather than redirected, so the caller decides where it opens —
    // a phone, not the car's browser, which cannot sign in to Spotify usefully.
    return new Response(JSON.stringify({ url: authUrl, redirectUri: cfg.redirectUri }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/api/spotify/unlink") {
    await unlink(env);
    return new Response(JSON.stringify({ ok: true, linked: false }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/api/spotify/status") {
    if (!(await isLinked(env))) {
      return new Response(JSON.stringify({ linked: false }), {
        headers: { "content-type": "application/json" },
      });
    }

    // The whole point of building this read-only first: find out what Spotify
    // can actually see while the car is playing. Devices and player state,
    // verbatim, with no interpretation layered on top.
    const [devices, player] = await Promise.all([
      call(env, cfg, "/me/player/devices"),
      call(env, cfg, "/me/player"),
    ]);

    return new Response(
      JSON.stringify(
        {
          linked: true,
          devices: devices.body ?? explain(devices),
          player: player.status === 204 ? "nothing playing" : (player.body ?? explain(player)),
        },
        null,
        2,
      ),
      { headers: { "content-type": "application/json" } },
    );
  }

  return err(404, `no route for ${url.pathname}`);
}
