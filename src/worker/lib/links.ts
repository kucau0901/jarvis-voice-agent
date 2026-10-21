import type { Cited } from "./jobs.ts";

/**
 * The pages an answer cited, from its web search's url_citation annotations,
 * on the key and the plan alike: a research report's Sources list
 * (lib/jobs.ts), and the link cards under a typed answer (lib/router-loop.ts,
 * src/app/ui/rich.ts).
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** Read off a response's output items, whatever else they hold. */
export function citationsOf(output: readonly unknown[]): Cited[] {
  const out: Cited[] = [];
  for (const item of output) {
    if (!isObj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObj(part) || part.type !== "output_text" || !Array.isArray(part.annotations)) continue;
      for (const a of part.annotations) {
        if (isObj(a) && a.type === "url_citation" && typeof a.url === "string") out.push({ url: a.url, ...(typeof a.title === "string" ? { title: a.title } : {}) });
      }
    }
  }
  return out;
}

/** Web pages only, each once, without the tracking tags that make one page look like several; the first `max`. */
export function sourcesOf(cited: readonly Cited[], max: number): Cited[] {
  const seen = new Set<string>();
  const out: Cited[] = [];
  for (const c of cited) {
    let url: string;
    try {
      const u = new URL(c.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
      url = u.toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, ...(c.title?.trim() ? { title: c.title.trim() } : {}) });
    if (out.length === max) break;
  }
  return out;
}
