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

/**
 * A request's body as text, or null past `max` bytes: read no further than
 * that, whatever its content-length says. Some routes are reached before any
 * credential, and a huge body must not be held in memory only to be refused.
 */
export async function readText(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** The most readObjectOrEmpty() reads: its bodies are a few fields of text. */
const OBJECT_MAX = 64 * 1024;

/**
 * A request's body as a JSON object of at most `max` bytes, or null for
 * anything else: not JSON, not an object (an array, a number, null), or too
 * big. An empty body is an empty object.
 */
export async function readObject(req: Request, max: number): Promise<Record<string, unknown> | null> {
  const raw = await readText(req, max);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** A request's body as a JSON object; anything else (not JSON, an array, a number, null, over 64 KB) is an empty one. */
export async function readObjectOrEmpty(req: Request): Promise<Record<string, unknown>> {
  return (await readObject(req, OBJECT_MAX)) ?? {};
}
