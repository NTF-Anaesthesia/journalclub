// In-memory stand-in for an R2 bucket: get (with an {offset, length} range), head, put, delete.
const bytes = (v) => (typeof v === 'string' ? Buffer.from(v) : Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v));

export function r2Stub(store = new Map()) {
  const info = (k) => { const b = bytes(store.get(k)); return { size: b.length, httpEtag: `"e${b.length}"`, b }; };
  return {
    store,
    async head(k) { if (!store.has(k)) return null; const { size, httpEtag } = info(k); return { size, httpEtag }; },
    async get(k, opts) {
      if (!store.has(k)) return null;
      const { size, httpEtag, b } = info(k);
      const r = opts?.range;
      return { size, httpEtag, body: r ? b.subarray(r.offset, r.offset + r.length) : store.get(k) };
    },
    async put(k, v, o) { store.set(k, v); this.meta = o; },
    async delete(k) { store.delete(k); },
  };
}
