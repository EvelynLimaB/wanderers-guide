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

  const nonNumericType = structuredClone(fixture.build);
  nonNumericType.listCustomFiles[0].type = 'custom-buff';
  const reparsedNonNumeric = PathbuilderShareBuildSchema.safeParse(nonNumericType);
  assert.equal(reparsedNonNumeric.success, true);

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
  assert.deepEqual(resolved.variants, {
    ancestry_paragon: true,
    free_archetype: true,
    gradual_attribute_boosts: true,
  });
});

test('ability boosts expand from integer indices to ability names', () => {
  const levelOne = resolved.abilityBoosts.filter((b) => b.level === 1).map((b) => b.ability);
  assert.deepEqual(levelOne, ['con', 'str', 'dex', 'cha']);
  assert.equal(resolved.abilityBoosts.length, 13);
  assert.ok(resolved.abilityBoosts.every((b) => typeof b.level === 'number'));
  assert.deepEqual(
    resolved.abilityBoosts.map((b) => b.level),
    [...resolved.abilityBoosts.map((b) => b.level)].sort((a, b) => a - b),
    'boosts are sorted by level'
  );
});

test('skill increases keep their level and drop the empty ones', () => {
  assert.deepEqual(
    resolved.skillIncreases.map((s) => `${s.level}:${s.skill}`),
    ['3:Athletics', '5:Survival', '7:Athletics', '9:Acrobatics', '11:Acrobatics', '13:Diplomacy', '15:Athletics', '17:Crafting', '19:Stealth']
  );
  assert.deepEqual(resolved.trainedSkills, ['Athletics', 'Acrobatics', 'Stealth']);
});

test('feat selections split slot/level and category/qualifier/name', () => {
  assert.equal(resolved.feats.length, 34);

  const byRaw = new Map(resolved.feats.map((f) => [f.raw, f]));

  const smite = byRaw.get('CHAMPION_Smite Evil');
  assert.equal(smite.slot, 'Champion Feat');
  assert.equal(smite.level, 6);
  assert.equal(smite.category, 'CHAMPION');
  assert.equal(smite.name, 'Smite Evil');
  assert.equal(smite.qualifier, undefined);

  const exemplar = byRaw.get('ARCHETYPE_EXEMPLAR_Exemplar Dedication');
  assert.equal(exemplar.category, 'ARCHETYPE');
  assert.equal(exemplar.qualifier, 'EXEMPLAR');
  assert.equal(exemplar.name, 'Exemplar Dedication');
  assert.equal(exemplar.level, 10);

  const heritage = byRaw.get('AUTOMATON_Hunter Automaton');
  assert.equal(heritage.slot, 'Heritage Feat');
  assert.equal(heritage.level, undefined);

  assert.deepEqual(parseFeatSlotKey('Reincarnation FeatAncestry Paragon 3'), {
    slot: 'Reincarnation FeatAncestry Paragon',
    level: 3,
  });
  assert.deepEqual(parseFeatValue('ANCESTRY_GENERAL_Reincarnation Feat'), {
    category: 'ANCESTRY',
    qualifier: 'GENERAL',
    name: 'Reincarnation Feat',
  });
});

test('special selections are flattened into slot/prompt/value', () => {
  const cause = resolved.specialSelections.find((s) => s.prompt === 'Select Cause');
  assert.equal(cause.value, 'Iniquity Cause (Unholy)');
  assert.equal(cause.slot, 'Deity and Cause');

  const domain = resolved.specialSelections.filter((s) => s.prompt === 'Select Domain');
  assert.equal(domain.length, 2);
  assert.ok(domain.every((s) => s.value === 'Metal'));

  assert.ok(!resolved.specialSelections.some((s) => s.slot === 'Skill Feat 4'));
});

test('custom weapons resolve by UUID into their full definition', () => {
  assert.equal(resolved.weapons.length, 5);
  assert.deepEqual(resolved.weapons.map((w) => w.name), ['Javelin', 'Dagger', 'Claw', 'Stinger', 'Crimson Blade']);

  const crimson = resolved.weapons.find((w) => w.name === 'Crimson Blade');
  assert.equal(crimson.kind, 'custom');
  assert.equal(crimson.uuid, 'de586c2c-938e-413e-b3e9-38ed676b83b7');
  assert.equal(crimson.raw, 'de586c2c-938e-413e-b3e9-38ed676b83b7');
  assert.equal(crimson.potency, 1);
  assert.equal(crimson.striking, 1);
  assert.equal(crimson.strikingLabel, 'Striking');
  assert.deepEqual(crimson.runes, ['Wounding']);
  assert.equal(crimson.twoHanded, true);
  assert.equal(crimson.custom.itemLevel, 9);
  assert.equal(crimson.custom.price, 600);
  assert.equal(crimson.custom.hands, '1+');
  assert.equal(crimson.custom.weaponTraits, 'Unique, Sweep, Two-Hand d12, Cursed, 3rd Party');
  assert.match(crimson.custom.description, /fuse itself with the core of an automaton/);
  assert.match(crimson.custom.action0desc, /Trigger: You roll initiative/);
  assert.equal(crimson.custom.listCustomEffects.length, 3);

  const stinger = resolved.weapons.find((w) => w.name === 'Stinger');
  assert.equal(stinger.kind, 'custom');
  assert.equal(stinger.custom.damageType, 'P');
  assert.equal(stinger.custom.group, 'Brawling');
  assert.match(stinger.custom.weaponTraits, /Unarmed/);
});

