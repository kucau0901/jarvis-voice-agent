import { b64u } from "./webauthn.ts";
import { sha256Hex } from "./devices.ts";
import type { Grant } from "./scopes.ts";
import type { Storage } from "./state-host.ts";

/**
 * OAuth for MCP clients that will only sign in that way: grok.com's custom
 * connectors (lib/mcp-server.ts). Its one job is to hand the client a device
 * token. A person signed in to Jarvis sees what is asking, picks what it may
 * reach and presses Allow; the client trades the one-time code for a token;
 * from then on it is a device like any other, in Devices, revoked there.
 *
 * The authorization code grant with PKCE (S256), for public clients only: no
 * client secret, no registration, and no refresh token, since a device token
 * does not expire. The codes are kept in the Durable Object (lib/hub.ts),
 * under the digest of the code, never the code itself.
 */

export const CODE_MS = 5 * 60_000;
/** A person's codes waiting to be traded at once: one member's cannot crowd out another's. */
const MAX_CODES = 5;
const PREFIX = "oauth:code:";

/** What the client asked for, as it came to the authorization endpoint. */
export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

/** What a code stands for until it is traded. */
export interface CodeGrant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  /** Whose device it will be. */
  person: string;
  scopes: Grant[];
  exp: number;
}

/** RFC 7636's code_verifier and S256 challenge alphabets and lengths. */
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const CLIENT = /^[\x21-\x7e]{1,64}$/;

/** The request, or why it cannot be one. */
export function readAuthRequest(q: URLSearchParams): AuthRequest | string {
  const clientId = q.get("client_id") ?? "";
  if (!CLIENT.test(clientId)) return "client_id is missing or not plain text";
  let redirect: URL;
  try {
    redirect = new URL(q.get("redirect_uri") ?? "");
  } catch {
    return "redirect_uri is missing or not an address";
  }
  if (redirect.protocol !== "https:" || redirect.hash) return "redirect_uri must be an https address with no fragment";
  if (q.get("response_type") !== "code") return "response_type must be code";
  if (q.get("code_challenge_method") !== "S256") return "code_challenge_method must be S256";
  const challenge = q.get("code_challenge") ?? "";
  if (!PKCE.test(challenge)) return "code_challenge is missing";
  const state = q.get("state") ?? "";
  if (state.length > 512) return "state is too long";
  return { clientId, redirectUri: redirect.href, state, challenge };
}

/** Where the person goes back to once they allow it: the client's address, with the code. */
export function backTo(r: AuthRequest, code: string): string {
  const u = new URL(r.redirectUri);
  u.searchParams.set("code", code);
  if (r.state) u.searchParams.set("state", r.state);
  return u.href;
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!PKCE.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64u(digest) === challenge;
}

/** A trade that fails says only invalid_grant, as RFC 6749 has it, whichever part was wrong. */
export async function tradeOk(
  g: CodeGrant | null,
  form: { clientId: string; redirectUri: string; verifier: string },
): Promise<boolean> {
  return !!g && g.clientId === form.clientId && g.redirectUri === form.redirectUri && (await pkceMatches(form.verifier, g.challenge));
}

export class OAuthCodes {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** A new code for this grant, or null with too many waiting. */
  async issue(g: Omit<CodeGrant, "exp">, now: number): Promise<string | null> {
    let live = 0;
    for (const [k, c] of await this.storage.list<CodeGrant>({ prefix: PREFIX })) {
      if (c.exp < now) await this.storage.delete(k);
      else if (c.person === g.person) live++;
    }
    if (live >= MAX_CODES) return null;
    const code = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await this.storage.put(PREFIX + (await sha256Hex(code)), { ...g, exp: now + CODE_MS });
    return code;
  }

  /** A code, once: taking it spends it, good or not. */
  async take(code: string, now: number): Promise<CodeGrant | null> {
    const key = PREFIX + (await sha256Hex(code));
    const g = await this.storage.get<CodeGrant>(key);
    if (!g) return null;
    await this.storage.delete(key);
    return g.exp < now ? null : g;
  }
}
