// My notes (Saved tab): the member's own paper and session notes as rows, newest first, and the on-page search.
// A row: { kind: 'paper' | 'session', id, title, text, ms, shared, href, when }.

export function sortNotes(rows) {
  return [...rows].sort((a, b) => (b.ms || 0) - (a.ms || 0));
}

// Every word typed must appear in the title or the note, in any order and case.
export function filterNotes(rows, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.title} ${r.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const millis = (t) => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : 0);
