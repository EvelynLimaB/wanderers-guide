/**
 * Pathbuilder 2e -> Wanderer's Guide, 1:1 importer.
 *
 * Replaces the legacy `json.php` -> `convertPathbuilderToFTC()` -> `importFromFTC()`
 * chain. That chain was lossy by construction: the FTC intermediate can only
 * express an item as `{ name, level? }`, so every Custom File (custom weapons,
 * custom buffs, homebrew gear) was reduced to a name and then dropped when the
 * name did not match WG content.
 *
 * This importer works from the share payload directly:
 *
 *   POST /app/fetch_emailed.php {id}
 *     -> { characterData, listCustomFiles }
 *     -> resolveBuild()                  pure normalization, unit tested
 *     -> ensureCustomContent()           Custom Files become real WG Items
 *     -> buildCharacter()                identity, variants, selections, gear
 *     -> makeRequest('create-character')
 *     -> persistImportRow()              raw payload kept for re-translation
 *
 * Two invariants worth preserving:
 *
 *  1. Nothing is silently dropped. Anything that cannot be resolved is recorded
 *     in `unresolved`, persisted to `pathbuilder_import.unresolved`, and reported
 *     back to the caller as a warning.
 *  2. The raw payload is written *before* the character is created, and updated
 *     with the character id afterwards. An import that fails halfway still leaves
 *     a record of what Pathbuilder said, which is the whole point of keeping it.
 */

import { createPathbuilderContentSource, upsertItem } from '@content/content-creation';
import { defineDefaultSources, fetchContentPackage, fetchContentSources } from '@content/content-store';
import { toMarkdown } from '@content/content-utils';
import { findFirstSelection, findMatchingOption } from '@import/ftc/import-from-ftc';
import { isItemEquippable, isItemImplantable, isItemInvestable } from '@items/inv-utils';
import { hideNotification, showNotification } from '@mantine/notifications';
import { ObjectWithUUID } from '@operations/operation-utils';
import { executeOperations } from '@operations/operations.main';
import { makeRequest } from '@requests/request-manager';
import { Character, InventoryItem, Item, ItemMetaGroupSchema, OperationCharacterResultPackage, Trait } from '@schemas/content';
import { lengthenLabels, labelToVariable } from '@variables/variable-utils';
import { cloneDeep } from 'lodash-es';

import { extractBuildId, fetchPathbuilderDerived, fetchPathbuilderShare } from './fetch-pathbuilder-share';
import { resolveBuild } from './pathbuilder-resolve';
import { PathbuilderCustomFile, ResolvedBuild, ResolvedItemRef } from './types';

export type PathbuilderImportOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Import the character but do not create homebrew Items for Custom Files. */
  skipCustomContent?: boolean;
  /** Turn off the Mantine notifications (used by tests and bulk imports). */
  silent?: boolean;
};

/**
 * A result type rather than a thrown error: the caller (the import modal) always
 * has something to show the user, and a rejected Pathbuilder id is the client's
 * fault, not an exceptional condition.
 */
export type PathbuilderImportOutcome =
  | {
      ok: true;
      character: Character;
      resolved: ResolvedBuild;
      /** Row id in `public.pathbuilder_import`. */
      importId: number | null;
      /** Content source created to hold the imported Custom Files, if any. */
      customSourceId: number | null;
      /** Human-readable summary of everything that could not be mapped. */
      warnings: string[];
    }
  | { ok: false; error: string; resolved?: ResolvedBuild; warnings: string[] };

const NOTIFICATION_ID = 'pathbuilder-import';

