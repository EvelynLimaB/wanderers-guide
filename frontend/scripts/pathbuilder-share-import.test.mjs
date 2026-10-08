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
  parsePathbuilderAbility,
  pathbuilderAbilityLabel,
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
  driftedType.listCustomFiles[2].type = { kind: 'custom-content' };
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

/** Verify compact Pathbuilder ability tokens match the labels emitted by WG attribute selectors. */
test('Pathbuilder ability tokens map to native WG attribute labels', () => {
  const labels = {
    str: 'Strength',
    dex: 'Dexterity',
    con: 'Constitution',
    int: 'Intelligence',
    wis: 'Wisdom',
    cha: 'Charisma',
  };

  for (const [ability, label] of Object.entries(labels)) {
    assert.equal(pathbuilderAbilityLabel(ability), label);
    assert.equal(parsePathbuilderAbility(ability), ability);
  }
});

/** Verify the full imported boost set for Arsene can be represented by native WG selectors. */
test('Arsene ability boosts retain every Pathbuilder choice', () => {
  const arsene = resolveBuild(
    {
      characterData: {
        characterName: 'Arsene (Reset)',
        characterLevel: 7,
        ancestry: 'Fleshwarp',
        heritage: 'Ifrit',
        className: 'Wizard',
        background: 'Criminal',
        keyability: 'int',
        hashMapAncestryFreeBoostSelections: { '0': 3 },
        backgroundBoostLimitedSelection: 3,
        getBackgroundBoostFreeSelection: 1,
        hashMapAbilityBoosts: {
          '1': [1, 2, 3, 5],
          '2': [1],
          '3': [4],
          '4': [2],
          '5': [3],
          '7': [3],
        },
      },
    },
    { buildId: '1596127' }
  );

  assert.equal(arsene.identity.keyAbility, 'int');
  assert.deepEqual(arsene.abilityBoosts, [
    { level: 1, ability: 'int' },
    { level: 1, ability: 'str' },
    { level: 1, ability: 'dex' },
    { level: 1, ability: 'cha' },
    { level: 1, ability: 'con' },
    { level: 1, ability: 'dex' },
    { level: 1, ability: 'int' },
    { level: 1, ability: 'int' },
    { level: 2, ability: 'dex' },
    { level: 3, ability: 'wis' },
    { level: 4, ability: 'con' },
    { level: 5, ability: 'int' },
    { level: 7, ability: 'int' },
  ]);
});

/** Verify a derived-only key ability still reaches the native import representation. */
test('derived key ability is retained when share characterData does not contain it', () => {
  const resolvedFromDerived = resolveBuild(
    {
      characterData: {
        characterName: 'Wizard fixture',
        characterLevel: 7,
        className: 'Wizard',
      },
    },
    {
      buildId: '1',
      derived: { keyability: 'INT' },
    }
  );

  assert.equal(resolvedFromDerived.identity.keyAbility, 'int');
});

/** The share payload wins when both payload forms contain a key ability. */
test('share key ability takes precedence over derived key ability', () => {
  const resolvedFromBoth = resolveBuild(
    {
      characterData: {
        className: 'Wizard',
        keyability: 'dex',
      },
    },
    {
      derived: { keyability: 'int' },
    }
  );

  assert.equal(resolvedFromBoth.identity.keyAbility, 'dex');
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
  assert.deepEqual(resolved.trainedSkills, ['Athletics', 'Acrobatics', 'Stealth']);
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
  assert.equal(resolved.variants.ancestry_paragon, true);
  assert.equal(resolved.variants.free_archetype, true);
  assert.equal(resolved.variants.gradual_attribute_boosts, true);
});

test('custom references, quantities, containers and runes are preserved', () => {
  assert.equal(resolved.weapons.length, 5);
  assert.equal(resolved.weapons[0].quantity, 4);
  assert.equal(resolved.weapons[3].kind, 'custom');
  assert.equal(resolved.weapons[3].name, 'Stinger');
  assert.equal(resolved.weapons[4].kind, 'custom');
  assert.equal(resolved.weapons[4].name, 'Crimson Blade');
  assert.deepEqual(resolved.weapons[4].runes, ['Wounding']);
  assert.equal(resolved.containers.length, 1);
  assert.equal(resolved.containers[0].name, 'Backpack');
  assert.equal(resolved.containers[0].items.find((item) => item.name === 'Chalk')?.quantity, 10);
  assert.equal(resolved.containers[0].items.find((item) => item.name === 'Rations')?.quantity, 2);
});

test('missing derived armor remains explicitly unresolved instead of being silently dropped', () => {
  assert.equal(resolved.armor, undefined);
  assert.equal(resolved.armorRunes.includes('Raiment'), true);
  assert.equal(resolved.armorPotency, 1);
  assert.equal(resolved.unresolved.some((entry) => entry.kind === 'armor'), true);
});

test('build id extraction accepts ids/URLs and rejects arbitrary text', () => {
  assert.equal(extractBuildId('1596127'), '1596127');
  assert.equal(extractBuildId('https://pathbuilder2e.com/app.html?emailedBuildID=1596127'), '1596127');
  assert.equal(extractBuildId('https://pathbuilder2e.com/app.html?id=1596127'), '1596127');
  assert.equal(extractBuildId('not-a-build-abc'), null);
  assert.equal(extractBuildId('build 1596127 please'), null);
  assert.equal(extractBuildId(-1), null);
  assert.equal(extractBuildId(1596127.5), null);
});

test('custom item schema preserves generic Custom Pack fields', () => {
  const entry = {
    type: 5,
    uniqueIdentifier: '00000000-0000-0000-0000-000000000001',
    json: JSON.stringify({
      uniqueIdentifier: '00000000-0000-0000-0000-000000000001',
      name: 'Gloves of Combustion',
      bulk: 'L',
      traits: 'Fire, Staff, 3rd Party, Invested, Unique',
      category: 8,
      itemLevel: 9,
    }),
  };

  const parsed = parseCustomFileJson(entry);
  assert.equal(parsed?.name, 'Gloves of Combustion');
  assert.equal(parsed?.bulk, 'L');
  assert.equal(parsed?.traits, 'Fire, Staff, 3rd Party, Invested, Unique');
  assert.equal(parsed?.category, 8);
});

test('custom file index accepts Pathbuilder uniqueIdentifier misspellings', () => {
  const index = buildCustomFileIndex(fixture.build.listCustomFiles);
  assert.equal(index.size, 3);
  assert.equal(index.get('aed7ec78-7487-4428-80f6-8f4334f7dce7')?.name, 'Stinger');
  assert.equal(index.get('de586c2c-938e-413e-b3e9-38ed676b83b7')?.name, 'Crimson Blade');
});