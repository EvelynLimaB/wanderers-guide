import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertPathbuilderDerivedMatchesShare,
  parsePathbuilderBrowserExport,
  PATHBUILDER_EXPORT_RESULT,
} from '../src/process/import/pathbuilder/pathbuilder-browser-bridge.ts';

const share = {
  characterName: 'Kasane',
  className: 'Champion',
  characterLevel: 7,
  ancestry: 'Automaton',
  heritage: 'Hunter Automaton',
};

const derived = {
  name: 'Kasane',
  class: 'Champion',
  level: 7,
  keyability: 'str',
  ancestry: 'Automaton',
  heritage: 'Hunter Automaton',
  abilities: { str: 19, dex: 14, con: 16, int: 10, wis: 12, cha: 16 },
  acTotal: { acTotal: 24, shieldBonus: '1' },
};

test('browser export message is tied to its nonce and share ID', () => {
  const parsed = parsePathbuilderBrowserExport({
    type: PATHBUILDER_EXPORT_RESULT,
    nonce: '12345678-1234-4234-8234-123456789abc',
    shareId: '1596110',
    exportId: '476951',
    derived,
  }, '12345678-1234-4234-8234-123456789abc', '1596110');

  assert.equal(parsed.exportId, '476951');
  assert.equal(parsed.derived.keyability, 'str');

  assert.throws(
    () => parsePathbuilderBrowserExport({
      type: PATHBUILDER_EXPORT_RESULT,
      nonce: 'wrong-nonce-123456789',
      shareId: '1596110',
      exportId: 476951,
      derived,
    }, '12345678-1234-4234-8234-123456789abc', '1596110'),
    /did not match this import request/
  );

  assert.throws(
    () => parsePathbuilderBrowserExport({
      type: PATHBUILDER_EXPORT_RESULT,
      nonce: '12345678-1234-4234-8234-123456789abc',
      shareId: '1596000',
      exportId: 476951,
      derived,
    }, '12345678-1234-4234-8234-123456789abc', '1596110'),
    /different share ID/
  );
});

test('share and derived export identity must match exactly', () => {
  assert.doesNotThrow(() => assertPathbuilderDerivedMatchesShare(share, derived));

  assert.throws(
    () => assertPathbuilderDerivedMatchesShare(share, { ...derived, name: 'Another Character' }),
    /mismatch for name/
  );
  assert.throws(
    () => assertPathbuilderDerivedMatchesShare(share, { ...derived, class: 'Wizard' }),
    /mismatch for class/
  );
  assert.throws(
    () => assertPathbuilderDerivedMatchesShare(share, { ...derived, level: 8 }),
    /mismatch for level/
  );
  assert.throws(
    () => assertPathbuilderDerivedMatchesShare(share, { ...derived, ancestry: 'Elf' }),
    /mismatch for ancestry/
  );
});

test('missing identity on either side fails closed', () => {
  assert.throws(
    () => assertPathbuilderDerivedMatchesShare(share, { ...derived, name: undefined }),
    /JSON export is missing name/
  );
  assert.throws(
    () => assertPathbuilderDerivedMatchesShare({ ...share, className: undefined }, derived),
    /share payload is missing class/
  );
});
