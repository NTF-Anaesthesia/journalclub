// "Edit details": any signed-in member corrects a paper's title, authors, journal, year, DOI, PubMed ID and
// abstract, and its tags and "why read it". The fields typed here go in `manual`, so Refresh and
// "Fill missing details" never overwrite them (the paper page has a link to hand them back).
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { sheet, snack } from './bulk.js';
import { current, restore, dirty } from './catalogue.js';
import { cleanPaper } from './abstract.js';

export const HAND_FIELDS = ['title', 'authors', 'journal', 'year', 'doi', 'pmid', 'abstract'];
const tagList = (s) => [...new Set(String(s).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Form text -> the values to store, or { error }.
export function parseForm(f) {
  const title = f.title.trim();
  if (!title) return { error: 'The title cannot be empty.' };
  if (title.length > 500) return { error: 'The title is over 500 characters.' };
  const authors = f.authors.split('\n').map((a) => a.trim()).filter(Boolean);
  if (authors.length > 100) return { error: 'Over 100 authors: list the first 100.' };
  const yearText = f.year.trim();
  const year = yearText === '' ? null : Number(yearText);
  if (year !== null && !(Number.isInteger(year) && year >= 1800 && year <= 2100)) return { error: 'The year must be between 1800 and 2100.' };
  const doi = f.doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();
  if (doi && !/^10\./.test(doi)) return { error: 'A DOI starts with 10.' };
  const pmid = f.pmid.trim().replace(/^pmid:?\s*/i, '');
  if (!/^\d{0,9}$/.test(pmid)) return { error: 'A PubMed ID is up to 9 digits.' };
  const abstract = f.abstract.trim();
  if (abstract.length > 20000) return { error: 'The abstract is over 20,000 characters.' };
  return { values: { title, authors, journal: f.journal.trim().slice(0, 300), year, doi, pmid, abstract }, tags: tagList(f.tags), why: f.why.trim().slice(0, 200) };
}

// What to write: only fields that changed; typed metadata fields join `manual`; a changed abstract is marked as typed by hand.
export function editChanges(p, parsed) {
  const out = {};
  const hand = new Set(p.manual || []);
  const start = hand.size;
  for (const k of HAND_FIELDS) {
    const before = p[k] ?? (k === 'authors' ? [] : k === 'year' ? null : '');
    if (k === 'doi' && String(before).toLowerCase() === parsed.values.doi) continue; // the form lower-cases; stored case is not an edit
    if (!same(before, parsed.values[k])) { out[k] = parsed.values[k]; hand.add(k); }
  }
  if (out.abstract !== undefined) out.abstractSource = 'hand';
  if (hand.size !== start) out.manual = [...hand];
  if (!same(p.tags || [], parsed.tags)) out.tags = parsed.tags;
  if ((p.why || '') !== parsed.why) out.why = parsed.why;
  return out;
}

export function editSheet(c, id, p, onSaved) {
  const d = sheet(c, 'Edit details', `<div class="sheet-head"><button type="button" class="link" id="xcx">Cancel</button>
      <strong>Edit details</strong><span></span></div>
    <form id="xf" class="stack">
      <label>Title <input id="xtitle" maxlength="500" required></label>
      <label>Authors, one per line <textarea id="xauthors" rows="3"></textarea></label>
      <label>Journal <input id="xjournal" maxlength="300"></label>
      <label>Year <input id="xyear" inputmode="numeric" maxlength="4"></label>
      <label>DOI <input id="xdoi" autocapitalize="none" autocomplete="off"></label>
      <label>PubMed ID <input id="xpmid" inputmode="numeric" autocomplete="off"></label>
      <p><button type="button" id="xlook">Look up from the DOI or PubMed ID</button> <span class="muted" id="xmsg" role="status"></span></p>
      <label>Abstract <textarea id="xabstract" rows="8"></textarea></label>
      <label>Tags, comma separated <input id="xtags"></label>
      <label>Why read it <input id="xwhy" maxlength="200"></label>
      <p class="muted">Fields you change here are kept: Refresh and Fill missing details will not overwrite them.</p>
      <button class="primary" id="xsave">Save</button></form>`);
  const $ = (s) => d.querySelector(s);
  $('#xtitle').value = p.title || '';
  $('#xauthors').value = (p.authors || []).join('\n');
  $('#xjournal').value = p.journal || '';
  $('#xyear').value = p.year || '';
  $('#xdoi').value = p.doi || '';
  $('#xpmid').value = p.pmid || '';
  $('#xabstract').value = p.abstract || '';
  $('#xtags').value = (p.tags || []).join(', ');
  $('#xwhy').value = p.why || '';
  $('#xcx').onclick = () => d.close();

  $('#xlook').onclick = async () => {
    const key = $('#xdoi').value.trim() || $('#xpmid').value.trim();
    const msg = $('#xmsg');
    if (!key) { msg.textContent = 'Type a DOI or PubMed ID first.'; return; }
    msg.textContent = 'Looking up…';
    try {
      const t = await c.user.getIdToken();
      const r = await fetch('/api/lookup?id=' + encodeURIComponent(key), { headers: { Authorization: `Bearer ${t}` } });
      const f = await r.json();
      if (!r.ok) { msg.textContent = f.error || 'Not found.'; return; }
      const put = (sel, v) => { if (v) $(sel).value = v; };
      put('#xtitle', f.title); put('#xauthors', (f.authors || []).join('\n')); put('#xjournal', f.journal);
      put('#xyear', f.year); put('#xdoi', f.doi); put('#xpmid', f.pmid); put('#xabstract', f.abstract);
      msg.textContent = 'Filled from the lookup. Check it, then Save.';
    } catch { msg.textContent = 'Lookup failed. Check the connection.'; }
  };

  $('#xf').onsubmit = async (e) => {
    e.preventDefault();
    const parsed = parseForm({ title: $('#xtitle').value, authors: $('#xauthors').value, journal: $('#xjournal').value, year: $('#xyear').value,
      doi: $('#xdoi').value, pmid: $('#xpmid').value, abstract: $('#xabstract').value, tags: $('#xtags').value, why: $('#xwhy').value });
    const msg = $('#xmsg');
    if (parsed.error) { msg.textContent = parsed.error; return; }
    const ch = editChanges(p, parsed);
    if (!Object.keys(ch).length) { d.close(); return; }
    const other = parsed.values.doi && [...(current()?.papers || [])].find(([oid, o]) => oid !== id && o.doi === parsed.values.doi);
    if (other && !confirm(`Another paper already has this DOI: “${other[1].title}”. Save anyway? (Find duplicates under More can merge them.)`)) return;
    $('#xsave').disabled = true;
    try {
      await updateDoc(doc(c.db, 'papers', id), { ...ch, changedAt: serverTimestamp() });
      restore(id, cleanPaper({ ...p, ...ch }));
      dirty();
      d.close();
      onSaved?.();
      snack(c, 'Saved');
    } catch (err) {
      console.error(err);
      $('#xsave').disabled = false;
      msg.textContent = 'Could not save. Check the connection and try again.';
    }
  };
}

// Hand back the fields typed by hand to Refresh and Fill missing details.
export async function releaseHand(c, id) {
  await updateDoc(doc(c.db, 'papers', id), { manual: [], changedAt: serverTimestamp() });
  dirty();
}
