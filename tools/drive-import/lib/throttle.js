// A fetch that waits between calls to the same host and says who is asking (Crossref and PubMed ask for this).
const GAP_MS = { 'api.crossref.org': 120, 'eutils.ncbi.nlm.nih.gov': 350, 'api.unpaywall.org': 120 };

export function politeFetch(email, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now) {
  const next = new Map();
  return async (url, opts = {}) => {
    const host = new URL(url).host;
    const gap = GAP_MS[host] || 0;
    const at = Math.max(now(), next.get(host) || 0);
    next.set(host, at + gap);
    if (at > now()) await sleep(at - now());
    return fetchFn(url, { ...opts, headers: { 'User-Agent': `journalclub-import (mailto:${email})`, ...opts.headers } });
  };
}

// Run fn over items, n at a time.
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}
