// Offline papers: PDFs of starred papers plus the last 20 opened are kept in the Cache API (not the Service Worker's
// shell cache), so they survive app updates, show space used, and are cleared on sign-out.
const CACHE = 'jc-offline-pdfs';
const RECENT = 20;
const keyOf = (id) => `${location.origin}/offline/pdf/${id}`;
const ids = new Set();

const supported = () => typeof caches !== 'undefined';
export const isOffline = (id) => ids.has(id);
export const offlineCount = () => ids.size;

async function open() { return caches.open(CACHE); }

// Reads the cache once so rows and pages can show the badge synchronously.
export async function refresh() {
  ids.clear();
  if (!supported()) return ids;
  try {
    const keys = await (await open()).keys();
    keys.forEach((r) => ids.add(r.url.split('/').pop()));
  } catch { /* no cache in this browser mode */ }
  return ids;
}

export async function getCached(id) {
  if (!supported()) return null;
  try { return (await (await open()).match(keyOf(id))) || null; } catch { return null; }
}

// Stores the PDF with the time it was opened; the response header carries the size for the Settings total.
export async function keep(id, buf, openedAt = Date.now()) {
  if (!supported()) return;
  try {
    const res = new Response(buf, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(buf.byteLength ?? buf.size), 'X-Opened': String(openedAt) } });
    await (await open()).put(keyOf(id), res);
    ids.add(id);
  } catch (e) { console.warn('offline cache', e?.name); }
}

// Marks a cached PDF as just opened.
export async function touch(id) {
  const hit = await getCached(id);
  if (hit) await keep(id, await hit.arrayBuffer());
}

export async function forget(id) {
  ids.delete(id);
  if (supported()) try { await (await open()).delete(keyOf(id)); } catch { /* ignore */ }
}

// Keeps starred papers and the RECENT most recently opened others; evicts the oldest of the rest.
export async function prune(starred) {
  if (!supported()) return;
  const cache = await open();
  const rows = [];
  for (const r of await cache.keys()) {
    const id = r.url.split('/').pop();
    if (starred.has(id)) continue;
    rows.push({ id, at: Number((await cache.match(r))?.headers.get('X-Opened')) || 0 });
  }
  rows.sort((a, b) => b.at - a.at);
  for (const x of rows.slice(RECENT)) await forget(x.id);
}

export async function usage() {
  let bytes = 0, count = 0;
  if (supported()) {
    try {
      const cache = await open();
      for (const r of await cache.keys()) { count++; bytes += Number((await cache.match(r))?.headers.get('Content-Length')) || 0; }
    } catch { /* ignore */ }
  }
  return { count, bytes };
}

export async function clearAll() {
  ids.clear();
  if (supported()) try { await caches.delete(CACHE); } catch { /* ignore */ }
}

export const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// Downloads starred papers that have a PDF and are not cached yet, one at a time, in the background.
export async function syncStarred(starred, papers, fetchPdf) {
  if (!supported() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  for (const id of starred) {
    if (ids.has(id) || !papers.get(id)?.file) continue;
    try {
      const r = await fetchPdf(id);
      if (r?.ok) await keep(id, await r.arrayBuffer(), 0); // opened-time 0: starred ones are exempt from pruning anyway
    } catch { return; }
  }
  await prune(starred);
}
