import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.window = { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { documentElement: { style: {} }, addEventListener() {}, removeEventListener() {} };

import { build } from 'esbuild';
import { createOperationEngine, readContentRows } from './operation-test-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'pathbuilder-kasane-1597410.json'), 'utf8'));

assert.equal(fixture.build_id, '1597410');
assert.equal(fixture.format_version, '121');

const sourceIds = [
  3, 32, 14, 34, 33, 18, 839, 611, 114, 239, 240, 241, 35, 51, 19, 20, 11, 43, 580, 12,
  420, 730, 36, 9, 21, 37, 818, 203, 38, 7, 22, 23, 731, 17, 852, 853, 859, 867, 146, 185,
  24, 842, 437, 635, 39, 25, 26, 45, 8, 873, 27, 636, 811, 46, 499, 40, 117, 186, 50, 29, 1,
  256, 276, 476, 41, 15, 748, 493, 402, 52, 13, 118, 582, 591, 147, 448, 578, 793, 579, 152,
  42, 840, 590, 172, 44, 28, 47, 48, 318, 171, 30, 16, 581, 838, 49, 85, 400, 305, 31,
];

const tableMap = {
  ability_block: 'abilityBlocks',
  class: 'classes',
  ancestry: 'ancestries',
  background: 'backgrounds',
  spell: 'spells',
  item: 'items',
  trait: 'traits',
  language: 'languages',
  archetype: 'archetypes',
  versatile_heritage: 'versatileHeritages',
  class_archetype: 'classArchetypes',
};

const rows = await readContentRows(
  Object.keys(tableMap).map((table) => ({ table, sourceIds }))
);

const content = Object.fromEntries(Object.values(tableMap).map((key) => [key, []]));
for (const { table, row } of rows) {
  content[tableMap[table]].push(row);
}
content.defaultSources = { PAGE: sourceIds, INFO: sourceIds };
content.sources = sourceIds.map((id) => ({ id }));

const contentStore = `
let packageContent = {
  abilityBlocks: [], classes: [], ancestries: [], backgrounds: [], spells: [], items: [],
  traits: [], languages: [], archetypes: [], versatileHeritages: [], classArchetypes: [],
  sources: [], defaultSources: { PAGE: [], INFO: [] },
};
export function importFromContentPackage(value) { packageContent = structuredClone(value); }
export function setFixtures() {}
export function getCachedContent(type) {
  const map = {
    'ability-block': 'abilityBlocks',
    class: 'classes',
    ancestry: 'ancestries',
    background: 'backgrounds',
    spell: 'spells',
    item: 'items',
    trait: 'traits',
    language: 'languages',
    archetype: 'archetypes',
    'versatile-heritage': 'versatileHeritages',
    'class-archetype': 'classArchetypes',
  };
  return packageContent[map[type]] ?? [];
}
export async function fetchContentById(type, id) {
  return getCachedContent(type).find((row) => row.id === id) ?? null;
}
export async function fetchContent(type, data) {
  let rows = getCachedContent(type);
  if (data?.id !== undefined) {
    const ids = Array.isArray(data.id) ? data.id : [data.id];
    rows = rows.filter((row) => ids.includes(row.id));
  }
  if (Array.isArray(data?.content_sources)) {
    rows = rows.filter((row) => data.content_sources.includes(row.content_source_id));
  }
  return rows;
}
export async function fetchContentAll(type, requestedSources) {
  const rows = getCachedContent(type);
  return rows.filter((row) =>
    !Array.isArray(requestedSources) ||
    requestedSources.length === 0 ||
    requestedSources.includes(row.content_source_id)
  );
}
export async function fetchTraitByName(name) {
  return getCachedContent('trait').find((row) => row.name.toLowerCase() === name.toLowerCase()) ?? null;
}
export async function fetchArchetypeByDedicationFeat(id) {
  return getCachedContent('archetype').find((row) => row.dedication_feat_id === id) ?? null;
}
export function getDefaultSources(view) { return packageContent.defaultSources?.[view] ?? []; }
export function getDefaultSourcesKey(view) { return getDefaultSources(view).join(','); }
export function defineDefaultSources(view, values) {
  packageContent.defaultSources[view] = values;
  return values;
}
export async function fetchContentPackage() { return structuredClone(packageContent); }
export async function fetchContentSources() { return structuredClone(packageContent.sources ?? []); }
export async function fetchAbilityBlockByName(name) {
  return getCachedContent('ability-block').find((row) => row.name.toLowerCase() === name.toLowerCase()) ?? null;
}
export async function fetchAllPrereqs() { return []; }
export async function fetchCreatureByName() { return null; }
export async function fetchItemByName() { return null; }
export async function fetchLanguageByName() { return null; }
export async function fetchSpellByName() { return null; }
export async function fetchTraits() { return []; }
export async function fetchVersHeritageByHeritage() { return null; }
export async function findRequiredContentSources() {
  return { sourceIds: [], sources: [], newSourceIds: [], newSources: [] };
}
export function getContentFast() { return []; }
export function resetContentStore() {}
export function setContentCacheActor() {}
`;

const notifications = 'export function showNotification() {} export function hideNotification() {} export function updateNotification() {}';

const creation = `
let itemId = 100000;
export async function createPathbuilderContentSource() {
  return {
    id: 902, created_at: '', user_id: '', name: 'Pathbuilder Custom',
    foundry_id: null, url: null, description: '', operations: [], contact_info: '',
    require_key: false, keys: null, is_published: false, artwork_url: '',
    required_content_sources: [], group: '', meta_data: null,
  };
}
export async function upsertItem(item) { return { ...structuredClone(item), id: ++itemId }; }
export async function upsertSpell(item) { return { ...structuredClone(item), id: ++itemId }; }
export async function deleteContent() { return null; }
export async function upsertAbilityBlock() { return null; }
export async function upsertAncestry() { return null; }
export async function upsertArchetype() { return null; }
export async function upsertBackground() { return null; }
export async function upsertClass() { return null; }
export async function upsertClassArchetype() { return null; }
export async function upsertContent() { return null; }
export async function upsertContentSource() { return null; }
export async function upsertCreature() { return null; }
export async function upsertLanguage() { return null; }
export async function upsertTrait() { return null; }
export async function upsertVersatileHeritage() { return null; }
`;

const requests = `
let importRowId = 7001;
export async function makeRequest(endpoint, body) {
  if (endpoint === 'create-pathbuilder-import' && body?.id === -1) return { id: importRowId };
  if (endpoint === 'create-pathbuilder-import') return true;
  if (endpoint === 'create-character') return { ...structuredClone(body), id: 9001 };
  return { ...structuredClone(body), id: body?.id === undefined ? 9001 : body.id };
}
`;

const contentUtils = `
export function toMarkdown(value) { return String(value ?? ''); }
export function toHTML(value) { return String(value ?? ''); }
export function toText(value) { return String(value ?? ''); }
export function isAbilityBlockType(value) {
  return ['action','feat','physical-feature','sense','class-feature','heritage','mode'].includes(value ?? '');
}
export function isActionCost(value) {
  return ['ONE-ACTION','TWO-ACTIONS','THREE-ACTIONS','REACTION','FREE-ACTION',
    'REACTION-OR-ONE-ACTION','ONE-TO-TWO-ACTIONS','ONE-TO-THREE-ACTIONS',
    'TWO-TO-THREE-ACTIONS','TWO-TO-TWO-ROUNDS','TWO-TO-THREE-ROUNDS',
    'THREE-TO-TWO-ROUNDS','THREE-TO-THREE-ROUNDS',null].includes(value);
}
export function convertToContentType(type) {
  if (type === 'hazard') return 'creature';
  if (type === 'cast-spell' || type === 'add-spell') return 'spell';
  if (type === 'inv-item') return 'item';
  return isAbilityBlockType(type) ? 'ability-block' : type;
}
export function getIconFromContentType() { return undefined; }
`;

const bundleDir = await mkdtemp(join(tmpdir(), 'wg-pathbuilder-real-import-'));
const outfile = join(bundleDir, 'importer.mjs');

try {
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        export { importFromPathbuilderShare, preflightPathbuilderImport, buildCharacter } from './src/process/import/pathbuilder/pathbuilder-share-importer.ts';
        export { importFromContentPackage } from '@content/content-store';
      `,
      resolveDir: root,
    },
    outfile,
    bundle: true,
    write: true,
    platform: 'node',
    format: 'esm',
    define: { 'import.meta.env': '{"VITE_ENV":"test","VITE_SUPABASE_URL":"http://localhost:8000","VITE_SUPABASE_KEY":"test-anon-key"}' },
    tsconfig: join(root, 'tsconfig.json'),
    plugins: [{
      name: 'pathbuilder-real-import-fixtures',
      setup(pluginBuild) {
        const entries = new Map([
          ['@content/content-store', contentStore],
          ['@content/content-creation', creation],
          ['@requests/request-manager', requests],
          ['@mantine/notifications', notifications],
          ['@content/content-utils', contentUtils],
        ]);
        for (const [key] of entries) {
          const filter = new RegExp('^' + key + '$');
          pluginBuild.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'pb-real-fixture' }));
        }
        pluginBuild.onLoad({ filter: /.*/, namespace: 'pb-real-fixture' }, (args) => {
          const value = entries.get(args.path);
          if (value === undefined) throw new Error('Missing fixture module: ' + args.path);
          return { contents: value, loader: 'ts' };
        });
      },
    }],
  });

  const importer = await import(pathToFileURL(outfile).href);
  importer.importFromContentPackage(content);

  let shareRequests = 0;
  let derivedRequests = 0;

  const createFetch = (build) => async (url, init = {}) => {
    if (url.includes('/app/fetch_emailed.php')) {
      shareRequests++;
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { id: '1597410' });
      return new Response(JSON.stringify({
        success: true,
        version: '121',
        build: JSON.stringify(build),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.includes('/json.php')) {
      derivedRequests++;
      return new Response(JSON.stringify({
        success: false,
        error: 'Build not found.',
      }), { status: 404, headers: { 'content-type': 'application/json' } });
    }

    throw new Error('Unexpected URL: ' + url);
  };

  const importBuild = async (build, selectionOverrides = {}) =>
    importer.importFromPathbuilderShare('1597410', {
      silent: true,
      selectionOverrides,
      fetchImpl: createFetch(build),
    });

  assert.equal(fixture.build.characterData.keyability, undefined);
  const rawOutcome = await importBuild(fixture.build);
  assert.equal(rawOutcome.ok, false);
  assert.match(rawOutcome.error, /key ability/i);
  assert.equal(shareRequests, 1);
  assert.equal(derivedRequests, 0);

  // The captured Pathbuilder share genuinely omits keyability. For the mechanical
  // parity test, inject the independently recovered value from the human-readable
  // oracle rather than pretending the source payload contained it.
  const certifiedBuild = structuredClone(fixture.build);
  certifiedBuild.characterData.keyability = 'str';

  shareRequests = 0;
  derivedRequests = 0;

  // Simulate the new UI wizard explicitly answering each missing required
  // operation choice before the persistence/creation path is invoked.
  const selectionOverrides = {};
  const preflight = await importer.preflightPathbuilderImport('1597410', {
    fetchImpl: createFetch(certifiedBuild),
    selectionOverrides,
  });
  assert.equal(preflight.status, 'selection-required', 'fixture should expose its omitted required choice');
  assert.match(preflight.selection.title, /deific weapon/i);
  assert.ok(
    preflight.selection.options.length > 0,
    `fixture has a required selection with no eligible options: ${preflight.selection.title}`
  );
  // Simulate the user selecting a visible, eligible option in the import wizard.
  selectionOverrides[preflight.selection.path] = preflight.selection.options[0].value;

  // Exclude preflight reads from the assertions for the actual import call.
  shareRequests = 0;
  derivedRequests = 0;
  const outcome = await importBuild(certifiedBuild, selectionOverrides);

  assert.equal(shareRequests, 1);
  assert.equal(derivedRequests, 0);
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
  assert.deepEqual(
    outcome.warnings,
    [],
    `1597410 must import without unresolved mechanics; got: ${outcome.warnings.join('; ')}`
  );
  assert.equal(outcome.character?.id, 9001);
  assert.equal(outcome.character?.name, 'Kasane');

  const engine = await createOperationEngine();
  try {
    engine.setFixtures(rows);
    const packet = await engine._executeCharacterOperations({
      character: outcome.character,
      content,
      context: 'CHARACTER-SHEET',
    });
    engine.importVariableStore('CHARACTER', packet.store);

    const score = (name) => 10 + engine.getFinalVariableValue('CHARACTER', `ATTRIBUTE_${name}`).total * 2;
    assert.deepEqual(
      Object.fromEntries(['STR','DEX','CON','INT','WIS','CHA'].map((name) => [name, score(name)])),
      { STR: 18, DEX: 14, CON: 16, INT: 10, WIS: 12, CHA: 16 },
      '1597410 ability scores must match the PDF oracle'
    );

    const armor = outcome.character.inventory.items.find(
      (entry) => entry.is_equipped && entry.item?.group === 'ARMOR'
    )?.item;
    assert.equal(
      engine.getFinalAcValue('CHARACTER', armor),
      24,
      '1597410 AC must match the PDF oracle'
    );
    assert.equal(engine.getFinalHealthValue('CHARACTER'), 99, '1597410 HP must match the PDF oracle');
    assert.equal(engine.getFinalVariableValue('CHARACTER', 'SPEED').total, 45, '1597410 speed must match the PDF oracle');

    const prof = (name) => engine.getFinalProfValue('CHARACTER', name);
    assert.equal(prof('PERCEPTION'), '+10');
    assert.equal(prof('SAVE_FORT'), '+14');
    assert.equal(prof('SAVE_REFLEX'), '+11');
    assert.equal(prof('SAVE_WILL'), '+12');
    assert.equal(prof('SKILL_ATHLETICS'), '+18');
    assert.equal(prof('SKILL_ACROBATICS'), '+11');
    assert.equal(prof('SKILL_RELIGION'), '+10');
    assert.equal(prof('SKILL_STEALTH'), '+11');
    assert.equal(prof('SKILL_SURVIVAL'), '+12');
    assert.equal(prof('SKILL_LORE_LEGAL'), '+9');

    const inventoryNames = outcome.character.inventory.items.map((entry) => entry.item?.name);
    assert.equal(inventoryNames.filter((name) => name === 'Chalk').length, 10);
    assert.equal(inventoryNames.filter((name) => name === 'Rations').length, 2);
    assert.equal(outcome.character.spells.list.length, 1);

    const weaponByName = (name) =>
      outcome.character.inventory.items.find((entry) => entry.item?.name === name)?.item;
    const javelin = weaponByName('Javelin');
    const dagger = weaponByName('Dagger');
    const claw = weaponByName('Claw');
    const stinger = weaponByName('Stinger');
    const crimson = weaponByName('Crimson Blade');

    assert.ok(javelin, 'Javelin must exist in the imported inventory');
    assert.ok(dagger, 'Dagger must exist in the imported inventory');
    assert.ok(claw, 'Claw must exist in the imported inventory');
    assert.ok(stinger, 'Stinger must exist in the imported inventory');
    assert.ok(crimson, 'Crimson Blade must exist in the imported inventory');

    const javelinStats = engine.getWeaponStats('CHARACTER', javelin);
    const daggerStats = engine.getWeaponStats('CHARACTER', dagger);
    const clawStats = engine.getWeaponStats('CHARACTER', claw);
    const stingerStats = engine.getWeaponStats('CHARACTER', stinger);
    const crimsonStats = engine.getWeaponStats('CHARACTER', crimson);

    assert.equal(javelinStats.attack_bonus.total, 14);
    assert.equal(javelinStats.damage.dice, 2);
    assert.equal(javelinStats.damage.die, 'd6');

    assert.equal(daggerStats.attack_bonus.total, 16);
    assert.equal(daggerStats.damage.dice, 2);
    assert.equal(daggerStats.damage.die, 'd4');

    assert.equal(clawStats.attack_bonus.total, 16);
    assert.equal(clawStats.damage.dice, 2);
    assert.equal(clawStats.damage.die, 'd4');

    assert.equal(stingerStats.attack_bonus.total, 16);

    assert.equal(stingerStats.attack_bonus.total, 16);
    assert.equal(stingerStats.damage.dice, 2);
    assert.equal(stingerStats.damage.die, 'd6');

    assert.equal(crimsonStats.attack_bonus.total, 16);
    assert.equal(crimsonStats.damage.dice, 2);
    assert.equal(crimsonStats.damage.die, 'd12');
  } finally {
    await engine.cleanup();
  }
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}
