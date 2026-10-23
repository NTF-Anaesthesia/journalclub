// Match a typed name to a member account, so the presenter or coordinator can edit the session.
// Ignores case, extra spaces, dots and a leading "Dr"; an email address also matches.
export const normName = (s) => String(s || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim().replace(/^dr /, '');

// entries: [{ name, uid, email? }]. Returns uid for a typed name, or '' when no single member matches.
export function personIndex(entries) {
  const hits = new Map();
  const add = (key, uid) => {
    const k = normName(key);
    if (!k || !uid) return;
    const prev = hits.get(k);
    hits.set(k, prev === undefined || prev === uid ? uid : null);   // null = two members share it
  };
  entries.forEach((e) => { add(e.name, e.uid); add(e.email, e.uid); });
  return (typed) => hits.get(normName(typed)) || '';
}
