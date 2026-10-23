// A list of papers by DOI (no PDFs): CSV rows doi,pmid,short_name,year,takehome,tags (tags split by ";"). New papers are
// looked up and added with the take-home as "why read it"; papers already in the library only gain the tags, and the
// take-home when they have none.

// RFC 4180 CSV: quoted cells may hold commas, newlines and "" quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  const [head, ...body] = rows;
  const keys = (head || []).map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export const TAGS_MAX = 20;

export function listRows(text, extraTags = []) {
  return parseCsv(text).filter((r) => r.doi || r.pmid).map((r) => ({
    id: r.doi || r.pmid,
    doi: (r.doi || '').toLowerCase(),
    name: r.short_name || r.doi || r.pmid,
    why: r.takehome || '',
    tags: [...new Set([...(r.tags || '').split(';'), ...extraTags].map((t) => t.trim().toLowerCase()).filter(Boolean))],
  }));
}

// What to write for one row. hit: the library paper with the same DOI (or title), with its tags and why.
export function planRow(row, hit) {
  if (!hit) return { status: 'new' };
  const tags = [...new Set([...(hit.tags || []), ...row.tags])].slice(0, TAGS_MAX);
  const update = {};
  if (tags.length !== (hit.tags || []).length) update.tags = tags;
  if (!hit.why && row.why) update.why = row.why;
  return Object.keys(update).length ? { status: 'update', id: hit.id, update } : { status: 'same', id: hit.id };
}
