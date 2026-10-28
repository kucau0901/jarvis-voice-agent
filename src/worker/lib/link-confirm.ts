import type { Env } from "../types.ts";
import { escapeHtml, HTML_PAGE_HEADERS } from "./http.ts";
import { personView } from "./hub-client.ts";

/**
 * Before a Google or Spotify account is linked (routes/google.ts,
 * routes/spotify.ts): whose Jarvis it goes to, asked of whoever is at the
 * consent screen. The link is started by someone signed in, but the account
 * is chosen by whoever finishes it, who may not be them: a family member sent
 * the link "to fix the mail" would otherwise hand the starter their mailbox
 * without being told. So the callback names the person first, and links only
 * when this page is sent back.
 */

/** The person's name, as the family knows them. */
export async function nameOf(env: Env, person: string): Promise<string> {
  const v = await personView(env, person).catch(() => null);
  return v?.name?.trim() || (person === "owner" ? "the owner" : "someone in the family");
}

/** The callback's fields: from Google's redirect, or from this page sent back. */
export async function callbackFields(req: Request): Promise<URLSearchParams> {
  if (req.method !== "POST") return new URL(req.url).searchParams;
  return new URLSearchParams((await req.text()).slice(0, 4096));
}

/** The question, and the one form that answers it: back to the same address, nowhere else. */
export function confirmLink(o: { account: string; does: string; name: string; path: string; state: string; code: string }): Response {
  const name = escapeHtml(o.name);
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link ${escapeHtml(o.account)}?</title>
<style>
 body{background:#0b0d11;color:#e8ecf3;font:16px/1.6 system-ui,-apple-system,sans-serif;
      display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
 .c{max-width:32rem} h1{font-size:1.4rem;margin:0 0 .6rem} p{margin:.4rem 0;color:#9aa6b8} b{color:#e8ecf3}
 button{margin-top:1rem;font:inherit;font-weight:600;padding:.7rem 1.4rem;border-radius:999px;border:0;background:#3e6ae1;color:#fff}
</style>
<div class="c"><h1>Link this ${escapeHtml(o.account)} to <b>${name}</b>?</h1>
<p>${name}'s Jarvis will be able to ${escapeHtml(o.does)}.</p>
<p>If you are not ${name}, close this page: nothing is linked.</p>
<form method="post" action="${escapeHtml(o.path)}">
<input type="hidden" name="state" value="${escapeHtml(o.state)}">
<input type="hidden" name="code" value="${escapeHtml(o.code)}">
<button type="submit">Link it to ${name}</button>
</form></div>`,
    // As the other pages: no script at all, only the form back to here.
    { status: 200, headers: { ...HTML_PAGE_HEADERS, "content-security-policy": HTML_PAGE_HEADERS["content-security-policy"].replace("form-action 'none'", "form-action 'self'") } },
  );
}
