import test from 'node:test';
import assert from 'node:assert/strict';
import { personIndex } from '../src/people.js';

test('a typed presenter name finds the member despite case, spaces, dots, Dr and email', () => {
  const find = personIndex([
    { name: 'Tan Wei Ming', uid: 'u1', email: 'wm.tan@x.org' },
    { name: 'Lee', uid: 'u2' }, { name: 'Lee', uid: 'u3' },
    { name: 'Not linked', uid: '' },
  ]);
  assert.equal(find('Tan Wei Ming'), 'u1');
  assert.equal(find('  tan  wei ming '), 'u1');
  assert.equal(find('Dr Tan Wei Ming'), 'u1');
  assert.equal(find('Dr. Tan Wei Ming'), 'u1');
  assert.equal(find('WM.Tan@x.org'), 'u1');
  assert.equal(find('Lee'), '');           // two members share the name: no guess
  assert.equal(find('Not linked'), '');
  assert.equal(find('Someone else'), '');
  assert.equal(find(''), '');
});