export async function importFromPathbuilderShare(
  input: string | number,
  options: PathbuilderImportOptions = {}
): Promise<PathbuilderImportOutcome> {
  const buildId = extractBuildId(input);
  if (!buildId) {
    return {
      ok: false,
      error: 'That does not look like a Pathbuilder build id or share link',
      warnings: [],
    };
  }

  const notify = (patch: Parameters<typeof showNotification>[0]) => {
    if (!options.silent) showNotification(patch);
  };
  const closeNotification = () => {
    if (!options.silent) hideNotification(NOTIFICATION_ID);
  };

  notify({
    id: NOTIFICATION_ID,
    title: `Importing Pathbuilder build ${buildId}`,
    message: 'Fetching the share payload...',
    autoClose: false,
    withCloseButton: false,
    loading: true,
  });

  try {
    // The derived payload is optional enrichment; it 403s for many shared builds
    // and must never be able to fail the import.
    const [shared, derived] = await Promise.all([
      fetchPathbuilderShare(buildId, { fetchImpl: options.fetchImpl, signal: options.signal }),
      fetchPathbuilderDerived(buildId, { fetchImpl: options.fetchImpl, signal: options.signal }),
    ]);

    if (!shared.ok) {
      closeNotification();
      notify({ title: 'Import failed', message: shared.error, color: 'red', icon: null, autoClose: false });
      return { ok: false, error: shared.error, warnings: [] };
    }

    const resolved = resolveBuild(shared.build, {
      buildId,
      formatVersion: shared.formatVersion,
      derived: derived as Record<string, unknown> | null,
    });

    // Provenance first: if character creation blows up, the payload is still saved.
    const importId = await insertImportRow(buildId, shared, derived, resolved);

    notify({
      id: NOTIFICATION_ID,
      title: `Importing "${resolved.identity.name}"`,
      message: 'This may take a minute...',
      autoClose: false,
      withCloseButton: false,
      loading: true,
    });

    const warnings = resolved.unresolved.map((u) => `${u.kind}: ${u.ref} (${u.reason})`);
    warnings.push(...resolved.hints);
    if (importId === null) {
      warnings.push('provenance: the raw payload could not be saved, so this character cannot be re-imported later');
    }

    let customSourceId: number | null = null;
    let customItems = new Map<string, Item>();
    if (!options.skipCustomContent && resolved.customFiles.size > 0) {
      const custom = await ensureCustomContent(resolved, buildId, warnings);
      customSourceId = custom.sourceId;
      customItems = custom.byUuid;
    }

    const character = await buildCharacter(resolved, customItems, warnings);

    if (importId !== null && character?.id) {
      // Second call to the same endpoint: upsertData takes the update path when a
      // real id is supplied, and the handler only touches the columns we send.
      await makeRequest('create-pathbuilder-import', { id: importId, character_id: character.id }, false);
    }

    closeNotification();
    if (!character) {
      notify({
        title: 'Import failed',
        message: 'Wanderer\u2019s Guide rejected the character',
        color: 'red',
        icon: null,
        autoClose: false,
      });
      return { ok: false, error: 'Wanderer\u2019s Guide rejected the character', resolved, warnings };
    }

    notify({
      title: 'Import complete',
      message:
        warnings.length > 0
          ? `Imported "${character.name}" with ${warnings.length} unmapped detail${warnings.length === 1 ? '' : 's'}`
          : `Imported "${character.name}"`,
      icon: null,
      color: warnings.length > 0 ? 'yellow' : undefined,
      autoClose: warnings.length > 0 ? false : 3000,
    });

    return { ok: true, character, resolved, importId, customSourceId, warnings };
  } catch (error) {
    // Genuine unexpected failure (content fetch, operation engine). Logged, and
    // converted to the same result shape so callers have one thing to handle.
    console.error('Pathbuilder import failed:', error);
    closeNotification();
    notify({
      title: 'Import failed',
      message: error instanceof Error ? error.message : 'Error importing from Pathbuilder',
      color: 'red',
      icon: null,
      autoClose: false,
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Error importing from Pathbuilder',
      warnings: [],
    };
  }
}

// ─── provenance ───────────────────────────────────────────────────────────────

async function insertImportRow(
  buildId: string,
  shared: { build: { characterData: unknown; listCustomFiles?: unknown } },
  derived: unknown,
  resolved: ResolvedBuild
): Promise<number | null> {
  try {
    // notifyFailure=false: a missing snapshot must not abort the import, and the
    // caller reports this as a warning instead of a red notification.
    const result = await makeRequest<{ id?: number } | true>(
      'create-pathbuilder-import',
      {
        id: -1,
        build_id: buildId,
        source_url: `https://pathbuilder2e.com/app.html?emailedBuildID=${buildId}`,
        format_version: resolved.formatVersion ?? null,
        character_data: shared.build.characterData,
        custom_files: shared.build.listCustomFiles ?? [],
        derived_data: derived ?? null,
        unresolved: resolved.unresolved,
      },
      false
    );
    // create-* endpoints answer `true` instead of the row on some paths.
    if (result && result !== true) return result.id ?? null;
    return null;
  } catch (error) {
    // Not fatal: the character import is still worth completing, and the raw
    // payload survives in the browser console via the returned `resolved`.
    console.warn('Could not record the Pathbuilder import snapshot:', error);
    return null;
  }
}

// ─── custom content ───────────────────────────────────────────────────────────

/**
 * Turn referenced Custom Files into real WG Items inside a per-import content
 * source, so they survive as items with stats instead of as dropped names.
 */
async function ensureCustomContent(
  resolved: ResolvedBuild,
  buildId: string,
  warnings: string[]
): Promise<{ sourceId: number | null; byUuid: Map<string, Item> }> {
  const byUuid = new Map<string, Item>();

  // Only materialize Custom Files the character actually references. A payload can
  // carry files for gear the character no longer has.
  const referenced = new Map<string, PathbuilderCustomFile>();
  const consider = (ref: ResolvedItemRef | undefined) => {
    if (ref?.kind === 'custom' && ref.uuid && ref.custom) referenced.set(ref.uuid.toLowerCase(), ref.custom);
  };
  resolved.weapons.forEach(consider);
  resolved.looseEquipment.forEach(consider);
  resolved.containers.forEach((container) => container.items.forEach(consider));
  consider(resolved.armor);
  consider(resolved.shield);
  resolved.activeCustomBuffs.forEach((buff) => {
    if (buff.custom) referenced.set(buff.uuid.toLowerCase(), buff.custom);
  });

  if (referenced.size === 0) return { sourceId: null, byUuid };

  const source = await createPathbuilderContentSource(buildId);

  const sourceId = source?.id ?? null;
  if (sourceId === null || sourceId < 0) {
    warnings.push('custom content: could not create a content source, so Custom Files were not persisted as items');
    return { sourceId, byUuid };
  }

  // Trait names need WG trait ids; unresolved names are kept as display_traits.
  const traits = await fetchTraitMap();

  for (const [uuid, customFile] of referenced) {
    const item = await createCustomItem(customFile, sourceId, traits, warnings);
    if (item) byUuid.set(uuid, item);
  }

  return { sourceId, byUuid };
}

async function fetchTraitMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const sources = await fetchContentSources('ALL-OFFICIAL-PUBLIC');
    const sv = defineDefaultSources('PAGE', sources.map((source) => source.id));
    const content = await fetchContentPackage(sv, { fetchSources: true });
    for (const trait of (content.traits ?? []) as Trait[]) {
      map.set(labelToVariable(trait.name), trait.id);
    }
  } catch (error) {
    console.warn('Could not load traits for the Pathbuilder import:', error);
  }
  return map;
}

