import type { Env } from "../types";
import { publicOrigin } from "./http.ts";

/**
 * Google account access, for Gmail.
 *
 * The same shape as lib/spotify.ts, and deliberately so: a one-time
 * Authorization Code flow whose refresh token is kept in KV, because nobody can
 * type a refresh token in ahead of time. A new OAuth integration should copy
 * that shape rather than widen the auth gate, and this does.
 *
 * Google's own SDK is not an option here. `googleapis` depends on Node built-ins
 * and a Worker is a V8 isolate, not Node — so every call below is plain `fetch`
 * against the REST endpoints, which needs no compatibility flag.
 */

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
export const GMAIL = "https://gmail.googleapis.com/gmail/v1";
export const CALENDAR = "https://www.googleapis.com/calendar/v3";
export const PEOPLE = "https://people.googleapis.com/v1";

const REFRESH_KEY = "google:refresh";
const ACCESS_KEY = "google:access";
const STATE_PREFIX = "google:state:";

/**
 * Everything a person does with mail, except destroying it.
 *
 * This started as `gmail.readonly` + `gmail.send` on the argument that modify
 * can trash mail and a car has no undo. That was overruled deliberately: the
 * point of this assistant is to act, and read-and-send is a notetaker. So
 * `gmail.modify`, which covers reading, sending, replying, drafting, trashing,
 * archiving and labelling in one grant.
 *
 * Two things make that defensible rather than merely convenient:
 *
 *   - **Trash is not deletion.** `users.messages.trash` moves a message to
 *     Trash, where Gmail keeps it for 30 days, and `mail_manage` exposes the
 *     restore alongside it. The car now has an undo, which is the honest answer
 *     to the original objection.
 *   - **Permanent deletion is impossible by construction.** `gmail.modify`
 *     explicitly excludes it; that needs the full `mail.google.com` scope,
 *     which is NOT requested here and must not be added. No sequence of
 *     misheard words can destroy a message irrecoverably.
 *
 * `gmail.settings.*` stays absent for the original reason, which nothing here
 * changes: it is the scope that would let an instruction hidden in an email
 * body install an auto-forwarding rule, turning one bad turn into ongoing
 * exfiltration.
 *
 * Note that `gmail.modify` sits in the same RESTRICTED tier Google already put
 * `gmail.readonly` in, so this widens what the app can do without widening what
 * Google requires of it.
 */
/*
 * Calendar and Contacts ride the SAME client, token and callback as Gmail.
 *
 * That is the dividend of talking to Google directly instead of through an MCP
 * server: another service costs three lines here and a tool file, not another
 * deployment, another credential and another consent.
 *
 * `calendar.events` covers reading and creating events but NOT deleting a whole
 * calendar — the broader `calendar` scope does that, and is not requested.
 * `contacts.readonly` exists to answer one question: what address does "Sam"
 * mean? Without it `mail_send` can only refuse a name, which it should, because
 * guessing an address is how private mail reaches a stranger.
 *
 * Both are SENSITIVE rather than restricted — one tier below the Gmail scope
 * already granted — so neither adds anything to what Google asks of the project.
 *
 * WARNING: a refresh token carries the scopes it was granted with. Adding to
 * this list does NOT widen a token already sitting in KV; the new calls simply
 * 403 while everything else keeps working. Adding a scope means unlinking and
 * consenting again, which is why the full set is decided here in one go.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(env: Env, origin: string): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
    redirectUri: `${publicOrigin(env, origin)}/api/google/callback`,
  };
}

/**
 * Raised when the refresh token itself is dead rather than the request being
 * wrong. Distinguished because the fix is different and the user has to do it:
 * every other failure is worth retrying, this one needs a re-link from a phone.
 */
export class NeedsRelink extends Error {
  constructor(detail: string) {
    super(`Gmail needs re-linking: ${detail}`);
    this.name = "NeedsRelink";
  }
}

/* ---------- the one-time authorisation ------------------------------------ */

/**
 * The callback cannot carry the app's own auth header — it arrives as a
 * redirect from Google — so a single-use state value, minted by an
 * authenticated request and held briefly in KV, is what proves the callback
 * belongs to us. Identical to the Spotify flow.
 */
export async function beginAuth(env: Env, cfg: GoogleConfig): Promise<string> {
  const state = crypto.randomUUID();
  await env.CONFIG.put(STATE_PREFIX + state, "1", { expirationTtl: 900 });

  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: SCOPES,
    state,
    // Without access_type=offline Google returns no refresh token at all, and
    // the whole point here is a credential that outlives the browser tab.
    access_type: "offline",
    // Google issues a refresh token only on the FIRST consent for a given
    // client/user pair. Re-linking after a revoke would otherwise hand back an
    // access token and no refresh token, and the link would silently last an
    // hour. prompt=consent forces a new one every time.
    prompt: "consent",
    include_granted_scopes: "true",
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
  cfg: GoogleConfig,
  code: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!res.ok || !body.refresh_token) {
    // The commonest cause of a missing refresh_token is a re-consent without
    // prompt=consent, so say that rather than just echoing the status.
    const detail =
      body.error_description ??
      body.error ??
      (res.ok
        ? "Google returned no refresh token. Remove this app at myaccount.google.com/permissions and link again."
        : `status ${res.status}`);
    return { ok: false, detail };
  }

  await env.CONFIG.put(REFRESH_KEY, body.refresh_token);
  if (body.access_token) await cacheAccess(env, body.access_token, body.expires_in);
  return { ok: true };
}

