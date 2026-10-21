/*
 * Just enough service worker to be installable, to start fast, and to show alerts.
 *
 * Deliberately NOT an offline app. Jarvis is a voice agent that talks to a
 * Worker, OpenAI and a house; with no network there is nothing for it to do, and
 * a cached shell that loads into a dead app is worse than an honest failure.
 * What this buys is the install prompt, a home-screen launch, and a warm start.
 */
const VERSION = "v1";
const SHELL = `jarvis-shell-${VERSION}`;
/** What another app shared into Jarvis, held until the page takes it (src/app/share.ts). */
const SHARED = "jarvis-shared";
/** As many as a question can carry: two photos and two files (src/app/attach.ts). */
const MAX_SHARED = 4;
/** A file bigger than this is not kept: more than any photo, and over the 10 MB a PDF may be (src/app/attach.ts). */
const MAX_SHARED_BYTES = 25 * 1024 * 1024;

self.addEventListener("install", () => {
  // Take over immediately: a stale worker serving a stale bundle is the classic
  // way a PWA starts lying about what version it is running.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL && key !== SHARED) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A phone's share sheet (share_target in manifest.webmanifest): kept here, then Chat.
  if (req.method === "POST" && url.pathname === "/share") {
    event.respondWith(takeShare(req));
    return;
  }
  if (req.method !== "GET") return;

  /*
   * Never touch the API. Every one of these is live state — what the car is
   * doing, what a camera sees, whether a token is still valid — and a cached
   * answer to any of them is a wrong answer. The credential in the header would
   * also end up in a cache entry, which is its own problem.
   */
  if (url.pathname.startsWith("/api/")) return;

  // Hashed build assets are immutable by filename, so cache-first is safe and a
  // new deploy simply requests new names.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // The document itself is network-first: a deploy must be picked up on the next
  // load, not whenever a cache happens to expire. Cache is the fallback only.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const forCache = res.clone();
            const forPrune = res.clone();
            event.waitUntil(
              (async () => {
                const cache = await caches.open(SHELL);
                await cache.put("/", forCache);
                await prune(cache, await forPrune.text());
              })(),
            );
          }
          return res;
        } catch {
          return (await caches.match("/")) ?? Response.error();
        }
      })(),
    );
  }
});

/*
 * Alerts, when no Jarvis screen is open (src/worker/lib/alerts.ts).
 *
 * The payload arrives encrypted to this browser and already decrypted here.
 * Every push must show a notification — the browser requires it — so there is
 * no quiet path. A tap brings Jarvis forward on that alert; the notification
 * carries only its id, and the page fetches the text itself.
 */
self.addEventListener("push", (event) => {
  let a = {};
  try {
    a = event.data ? event.data.json() : {};
  } catch {
    a = { text: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(a.title || "Jarvis", {
      body: a.text || "",
      tag: a.id || undefined,
      data: { id: a.id || "" },
      icon: "/icons/icon-192.png",
      timestamp: typeof a.at === "number" ? a.at : Date.now(),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.id || "";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ type: "alert-open", id });
        return;
      }
      // Only the id in the address: the text stays out of history and logs.
      await self.clients.openWindow(id ? `/?alert=${encodeURIComponent(id)}` : "/");
    })(),
  );
});

/**
 * Something shared into Jarvis from another app: its words and files, kept in
 * a cache of their own until the page takes them, which it does once and then
 * deletes (src/app/share.ts). Only the newest share is kept. Nothing is sent
 * anywhere from here: the page puts them in the message box, to be sent or
 * not. A share that cannot be read still opens Jarvis.
 */
async function takeShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARED);
    for (const key of await cache.keys()) await cache.delete(key);
    const words = [];
    for (const name of ["title", "text", "url"]) {
      const v = form.get(name);
      // A link is often in the text as well: said once.
      if (typeof v === "string" && v.trim() && !words.some((w) => w.includes(v.trim()))) words.push(v.trim());
    }
    const all = form.getAll("files").filter((f) => f instanceof File && f.size);
    const files = all.filter((f) => f.size <= MAX_SHARED_BYTES).slice(0, MAX_SHARED);
    // Named, so the page can say why they are not attached.
    const tooBig = all.filter((f) => f.size > MAX_SHARED_BYTES).map((f) => f.name || "A file");
    await cache.put("/shared/words", new Response(JSON.stringify({ words, files: files.length, tooBig })));
    for (const [i, f] of files.entries()) {
      await cache.put(`/shared/file/${i}`, new Response(f, {
        headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name || `Shared ${i + 1}`) },
      }));
    }
  } catch {
    // Nothing kept: Jarvis opens as it would.
  }
  return Response.redirect(new URL("/?shared=1", self.location.origin).href, 303);
}

/**
 * Drop cached bundles the current page no longer references.
 *
 * Bundles are content-hashed, so every deploy adds a new ~1.6 MB file, and
 * VERSION never changes, so activate never cleared the old ones: the cache grew
 * by a bundle per deploy, forever. On the car's browser that ends with the
 * origin evicted wholesale — the stored access key with it. The freshly fetched
 * page names exactly the assets in use; everything else under /assets/ goes.
 */
async function prune(cache, html) {
  const live = new Set(html.match(/\/assets\/[^"'()\s>]+/g) ?? []);
  if (!live.size) return; // not the page we expected; delete nothing
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (path.startsWith("/assets/") && !live.has(path)) await cache.delete(key);
  }
}