/** Convert one Pathbuilder Custom File to a WG Item while preserving the raw file in meta_data. */
/**
 * The Custom File discriminator is useful for identifying known Pathbuilder
 * file kinds, but it is not a stable contract. Keep the original value in
 * meta_data.pathbuilder.raw and only expose a numeric discriminator to the WG
 * metadata schema when Pathbuilder actually provided one.
 */
function numericPathbuilderType(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

async function createCustomItem(
  customFile: PathbuilderCustomFile,
  sourceId: number,
  traits: Map<string, number>,
  warnings: string[]
): Promise<Item | null> {
  const rawTraits = (customFile.weaponTraits ?? '')
    .split(',')
    .map((trait) => trait.trim())
    .filter(Boolean);

  const traitIds: number[] = [];
  const unresolvedTraits: string[] = [];
  for (const name of rawTraits) {
    const id = traits.get(labelToVariable(name));
    if (id !== undefined) traitIds.push(id);
    else unresolvedTraits.push(name);
  }
  if (unresolvedTraits.length > 0) {
    warnings.push(`custom item "${customFile.name}": traits not found in WG content: ${unresolvedTraits.join(', ')}`);
  }

  const isWeapon =
    typeof customFile.damage === 'number' ||
    (customFile.weaponTraits ?? '').length > 0 ||
    typeof customFile.group === 'string';

  // Pathbuilder descriptions are HTML-ish (<br>, <br><br>); WG content is markdown.
  // toMarkdown is the same helper the custom-pack importer uses, so both Pathbuilder
  // entry points normalize prose identically.
  const description =
    toMarkdown([customFile.description, customFile.action0desc].filter(Boolean).join('<br><br>')) ?? '';

  const item = {
    id: -1,
    created_at: '',
    name: customFile.name ?? 'Unnamed Custom Item',
    price: typeof customFile.price === 'number' ? { gp: customFile.price } : null,
    bulk: null,
    level: customFile.itemLevel ?? 0,
    rarity: /unique/i.test(customFile.weaponTraits ?? '') ? 'UNIQUE' : 'COMMON',
    traits: traitIds,
    description,
    group: isWeapon ? 'WEAPON' : 'GENERAL',
    hands: customFile.hands ?? null,
    size: 'MEDIUM',
    craft_requirements: null,
    usage: null,
    operations: [],
    content_source_id: sourceId,
    version: '1.0',
    meta_data: {
      bulk: {},
      // Kept as display text so nothing is lost when a trait has no WG id.
      display_traits: rawTraits,
      ...(isWeapon
        ? {
            damage: {
              dice: 1,
              die: typeof customFile.damage === 'number' ? `d${customFile.damage}` : null,
              damageType: mapDamageType(customFile.damageType),
            },
            category: (customFile.group ?? '').toLowerCase().includes('brawling') ? 'unarmed_attack' : '',
            group: mapMetaGroup(customFile.group),
          }
        : {}),
      // The verbatim Custom File, so the PT-BR translation layer and any future
      // re-export can work from the original rather than from our mapping.
      pathbuilder: {
        uniqueIdentifier: customFile.uniqueIdentifier,
        type: numericPathbuilderType(customFile.type) ?? 0,
        source: customFile.src ?? 'Custom',
        raw: customFile,
      },
    },
  } satisfies Item;

  const created = await upsertItem(item);
  if (!created) {
    warnings.push(`custom item "${item.name}": WG rejected the item, so it was not added to the inventory`);
    return null;
  }
  if ((created.id ?? -1) < 0) {
    // create-item answered `true` instead of the row, so we have no real id.
    warnings.push(`custom item "${item.name}": created without a returned id; it may need a manual re-link`);
  }
  return created;
}
/** Map Pathbuilder's free-form weapon group to WG's finite ItemMetaGroup vocabulary. */
function mapMetaGroup(value: string | null | undefined): NonNullable<Item['meta_data']>['group'] {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  return ItemMetaGroupSchema.safeParse(normalized).success
    ? (normalized as NonNullable<NonNullable<Item['meta_data']>['group']>)
    : undefined;
}

/** Pathbuilder uses single-letter damage types ("P"); WG spells them out. */
function mapDamageType(value: string | null | undefined): string | undefined {
  switch ((value ?? '').toUpperCase()) {
    case 'P':
      return 'piercing';
    case 'S':
      return 'slashing';
    case 'B':
      return 'bludgeoning';
    default:
      return value ? value.toLowerCase() : undefined;
  }
}

// ─── character construction ───────────────────────────────────────────────────

/**
 * Build the WG Character from the resolved payload.
 *
 * Selection resolution reuses the same operation-loop helpers as the FTC
 * importer: WG's character model is derived by *running operations*, so there is
 * no way to write feats/boosts directly. You feed the builder the choices and
 * let `executeOperations` converge.
 */
async function buildCharacter(
  resolved: ResolvedBuild,
  customItems: Map<string, Item>,
  warnings: string[]
): Promise<Character | null> {
  const character = {
    id: -1,
    created_at: '',
    user_id: '',
    name: resolved.identity.name,
    level: resolved.identity.level,
    experience: 0,
    hp_current: 0,
    hp_temp: 0,
    hero_points: 1,
    stamina_current: -1,
    resolve_current: -1,
    details: {
      class: undefined,
      background: undefined,
      ancestry: undefined,
      info: {
        appearance: '',
        personality: '',
        alignment: resolved.identity.alignment ?? '',
        beliefs: resolved.identity.deity ?? '',
        age: resolved.identity.age ?? '',
        height: '',
        weight: '',
        gender: resolved.identity.gender ?? '',
        pronouns: '',
        faction: '',
        reputation: 0,
        ethnicity: '',
        nationality: '',
        birthplace: '',
        organized_play_id: '',
      },
    },
    notes: resolved.notes
      ? {
          pages: [
            {
              name: 'Imported Notes',
              icon: 'notes',
              color: '#ffffff',
              contents: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    attrs: { textAlign: 'left' },
                    content: [{ type: 'text', text: resolved.notes }],
                  },
                ],
              },
            },
          ],
        }
      : null,
    options: {
      is_public: false,
      auto_detect_prerequisites: true,
      auto_heighten_spells: false,
      class_archetypes: false,
      custom_operations: false,
      dice_roller: true,
      ignore_bulk_limit: false,
      alternate_ancestry_boosts: false,
      voluntary_flaws: false,
    },
    variants: {
      ancestry_paragon: resolved.variants.ancestry_paragon,
      proficiency_without_level: false,
      proficiency_half_level: false,
      stamina: false,
      free_archetype: resolved.variants.free_archetype,
      dual_class: false,
      gradual_attribute_boosts: resolved.variants.gradual_attribute_boosts,
    },
    content_sources: { enabled: [] },
    operation_data: { selections: {} },
    // Cast justified, and the same one importFromFTC makes: this is a partial
    // skeleton. details.class/background/ancestry, inventory, spells and
    // operation_data.selections are filled in below once the content package has
    // been fetched, so the object cannot satisfy Character at this point.
  } as unknown as Character;

  const sources = await fetchContentSources('ALL-OFFICIAL-PUBLIC');
  character.content_sources!.enabled = sources.map((source) => source.id);

  const sv = defineDefaultSources('PAGE', character.content_sources?.enabled ?? []);
  const content = await fetchContentPackage(sv, { fetchSources: true });

  character.details!.class = content.classes.find((c) => labelToVariable(c.name) === labelToVariable(resolved.identity.className ?? ''));
  character.details!.background = content.backgrounds.find(
    (b) => labelToVariable(b.name) === labelToVariable(resolved.identity.background ?? '')
  );
  character.details!.ancestry = content.ancestries.find(
    (a) => labelToVariable(a.name) === labelToVariable(resolved.identity.ancestry ?? '')
  );
  for (const [field, value] of [
    ['class', resolved.identity.className],
    ['background', resolved.identity.background],
    ['ancestry', resolved.identity.ancestry],
  ] as const) {
    if (value && !character.details?.[field]) warnings.push(`identity: WG has no ${field} matching "${value}"`);
  }

  await resolveSelections(character, content, resolved);

  character.inventory = {
    coins: { ...resolved.coins },
    items: buildInventory(resolved, content, customItems, warnings),
  };

  character.spells = {
    slots: [],
    list: [],
    focus_point_current: 0,
    innate_casts: [],
  };
  for (const spell of resolved.spells) {
    const found = content.spells.find((s) => labelToVariable(s.name) === labelToVariable(spell.name));
    if (found) {
      character.spells.list.push({
        spell_id: found.id,
        rank: Math.max(spell.heighten, found.rank ?? 1),
        source: '',
      });
    } else {
      warnings.push(`spell: WG has no spell matching "${spell.name}"`);
    }
  }

  character.details!.conditions = [];

  return await makeRequest<Character>('create-character', {
    ...character,
    id: undefined, // remove the sentinel so the API creates a new row
  });
}

