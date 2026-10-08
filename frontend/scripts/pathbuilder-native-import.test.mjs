import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBuild } from '../src/process/import/pathbuilder/pathbuilder-resolve.ts';
import { createOperationEngine } from './operation-test-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { build } = createRequire(join(root, 'package.json'))('esbuild');
const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = await mkdtemp(join(tmpdir(), 'wg-pathbuilder-import-'));

const contentStore = `
let packageContent = {
  abilityBlocks: [],
  classes: [],
  ancestries: [],
  backgrounds: [],
  items: [],
  traits: [],
  languages: [],
  spells: [],
  archetypes: [],
  classArchetypes: [],
  sources: [],
  defaultSources: { PAGE: [], INFO: [] },
};
export function importFromContentPackage(content) {
  packageContent = structuredClone(content);
}
export function setFixtures() {}
export function getCachedContent(type) {
  const map = {
    'ability-block': 'abilityBlocks',
    class: 'classes',
    ancestry: 'ancestries',
    background: 'backgrounds',
    item: 'items',
    trait: 'traits',
    language: 'languages',
    spell: 'spells',
    archetype: 'archetypes',
    'class-archetype': 'classArchetypes',
  };
  return packageContent[map[type]] ?? [];
}
export async function fetchContentById(type, id) {
  return getCachedContent(type).find((row) => row.id === id) ?? null;
}
export async function fetchContent(type, data) {
  const rows = getCachedContent(type);
  if (data?.id === undefined) return rows;
  const ids = Array.isArray(data.id) ? data.id : [data.id];
  return rows.filter((row) => ids.includes(row.id));
}
export async function fetchContentAll(type) {
  return getCachedContent(type);
}
export async function fetchTraitByName(name) {
  return getCachedContent('trait').find((row) => row.name.toLowerCase() === name.toLowerCase()) ?? null;
}
export async function fetchArchetypeByDedicationFeat() { return null; }
export function getDefaultSources(view) { return packageContent.defaultSources?.[view] ?? []; }
export function getDefaultSourcesKey(view) { return (getDefaultSources(view) ?? []).join(','); }
export function defineDefaultSources() {}
export async function fetchContentPackage() { return structuredClone(packageContent); }
export async function fetchContentSources() { return []; }
export async function fetchAbilityBlockByName() { return null; }
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

const notifications = 'export function showNotification() {} export function hideNotification() {}';
const creation = `export async function createPathbuilderContentSource() { return null; }
export async function upsertItem() {}
export async function upsertSpell() {}
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
export async function upsertVersatileHeritage() { return null; }`;
const requests = 'export async function makeRequest(_endpoint, body) { return { ...body, id: body.id === undefined ? 9001 : body.id }; }';

const outfile = join(bundleDir, 'importer.mjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: 'export { buildCharacter } from "./src/process/import/pathbuilder/pathbuilder-share-importer.ts";',
    resolveDir: root,
  },
  outfile,
  bundle: true,
  write: true,
  platform: 'node',
  format: 'esm',
  tsconfig: join(root, 'tsconfig.json'),
  plugins: [
    {
      name: 'pathbuilder-integration-fixtures',
      setup(p) {
        for (const [filter, contents] of [
          [/^@content\/content-store$/, contentStore],
          [/^@content\/content-creation$/, creation],
          [/^@requests\/request-manager$/, requests],
          [/^@mantine\/notifications$/, notifications],
          [/^@content\/content-utils$/, `
export function toMarkdown(value) { return String(value ?? ""); }
export function toHTML(value) { return String(value ?? ""); }
export function toText(value) { return String(value ?? ""); }
export function isAbilityBlockType(value) { return ['action', 'feat', 'physical-feature', 'sense', 'class-feature', 'heritage', 'mode'].includes(value ?? ''); }
export function isActionCost(value) { return ['ONE-ACTION', 'TWO-ACTIONS', 'THREE-ACTIONS', 'REACTION', 'FREE-ACTION', 'REACTION-OR-ONE-ACTION', 'ONE-TO-TWO-ACTIONS', 'ONE-TO-THREE-ACTIONS', 'TWO-TO-THREE-ACTIONS', 'TWO-TO-TWO-ROUNDS', 'TWO-TO-THREE-ROUNDS', 'THREE-TO-TWO-ROUNDS', 'THREE-TO-THREE-ROUNDS', null].includes(value); }
export function convertToContentType(type) { if (type === 'hazard') return 'creature'; if (type === 'cast-spell' || type === 'add-spell') return 'spell'; if (type === 'inv-item') return 'item'; return isAbilityBlockType(type) ? 'ability-block' : type; }
export function getIconFromContentType() { return undefined; }
`],
        ]) {
          p.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'pb-fixture' }));
        }
        p.onLoad({ filter: /.*/, namespace: 'pb-fixture' }, (args) => {
          const entry = [
            { key: '@content/content-store', value: contentStore },
            { key: '@content/content-creation', value: creation },
            { key: '@requests/request-manager', value: requests },
            { key: '@mantine/notifications', value: notifications },
            { key: '@content/content-utils', value: `
