import { b64u, fromB64u } from "./webauthn.ts";
import type { Storage } from "./state-host.ts";

/**
 * The owner's ChatGPT plan, which Jarvis's model calls use before any API
 * key ("Sign in with ChatGPT" plan usage, developers.openai.com/siwc). One
 * plan for the house: the owner connects it in Settings, and every question
 * in the family comes out of its included usage. GPT-Live is not part of it,
 * so live voice still needs OPENAI_API_KEY (docs/DESIGN.md).
 *
 * Signing in is OAuth with PKCE for a public client, whose redirect must be a
 * loopback address. A Worker cannot listen there, so the browser ends on a
 * page that does not load, and the owner pastes its address into Settings,
 * where the code is traded here: the remote-host case OpenAI describes, with
 * this object owning the refreshes. The session is kept in the object, never
 * in KV, and no token leaves it but the access token a model call needs.
 */

export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const ISSUER = "https://auth.openai.com";
/** Where plan requests go, whatever OPENAI_BASE_URL says: that may be a proxy holding the key. */
export const PLAN_BASE = "https://api.openai.com/v1";
export const REDIRECT = "http://127.0.0.1:1455/auth/callback";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** A sign-in started is good for this long. */
export const PENDING_MS = 10 * 60_000;
/** Refreshed this long before the access token runs out, if not allowed sooner. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** After the plan's limit, the key is used for this long before the plan is tried again. */
export const LIMIT_MS = 60 * 60_000;

const K = {
  host: "chatgpt:host",
  client: "chatgpt:client",
  pending: "chatgpt:pending",
  session: "chatgpt:session",
};

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export interface PlanSession {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  /** Not refreshed before this (the token response's earliest_refresh_at). */
  refreshAfter: number;
  email: string;
  sub: string;
  /** The plan's model for Jarvis's questions, chosen in Settings; null for the router model. */
  model: string | null;
  /** The plan's limit was reached: the key is used until then. */
  limitedUntil?: number;
  /** Why the plan cannot be used now, until it is fixed in Settings. */
  problem?: string;
}

export interface PlanStatus {
  connected: boolean;
  email?: string;
  model?: string | null;
  limitedUntil?: number;
  problem?: string;
  /** A sign-in under way, waiting for the pasted address. */
  pending: boolean;
}

/** A plan request's failure, by OpenAI's error code (developers.openai.com/siwc, "Errors and recovery"). */
export type PlanFailure = "limit" | "unavailable" | "signin" | "not_eligible" | "unsupported";

export function planFailureOf(code: unknown): PlanFailure | null {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return "limit";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "unavailable";
    case "subscription_sharing_invalid_user":
      return "signin";
    case "subscription_sharing_user_not_eligible":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "not_eligible";
    case "subscription_sharing_unsupported_capability":
    case "subscription_sharing_route_not_supported":
      return "unsupported";
    default:
      return null;
  }
}

/** What a failure says to the owner, in Settings and in the one alert. */
export const FAILURE_SAYS: Record<PlanFailure, string> = {
  limit: "The ChatGPT plan's usage limit is reached (chatgpt.com/settings/usage).",
  unavailable: "ChatGPT plan usage is unavailable just now.",
  signin: "ChatGPT did not accept the sign-in: connect it again in Settings.",
  not_eligible: "This ChatGPT account cannot share its plan (Plus or Pro is needed).",
  unsupported: "The ChatGPT plan refused part of a request.",
};

type Fetch = typeof fetch;

const random = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));

async function challengeOf(verifier: string): Promise<string> {
  return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

/** The pasted address's query: a whole address, or only what follows its "?". */
function pastedParams(pasted: string): URLSearchParams | null {
  const t = pasted.trim();
  if (!t) return null;
  try {
    return new URL(t).searchParams;
  } catch {
    const q = t.includes("?") ? t.slice(t.indexOf("?") + 1) : t;
    const p = new URLSearchParams(q);
    return p.has("state") || p.has("code") || p.has("error") ? p : null;
  }
}

interface IdClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
}

/**
 * The ID token's claims, once its RS256 signature checks against OpenAI's
 * published keys and it is ours: issuer, audience (the issued client id),
 * nonce and expiry. A string says what is wrong.
 */