/** Feed the operation builder every choice the payload records, level by level. */
async function resolveSelections(
  character: Character,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  resolved: ResolvedBuild
): Promise<void> {
  // Levels for special selections come from the feat slot that owns them.
  const slotLevel = new Map<string, number>();
  for (const feat of resolved.feats) {
    if (feat.level !== undefined) slotLevel.set(feat.slot, feat.level);
  }

  const selections: { name: string; level: number }[] = [
    ...resolved.feats.map((feat) => ({ name: feat.name, level: feat.level ?? 1 })),
    ...resolved.abilityBoosts.map((boost) => ({ name: lengthenLabels(boost.ability), level: boost.level })),
    ...resolved.skillIncreases.map((increase) => ({ name: increase.skill, level: increase.level })),
    ...resolved.specialSelections.map((special) => ({
      name: special.value,
      level: slotLevel.get(special.slot) ?? 1,
    })),
    ...(resolved.identity.heritage ? [{ name: resolved.identity.heritage, level: 1 }] : []),
  ];

  const chosen: Record<string, string> = {};
  const checked = new Set<string>();

  let hasSelections = true;
  let iteration = 0;
  while (hasSelections) {
    const results = await executeOperations<OperationCharacterResultPackage>({
      type: 'CHARACTER',
      data: {
        character: cloneDeep(character),
        content,
        context: 'CHARACTER-BUILDER',
      },
    });
    const found = findFirstSelection(results, checked);
    if (found) {
      const result: ObjectWithUUID | null = findMatchingOption(
        selections,
        found.selection?.selection?.options ?? [],
        found.level
      );
      if (result) {
        chosen[found.path] = result._select_uuid;
        character.operation_data!.selections = cloneDeep(chosen);
      }
      checked.add(found.path);
    } else {
      hasSelections = false;
    }
    if (++iteration > 999) {
      console.warn('Infinite loop detected in the Pathbuilder import.');
      break;
    }
  }
}

