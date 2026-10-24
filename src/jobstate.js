// Long jobs (Library bulk jobs, Rebuild PDF search) keep their place on the device, so a closed tab or a phone that
// froze the page can carry on where it stopped. Also the retry rule for flaky connections. No imports: unit-tested alone.

export const RETRY_DELAYS = [2000, 5000, 15000]; // ms before each retry of a step
export const FAIL_RUN = 5; // this many steps in a row that cannot get through pause the job

const key = (uid, name) => `jc-job:${uid}:${name}`;
const device = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function saveState(uid, name, state, store = device()) {
  try { store?.setItem(key(uid, name), JSON.stringify(state)); } catch { /* storage full or blocked: the job still runs */ }
}

export function loadState(uid, name, store = device()) {
  try {
    const s = JSON.parse(store?.getItem(key(uid, name)) || 'null');
    return s && typeof s === 'object' ? s : null;
  } catch { return null; }
}

export function clearState(uid, name, store = device()) {
  try { store?.removeItem(key(uid, name)); } catch { /* nothing to clear */ }
}

// Only a bulk job state with a usable list counts; anything else on the device is ignored.
export function loadJobState(uid, store) {
  const s = loadState(uid, 'job', store);
  if (!s || typeof s.kind !== 'string' || !Array.isArray(s.ids) || !s.ids.length) return null;
  return { counts: {}, missing: [], total: s.ids.length, done: 0, ...s };
}

// A dropped connection (fetch throws a TypeError), a Firestore "unavailable", or a 5xx answer.
export const isTransient = (e) => e instanceof TypeError || /^HTTP 5\d\d/.test(e?.message || '') || ['unavailable', 'deadline-exceeded'].includes(e?.code);

export const httpError = (r) => Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });

// Runs `fn`; a transient failure waits and tries again, once per delay. Other errors, and the last failure, are thrown.
export async function retrying(fn, { delays = globalThis.__jcRetryDelays || RETRY_DELAYS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stopped = () => false } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!isTransient(e) || i >= delays.length || stopped()) throw e;
      await sleep(delays[i]);
    }
  }
}
