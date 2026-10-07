import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildCustomFileIndex,
  isPathbuilderUuid,
  parseCustomFileJson,
  parseFeatSlotKey,
  parseFeatValue,
  resolveBuild,
  stripCategoryPrefix,
} from '../src/process/import/pathbuilder/pathbuilder-resolve.ts';
import { extractBuildId, fetchPathbuilderShare } from '../src/process/import/pathbuilder/fetch-pathbuilder-share.ts';
import { PathbuilderShareBuildSchema } from '../src/schemas/pathbuilder.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'pathbuilder-kasane-1596127.json'), 'utf8'));

/**
 * Build 1596127 ("Kasane") is the regression case for the whole importer: it is
 * a level 20 Automaton Champion carrying two custom weapons, one active custom
 * buff, a container hierarchy, and an armor entry that cannot be resolved.
 * Everything below asserts against that captured payload.
 */
const resolved = resolveBuild(fixture.build, {
  buildId: fixture.build_id,
  formatVersion: fixture.format_version,
});

test('the captured v121 share payload passes the wire schema and fetch parser', async () => {
  const parsed = PathbuilderShareBuildSchema.safeParse(fixture.build);
  assert.equal(parsed.success, true);

  const stringTyped = structuredClone(fixture.build);
  stringTyped.listCustomFiles[0].type = '1';

  const reparsed = PathbuilderShareBuildSchema.safeParse(stringTyped);
  assert.equal(reparsed.success, true);

  const response = new Response(
    JSON.stringify({
      success: true,
      version: '121',
      build: JSON.stringify(stringTyped),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

  const fetched = await fetchPathbuilderShare('1596127', {
    fetchImpl: async () => response,
  });

  assert.equal(fetched.ok, true);
  if (fetched.ok) {
    assert.equal(fetched.formatVersion, '121');
    assert.equal(fetched.build.listCustomFiles?.[0]?.type, 1);
  }
});

test('identity is read from characterData, not from a derived sheet', () => {
  assert.equal(resolved.identity.name, 'Kasane');
  assert.equal(resolved.identity.level, 20);
  assert.equal(resolved.identity.ancestry, 'Automaton');
  assert.equal(resolved.identity.className, 'Champion');
  assert.equal(resolved.identity.gender, 'Female?');
  assert.equal(resolved.buildId, '1596127');
  assert.equal(resolved.formatVersion, '121');
});

test('the BACKGROUND_ prefix is stripped but nothing else is mangled', () => {
  assert.equal(resolved.identity.background, 'Bounty Hunter');
  assert.equal(stripCategoryPrefix('BACKGROUND_Bounty Hunter'), 'Bounty Hunter');
  assert.equal(stripCategoryPrefix('Bounty Hunter'), 'Bounty Hunter');
  assert.equal(stripCategoryPrefix(undefined), undefined);
});

test('rule variants map onto WG CharacterVariants keys', () => {