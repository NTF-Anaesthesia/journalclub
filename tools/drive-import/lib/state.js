// Resume file: one JSON object per line, the last line for a hash wins. Append-only, so a crash loses nothing.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

export function loadState(path) {
  const map = new Map();
  if (!path || !existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); map.set(r.hash, { ...map.get(r.hash), ...r }); } catch { /* a half-written last line */ }
  }
  return map;
}

export function saveState(path, map, rec) {
  map.set(rec.hash, { ...map.get(rec.hash), ...rec });
  if (path) appendFileSync(path, JSON.stringify(rec) + '\n');
}
