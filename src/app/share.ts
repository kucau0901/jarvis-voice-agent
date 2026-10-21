/**
 * What another app shared into Jarvis: a phone's share sheet posts it to
 * /share, where the service worker keeps it and opens /?shared=1
 * (public/sw.js). Taken here once, then deleted: the words go in the message
 * box and the files are attached, never sent, as Hark's web app has no way
 * to do at all.
 */

/** The service worker's cache of the newest share (public/sw.js). */
const SHARED = "jarvis-shared";

export interface Shared {
  text: string;
  files: File[];
}

/** A share waiting for this page, taken off the address bar and out of the cache; null when there is none. */
export async function takeShared(): Promise<Shared | null> {
  const url = new URL(location.href);
  if (!url.searchParams.has("shared")) return null;
  url.searchParams.delete("shared");
  window.history.replaceState(null, "", url);
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(SHARED);
    const said = await cache.match("/shared/words");
    if (!said) return null;
    const { words, files: count } = (await said.json()) as { words?: unknown; files?: unknown };
    const files: File[] = [];
    for (let i = 0; i < (typeof count === "number" ? count : 0); i++) {
      const r = await cache.match(`/shared/file/${i}`);
      if (!r) continue;
      const name = decodeURIComponent(r.headers.get("x-name") ?? `Shared ${i + 1}`);
      files.push(new File([await r.blob()], name, { type: r.headers.get("content-type") ?? "" }));
    }
    await caches.delete(SHARED);
    const text = Array.isArray(words) ? words.filter((w): w is string => typeof w === "string").join("\n") : "";
    return text || files.length ? { text, files } : null;
  } catch {
    return null; // A share that cannot be read: Jarvis opens as it would.
  }
}
