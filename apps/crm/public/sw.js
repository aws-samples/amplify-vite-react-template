/*
 * BuzzKill CRM service worker.
 *
 * Strategy:
 *  - Navigations: network-first (a live business tool must never serve a
 *    stale shell while online); the last good shell is kept for offline.
 *  - /assets/*: cache-first — filenames are content-hashed, so entries are
 *    immutable. Never caches non-OK, redirected, or HTML (SPA-fallback)
 *    responses, and prunes old deploys' leftovers.
 *  - /icons/*: stale-while-revalidate (unhashed but rarely change).
 */
const VERSION = "v2";
const SHELL_CACHE = `bk-shell-${VERSION}`;
const ASSET_CACHE = `bk-assets-${VERSION}`;
const MAX_ASSET_ENTRIES = 80;

function cacheable(res) {
  return res && res.ok && !res.redirected && res.status === 200;
}

function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Precache the shell so offline works from the first visit.
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      try {
        const res = await fetch("/", { cache: "no-cache" });
        if (cacheable(res)) await cache.put("/", res);
      } catch {
        /* offline install — shell gets cached on first navigation */
      }
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function trimAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_ASSET_ENTRIES) {
    // Oldest-first eviction of the overflow (insertion order).
    await Promise.all(
      keys.slice(0, keys.length - MAX_ASSET_ENTRIES).map((k) => cache.delete(k))
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (cacheable(res) && isHtml(res)) {
            const copy = res.clone();
            caches
              .open(SHELL_CACHE)
              .then((c) => c.put("/", copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/", { cacheName: SHELL_CACHE }))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request, { cacheName: ASSET_CACHE }).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            // Guard against the SPA 404-fallback: never cache HTML as an asset.
            if (cacheable(res) && !isHtml(res)) {
              const copy = res.clone();
              caches
                .open(ASSET_CACHE)
                .then((c) => c.put(request, copy))
                .then(trimAssets)
                .catch(() => {});
            }
            return res;
          })
      )
    );
    return;
  }

  if (url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        const refresh = fetch(request)
          .then((res) => {
            if (cacheable(res) && !isHtml(res)) {
              cache.put(request, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit ?? refresh;
      })
    );
  }
});
