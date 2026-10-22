const CACHE_NAME = "peak-level-shell-v1";
const SHELL_ASSETS = [
    "/offline.html",
    "/manifest.webmanifest",
    "/assets/app-icon.svg",
    "/assets/app-icon-180.png",
    "/assets/app-icon-192.png",
    "/assets/app-icon-512.png",
    "/css/workbench.css",
    "/css/peak-level.css",
    "/js/workbench.js",
    "/js/tcode-catalog.js"
];
const SHELL_PATHS = new Set(SHELL_ASSETS);

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all(SHELL_ASSETS.map(async path => {
            try {
                const response = await fetch(path, { cache: "reload" });
                if (response.ok && response.type === "basic" && !response.redirected) {
                    await cache.put(path, response);
                }
            } catch (_) {
                // Keep installation available when one optional asset cannot be cached.
            }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(name => name.startsWith("peak-level-shell-") && name !== CACHE_NAME)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;

    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== self.location.origin) return;

    if (request.mode === "navigate") {
        event.respondWith(fetch(request).catch(async () => {
            const offlinePage = await caches.match("/offline.html");
            return offlinePage || new Response("You're offline. Reconnect and try again.", {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        }));
        return;
    }

    if (!SHELL_PATHS.has(requestUrl.pathname)) return;

    event.respondWith((async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        try {
            const response = await fetch(request);
            if (response.ok && response.type === "basic" && !response.redirected) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
            }
            return response;
        } catch (error) {
            if (cached) return cached;
            throw error;
        }
    })());
});
