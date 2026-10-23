// PDF.js 6 draws pages with Map.getOrInsertComputed, which browsers older than 2026 do not have yet.
for (const C of [Map, WeakMap]) {
  C.prototype.getOrInsert ??= function getOrInsert(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); };
  C.prototype.getOrInsertComputed ??= function getOrInsertComputed(key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); };
}