test('standard weapons keep quantity, runes and attack ability', () => {
  const javelin = resolved.weapons.find((w) => w.name === 'Javelin');
  assert.equal(javelin.kind, 'standard');
  assert.equal(javelin.quantity, 4);
  assert.deepEqual(javelin.runes, ['Returning']);
  assert.equal(javelin.potency, 1);
  assert.equal(javelin.attackAbility, 'dex');

  const dagger = resolved.weapons.find((w) => w.name === 'Dagger');
  assert.equal(dagger.attackAbility, 'str');

  const claw = resolved.weapons.find((w) => w.name === 'Claw');
  assert.equal(claw.raw, 'Special Unarmed (1d4)');
  assert.equal(claw.kind, 'standard');
});

test('the container hierarchy survives and the container is not duplicated as an item', () => {
  assert.equal(resolved.containers.length, 1);
  const backpack = resolved.containers[0];
  assert.equal(backpack.name, 'Backpack');
  assert.equal(backpack.isBackpack, true);
  assert.equal(backpack.id, 'c2a7a90d-b1ac-4a9b-a8ff-8e5536a7a3ab');

  assert.deepEqual(
    backpack.items.map((i) => `${i.name} x${i.quantity}`),
    ['Chalk x10', 'Flint and Steel x1', 'Rope x1', 'Rations x2', 'Waterskin x1', 'Soap x1']
  );

  assert.deepEqual(resolved.looseEquipment.map((i) => i.name), ['Crowbar', 'Grappling Hook', 'Bracers of Missile Deflection', 'Smoke Ball (Lesser)']);
  assert.ok(!resolved.looseEquipment.some((i) => i.name === 'Backpack'));
});

test('an armor entry with runes but no name is reported, not silently dropped', () => {
  assert.equal(resolved.armor, undefined);
  assert.deepEqual(resolved.armorRunes, ['Raiment']);
  assert.equal(resolved.armorPotency, 1);

  const armor = resolved.unresolved.find((u) => u.kind === 'armor');
  assert.ok(armor);
  assert.match(armor.reason, /no armorName/);
});

test('shield resolves from shieldName', () => {
  assert.equal(resolved.shield?.name, 'Cold Iron Buckler (Low-Grade)');
  assert.equal(resolved.shield?.kind, 'standard');
});

test('spells use spellName from the value, and flag the missing casting source', () => {
  assert.equal(resolved.spells.length, 1);
  assert.equal(resolved.spells[0].name, 'Message');
  assert.equal(resolved.spells[0].rawKey, 'Messenger&0&0');
  assert.equal(resolved.spells[0].spellListIndex, 0);

  const source = resolved.unresolved.find((u) => u.kind === 'spell-source');
  assert.ok(source);
  assert.match(source.reason, /json\.php/);
});

test('active custom buffs resolve through the Custom File index', () => {
  assert.equal(resolved.activeCustomBuffs.length, 1);
  const buff = resolved.activeCustomBuffs[0];
  assert.equal(buff.name, 'ABP Spell Attack Bonus');
  assert.equal(buff.uuid, '59119c8a-ae8a-43c7-bfe7-b0529d76ca7f');
  assert.equal(buff.stacks, 1);
  assert.equal(buff.custom.listCustomEffects[0].effectType, 8);
});

test('all three Custom Files are indexed and their raw JSON is preserved', () => {
  assert.equal(resolved.customFiles.size, 3);
  assert.deepEqual([...resolved.customFiles.keys()].sort(), [
    '59119c8a-ae8a-43c7-bfe7-b0529d76ca7f',
    'aed7ec78-7487-4428-80f6-8f4334f7dce7',
    'de586c2c-938e-413e-b3e9-38ed676b83b7',
  ]);
});

test('coins fall back to gold when the derived payload is absent', () => {
  assert.deepEqual(resolved.coins, { cp: 0, sp: 0, gp: 273, pp: 0 });

  const withDerived = resolveBuild(fixture.build, {
    buildId: fixture.build_id,
    derived: { money: { cp: 3, sp: 2, gp: 1, pp: 0 } },
  });
  assert.deepEqual(withDerived.coins, { cp: 3, sp: 2, gp: 1, pp: 0 });
});

