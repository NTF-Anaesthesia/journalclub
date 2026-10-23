// Paper lookups (Crossref, PubMed, Unpaywall). Pure functions plus one
// orchestrator that takes fetch as an argument, so tests run on saved fixtures.
import { decodeEntities } from '../src/abstract.js';

const CROSSREF = 'https://api.crossref.org/works/';
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=';
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=';
const UNPAYWALL = 'https://api.unpaywall.org/v2/';

// "10.1/x", "doi:10.1/x", "https://doi.org/10.1/x", "PMID: 123", "123" -> { doi } or { pmid } or null.
export function parseId(input) {
  const s = String(input ?? '').trim();
  const doi = /(10\.\d{4,9}\/\S+)/.exec(decodeURIComponent(s));
  if (doi) return { doi: doi[1].replace(/[.,;)\]]+$/, '').toLowerCase() };
  const pmid = /^(?:pmid:?\s*)?(\d{1,9})$/i.exec(s);
  if (pmid) return { pmid: pmid[1] };
  return null;
}

const unxml = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/&[^;\s]+;/g, decodeEntities)
  .replace(/\s+/g, ' ').trim();
const first = (re, s) => { const m = re.exec(s); return m ? m[1] : ''; };

// Crossref JATS abstract: one line per <jats:title> section, as "Title: text".
function jatsAbstract(s) {
  const parts = String(s ?? '').split(/<jats:title>([\s\S]*?)<\/jats:title>/);
  const out = [unxml(parts[0])];
  for (let i = 1; i < parts.length; i += 2) {
    const title = unxml(parts[i]);
    const body = unxml(parts[i + 1]);
    if (body) out.push(title && !/^abstract$/i.test(title) ? `${title}: ${body}` : body);
  }
  return out.filter(Boolean).join('\n');
}

export function parseCrossref(json) {
  const m = json?.message;
  if (!m) return null;
  const date = (m.issued || m['published-print'] || m['published-online'])?.['date-parts']?.[0] || [];
  return {
    doi: String(m.DOI || '').toLowerCase(),
    title: unxml((m.title || [])[0]),
    authors: (m.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name || '').filter(Boolean),
    journal: unxml((m['container-title'] || [])[0]),
    year: date[0] || null,
    abstract: jatsAbstract(m.abstract),
  };
}

export function parsePubmed(xml) {
  const art = first(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/, xml);
  if (!art) return null;
  const abstract = [...art.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
    .map(([, attrs, text]) => {
      const label = first(/Label="([^"]+)"/, attrs);
      return (label ? label + ': ' : '') + unxml(text);
    }).join('\n');
  const authors = [...first(/<AuthorList[^>]*>([\s\S]*?)<\/AuthorList>/, art).matchAll(/<Author[^>]*>([\s\S]*?)<\/Author>/g)]
    .map(([, a]) => [unxml(first(/<ForeName>([\s\S]*?)<\/ForeName>/, a)), unxml(first(/<LastName>([\s\S]*?)<\/LastName>/, a))]
      .filter(Boolean).join(' ') || unxml(first(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/, a)))
    .filter(Boolean);
  const pubDate = first(/<PubDate>([\s\S]*?)<\/PubDate>/, art);
  const year = Number(first(/<Year>(\d{4})<\/Year>/, pubDate) || first(/(\d{4})/, first(/<MedlineDate>([\s\S]*?)<\/MedlineDate>/, pubDate))) || null;
  return {
    pmid: first(/<PMID[^>]*>(\d+)<\/PMID>/, art),
    doi: first(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/, art).toLowerCase(),
    title: unxml(first(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/, art)).replace(/\.$/, ''),
    authors,
    journal: unxml(first(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/, art)),
    year,
    abstract,
  };
}

export function parseUnpaywall(json) {
  if (!json || typeof json !== 'object' || !json.doi) return { status: 'unknown', license: null, url: null };
  const best = json.best_oa_location || {};
  return {
    status: json.oa_status || (json.is_oa ? 'green' : 'closed'),
    license: best.license || null,
    url: best.url_for_pdf || best.url || null,
  };
}

async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { Accept: 'application/json' } });
  return r.ok ? r.json() : null;
}
async function getText(fetchFn, url) {
  const r = await fetchFn(url);
  return r.ok ? r.text() : '';
}

export async function unpaywall(doi, fetchFn, email) {
  if (!doi) return parseUnpaywall(null);
  return parseUnpaywall(await getJson(fetchFn, `${UNPAYWALL}${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`).catch(() => null));
}

// Merge Crossref (metadata of record) with PubMed (abstract, PMID) and Unpaywall (open access).
export async function lookup(input, fetchFn, email) {
  const id = parseId(input);
  if (!id) return { error: 'Not a DOI or PubMed ID' };
  let pm = null;
  let doi = id.doi;
  if (id.pmid) {
    pm = parsePubmed(await getText(fetchFn, EFETCH + id.pmid));
    if (!pm) return { error: 'PubMed ID not found' };
    doi = pm.doi || null;
  }
  const cr = doi ? parseCrossref(await getJson(fetchFn, CROSSREF + encodeURIComponent(doi)).catch(() => null)) : null;
  if (!pm && doi) {
    const ids = await getJson(fetchFn, ESEARCH + encodeURIComponent(`${doi}[doi]`)).catch(() => null);
    const pmid = ids?.esearchresult?.idlist?.length === 1 ? ids.esearchresult.idlist[0] : null;
    if (pmid) pm = parsePubmed(await getText(fetchFn, EFETCH + pmid));
  }
  if (!cr && !pm) return { error: 'DOI not found' };
  const oa = await unpaywall(doi, fetchFn, email);
  return {
    doi: doi || '',
    pmid: pm?.pmid || '',
    title: cr?.title || pm?.title || '',
    authors: cr?.authors?.length ? cr.authors : pm?.authors || [],
    journal: cr?.journal || pm?.journal || '',
    year: cr?.year || pm?.year || null,
    abstract: pm?.abstract || cr?.abstract || '',
    oa,
  };
}
