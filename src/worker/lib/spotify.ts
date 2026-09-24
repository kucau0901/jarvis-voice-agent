import type { Env } from "../types";
import { publicOrigin } from "./http.ts";

/**
 * Spotify Web API access.
 *
 * Playback needs user authorisation — client credentials only reach the public
 * catalogue — so this is a one-time Authorization Code flow whose refresh token
 * is kept in KV. The refresh token cannot be a Worker secret because it is
 * obtained at runtime by the callback, not typed in by a person.
 */

const AUTH = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
export const API = "https://api.spotify.com/v1";

const TOKEN_KEY = "spotify:refresh";
const STATE_PREFIX = "spotify:state:";

/** Enough to see what is playing, control it, and reach saved music. */
export const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function spotifyConfig(env: Env, origin: string): SpotifyConfig | null {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
  return {
    clientId: env.SPOTIFY_CLIENT_ID,
    clientSecret: env.SPOTIFY_CLIENT_SECRET,
    redirectUri: `${publicOrigin(env, origin)}/api/spotify/callback`,
  };
}

const basic = (c: SpotifyConfig) => btoa(`${c.clientId}:${c.clientSecret}`);

/* ---------- the one-time authorisation ------------------------------------ */

/**
 * The callback cannot carry the app's own auth header — it arrives as a redirect
 * from Spotify — so a single-use state value, minted by an authenticated request
 * and held briefly in KV, is what proves the callback belongs to us.
 */
export async function beginAuth(env: Env, cfg: SpotifyConfig): Promise<string> {
  const state = crypto.randomUUID();
  await env.CONFIG.put(STATE_PREFIX + state, "1", { expirationTtl: 900 });

  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: SCOPES,
    state,
    show_dialog: "false",
  });
  return `${AUTH}?${p}`;
}

export async function consumeState(env: Env, state: string): Promise<boolean> {
  if (!state) return false;
  const key = STATE_PREFIX + state;
  const found = await env.CONFIG.get(key);
  if (!found) return false;
  // Single use, so a replayed callback cannot mint a second token.
  await env.CONFIG.delete(key);
  return true;
}

export async function exchangeCode(
  env: Env,
  cfg: SpotifyConfig,
  code: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic(cfg)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.refresh_token) {
    return { ok: false, detail: body.error_description ?? body.error ?? `status ${res.status}` };
  }
  await env.CONFIG.put(TOKEN_KEY, body.refresh_token);
  return { ok: true };
}

export async function isLinked(env: Env): Promise<boolean> {
  return !!(await env.CONFIG.get(TOKEN_KEY).catch(() => null));
}

export async function unlink(env: Env): Promise<void> {
  await env.CONFIG.delete(TOKEN_KEY).catch(() => {});
}

/* ---------- using it ------------------------------------------------------ */

/**
 * Access tokens last an hour and are cheap to mint, so one is fetched per
 * request rather than cached. Caching would mean holding an expiry alongside it
 * and getting the refresh race right, for a saving of a few hundred
 * milliseconds on a path that is already talking to Spotify.
 */
async function accessToken(env: Env, cfg: SpotifyConfig): Promise<string> {
  const refresh = await env.CONFIG.get(TOKEN_KEY);
  if (!refresh) throw new Error("Spotify is not linked yet");

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic(cfg)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? `could not refresh Spotify access (${res.status})`);
  }
  // Spotify occasionally rotates the refresh token; losing it means re-linking.
  if (body.refresh_token && body.refresh_token !== refresh) {
    await env.CONFIG.put(TOKEN_KEY, body.refresh_token);
  }
  return body.access_token;
}

export interface SpotifyResult {
  status: number;
  body: unknown;
}

/** One authenticated call. 204 (common for playback commands) has no body. */
export async function call(
  env: Env,
  cfg: SpotifyConfig,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<SpotifyResult> {
  const token = await accessToken(env, cfg);
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (res.status === 204 || res.status === 202) return { status: res.status, body: null };
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Spotify's own words are more useful than a status code invented here. */
export function explain(r: SpotifyResult): string | null {
  if (r.status < 400) return null;
  const e = (r.body as { error?: { message?: string; reason?: string } } | null)?.error;
  if (r.status === 404 && e?.reason === "NO_ACTIVE_DEVICE") {
    return "Spotify has no active device — start playing something on a phone or speaker first.";
  }
  if (r.status === 403 && e?.reason === "PREMIUM_REQUIRED") {
    return "That needs Spotify Premium.";
  }
  return e?.message ? `Spotify: ${e.message}` : `Spotify returned ${r.status}.`;
}
