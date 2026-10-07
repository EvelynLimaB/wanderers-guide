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

  // The type discriminator is opaque and has drifted between Pathbuilder
  // payloads. Preserve unexpected scalar/object values instead of rejecting
  // the entire share before we can resolve the actual Custom File JSON.
  const driftedType = structuredClone(fixture.build);
  driftedType.listCustomFiles[5].type = { kind: 'custom-content' };
  const driftedParsed = PathbuilderShareBuildSchema.safeParse(driftedType);
  assert.equal(driftedParsed.success, true);

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

test('level-1 ancestry/background boosts and trained-only skills are preserved', () => {
  assert.deepEqual(
    resolved.abilityBoosts
      .filter((boost) => boost.level === 1)
      .map((boost) => boost.ability),
    ['con', 'str', 'dex', 'cha', 'con', 'str', 'wis']
  );
  assert.deepEqual(resolved.trainedSkills, ['Acrobatics', 'Stealth']);
});


test('Pathbuilder keeps languages and active custom effects in the resolved payload', () => {
  assert.deepEqual(resolved.languages, ['Common']);
  assert.equal(resolved.activeCustomBuffs.length, 1);
  assert.equal(resolved.activeCustomBuffs[0].name, 'ABP Spell Attack Bonus');
  assert.equal(resolved.activeCustomBuffs[0].stacks, 1);
  assert.equal(resolved.activeCustomBuffs[0].custom?.listCustomEffects?.[0]?.effectType, 8);
  assert.equal(resolved.activeCustomBuffs[0].custom?.listCustomEffects?.[0]?.bonusAmount, 1);
});

test('json.php-derived spellcaster data resolves spell source instead of reporting it as unmapped', () => {
  const build = structuredClone(fixture.build);
  build.characterData.hashMapPlayerSpells = {
    'Message&0&0': {
      spellList: 0,
      spellName: 'Message',
      heighten: 0,
    },
  };

  const derived = {
    spellCasters: [
      {
        name: 'Wizard',
        magicTradition: 'arcane',
        spellcastingType: 'prepared',
      },
    ],
  };

  const derivedResolved = resolveBuild(build, {
    buildId: fixture.build_id,
    formatVersion: fixture.format_version,
    derived,
  });

  assert.equal(derivedResolved.spells[0].source, 'Wizard');
  assert.equal(derivedResolved.spells[0].tradition, 'arcane');
  assert.equal(derivedResolved.unresolved.some((entry) => entry.kind === 'spell-source'), false);
});

test('json.php-derived armor data recovers an armor name missing from playerArmor', () => {
  const build = structuredClone(fixture.build);
  build.characterData.playerArmor = {
    potency: 1,
    listPropertyRunes: ['Raiment'],
    armorName: 'be5e11f6-4459-4080-9107-8145dd57014b',
  };

  const derivedResolved = resolveBuild(build, {
    buildId: fixture.build_id,
    formatVersion: fixture.format_version,
    derived: {
      armor: [{ name: 'Full Plate', pot: 1 }],
    },
  });

  assert.equal(derivedResolved.armor?.name, 'Full Plate');
  assert.equal(derivedResolved.armor?.raw, 'be5e11f6-4459-4080-9107-8145dd57014b');
  assert.equal(derivedResolved.unresolved.some((entry) => entry.kind === 'armor'), false);
});

test('rule variants map onto WG CharacterVariants keys', () => {