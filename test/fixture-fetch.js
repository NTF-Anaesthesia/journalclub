import { readFileSync } from 'node:fs';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const key = (doi) => doi.replace(/[/.]/g, '_');
const NEJM = '10.1056/nejmoa1305889';
const PLOS = '10.1371/journal.pmed.0020124';

// Serves saved responses by URL, so tests never touch the network.
export function fixtureFetch(seen = []) {
  return async (url) => {
    seen.push(url);
    const u = decodeURIComponent(url).toLowerCase();
    let body = null;
    for (const [doi, pmid] of [[NEJM, '23992602'], [PLOS, '16060722']]) {
      const k = key(doi === NEJM ? '10.1056/NEJMoa1305889' : doi);
      if (u.startsWith('https://api.crossref.org/works/' + doi)) body = fx(`crossref-${k}.json`);
      if (u.startsWith('https://api.unpaywall.org/v2/' + doi)) body = fx(`unpaywall-${k}.json`);
      if (u.includes('esearch.fcgi') && u.includes(doi)) body = fx(`esearch-${k}.json`);
      if (u.includes('efetch.fcgi') && u.endsWith('id=' + pmid)) body = fx(`pubmed-${pmid}.xml`);
    }
    if (u.startsWith('https://api.crossref.org/works/10.28923/atotw.551')) body = fx('crossref-10_28923_atotw_551.json');
    return body === null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  };
}