export function toMarkdown(value) { return String(value ?? ""); }
export function toHTML(value) { return String(value ?? ""); }
export function toText(value) { return String(value ?? ""); }
export function isAbilityBlockType(value) { return ['action', 'feat', 'physical-feature', 'sense', 'class-feature', 'heritage', 'mode'].includes(value ?? ''); }
export function isActionCost(value) { return ['ONE-ACTION', 'TWO-ACTIONS', 'THREE-ACTIONS', 'REACTION', 'FREE-ACTION', 'REACTION-OR-ONE-ACTION', 'ONE-TO-TWO-ACTIONS', 'ONE-TO-THREE-ACTIONS', 'TWO-TO-THREE-ACTIONS', 'TWO-TO-TWO-ROUNDS', 'TWO-TO-THREE-ROUNDS', 'THREE-TO-TWO-ROUNDS', 'THREE-TO-THREE-ROUNDS', null].includes(value); }
export function convertToContentType(type) { if (type === 'hazard') return 'creature'; if (type === 'cast-spell' || type === 'add-spell') return 'spell'; if (type === 'inv-item') return 'item'; return isAbilityBlockType(type) ? 'ability-block' : type; }
export function getIconFromContentType() { return undefined; }
` },
          ].find((entry) => args.path === entry.key);
          return { contents: entry.value, loader: 'ts' };
        });
      },
    },
  ],
});

const { buildCharacter } = await import(pathToFileURL(outfile).href);

const attributeSelect = (id, title = 'Select an Attribute') => ({
  id,
  type: 'select',
  data: {
    title,
    modeType: 'FILTERED',
    optionType: 'ADJ_VALUE',
    optionsPredefined: [],
    optionsFilters: {
      id: `filter-${id}`,
      type: 'ADJ_VALUE',
      group: 'ATTRIBUTE',
      value: { value: 1 },
    },
  },
});

const pathbuilderCharacterData = {
  characterLevel: 7,
  characterName: 'Arsene (Reset)',
  ancestry: 'Fleshwarp',
  heritage: 'Ifrit',
  className: 'Wizard',
  background: 'BACKGROUND_Criminal',
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
  hashMapFeatSelections: {
    'Free Archetype 4': 'ARCHETYPE_Rogue Dedication',
  },
  freeArchetype: false,
  playerArmor: { armorName: 'Padded Armor', potency: 1 },
};

const resolved = resolveBuild(
  { characterData: pathbuilderCharacterData },
  { buildId: '1596127' }
);

const WIZARD_TRAIT = 2001;
const ANCESTRY_TRAIT = 2002;
const DEDICATION_TRAIT = 1001;

const content = {
  defaultSources: { PAGE: [], INFO: [] },
  classes: [
    {
      id: 1, name: 'Wizard', trait_id: WIZARD_TRAIT, skill_training_base: 0,
      operations: [
        { id: 'wizard-key', type: 'select', data: {
          title: 'Select Key Ability', modeType: 'FILTERED', optionType: 'ADJ_VALUE',
          optionsPredefined: [], optionsFilters: { id: 'wizard-key-filter', type: 'ADJ_VALUE', group: 'ATTRIBUTE', value: { value: 0 } },
        } },
        attributeSelect('wizard-boost-1'),
        attributeSelect('wizard-boost-2'),
        attributeSelect('wizard-boost-3'),
        attributeSelect('wizard-boost-4'),
        { id: 'wizard-unarmored', type: 'adjValue', data: { variable: 'UNARMORED_DEFENSE', value: { value: 'T' } } },
      ],
    },
  ],
  ancestries: [
    {
      id: 2, name: 'Fleshwarp', trait_id: ANCESTRY_TRAIT,
      operations: [
        { id: 'fleshwarp-fixed-con', type: 'adjValue', data: { variable: 'ATTRIBUTE_CON', value: { value: 1 } } },
        attributeSelect('fleshwarp-free'),
      ],
    },
  ],
  backgrounds: [
    {
      id: 3, name: 'Criminal',
      operations: [
        { id: 'criminal-int', type: 'adjValue', data: { variable: 'ATTRIBUTE_INT', value: { value: 1 } } },
        { id: 'criminal-dex', type: 'adjValue', data: { variable: 'ATTRIBUTE_DEX', value: { value: 1 } } },
      ],
    },
  ],
  abilityBlocks: [
    {
      id: 4004, name: 'Ifrit', type: 'heritage', traits: [ANCESTRY_TRAIT],
      operations: [],
    },
    {
      id: 5001, name: 'Rogue Dedication', type: 'feat', traits: [DEDICATION_TRAIT],
      operations: [
        { id: 'rogue-light-armor', type: 'adjValue', data: { variable: 'LIGHT_ARMOR', value: { value: 'T' } } },
      ],
      meta_data: { archetype_trait: true },
    },
    ...[2, 3, 4, 5, 7].map((level) => ({
      id: 6000 + level,
      name: 'Attribute Boosts',
      type: 'class-feature',
      level,
      traits: [WIZARD_TRAIT],
      operations: [attributeSelect(`level-${level}-boost`)],
    })),
    {
      id: 6104,
      name: 'Archetype Choice',
      type: 'class-feature',
      level: 4,
      traits: [WIZARD_TRAIT],
      operations: [{
        id: 'rogue-dedication-slot',
        type: 'select',
        data: {
          title: 'Select an Archetype Feat',
          modeType: 'PREDEFINED',
          optionType: 'ABILITY_BLOCK',
          optionsPredefined: [{
            id: 'rogue-option',
            type: 'ABILITY_BLOCK',
            operation: { id: 'rogue-give', type: 'giveAbilityBlock', data: { abilityBlockId: 5001, type: 'feat' } },
          }],
        },
      }],
    },
  ],
  items: [
    {
      id: 7001,
      name: 'Padded Armor',
      group: 'ARMOR',
      traits: [],
      operations: [
        { id: 'padded-potency', type: 'addBonusToValue', data: { variable: 'AC_BONUS', value: '+1', type: 'item', text: '' } },
      ],
      meta_data: {
        category: 'light',
        ac_bonus: 1,
        dex_cap: 3,
        runes: { potency: 0, striking: 0, property: [] },
      },
    },
  ],
  traits: [
    { id: DEDICATION_TRAIT, name: 'Dedication', meta_data: {} },
    { id: WIZARD_TRAIT, name: 'Wizard', meta_data: { class_trait: true } },
    { id: ANCESTRY_TRAIT, name: 'Fleshwarp', meta_data: { ancestry_trait: true } },
  ],
  sources: [],
  languages: [],
  spells: [],
  archetypes: [],
  classArchetypes: [],
};

const derived = {
  abilities: { str: 10, dex: 16, con: 16, int: 20, wis: 12, cha: 12 },
  acTotal: { acTotal: 24 },
};

const warnings = [];
const customItems = new Map();
const fallbackSpells = new Map();
const built = await buildCharacter(resolved, content, customItems, fallbackSpells, null, warnings, derived);

const engine = await createOperationEngine();
try {
  const packet = await engine._executeCharacterOperations({
    character: built,
    content,
    context: 'CHARACTER-SHEET',
  });
  engine.importVariableStore('CHARACTER', packet.store);
  const parts = engine.getAcParts('CHARACTER', built.inventory.items.find((entry) => entry.is_equipped)?.item);
  const attrs = Object.fromEntries(
    ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map((name) => [
      name,
      engine.getFinalVariableValue('CHARACTER', `ATTRIBUTE_${name}`).total,
    ])
  );
  const expectedPathbuilderScores = { STR: 10, DEX: 16, CON: 16, INT: 20, WIS: 12, CHA: 12 };
  assert.deepEqual(
    Object.fromEntries(Object.entries(attrs).map(([name, modifier]) => [name, 10 + modifier * 2])),
    expectedPathbuilderScores,
    'imported WG modifiers must reproduce the Pathbuilder ability scores 1:1'
  );
  assert.equal(parts.profBonus, 9, 'Light Armor trained proficiency must include level 7');
  assert.equal(engine.getFinalProfValue('CHARACTER', 'LIGHT_ARMOR'), '+9');
  assert.equal(engine.getFinalProfValue('CHARACTER', 'UNARMORED_DEFENSE'), '+9');
  assert.equal(parts.armorBonus, 2, 'Padded Armor +1 must contribute +2 AC');
  assert.equal(engine.getFinalAcValue('CHARACTER', built.inventory.items.find((entry) => entry.is_equipped)?.item), 24);
  assert.equal(warnings.length, 0, `import must not leave warnings: ${warnings.join('; ')}`);

  await assert.rejects(
    buildCharacter(
      resolved,
      content,
      customItems,
      fallbackSpells,
      null,
      [],
      { abilities: { str: 10, dex: 16, con: 16, int: 20, wis: 12, cha: 12 }, acTotal: { acTotal: 23 } }
    ),
    /Pathbuilder 1:1 validation failed:/
  );
} finally {
  await engine.cleanup();
  await rm(bundleDir, { recursive: true, force: true });
}
