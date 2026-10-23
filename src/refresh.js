// Admin-only "Refresh abstracts": look every paper up again and rewrite the bibliographic fields that changed.
import { doc, getDocs, collection, updateDoc } from 'firebase/firestore';
import { atotwDoi } from './doi.js';

const FIELDS = ['title', 'journal', 'authors', 'abstract'];

// The identifier to look a stored paper up by: DOI, else PubMed ID, else an ATOTW number in its title.
export function refreshId(p) {
  return p.doi || p.pmid || atotwDoi(p.title) || null;
}

// Only the fields a lookup may change: title, journal, authors, abstract, and doi/pmid when the paper had none.
// Empty lookup values never overwrite stored ones. Never tags, why, file or addedBy.
export function refreshChanges(p, fresh) {
  const out = {};
  for (const f of FIELDS) {
    const v = fresh[f];
    if (!v || (Array.isArray(v) && !v.length)) continue;
    if (JSON.stringify(v) !== JSON.stringify(p[f] ?? (f === 'authors' ? [] : ''))) out[f] = v;
  }
  for (const f of ['doi', 'pmid']) if (!p[f] && fresh[f]) out[f] = fresh[f];
  return out;
}

export function mountRefresh(page, ctx, onDone) {
  const { db, user, el } = ctx;
  const box = el(`<p class="actions"><button type="button" id="refresh">Refresh abstracts</button>
    <span id="refresh-msg" class="muted" role="status"></span></p>`);
  page.querySelector('#count').before(box); // under the Add / Import links, above the long list
  const btn = box.querySelector('#refresh'), msg = box.querySelector('#refresh-msg');
  btn.onclick = async () => {
    btn.disabled = true;
    const counts = { updated: 0, unchanged: 0, none: 0 };
    try {
      const snap = await getDocs(collection(db, 'papers'));
      let n = 0;
      for (const d of snap.docs) {
        msg.textContent = `Refreshing ${++n} of ${snap.size}…`;
        const p = d.data(), id = refreshId(p);
        if (!id) { counts.none++; continue; }
        const token = await user.getIdToken();
        const r = await fetch('/api/lookup?id=' + encodeURIComponent(id), { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { counts.none++; continue; }
        const changes = refreshChanges(p, await r.json());
        if (Object.keys(changes).length) { await updateDoc(doc(db, 'papers', d.id), changes); counts.updated++; } else counts.unchanged++;
      }
      msg.textContent = `Done: ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.none} with no identifier or not found.`;
    } catch (err) {
      console.error(err);
      msg.textContent = `Stopped: ${err.message || 'error'}. ${counts.updated} updated so far.`;
    }
    onDone();
    btn.disabled = false;
  };
}
