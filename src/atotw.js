// "Tidy ATOTW" (admin, More in select mode): preview sheet, then Apply. The rules are in atotw-plan.js; nothing is
// written until Apply.
import { doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { current, restore, dirty } from './catalogue.js';
import { sheet, snack } from './bulk.js';
import { cleanPaper } from './abstract.js';
import { tidyPlan, tidyWrite, crossrefYear } from './atotw-plan.js';

export * from './atotw-plan.js';

const api = (c, path) => c.user.getIdToken().then((t) => fetch(path, { headers: { Authorization: `Bearer ${t}` } }));
const esc = (c, s) => c.esc(String(s ?? ''));

// Admin: preview, then Apply. Two papers with the same number are listed as unsure (merge them first under Find duplicates).
export async function tidyAtotw(c, ids, onChange) {
  const lib = current();
  const picked = ids.map((id) => [id, lib.papers.get(id)]).filter(([, p]) => p && (p.atotw || /^\s*atotw\b/i.test(p.title || '')));
  const d = sheet(c, 'Tidy ATOTW', `<h2 class="sheet-title">Tidy ATOTW</h2><p class="muted" id="tmsg" role="status">Reading page 1 of ${picked.length} papers…</p><ul class="list" id="tlist"></ul>
    <div class="sheet-buttons"><button type="button" id="tcancel">Cancel</button><button type="button" class="primary" id="tapply" disabled>Apply</button></div>`);
  const $ = (s) => d.querySelector(s);
  $('#tcancel').onclick = () => d.close();
  const plans = new Map();
  let next = 0;
  const worker = async () => {
    while (next < picked.length && d.isConnected) {
      const [id, p] = picked[next++];
      let page = '';
      try {
        const r = p.file ? await api(c, `/api/firstpage/${id}`) : null;
        if (r?.ok) page = (await r.json()).pages?.[0] || '';
      } catch { /* offline: the title is tidied without page 1 */ }
      let plan = tidyPlan(p, page);
      // No year on page 1: tutorials from about 525 on have a DOI, and Crossref knows the year.
      if (plan && !plan.next.year && !p.year && plan.n >= 525 && !(p.manual || []).includes('year')) {
        try {
          const r = await api(c, '/api/lookup?id=' + encodeURIComponent(`10.28923/atotw.${plan.n}`));
          if (r.ok) plan = tidyPlan(p, page, crossrefYear(await r.json()));
        } catch { /* offline: no year */ }
      }
      if (plan) plans.set(id, plan);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (!d.isConnected) return;
  const count = new Map();
  for (const [, plan] of plans) count.set(plan.n, (count.get(plan.n) || 0) + 1);
  for (const [, plan] of plans) if (count.get(plan.n) > 1) Object.assign(plan, { status: 'unsure', next: {}, note: 'Same number as another paper: merge them first' });
  const rows = [...plans].filter(([, pl]) => pl.status !== 'same');
  const tally = { change: 0, same: 0, unsure: 0 };
  for (const [, pl] of plans) tally[pl.status]++;
  $('#tmsg').textContent = `${tally.change} to change, ${tally.same} already tidy, ${tally.unsure} unsure. Nothing is saved until you tap Apply.`;
  $('#tlist').replaceChildren(...rows.map(([id, pl]) => {
    const p = lib.papers.get(id), n = pl.next;
    const bits = [n.title !== undefined && `Title: ${esc(c, p.title)} → ${esc(c, n.title)}`, n.journal && `Journal: ${esc(c, n.journal)}`,
      n.year && `Year: ${esc(c, n.year)}`, `No. ${pl.n}`].filter(Boolean);
    return c.el(`<li class="tidy-row"><span class="${pl.status === 'unsure' ? 'warn-text' : ''}">${pl.note ? esc(c, pl.note) + ' · ' : ''}${bits.join('<br>')}</span></li>`);
  }));
  const apply = $('#tapply');
  apply.disabled = !tally.change;
  apply.textContent = tally.change ? `Apply to ${tally.change}` : 'Nothing to apply';
  apply.onclick = async () => {
    apply.disabled = true;
    let done = 0, failed = 0;
    for (const [id, pl] of plans) {
      if (pl.status !== 'change') continue;
      try {
        const snap = await getDoc(doc(c.db, 'papers', id));
        if (!snap.exists()) { failed++; continue; }
        const p = snap.data();
        const kept = Object.fromEntries(Object.entries(pl.next).filter(([k]) => !(p.manual || []).includes(k))); // typed since the preview
        const ch = tidyWrite(p, { ...pl, next: kept });
        await updateDoc(snap.ref, { ...ch, changedAt: serverTimestamp() });
        restore(id, cleanPaper({ ...p, ...ch }));
        done++;
      } catch (err) { console.error(err); failed++; }
      $('#tmsg').textContent = `Applied ${done} of ${tally.change}…`;
    }
    dirty();
    d.close();
    onChange?.();
    snack(c, `Tidied ${done}${failed ? `, ${failed} failed` : ''}; ${tally.same} unchanged, ${tally.unsure} unsure`);
  };
}