export async function isLinked(env: Env): Promise<boolean> {
  return !!(await env.CONFIG.get(REFRESH_KEY).catch(() => null));
}

export async function unlink(env: Env): Promise<void> {
  const refresh = await env.CONFIG.get(REFRESH_KEY).catch(() => null);
  await Promise.all([
    env.CONFIG.delete(REFRESH_KEY).catch(() => {}),
    env.CONFIG.delete(ACCESS_KEY).catch(() => {}),
  ]);
  // Best effort: tell Google too, so the grant disappears from the account's
  // permissions page rather than lingering as a live token nobody is holding.
  if (refresh) {
    await fetch(REVOKE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }
}

/* ---------- using it ------------------------------------------------------ */

interface CachedAccess {
  token: string;
  /** Epoch ms after which this must not be used. */
  expiresAt: number;
}

/** Refresh this far before the real expiry, so a slow call cannot outlive it. */
const EXPIRY_MARGIN_MS = 120_000;

async function cacheAccess(env: Env, token: string, expiresIn = 3600): Promise<void> {
  const ttl = Math.max(60, Math.floor(expiresIn));
  const value: CachedAccess = { token, expiresAt: Date.now() + ttl * 1000 };
  // KV expires it too, so a stale entry cannot outlive the token it describes
  // even if nothing reads it for a week.
  await env.CONFIG.put(ACCESS_KEY, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {});
}

/**
 * An access token, cached.
 *
 * This is where Gmail deliberately diverges from lib/spotify.ts, which mints a
 * fresh token per request and says so. The trade is different here: Gmail is
 * meant to sit in the same latency tier as car_state, and a token POST to
 * Google is a few hundred milliseconds spent before the real request has even
 * started. A cached read is a KV get.
 *
 * The refresh race that argument worried about is benign for Google: two
 * concurrent refreshes both succeed, both tokens are valid, and the later write
 * wins. The only genuine hazard is handing out a token that expires mid-flight,
 * which the margin above covers.
 */
async function accessToken(env: Env, cfg: GoogleConfig): Promise<string> {
  const cached = (await env.CONFIG.get(ACCESS_KEY, "json").catch(() => null)) as
    | CachedAccess
    | null;
  if (cached?.token && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;

  const refresh = await env.CONFIG.get(REFRESH_KEY);
  if (!refresh) throw new Error("Gmail is not linked yet");

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !body.access_token) {
    /*
     * `invalid_grant` means the refresh token is gone, not that the call was
     * malformed — and for Gmail it is the failure mode to expect. Two causes,
     * both documented by Google and neither retryable:
     *
     *   - the OAuth consent screen is still in "Testing", where refresh tokens
     *     expire after exactly 7 days. Publishing to "In production" fixes it
     *     permanently and needs no verification review.
     *   - the account's password changed. Google revokes refresh tokens
     *     carrying Gmail scopes specifically when that happens, which Spotify
     *     never does — so this path matters here in a way it does not there.
     */
    if (body.error === "invalid_grant") {
      await env.CONFIG.delete(ACCESS_KEY).catch(() => {});
      throw new NeedsRelink(body.error_description ?? "the saved authorisation is no longer valid");
    }
    throw new Error(
      body.error_description ?? body.error ?? `could not refresh Google access (${res.status})`,
    );
  }

  // Google does not normally rotate the refresh token, but it is allowed to.
  if (body.refresh_token && body.refresh_token !== refresh) {
    await env.CONFIG.put(REFRESH_KEY, body.refresh_token);
  }
  await cacheAccess(env, body.access_token, body.expires_in);
  return body.access_token;
}

export interface GoogleResult {
  status: number;
  body: unknown;
}

/**
 * One authenticated call against a Google REST API.
 *
 * Defaults to Gmail because that is most of the traffic; pass `base` for
 * Calendar or People. One access token covers all three, since they are scopes
 * on a single grant rather than separate credentials.
 */
export async function call(
  env: Env,
  cfg: GoogleConfig,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; base?: string } = {},
): Promise<GoogleResult> {
  const token = await accessToken(env, cfg);
  const res = await fetch(`${init.base ?? GMAIL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (res.status === 204) return { status: res.status, body: null };
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Google's own words beat a status code invented here. */
export function explain(r: GoogleResult): string | null {
  if (r.status < 400) return null;
  const e = (r.body as { error?: { message?: string; status?: string } } | null)?.error;
  if (r.status === 401) return "Google rejected the saved authorisation. Gmail needs re-linking.";
  if (r.status === 403 && /insufficient/i.test(e?.message ?? "")) {
    return "That needs a Gmail permission this app was not granted. Re-link to grant it.";
  }
  if (r.status === 429) return "Google is rate limiting this account. Try again shortly.";
  return e?.message ? `Google: ${e.message}` : `Google returned ${r.status}.`;
}

/* ---------- base64url ------------------------------------------------------ */

/**
 * Gmail speaks base64url everywhere — message bodies coming out, whole RFC 2822
 * messages going in. Neither `atob` nor `btoa` knows about the URL alphabet or
 * about UTF-8, so both directions need the byte layer doing explicitly.
 */

export function b64urlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  // Chunked: spreading a large array into String.fromCharCode blows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
