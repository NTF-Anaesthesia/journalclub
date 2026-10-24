// The Worker isn't running under the static test server: answer /api/ in the test process with the real Worker
// code (worker/index.js), a local D1 for search, an in-memory R2 stand-in, saved lookup fixtures, and the
// Firestore emulator in place of the Firestore REST API (so the caller's token and the rules decide, as live).
import { api } from '../worker/index.js';
import { fixtureFetch } from '../test/fixture-fetch.js';
import { localD1 } from '../test/d1.js';
import { r2Stub } from '../test/r2-stub.js';

const LIVE = 'https://firestore.googleapis.com/v1/projects/journalclub-anantf/';

// A stand-in for the Workers AI binding: one canned summary, and a record of what was asked.
export function fakeAi(response = 'A short neutral summary of this handout: it lists the steps of the ward round and who does what, for trainees.') {
  const calls = [];
  return { calls, run: async (model, req) => { calls.push({ model, req }); return { response }; } };
}

export async function workerApi(page, project = 'demo-jc', { ai = fakeAi() } = {}) {
  const EMU = `http://127.0.0.1:8080/v1/projects/${project}/`;
  const d1 = await localD1();
  const FILES = r2Stub();
  const store = FILES.store;
  const lookups = fixtureFetch();
  const fetchFn = (url, init) => (String(url).startsWith(LIVE) ? fetch(String(url).replace(LIVE, EMU), init) : lookups(url, init));
  const calls = [];
  // The app sends some requests without waiting (POST /api/index/<id>/notes after a note save), so one can still be
  // running when the test ends. Dispose D1 only after those finish and drop any that arrive after close: a late
  // request on a disposed D1 throws, and that error fails whichever test this Playwright worker runs next.
  let closed = false;
  const pending = new Set();
  await page.route('**/api/**', async (route) => {
    if (closed) return route.abort().catch(() => {});
    const r = route.request();
    calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    const body = ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postDataBuffer();
    const job = (async () => {
      const res = await api(new Request(r.url(), { method: r.method(), headers: r.headers(), body }), { FILES, SEARCH: d1.db, AI: ai }, fetchFn);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    })();
    pending.add(job);
    try { await job; } catch (e) { if (!closed) throw e; } finally { pending.delete(job); }
  });
  page.on('close', async () => {
    closed = true;
    await Promise.allSettled([...pending]);
    await d1.dispose().catch(() => {});
  });
  return { files: store, calls, db: d1.db, ai };
}
