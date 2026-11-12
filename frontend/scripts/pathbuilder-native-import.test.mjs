import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBuild } from '../src/process/import/pathbuilder/pathbuilder-resolve.ts';
globalThis.window = { location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { documentElement: { style: {} }, addEventListener() {}, removeEventListener() {} };

// This integration test replaces all network/request boundaries with fixtures.
// Keep Supabase's auth client from opening Node's real BroadcastChannel, which
// creates a referenced MessagePort and prevents the standalone test process exiting.
globalThis.BroadcastChannel = class TestBroadcastChannel {
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
};

// The bundled Supabase client requires a global WebSocket. Node 20 ships one
// behind a flag, so provide the `ws` polyfill when running on older runtimes.
if (typeof globalThis.WebSocket === 'undefined') {
  const { WebSocket } = await import('ws');
  globalThis.WebSocket = WebSocket;
}


const root = fileURLToPath(new URL('../', import.meta.url));
const { build, stop } = createRequire(join(root, 'package.json'))('esbuild');
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
  languages: [{ id: 9001, name: 'Common', speakers: '', script: '', description: '', content_source_id: 1, deprecated: false, rarity: 'COMMON', availability: null, meta_data: null }],
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

const notifications = 'export function showNotification() {} export function hideNotification() {} export function updateNotification() {}';
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
try {
  await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export { buildCharacter } from "./src/process/import/pathbuilder/pathbuilder-share-importer.ts";
      export { importFromContentPackage } from "@content/content-store";
      export { _executeCharacterOperations } from "@operations/operation-controller";
      export { importVariableStore, getVariable } from "@variables/variable-manager";
      export { getFinalAcValue, getFinalVariableValue } from "@variables/variable-helpers";
      export { getAcParts } from "@items/armor-handler";
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
} finally {
  // The esbuild JS API keeps a child service alive; stop it once bundling is done.
  await stop();
}

const {
  buildCharacter,
  importFromContentPackage,
  _executeCharacterOperations,
  importVariableStore,
  getVariable,
  getFinalAcValue,
  getFinalVariableValue,
  getAcParts,
} = await import(pathToFileURL(outfile).href);

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
  classOptionalTrainedSkill: 'Arcana',
  listLanguages: ['Common'],
  hashMapTrainedOnlySkillChoices: { standardSelection: ['Athletics'] },
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
          optionsPredefined: [], optionsFilters: { id: 'wizard-key-filter', type: 'ADJ_VALUE', group: 'ATTRIBUTE', value: { value: 1 } },
        } },
        attributeSelect('wizard-boost-1'),
        attributeSelect('wizard-boost-2'),
        attributeSelect('wizard-boost-3'),
        attributeSelect('wizard-boost-4'),
        { id: 'wizard-unarmored', type: 'adjValue', data: { variable: 'UNARMORED_DEFENSE', value: { value: 'T' } } },
        { id: 'wizard-class-hp', type: 'adjValue', data: { variable: 'MAX_HEALTH_CLASS_PER_LEVEL', value: 6 } },
      ],
    },
  ],
  ancestries: [
    {
      id: 2, name: 'Fleshwarp', trait_id: ANCESTRY_TRAIT,
      operations: [
        { id: 'fleshwarp-ancestry-hp', type: 'adjValue', data: { variable: 'MAX_HEALTH_ANCESTRY', value: 10 } },
        { id: 'fleshwarp-speed', type: 'setValue', data: { variable: 'SPEED', value: 25 } },
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
    { id: 5002, name: 'Synthetic Option', type: 'feat', level: 1, traits: [WIZARD_TRAIT], operations: [], meta_data: {} },
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
            name: 'Rogue Dedication',
            title: 'Rogue Dedication',
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
      operations: [],
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
  languages: [{ id: 9001, name: 'Common', speakers: '', script: '', description: '', content_source_id: 1, deprecated: false, rarity: 'COMMON', availability: null, meta_data: null }],
  spells: [],
  archetypes: [],
  classArchetypes: [],
};
importFromContentPackage(content);

const derived = {
  name: 'Arsene (Reset)',
  class: 'Wizard',
  level: 7,
  ancestry: 'Fleshwarp',
  heritage: 'Ifrit',
  background: 'Criminal',
  keyability: 'int',
  abilities: { str: 10, dex: 16, con: 16, int: 20, wis: 12, cha: 12 },
  proficiencies: { light: 2, unarmored: 2 },
  attributes: { ancestryhp: 10, classhp: 6, bonushp: 0, bonushpPerLevel: 0, speed: 25, speedBonus: 0 },
  armor: [{ name: 'Padded Armor', qty: 1, prof: 'light', pot: 1, display: '+1 Padded Armor', worn: true, runes: [] }],
  acTotal: { acProfBonus: 9, acAbilityBonus: 3, acItemBonus: 2, acTotal: 24, shieldBonus: null },
};

// Import the complete synthetic Arsene payload through the real WG operation
// engine. This is a fail-closed parity test: it must reproduce the exact source
// attributes, Light Armor training, armor components, and AC before creation.
const preflightOutcome = await buildCharacter(
  resolved,
  content,
  new Map(),
  new Map(),
  null,
  [],
  derived,
  { preflightOnly: true }
);
assert.equal(preflightOutcome.status, 'ready', preflightOutcome.status === 'selection-required'
  ? `Unexpected manual selection: ${preflightOutcome.selection.title} at ${preflightOutcome.selection.path}`
  : preflightOutcome.error ?? 'preflight should be ready');
assert.equal(preflightOutcome.current.acTotal, 24);
assert.deepEqual(
  Object.fromEntries(preflightOutcome.current.abilities.map((ability) => [
    ability.key.toUpperCase(),
    10 + ability.modifier * 2,
  ])),
  { STR: 10, DEX: 16, CON: 16, INT: 20, WIS: 12, CHA: 12 }
);

const warnings = [];
const importedCharacter = await buildCharacter(
  resolved,
  content,
  new Map(),
  new Map(),
  null,
  warnings,
  derived
);
assert.ok(importedCharacter && !('status' in importedCharacter));
assert.deepEqual(warnings, [], `Arsene import warnings: ${warnings.join('; ')}`);
assert.equal(importedCharacter.name, 'Arsene (Reset)');
assert.ok(importedCharacter.operation_data?.selections);
assert.ok(
  Object.keys(importedCharacter.operation_data.selections).some((key) => key === 'class_wizard-boost-1'),
  `the first class attribute choice must be stored under its operation path, got: ${Object.keys(importedCharacter.operation_data.selections).join(', ')}`
);
assert.ok(
  Object.values(importedCharacter.operation_data.selections).includes('ATTRIBUTE_DEX'),
  'the actual selected attribute variable must be stored as the selection value'
);

const packet = await _executeCharacterOperations({
  character: importedCharacter,
  content,
  context: 'CHARACTER-SHEET',
});
assert.deepEqual(packet.errors, [], `WG operation errors: ${packet.errors.join('; ')}`);
importVariableStore('CHARACTER', packet.store);

const score = (name) => {
  const attribute = getVariable('CHARACTER', `ATTRIBUTE_${name}`);
  const modifier = getFinalVariableValue('CHARACTER', `ATTRIBUTE_${name}`).total;
  return 10 + modifier * 2 + (attribute?.value?.partial ? 1 : 0);
};
assert.deepEqual(
  Object.fromEntries(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map((name) => [name, score(name)])),
  { STR: 10, DEX: 16, CON: 16, INT: 20, WIS: 12, CHA: 12 }
);

const armor = importedCharacter.inventory.items.find(
  (entry) => entry.is_equipped && entry.item?.name === 'Padded Armor'
)?.item;
assert.ok(armor, 'the imported +1 Padded Armor must be equipped');
const acParts = getAcParts('CHARACTER', armor);
assert.deepEqual(
  {
    proficiency: acParts.profBonus,
    dexterity: acParts.dexBonus,
    item: acParts.armorBonus,
  },
  { proficiency: 9, dexterity: 3, item: 2 }
);
assert.equal(getFinalAcValue('CHARACTER', armor), 24);

const lightArmor = getVariable('CHARACTER', 'LIGHT_ARMOR');
assert.equal(lightArmor?.type, 'prof');
assert.equal(lightArmor.value.value, 'T', 'Rogue Dedication must grant Light Armor training natively');

// TDD guard: an unresolved required selection must fail the import instead of becoming a warning
// or causing the selection resolver to spin until the global calculation timeout.
const unresolvedSelectionFixture = structuredClone(resolved);
unresolvedSelectionFixture.specialSelections = [
  { slot: 'Archetype Choice', prompt: 'Select an Archetype Feat', value: 'Definitely Not A Real Option' },
];
await assert.rejects(
  buildCharacter(
    unresolvedSelectionFixture,
    content,
    new Map(),
    new Map(),
    null,
    [],
    null
  ),
  /Pathbuilder 1:1 selection mapping failed:/
);