test('notes and languages come through verbatim', () => {
  assert.match(resolved.notes, /Sun Blade: 1d4 Fire Damage/);
  assert.deepEqual(resolved.languages, ['Common']);
});

test('an ABP buff raises a hint without silently flipping a rules variant', () => {
  assert.ok(resolved.hints.some((h) => /Automatic Bonus Progression/.test(h)));
  assert.equal(resolved.variants.automatic_bonus_progression, undefined);
});

test('parseCustomFileJson tolerates both escape depths', () => {
  const inner = { name: 'Test Blade', uniqueIdentiier: 'x' };
  const single = { type: 3, json: JSON.stringify(inner), uniqueIdentifier: 'x' };
  const double = { type: 1, json: JSON.stringify(JSON.stringify(inner)), uniqueIdentifier: 'x' };

  assert.equal(parseCustomFileJson(single)?.name, 'Test Blade');
  assert.equal(parseCustomFileJson(double)?.name, 'Test Blade');
});

test('parseCustomFileJson accepts the misspelled identifier and falls back to the envelope', () => {
  const misspelled = { type: 3, json: JSON.stringify({ name: 'A', uniqueIdentiier: 'aaa' }) };
  assert.equal(parseCustomFileJson(misspelled)?.uniqueIdentifier, 'aaa');

  const noInner = { type: 3, json: JSON.stringify({ name: 'B' }), uniqueIdentifier: 'bbb' };
  assert.equal(parseCustomFileJson(noInner)?.uniqueIdentifier, 'bbb');

  assert.equal(parseCustomFileJson({ type: 9, json: 'not json at all' }), null);
  assert.equal(parseCustomFileJson({ type: 9, json: '[]' }), null);
});

test('buildCustomFileIndex is case-insensitive on the UUID key', () => {
  const index = buildCustomFileIndex([
    { type: 3, json: JSON.stringify({ name: 'A', uniqueIdentiier: 'AED7EC78-7487-4428-80f6-8f4334f7dce7' }) },
  ]);
  assert.ok(index.get('aed7ec78-7487-4428-80f6-8f4334f7dce7'));
});

test('isPathbuilderUuid distinguishes UUID references from item names', () => {
  assert.ok(isPathbuilderUuid('de586c2c-938e-413e-b3e9-38ed676b83b7'));
  assert.ok(!isPathbuilderUuid('Dagger'));
  assert.ok(!isPathbuilderUuid('Smoke Ball (Lesser)'));
  assert.ok(!isPathbuilderUuid(undefined));
});

test('extractBuildId accepts ids, share URLs and pasted junk', () => {
  assert.equal(extractBuildId(1596127), '1596127');
  assert.equal(extractBuildId('1596127'), '1596127');
  assert.equal(extractBuildId('  1596127  '), '1596127');
  assert.equal(extractBuildId('https://pathbuilder2e.com/app.html?emailedBuildID=1596127'), '1596127');
  assert.equal(extractBuildId('https://pathbuilder2e.com/app.html?id=1596127&x=1'), '1596127');
  assert.equal(extractBuildId('https://pathbuilder2e.com/share/1596127'), '1596127');
  assert.equal(extractBuildId('build 1596127 please'), '1596127');
  assert.equal(extractBuildId(''), null);
  assert.equal(extractBuildId(undefined), null);
  assert.equal(extractBuildId('https://pathbuilder2e.com/app.html'), null);
});

test('an unresolvable Custom File reference is reported with a reason', () => {
  const partial = {
    characterData: {
      characterName: 'Partial',
      characterLevel: 1,
      playerArmor: { armorName: 'be5e11f6-4459-4080-9107-8145dd57014b', potency: 1 },
      listPlayerWeapons: [{ weaponName: 'be5e11f6-4459-4080-9107-8145dd57014b' }],
    },
    listCustomFiles: [],
  };
  const result = resolveBuild(partial, { buildId: '1596110' });

  const armor = result.unresolved.find((u) => u.kind === 'armor');
  assert.ok(armor);
  assert.equal(armor.ref, 'be5e11f6-4459-4080-9107-8145dd57014b');
  assert.equal(result.armor?.kind, 'unresolved');

  const weapon = result.unresolved.find((u) => u.kind === 'weapon');
  assert.ok(weapon);
  assert.match(weapon.reason, /Custom Pack/);
});

test('a payload with nothing in it still produces a usable shell', () => {
  const empty = resolveBuild({ characterData: {} });
  assert.equal(empty.identity.name, 'Unknown Wanderer');
  assert.equal(empty.identity.level, 1);
  assert.deepEqual(empty.weapons, []);
  assert.deepEqual(empty.containers, []);
  assert.deepEqual(empty.coins, { cp: 0, sp: 0, gp: 0, pp: 0 });
});
