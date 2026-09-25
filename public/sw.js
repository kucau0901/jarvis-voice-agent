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

self.addEventListener("install", () => {
  // Take over immediately: a stale worker serving a stale bundle is the classic
  // way a PWA starts lying about what version it is running.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

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
