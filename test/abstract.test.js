import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeEntities, abstractSections } from '../src/abstract.js';
import { parsePubmed, parseCrossref } from '../worker/lookup.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('decodeEntities reads hex, decimal and named entities once', () => {
  assert.equal(decodeEntities('CO&#x2082; &#x2264;&#xa0;5 &#8805; &le; &alpha; &Delta; &sigma;'), 'CO₂ ≤ 5 ≥ ≤ α Δ σ');
  assert.equal(decodeEntities('&amp;#x2264;'), '&#x2264;');
  assert.equal(decodeEntities('&unknown; &#x0;'), '&unknown; &#x0;');
});

test('parsePubmed decodes hex entities and keeps section labels', () => {
  const p = parsePubmed(fx('pubmed-hex-entities.xml'));
  assert.equal(p.title, 'Oxygen and CO₂ in the PACU');
  assert.doesNotMatch(p.abstract, /&#x|&amp;|&lt;/);
  assert.equal(p.abstract, 'BACKGROUND: Low SpO₂ is common.\nMETHODS: Adults aged ≥ 18 years with BMI ≤ 35 kg·m-2 & ASA I–III.\nRESULTS: Rate fell (P < 0.001).');
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
