// Calendar tab (#/calendar, #/calendar/<yyyy-mm>): the month's sessions on a grid, then the same sessions as a list.
// A day with a session opens it; an empty day from today on plans one on that date (#/plan?date=<yyyy-mm-dd>).
import { getDocs, collection, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { decodeEntities } from './abstract.js';

const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (y, m) => `${y}-${pad(m + 1)}`;

// '2026-10' -> { y: 2026, m: 9 }; anything else is this month.
export function parseMonth(arg, now = new Date()) {
  const x = /^(\d{4})-(\d{2})$/.exec(arg || '');
  return x && +x[2] >= 1 && +x[2] <= 12 ? { y: +x[1], m: +x[2] - 1 } : { y: now.getFullYear(), m: now.getMonth() };
}

// The month as whole weeks from Monday: days outside the month are null.
export function monthGrid(y, m) {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

export async function renderCalendar(arg, c) {
  const { y, m } = parseMonth(arg);
  const first = new Date(y, m, 1), next = new Date(y, m + 1, 1);
  const prev = new Date(y, m - 1, 1);
  const title = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const page = c.el(`<section class="card calendar"><h1>Calendar</h1>
    <div class="cal-head"><a class="cal-nav" href="#/calendar/${monthKey(prev.getFullYear(), prev.getMonth())}" aria-label="Previous month">‹</a>
      <h2 id="cal-month">${title}</h2>
      <a class="cal-nav" href="#/calendar/${monthKey(next.getFullYear(), next.getMonth())}" aria-label="Next month">›</a></div>
    <table class="cal-grid" aria-labelledby="cal-month"><thead><tr>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<th scope="col" abbr="${d}">${d[0]}</th>`).join('')}</tr></thead>
      <tbody id="cal-body"></tbody></table>
    <p class="muted cal-hint">Tap a session to open it, or an empty day to plan one.</p>
    <h2>Sessions in ${first.toLocaleDateString('en-GB', { month: 'long' })}</h2><ul id="cal-list" class="list"><li class="muted">Loading…</li></ul>
    <p class="actions"><a class="button primary" href="#/plan">Plan a session</a></p></section>`);
  c.view.replaceChildren(page);
  const ss = await getDocs(query(collection(c.db, 'sessions'), where('date', '>=', Timestamp.fromDate(first)),
    where('date', '<', Timestamp.fromDate(next)), orderBy('date'))).catch(() => null);
  if (!page.isConnected) return;
  const byDay = new Map();
  const list = page.querySelector('#cal-list');
  list.replaceChildren();
  (ss?.docs || []).forEach((d) => {
    const s = d.data(), day = s.date.toDate().getDate();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ id: d.id, ...s });
    const when = s.date.toDate().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    list.append(c.el(`<li class="paper"><a href="#/session/${d.id}">${c.esc(decodeEntities(s.paperTitle || 'Session'))}</a>
      <span class="muted">${c.esc(when)}${s.presenterName ? ` · ${c.esc(s.presenterName)}` : ''}</span></li>`));
  });
  if (!ss) list.append(c.el('<li class="muted">Could not load the sessions. Check your connection and try again.</li>'));
  else if (!list.children.length) list.append(c.el('<li class="muted">No sessions this month.</li>'));

  const today = isoDay(new Date());
  page.querySelector('#cal-body').replaceChildren(...monthGrid(y, m).map((week) => c.el(`<tr>${week.map((day) => {
    if (!day) return '<td></td>';
    const iso = isoDay(new Date(y, m, day)), here = byDay.get(day);
    const label = new Date(y, m, day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const cls = `cal-day${iso === today ? ' is-today' : ''}${here ? ' has-session' : ''}`;
    const inner = `<span class="cal-num">${day}</span>${here ? '<span class="cal-dot" aria-hidden="true"></span>' : ''}`;
    if (here) return `<td><a class="${cls}" href="#/session/${here[0].id}" aria-label="${label}: ${c.esc(decodeEntities(here[0].paperTitle || 'session'))}">${inner}</a></td>`;
    if (iso >= today) return `<td><a class="${cls}" href="#/plan?date=${iso}" aria-label="${label}: plan a session">${inner}</a></td>`;
    return `<td><span class="${cls} is-past">${inner}</span></td>`;
  }).join('')}</tr>`)));
}