/**
 * Rebuild the inventory, including the container hierarchy.
 *
 * `InventoryItem.container_contents` is recursive, so a Pathbuilder container
 * maps onto a WG container item whose contents are the child rows.
 */
function buildInventory(
  resolved: ResolvedBuild,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  customItems: Map<string, Item>,
  warnings: string[]
): InventoryItem[] {
  const lookup = (ref: ResolvedItemRef): Item | undefined => {
    if (ref.kind === 'custom' && ref.uuid) {
      const custom = customItems.get(ref.uuid.toLowerCase());
      if (custom) return custom;
    }
    if (ref.kind === 'unresolved') return undefined;
    return content.items.find((item) => labelToVariable(item.name) === labelToVariable(ref.name));
  };

  const toInventoryItem = (ref: ResolvedItemRef): InventoryItem | undefined => {
    const item = lookup(ref);
    if (!item) {
      warnings.push(`item: WG has no "${ref.name}"${ref.kind === 'custom' ? ' and the Custom File could not be created' : ''}`);
      return undefined;
    }
    const entry: InventoryItem = {
      id: crypto.randomUUID(),
      item,
      is_formula: false,
      is_equipped: isItemEquippable(item),
      is_invested: isItemInvestable(item),
      is_implanted: isItemImplantable(item),
      container_contents: [],
    };
    // Pathbuilder stacks (`quantity`) become repeated entries; WG has no quantity
    // field on InventoryItem, and the FTC path dropped the count entirely.
    return entry;
  };

  const items: InventoryItem[] = [];

  for (const container of resolved.containers) {
    const containerItem = content.items.find(
      (item) => labelToVariable(item.name) === labelToVariable(container.name)
    );
    const contents = container.items.map(toInventoryItem).filter(Boolean) as InventoryItem[];
    if (containerItem) {
      items.push({
        id: crypto.randomUUID(),
        item: containerItem,
        is_formula: false,
        is_equipped: false,
        is_invested: false,
        is_implanted: false,
        container_contents: contents,
      });
    } else {
      warnings.push(`container: WG has no "${container.name}", so its ${contents.length} item(s) were moved to the top level`);
      items.push(...contents);
    }
  }

  for (const ref of [...resolved.looseEquipment, ...resolved.weapons, ...(resolved.shield ? [resolved.shield] : [])]) {
    const entry = toInventoryItem(ref);
    if (entry) items.push(entry);
  }

  if (resolved.armor) {
    const entry = toInventoryItem(resolved.armor);
    if (entry) items.push(entry);
  }
  if (resolved.armorRunes.length > 0 && !resolved.armor) {
    warnings.push(
      `armor: runes [${resolved.armorRunes.join(', ')}] and potency +${resolved.armorPotency} were recorded but there is no armor to attach them to`
    );
  }

  // Pathbuilder quantities: emit one entry per unit so the count is not lost.
  const expanded: InventoryItem[] = [];
  for (const entry of items) {
    const quantity = quantityFor(entry, resolved);
    for (let index = 0; index < quantity; index++) {
      expanded.push(index === 0 ? entry : { ...entry, id: crypto.randomUUID() });
    }
  }
  return expanded;
}

/** Recover the Pathbuilder quantity for an inventory entry we just built. */
function quantityFor(entry: InventoryItem, resolved: ResolvedBuild): number {
  const name = labelToVariable(entry.item.name);
  const refs = [
    ...resolved.looseEquipment,
    ...resolved.weapons,
    ...resolved.containers.flatMap((container) => container.items),
  ];
  const match = refs.find((ref) => labelToVariable(ref.name) === name);
  return Math.max(1, match?.quantity ?? 1);
}
