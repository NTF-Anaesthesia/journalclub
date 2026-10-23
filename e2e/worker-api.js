// The Worker isn't running under the static test server: answer /api/ in the test process with the real Worker
// code (worker/index.js), a local D1 for search, an in-memory R2 stand-in, saved lookup fixtures, and the
// Firestore emulator in place of the Firestore REST API (so the caller's token and the rules decide, as live).
import { api } from '../worker/index.js';
import { fixtureFetch } from '../test/fixture-fetch.js';
import { localD1 } from '../test/d1.js';

const LIVE = 'https://firestore.googleapis.com/v1/projects/journalclub-anantf/';

export async function workerApi(page, project = 'demo-jc') {
  const EMU = `http://127.0.0.1:8080/v1/projects/${project}/`;
  const d1 = await localD1();
  const store = new Map();
  const FILES = {
    async get(k) { return store.has(k) ? { body: store.get(k) } : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  const lookups = fixtureFetch();
  const fetchFn = (url, init) => (String(url).startsWith(LIVE) ? fetch(String(url).replace(LIVE, EMU), init) : lookups(url, init));
  const calls = [];
  await page.route('**/api/**', async (route) => {
    const r = route.request();
    calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    const body = ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postDataBuffer();
    const res = await api(new Request(r.url(), { method: r.method(), headers: r.headers(), body }), { FILES, SEARCH: d1.db }, fetchFn);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  page.on('close', () => d1.dispose());
  return { files: store, calls, db: d1.db };
}
