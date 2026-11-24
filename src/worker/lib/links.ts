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

/* ---------- which of an answer's links were on a page the job saw ---------------- */

const LINK = /https?:\/\/[^\s<>()\[\]"'`]{3,2000}/g;
const trimmed = (url: string) => url.replace(/[.,;:!?…]+$/, "");

/** An address as it is compared: no tracking tags, no www, no part of the page; its query apart. */
function pageOf(url: string): { page: string; query: string } | null {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
    u.searchParams.sort();
    return { page: `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`, query: u.searchParams.toString() };
  } catch {
    return null;
  }
}

/** Every address in text, as compared: with its query, if it has one. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK)].flatMap((m) => {
    const p = pageOf(trimmed(m[0]));
    return p ? [p.query ? `${p.page}?${p.query}` : p.page] : [];
  });
}

/** The pages a response's own web searches opened or were given, beside those it cited. */
export function searchedIn(output: readonly unknown[]): string[] {
  const urls: string[] = [];
  for (const item of output) {
    if (!isObj(item) || item.type !== "web_search_call" || !isObj(item.action)) continue;
    if (typeof item.action.url === "string") urls.push(item.action.url);
    for (const s of Array.isArray(item.action.sources) ? item.action.sources : []) if (isObj(s) && typeof s.url === "string") urls.push(s.url);
  }
  return [...urls, ...citationsOf(output).map((c) => c.url)].flatMap(linksIn);
}

/**
 * An answer with "(not checked)" after each address that was on nothing it
 * read. One with no query is on record if any address of that page is; one
 * with a query only as it was seen, since a query can carry anything.
 */
export function markUnseen(text: string, seen: ReadonlySet<string>): string {
  const pages = new Set([...seen].map((s) => s.split("?")[0]!));
  // A markdown link's note goes after its closing bracket.
  return text.replace(/\[[^\]\n]{1,160}\]\((https?:\/\/[^\s)]{1,2000})\)|https?:\/\/[^\s<>()\[\]"'`]{3,2000}/g, (whole, inside?: string) => {
    const url = inside ?? trimmed(whole);
    const [as] = linksIn(url);
    const known = as === undefined || seen.has(as) || (!as.includes("?") && pages.has(as));
    if (known) return whole;
    return inside ? `${whole} (not checked)` : `${url} (not checked)${whole.slice(url.length)}`;
  });
}