export async function verifyIdToken(
  jwt: string,
  want: { clientId: string; nonce: string; now: number },
  keys: { kid?: string; kty?: string; n?: string; e?: string }[],
): Promise<IdClaims | string> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return "the ID token is not a JWT";
  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64u(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!)));
  } catch {
    return "the ID token cannot be read";
  }
  if (header.alg !== "RS256") return "the ID token is not RS256";
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk?.n || !jwk.e) return "the ID token's key is not among OpenAI's";
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64u(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return "the ID token's signature does not check";
  if (claims.iss !== ISSUER) return "the ID token is not OpenAI's";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(want.clientId)) return "the ID token is for another app";
  if (claims.nonce !== want.nonce) return "the ID token is from another sign-in";
  if (typeof claims.exp !== "number" || claims.exp * 1000 < want.now) return "the ID token has expired";
  if (typeof claims.sub !== "string" || !claims.sub) return "the ID token names no account";
  return claims;
}

const scopesOf = (v: unknown): string[] => (typeof v === "string" ? v.split(/[\s+]+/).filter(Boolean) : Array.isArray(v) ? v.map(String) : []);

/** A token response's tokens and times, kept as a session's. */
function tokensOf(t: Record<string, unknown>, now: number): Pick<PlanSession, "accessToken" | "refreshToken" | "expiresAt" | "refreshAfter"> | null {
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string") return null;
  const expiresAt = now + (Number(t.expires_in) > 0 ? Number(t.expires_in) * 1000 : 3_600_000);
  const earliest = Number(t.earliest_refresh_at) > 0 ? Number(t.earliest_refresh_at) * 1000 : 0;
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt, refreshAfter: Math.min(earliest || expiresAt - REFRESH_MARGIN_MS, expiresAt - REFRESH_MARGIN_MS) };
}

