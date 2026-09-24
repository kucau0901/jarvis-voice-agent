export const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init?.headers },
  });

export const err = (status: number, message: string, extra?: Record<string, unknown>) =>
  json({ error: message, ...extra }, { status });

/**
 * The origin people actually reach Jarvis at.
 *
 * On Cloudflare that is simply the request's own origin. Behind a reverse
 * proxy — Docker with Caddy in front, say — the Worker sees the proxy's plain
 * http hop, and an OAuth redirect built from it ("http://…/callback") is one
 * Google refuses. PUBLIC_URL, set in the settings panel, overrides it.
 */
export function publicOrigin(env: { PUBLIC_URL?: string }, origin: string): string {
  try {
    return env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : origin;
  } catch {
    return origin;
  }
}

/** For putting untrusted text inside HTML. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * For the few HTML pages the Worker renders itself (the OAuth callbacks): no
 * script of any kind, from anywhere. Those pages live on the app's own origin,
 * next to the stored owner key, so an injection there would be an injection
 * into the app.
 */
export const HTML_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Strip anything that looks like a credential before a value reaches a log. */
export function redact(s: string): string {
  return s
    .replace(/\b(sk|ek)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***");
}
