import { SdkHttpError } from "@modelcontextprotocol/client";
import { redact } from "../lib/http.ts";
import type { Remote } from "./mcp.ts";

/**
 * A component's MCP server, as Jarvis reaches it (lib/components.ts,
 * tools/mcp.ts): by the address an admin gave, with its key as a Bearer
 * credential and, when a person is asking, who they are in its own system.
 * Neither goes along a redirect, and nothing else of Jarvis goes at all: not
 * a name, not a Jarvis id.
 */
export const remoteOf = (c: { label: string; name: string; url: string; key?: string }, as?: string): Remote => ({
  label: c.label,
  url: c.url,
  spokenAs: c.name,
  component: true,
  headers: { ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}), ...(as ? { "X-Jarvis-Person": as } : {}) },
});

/** As much of a failure as is shown or told. */
const MAX_FAILURE = 200;

/**
 * Why reaching a component failed, in words fit to show: an error page or a
 * transport error can quote its key back, so the key is taken out first,
 * then anything else that looks like a credential (lib/http.ts redact).
 */
export function failureOf(e: unknown, key?: string): string {
  if (e instanceof SdkHttpError && e.status >= 300 && e.status < 400) {
    return "it answered with a redirect, which is not followed with its key. Its address may have moved: add it again with the new one.";
  }
  const said = e instanceof Error ? e.message : String(e);
  return redact(key ? said.split(key).join("***") : said).slice(0, MAX_FAILURE);
}
