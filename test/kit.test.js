import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UI } from '../src/kit.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the app core is pinned to one version in kit.js, style.css and sw.js', () => {
  assert.match(UI, /^https:\/\/core\.anawj\.com\/ui\/\d+\.\d+\.\d+(-rc\.\d+)?\/$/);
  assert.ok(read('public/style.css').includes(`@import url('${UI}theme/theme.css') layer(kit);`), 'style.css imports the pinned theme.css');
  assert.equal(/const UI = '([^']+)'/.exec(read('public/sw.js'))?.[1], UI, 'sw.js keeps the pinned version');
  const versions = new Set([...read('public/style.css').matchAll(/core\.anawj\.com\/ui\/([^/]+)\//g)].map((m) => m[1]));
  assert.equal(versions.size, 1, 'one core version in style.css');
});

test('the theme layer comes first, so the NTF kit and the app styles win', () => {
  const css = read('public/style.css');
  assert.ok(css.indexOf('@layer kit, kitoff;') < css.indexOf('@import'), 'layer order is named before the import');
  const html = read('public/index.html');
  assert.ok(html.indexOf('v1/tokens.css') < html.indexOf('v1/app.css') && html.indexOf('v1/app.css') < html.indexOf('href="style.css"'));
});
