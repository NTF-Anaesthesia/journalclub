import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeEntities, abstractSections, xmlToText, cleanPaper } from '../src/abstract.js';
import { parsePubmed, parseCrossref } from '../worker/lookup.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('decodeEntities reads hex, decimal and named entities once', () => {
  assert.equal(decodeEntities('CO&#x2082; &#x2264;&#xa0;5 &#8805; &le; &alpha; &Delta; &sigma;'), 'CO₂ ≤ 5 ≥ ≤ α Δ σ');
  assert.equal(decodeEntities('&amp;#x2264; &amp;lt;0.05 R&amp;D'), '≤ <0.05 R&D');
  assert.equal(decodeEntities('&unknown; &#x0; &#xD800;'), '&unknown; &#x0; &#xD800;');
  assert.equal(decodeEntities('&lowast; &sdot; &rArr; &hyphen; &sigmaf; &euro;'), '∗ ⋅ ⇒ ‐ ς €');
});

test('parsePubmed decodes hex entities and keeps section labels', () => {
  const p = parsePubmed(fx('pubmed-hex-entities.xml'));
  assert.equal(p.title, 'Oxygen and CO₂ in the PACU');
  assert.doesNotMatch(p.abstract, /&#x|&amp;|&lt;/);
  assert.equal(p.abstract, 'BACKGROUND: Low SpO₂ is common.\nMETHODS: Adults aged ≥ 18 years with BMI ≤ 35 kg·m⁻² & ASA I–III.\nRESULTS: Rate fell (P < 0.001).');
  assert.deepEqual(abstractSections(p.abstract).map((s) => s.label), ['BACKGROUND', 'METHODS', 'RESULTS']);
});

test('abstractSections splits stored labelled abstracts and decodes old entities', () => {
  const s = abstractSections('BACKGROUND: SpO&#x2082; dips.\nMETHODS: We studied &#x2264;&#xa0;40 adults.\nCONCLUSIONS: It works.');
  assert.deepEqual(s, [
    { label: 'BACKGROUND', text: 'SpO₂ dips.' },
    { label: 'METHODS', text: 'We studied ≤ 40 adults.' },
    { label: 'CONCLUSIONS', text: 'It works.' },
  ]);
});

test('abstractSections finds inline all-caps headers only before a colon after a sentence', () => {
  const s = abstractSections('BACKGROUND: Pain is common. METHODS AND RESULTS: We randomised 40 (HR: 0.8). Using MRI: none. INTERPRETATION: Fine.');
  assert.deepEqual(s.map((x) => x.label), ['BACKGROUND', 'METHODS AND RESULTS', 'INTERPRETATION']);
  assert.equal(s[1].text, 'We randomised 40 (HR: 0.8). Using MRI: none.');
  assert.deepEqual(abstractSections('Plain text with no headers. NOTE that MRI is fine.'), [{ label: '', text: 'Plain text with no headers. NOTE that MRI is fine.' }]);
  assert.deepEqual(abstractSections('Intro text. RESULTS: Good.'), [{ label: '', text: 'Intro text.' }, { label: 'RESULTS', text: 'Good.' }]);
});

test('parseCrossref reads a JATS abstract with section titles', () => {
  const p = parseCrossref({ message: { DOI: '10.1/x', title: ['T'], abstract:
    '<jats:sec><jats:title>Background</jats:title><jats:p>CO&#x2082; rises.</jats:p></jats:sec><jats:sec><jats:title>Results</jats:title><jats:p>It fell.</jats:p></jats:sec>' } });
  assert.equal(p.abstract, 'Background: CO₂ rises.\nResults: It fell.');
  assert.deepEqual(abstractSections(p.abstract).map((x) => x.label), ['Background', 'Results']);
});

test('xmlToText keeps exponents and subscripts, spaces block tags, drops invisible characters', () => {
  assert.equal(xmlToText('platelets &lt;100 &#xd7; 10<sup>9</sup>/L, CO<sub>2</sub>, H<inf>2</inf>O'), 'platelets <100 × 109/L, CO₂, H₂O'.replace('109', '10⁹'));
  assert.equal(xmlToText('P = 2 &#xd7; 10<sup>&#x2212;5</sup>; 10<sup>-3.5</sup>; Smith<sup>a</sup>; Drug<sup>&#xae;</sup>'), 'P = 2 × 10⁻⁵; 10^(-3.5); Smitha; Drug®');
  assert.equal(xmlToText('<jats:p>One.</jats:p><jats:p>Two<br/>three</jats:p>'), 'One. Two three');
  assert.equal(xmlToText('an\u00adaes\u200bthesia\ufeff and cafe\u0301'), 'anaesthesia and caf\u00e9');
  assert.equal(xmlToText('a <sub>&lt;5</sub> b'), 'a <5 b');
});

test('parsePubmed reads only the main abstract, not translations, and decodes labels', () => {
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>T</ArticleTitle>
    <Abstract><AbstractText Label="AIMS &amp; OBJECTIVES">English.</AbstractText></Abstract></Article>
    <OtherAbstract Language="spa"><AbstractText>Espa&#xf1;ol.</AbstractText></OtherAbstract></MedlineCitation></PubmedArticle>`;
  assert.equal(parsePubmed(xml).abstract, 'AIMS & OBJECTIVES: English.');
});

test('cleanPaper decodes titles, journals and authors saved the old way', () => {
  const p = cleanPaper({ title: 'CO&#x2082; and &#x3b2;-blockers', journal: 'Br J Anaesth', authors: ['J M&#xfc;ller'], abstract: 'x' });
  assert.deepEqual(p, { title: 'CO₂ and β-blockers', journal: 'Br J Anaesth', authors: ['J Müller'], abstract: 'x' });
});
