import type { Env } from "../types";

/**
 * Cross-origin access, for clients that are browsers somewhere else.
 *
 * None of this affects an ESP32 or any other native client: CORS is enforced by
 * browsers, not by servers, so a raw HTTP client never sees it. It exists only
 * for something like a pair of smartglasses running a WebView on its own origin.
 *
 * If such a client can simply load the app from this domain, none of this is
 * needed — that is the cheaper path and the one to prefer.
 */

const ALLOWED_HEADERS = "authorization, x-jarvis-key, content-type";
/**
 * Retry-After is not a CORS-safelisted response header, so without naming it
 * here a cross-origin client cannot read the backoff hint on a 429 — it would
 * see the status and no guidance.
 */
const EXPOSED_HEADERS = "retry-after";
const MAX_AGE = "86400";

/**
 * Exact string match only.
 *
 * No suffix or regex matching, ever: suffix matching is precisely how
 * `jarvis.example.com.attacker.net` gets itself allowed.
 */
export function originAllowed(origin: string | null, allowList: string | undefined): boolean {
  if (!origin || !allowList) return false;
  return allowList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

export function corsHeaders(
  origin: string | null,
  allowList: string | undefined,
): Record<string, string> {
  if (!originAllowed(origin, allowList)) return {};
  return {
    // The matched origin, never "*". The credential here is a bearer token, and
    // a wildcard would let any page a device happens to visit spend the owner's
    // OpenAI budget.
    "access-control-allow-origin": origin!,
    "access-control-expose-headers": EXPOSED_HEADERS,
    // Without this a cache can hand one origin's allow header to another —
    // /api/map is cached for a day, so this is not hypothetical.
    vary: "Origin",
  };
}

/**
 * Answer a preflight.
 *
 * This must run BEFORE authorisation. A browser sends no custom headers on a
 * preflight, so requiring a credential here would 401 every preflight and the
 * real request would never be issued at all. A preflight is unauthenticated by
 * protocol necessity — the same category as the Spotify OAuth callback — and it
 * reveals only whether an origin is allowed, which is not sensitive.
 */
export function preflight(req: Request, env: Env): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (!originAllowed(origin, env.JARVIS_ALLOWED_ORIGINS)) {
    // No CORS headers: the browser blocks it, which is the correct outcome.
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, env.JARVIS_ALLOWED_ORIGINS),
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": ALLOWED_HEADERS,
      "access-control-max-age": MAX_AGE,
      // Deliberately NOT Access-Control-Allow-Credentials: this API authenticates
      // with a header, not a cookie, so credentials mode buys nothing and would
      // widen what a hostile page could attempt.
    },
  });
}

/** Attach the response-side headers, leaving the body and status untouched. */
export function withCors(res: Response, origin: string | null, env: Env): Response {
  // A WebSocket upgrade cannot be rebuilt — the socket would be lost — and
  // CORS does not apply to WebSockets anyway.
  if (res.status === 101) return res;
  const extra = corsHeaders(origin, env.JARVIS_ALLOWED_ORIGINS);
  if (!Object.keys(extra).length) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