/** A refresh error that means signing in again, rather than trying later. */
const DEAD = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export class ChatGptPlan {
  private storage: Storage;
  private fetch: Fetch;
  /** A refresh under way: the object lets other calls in while it waits on the network, and they share it. */
  private refreshing: Promise<{ token: string; model: string | null } | null> | null = null;

  constructor(storage: Storage, fetcher: Fetch) {
    this.storage = storage;
    this.fetch = fetcher;
  }

  async status(now: number): Promise<PlanStatus> {
    const [s, p] = await Promise.all([this.storage.get<PlanSession>(K.session), this.storage.get<Pending>(K.pending)]);
    return {
      connected: !!s,
      pending: !!p && p.exp > now,
      ...(s ? { email: s.email, model: s.model, ...(s.limitedUntil && s.limitedUntil > now ? { limitedUntil: s.limitedUntil } : {}), ...(s.problem ? { problem: s.problem } : {}) } : {}),
    };
  }

  /** The address to sign in at. This host keeps one id, and the client id once OpenAI has issued it. */
  async start(now: number): Promise<string> {
    let host = await this.storage.get<string>(K.host);
    if (!host) await this.storage.put(K.host, (host = `urn:uuid:${crypto.randomUUID()}`));
    const client = await this.storage.get<string>(K.client);
    const pending: Pending = { state: random(16), nonce: random(16), verifier: random(32), exp: now + PENDING_MS };
    await this.storage.put(K.pending, pending);
    const q = new URLSearchParams({
      client_id: client ?? "dynamic_agent_client",
      // The app's name only on the first registration, as OpenAI asks.
      ...(client ? {} : { agent_name_hint: "Jarvis" }),
      ext_agent_host_id: host,
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: SCOPE,
      resource: PLAN_BASE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: "S256",
      code_challenge: await challengeOf(pending.verifier),
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  /** The address the browser ended on, pasted: traded for the session. A string says why not. */
  async finish(pasted: string, now: number): Promise<PlanStatus | string> {
    const p = pastedParams(pasted);
    if (!p) return "Paste the whole address the browser ended on, starting http://127.0.0.1.";
    const pending = await this.storage.get<Pending>(K.pending);
    if (!pending || pending.exp < now) return "That sign-in has expired: press Connect again.";
    if (p.get("state") !== pending.state) return "That address is from another sign-in: press Connect again and paste the newest one.";
    // Spent either way: a code is traded once.
    await this.storage.delete(K.pending);
    if (p.get("error")) return p.get("error") === "access_denied" ? "Not connected: the request was declined." : `Not connected: ChatGPT said ${p.get("error")}.`;
    const code = p.get("code");
    const saved = await this.storage.get<string>(K.client);
    const issued = p.get("client_id");
    if (saved && issued && issued !== saved) return "That address is for another registration: press Connect again.";
    const clientId = saved ?? issued;
    if (!code || !clientId) return "That address has no code: press Connect again.";

    const r = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: REDIRECT, resource: PLAN_BASE }),
    });
    const t = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) return `ChatGPT did not accept the sign-in (${String(t.error ?? r.status)}): press Connect again.`;
    const tokens = tokensOf(t, now);
    if (!tokens || typeof t.id_token !== "string") return "ChatGPT's answer had no tokens: press Connect again.";
    if (!scopesOf(t.scope).includes(PLAN_SCOPE)) return "Using the plan was not allowed: press Connect again and allow it.";
    const jwks = (await (await this.fetch(JWKS_URL)).json().catch(() => ({}))) as { keys?: [] };
    const claims = await verifyIdToken(t.id_token, { clientId, nonce: pending.nonce, now }, jwks.keys ?? []);
    if (typeof claims === "string") return `Not connected: ${claims}.`;

    await this.storage.put(K.client, clientId);
    const before = await this.storage.get<PlanSession>(K.session);
    await this.storage.put(K.session, { ...tokens, email: typeof claims.email === "string" ? claims.email : "", sub: String(claims.sub), model: before?.model ?? null } satisfies PlanSession);
    return this.status(now);
  }

  /**
   * An access token for a model call, refreshed first when due; null when
   * there is no usable plan (none, limited, or needing a sign-in). Calls that
   * arrive during a refresh wait for it, so two never race a rotating token,
   * as OpenAI asks.
   */
  async accessToken(now: number): Promise<{ token: string; model: string | null } | null> {
    if (this.refreshing) return this.refreshing;
    const s = await this.storage.get<PlanSession>(K.session);
    if (!s || s.problem || (s.limitedUntil && s.limitedUntil > now)) return null;
    if (now < s.refreshAfter) return { token: s.accessToken, model: s.model };
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh(s, now).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(s: PlanSession, now: number): Promise<{ token: string; model: string | null } | null> {
    const client = await this.storage.get<string>(K.client);
    let r: Response;
    try {
      r = await this.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: client ?? "", refresh_token: s.refreshToken, resource: PLAN_BASE }),
      });
    } catch {
      // A network failure is not a lost sign-in: the old token while it lasts.
      return now < s.expiresAt ? { token: s.accessToken, model: s.model } : null;
    }
    const t = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const tokens = r.ok ? tokensOf(t, now) : null;
    if (!tokens) {
      if (DEAD.has(String(t.error))) {
        await this.storage.put(K.session, { ...s, problem: FAILURE_SAYS.signin });
        return null;
      }
      return now < s.expiresAt ? { token: s.accessToken, model: s.model } : null;
    }
    await this.storage.put(K.session, { ...s, ...tokens });
    return { token: tokens.accessToken, model: s.model };
  }

  /** A plan call failed: at the limit the key is used for a while; a sign-in or eligibility problem until fixed. */
  async failed(why: PlanFailure, now: number): Promise<{ first: boolean }> {
    const s = await this.storage.get<PlanSession>(K.session);
    if (!s) return { first: false };
    if (why === "limit") {
      // Said once a day at most, not each hour the plan is tried again.
      const first = !s.limitedUntil || now - s.limitedUntil > 24 * 60 * 60_000;
      await this.storage.put(K.session, { ...s, limitedUntil: now + LIMIT_MS });
      return { first };
    }
    if (why === "signin" || why === "not_eligible") {
      await this.storage.put(K.session, { ...s, problem: FAILURE_SAYS[why] });
      return { first: !s.problem };
    }
    return { first: false };
  }

  async setModel(model: string | null): Promise<boolean> {
    const s = await this.storage.get<PlanSession>(K.session);
    if (!s) return false;
    await this.storage.put(K.session, { ...s, model });
    return true;
  }

  /** Disconnected: the refresh token revoked and the session forgotten. The host and client ids stay, as OpenAI asks. */
  async disconnect(): Promise<void> {
    const s = await this.storage.get<PlanSession>(K.session);
    await this.storage.delete(K.session);
    await this.storage.delete(K.pending);
    if (!s) return;
    const client = await this.storage.get<string>(K.client);
    await this.fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: client ?? "" }),
    }).catch(() => {});
  }
}
