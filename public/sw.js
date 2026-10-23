// App shell offline. Network first, so a deploy is picked up at once; the cached copy answers when the network
// does not. Hashed chunks never change and are served from the cache first. /api/ and sign-in (/__/) are never
// touched here: PDFs for offline reading are kept by the page itself (src/offline.js), not by this worker.
const SHELL = 'jc-shell-v1';
const CORE = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/pdf.worker.min.mjs'];
const KIT = 'https://design.anantf.com/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('jc-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// The page lists what it has loaded so far (hashed chunks included); keep those too.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'precache') return;
  const urls = (e.data.urls || []).filter((u) => typeof u === 'string' && (u.startsWith(self.location.origin + '/') || u.startsWith(KIT)));
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(urls.map(async (u) => {
    if (u.includes('/api/') || u.includes('/__/') || await c.match(u)) return;
    await c.add(u);
  }))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  const own = url.origin === self.location.origin;
  if (!own && !req.url.startsWith(KIT)) return;
  if (own && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__/') || url.pathname === '/sw.js')) return;
  if (own && url.pathname.startsWith('/chunks/')) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(networkFirst(req, req.mode === 'navigate' ? '/' : null));
});

async function cacheFirst(req) {
  const c = await caches.open(SHELL);
  return (await c.match(req)) || fetchAndKeep(c, req);
}
async function networkFirst(req, fallbackUrl) {
  const c = await caches.open(SHELL);
  try { return await fetchAndKeep(c, req, fallbackUrl); } catch {
    return (await c.match(req, { ignoreSearch: req.mode === 'navigate' })) || (fallbackUrl && (await c.match(fallbackUrl))) || Response.error();
  }
}
async function fetchAndKeep(c, req, fallbackUrl) {
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    // A navigation to any route is the one app page: keep it as "/".
    c.put(req.mode === 'navigate' && fallbackUrl ? fallbackUrl : req, res.clone()).catch(() => {});
  }
  return res;
}
