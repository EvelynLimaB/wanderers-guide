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

import { createPathbuilderContentSource, upsertItem, upsertSpell } from '@content/content-creation';
import { defineDefaultSources, fetchContent, fetchContentPackage, fetchContentSources } from '@content/content-store';
import { toMarkdown } from '@content/content-utils';
import { findFirstSelection, findMatchingOption } from '@import/ftc/import-from-ftc';
import { getBestArmor, isItemEquippable, isItemImplantable, isItemInvestable } from '@items/inv-utils';
import { hideNotification, showNotification } from '@mantine/notifications';
import { ObjectWithUUID } from '@operations/operation-utils';
import { executeOperations } from '@operations/operations.main';
import { makeRequest } from '@requests/request-manager';
import { Character, InventoryItem, Item, ItemMetaCategorySchema, ItemMetaGroupSchema, OperationCharacterResultPackage, Spell, Trait } from '@schemas/content';
import { Operation } from '@schemas/operations';
import { getFinalAcValue, getFinalVariableValue } from '@variables/variable-helpers';
import { labelToVariable } from '@variables/variable-utils';
import { cloneDeep } from 'lodash-es';

import { extractBuildId, fetchPathbuilderDerived, fetchPathbuilderShare } from './fetch-pathbuilder-share';
import { pathbuilderAbilityLabel, resolveBuild } from './pathbuilder-resolve';
import { PathbuilderCustomFile, ResolvedBuild, ResolvedItemRef } from './types';
import { findFreeArchetypeBranch, getAbilityBoostOriginForPath } from './pathbuilder-selection-routing';

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
      derived,
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

    const warnings = resolved.unresolved
      .filter((u) => u.kind !== 'spell-source')
      .map((u) => `${u.kind}: ${u.ref} (${u.reason})`);
    if (resolved.hints.length > 0) {
      console.info('Pathbuilder import notes:', resolved.hints);
    }
    if (importId === null) {
      warnings.push('provenance: the raw payload could not be saved, so this character cannot be re-imported later');
    }

    const sources = await fetchContentSources('ALL-USER-ACCESSIBLE');
    const enabledSourceIds = sources.map((source) => source.id);
    const sourceView = defineDefaultSources('PAGE', enabledSourceIds);
    const content = await fetchContentPackage(sourceView, { fetchSources: true });

    const custom = !options.skipCustomContent
      ? await ensureCustomContent(resolved, buildId, content, warnings)
      : { sourceId: null, byUuid: new Map<string, Item>(), fallbackSpellsByName: new Map<string, Spell>() };
    const customSourceId = custom.sourceId;
    const customItems = custom.byUuid;

    const character = await buildCharacter(
      resolved,
      content,
      customItems,
      custom.fallbackSpellsByName,
      customSourceId,
      warnings,
      derived
    );

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
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  warnings: string[]
): Promise<{
  sourceId: number | null;
  byUuid: Map<string, Item>;
  fallbackSpellsByName: Map<string, Spell>;
}> {
  const byUuid = new Map<string, Item>();
  const fallbackSpellsByName = new Map<string, Spell>();

  const referenced = new Map<string, PathbuilderCustomFile>();
  const consider = (ref: ResolvedItemRef | undefined) => {
    if (ref?.kind === 'custom' && ref.uuid && ref.custom) referenced.set(ref.uuid.toLowerCase(), ref.custom);
  };
  resolved.weapons.forEach(consider);
  resolved.looseEquipment.forEach(consider);
  resolved.containers.forEach((container) => container.items.forEach(consider));
  consider(resolved.armor);
  consider(resolved.shield);

  const itemRefs = [
    ...resolved.weapons,
    ...resolved.looseEquipment,
    ...resolved.containers.flatMap((container) => container.items),
    ...(resolved.armor ? [resolved.armor] : []),
    ...(resolved.shield ? [resolved.shield] : []),
  ];

  const standardRefs = itemRefs.filter((ref) => ref.kind === 'standard');
  const unresolvedRefs = new Map<string, ResolvedItemRef>();
  for (const ref of itemRefs) {
    if (ref.kind === 'unresolved') unresolvedRefs.set(ref.raw.toLowerCase(), ref);
  }

  const missingItems = standardRefs.filter((ref) => !findImportedItem(content.items, ref.name) && !findImportedItem(content.items, ref.raw));
  const missingSpells = resolved.spells.filter(
    (spell) => !content.spells.some((item) => labelToVariable(item.name) === labelToVariable(spell.name))
  );

  if (referenced.size === 0 && unresolvedRefs.size === 0 && missingItems.length === 0 && missingSpells.length === 0) {
    return { sourceId: null, byUuid, fallbackSpellsByName };
  }

  const source = await createPathbuilderContentSource(buildId);
  const sourceId = source?.id ?? null;
  if (sourceId === null || sourceId < 0) {
    warnings.push(
      'custom content: could not create the Pathbuilder import source, so custom/reference content was not persisted'
    );
    return { sourceId, byUuid, fallbackSpellsByName };
  }

  // The source is intentionally reused across retries of the same user/build.
  // Reload its existing content so an interrupted/repeated import does not treat
  // deterministic UUID collisions as a rejection and then lose the custom item.
  let sourceItems: Item[] = [];
  let sourceSpells: Spell[] = [];
  try {
    // A newly-created private source is not part of the operation worker's posted
    // content package. fetchContentPackage([sourceId]) could therefore return an
    // empty worker-local package instead of hitting Supabase, causing duplicate
    // UUID inserts on repeated imports. Bypass the worker and global cache here
    // because this read is specifically about freshly-created source content.
    sourceItems = await fetchContent<Item>(
      'item',
      { content_sources: [sourceId] },
      true,
      true
    );
    sourceSpells = await fetchContent<Spell>(
      'spell',
      { content_sources: [sourceId] },
      true,
      true
    );
  } catch (error) {
    console.warn('Could not reload existing Pathbuilder source content:', error);
  }

  const traits = new Map<string, number>(
    (content.traits ?? []).map((trait) => [labelToVariable(trait.name), trait.id])
  );

  for (const [uuid, customFile] of referenced) {
    const existing = sourceItems.find(
      (item) => item.meta_data?.pathbuilder?.uniqueIdentifier?.toLowerCase() === uuid
    );
    if (existing) {
      byUuid.set(uuid, existing);
      continue;
    }

    const item = await createCustomItem(customFile, sourceId, traits, content, warnings);
    if (item) byUuid.set(uuid, item);
  }

  for (const ref of unresolvedRefs.values()) {
    const existing = sourceItems.find((item) => {
      if (item.meta_data?.pathbuilder?.source !== 'Pathbuilder Reference') return false;
      const raw = (item.meta_data?.pathbuilder as { raw?: unknown } | undefined)?.raw;
      return typeof raw === 'object' && raw !== null && 'raw' in raw && (raw as Record<string, unknown>).raw === ref.raw;
    });
    if (existing) {
      byUuid.set(`unresolved:${ref.raw.toLowerCase()}`, existing);
      continue;
    }

    const item = await createReferenceItem(ref, sourceId, warnings);
    if (item) byUuid.set(`unresolved:${ref.raw.toLowerCase()}`, item);
  }

  for (const ref of missingItems) {
    const existing = sourceItems.find((item) => {
      if (item.meta_data?.pathbuilder?.source !== 'Pathbuilder Reference') return false;
      const raw = (item.meta_data?.pathbuilder as { raw?: unknown } | undefined)?.raw;
      return typeof raw === 'object' && raw !== null && 'raw' in raw && (raw as Record<string, unknown>).raw === ref.raw;
    });
    if (existing) {
      byUuid.set(`ref:${labelToVariable(ref.name)}`, existing);
      continue;
    }

    const semanticKind = resolved.weapons.some((weapon) => weapon === ref)
      ? 'weapon'
      : resolved.armor === ref
        ? 'armor'
        : resolved.shield === ref
          ? 'shield'
          : 'equipment';
    const item = await createReferenceItem(ref, sourceId, warnings, semanticKind, traits);
    if (item) byUuid.set(`ref:${labelToVariable(ref.name)}`, item);
  }

  for (const spell of missingSpells) {
    const existing = sourceSpells.find((candidate) => {
      const raw = (candidate.meta_data?.pathbuilder as { raw?: unknown } | undefined)?.raw;
      return typeof raw === 'object' && raw !== null && 'rawKey' in raw && (raw as Record<string, unknown>).rawKey === spell.rawKey;
    });
    if (existing) {
      fallbackSpellsByName.set(labelToVariable(spell.name), existing);
      continue;
    }

    const item = await createReferenceSpell(spell, sourceId);
    if (item) {
      warnings.push(
        `spell: WG has no spell matching "${spell.name}"; created a reference-only Pathbuilder spell so the spell is not lost`
      );
      fallbackSpellsByName.set(labelToVariable(spell.name), item);
    }
  }

  return { sourceId, byUuid, fallbackSpellsByName };
}

function findImportedItem(items: Item[], name: string): Item | undefined {
  const candidates = [name, ...(PATHBUILDER_ITEM_ALIASES[labelToVariable(name)] ?? [])];
  for (const candidate of candidates) {
    const found = items.find((item) => labelToVariable(item.name) === labelToVariable(candidate));
    if (found) return found;
  }
  return undefined;
}

const PATHBUILDER_ITEM_ALIASES: Record<string, string[]> = {
  [labelToVariable('Rations')]: ['Rations (1 week)'],
  [labelToVariable('Mask (Ordinary)')]: ['Ordinary Mask'],
};

async function createReferenceItem(
  ref: ResolvedItemRef,
  sourceId: number,
  warnings: string[],
  semanticKind: 'weapon' | 'armor' | 'shield' | 'equipment' = 'equipment',
  traits: Map<string, number> = new Map()
): Promise<Item | null> {
  const specialUnarmed = new RegExp('\\bSPECIAL\\s+UNARMED\\s*\\(\\s*\\d+d(?:4|6|8|10|12)\\s*\\)', 'i').test(ref.raw);
  const damageMatch = new RegExp('\\(\\s*(\\d+)d(4|6|8|10|12)\\s*\\)', 'i').exec(ref.raw);
  const displayTraits = semanticKind === 'weapon' && specialUnarmed
    ? ['Agile', 'Finesse', 'Magical', 'Nonlethal', 'Unarmed']
    : [];

  const traitIds = displayTraits
    .map((name) => traits.get(labelToVariable(name)))
    .filter((id): id is number => id !== undefined);

  const isWeapon = semanticKind === 'weapon';
  const item = {
    id: -1,
    created_at: '',
    name: ref.name,
    price: null,
    bulk: null,
    level: 0,
    rarity: 'COMMON',
    traits: traitIds,
    description:
      `Imported from Pathbuilder as a reference. Wanderer's Guide did not have a matching content record at import time. Original Pathbuilder reference: ${ref.raw}`,
    group:
      semanticKind === 'weapon'
        ? 'WEAPON'
        : semanticKind === 'armor'
          ? 'ARMOR'
          : semanticKind === 'shield'
            ? 'SHIELD'
            : 'GENERAL',
    hands: isWeapon && specialUnarmed ? '1' : null,
    size: 'MEDIUM',
    craft_requirements: null,
    usage: null,
    operations: [],
    content_source_id: sourceId,
    version: '1.0',
    meta_data: {
      bulk: {},
      ...(isWeapon
        ? {
            category: specialUnarmed ? 'unarmed_attack' : 'simple',
            group: specialUnarmed ? 'brawling' : undefined,
            damage: {
              dice: damageMatch ? Number(damageMatch[1]) : 1,
              die: damageMatch ? `d${damageMatch[2]}` : 'd4',
              damageType: 'B',
              extra: '',
            },
            display_traits: displayTraits,
          }
        : {}),
      pathbuilder: {
        uniqueIdentifier: crypto.randomUUID(),
        type: 0,
        source: 'Pathbuilder Reference',
        raw: {
          kind: ref.kind,
          semanticKind,
          name: ref.name,
          raw: ref.raw,
          quantity: ref.quantity,
        },
      },
    },
  } satisfies Item;

  try {
    const created = await upsertItem(item);
    return created;
  } catch (error) {
    console.warn(`Could not create Pathbuilder reference item "${ref.name}":`, error);
    warnings.push(`item: failed to create Pathbuilder reference for "${ref.name}"`);
    return null;
  }
}

async function createReferenceSpell(
  spell: ResolvedBuild['spells'][number],
  sourceId: number
): Promise<Spell | null> {
  const keyParts = spell.rawKey.split('&');
  const rankHint = Number(keyParts[1]);
  const item = {
    id: -1,
    created_at: '',
    name: spell.name,
    rank: Number.isFinite(rankHint) && rankHint >= 0 ? rankHint : 0,
    traditions: [],
    rarity: 'COMMON',
    availability: null,
    cast: '',
    traits: [],
    defense: null,
    cost: null,
    trigger: null,
    requirements: null,
    range: null,
    area: null,
    targets: null,
    duration: null,
    description:
      `Imported from Pathbuilder as a reference. Wanderer's Guide did not have a matching spell record at import time. Original spell key: ${spell.rawKey}`,
    heightened: {},
    meta_data: {
      pathbuilder: {
        raw: {
          rawKey: spell.rawKey,
          spellListIndex: spell.spellListIndex,
          heighten: spell.heighten,
        },
      },
    },
    content_source_id: sourceId,
    version: '1.0',
  } satisfies Spell;

  try {
    const created = await upsertSpell(item);
    return created;
  } catch {
    return null;
  }
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
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  warnings: string[]
): Promise<Item | null> {
  const rawTraits = (customFile.weaponTraits ?? customFile.traits ?? '')
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
  // Unknown/homebrew traits are retained verbatim in meta_data.display_traits.
  // They are not an import failure and must not inflate the "unmapped" count.
  if (unresolvedTraits.length > 0) {
    console.info(
      `Pathbuilder custom item "${customFile.name}" has traits not present in WG content; preserved as display text:`,
      unresolvedTraits
    );
  }

  const isWeapon =
    typeof customFile.damage === 'number' ||
    (customFile.weaponTraits ?? '').length > 0 ||
    (typeof customFile.group === 'string' && customFile.group.trim().length > 0);

  // Custom weapons frequently describe their base weapon without repeating its
  // mechanical fields. Reuse a uniquely identifiable WG weapon as a mechanical
  // baseline, while preserving the Custom File's own identity and raw payload.
  const inferredBaseWeapon = isWeapon ? inferBaseWeapon(customFile, content.items) : undefined;
  const baseDamage = (inferredBaseWeapon?.meta_data?.damage ?? {}) as Record<string, any>;
  const inferredDamageType =
    mapDamageType(customFile.damageType) ??
    (typeof baseDamage.damageType === 'string' ? baseDamage.damageType : undefined) ??
    inferDamageTypeFromText(customFile.description);
  const inheritedTraits = inferredBaseWeapon?.traits?.filter((id) => !traitIds.includes(id)) ?? [];

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
    bulk: customFile.bulk ?? inferredBaseWeapon?.bulk ?? null,
    level: customFile.itemLevel ?? inferredBaseWeapon?.level ?? 0,
    rarity: /\bunique\b/i.test(rawTraits.join(', ')) ? 'UNIQUE' : 'COMMON',
    traits: [...traitIds, ...inheritedTraits],
    description,
    group: isWeapon ? 'WEAPON' : 'GENERAL',
    hands: customFile.hands ?? null,
    size: 'MEDIUM',
    craft_requirements: null,
    usage: null,
    operations: customEffectOperations(customFile, 1, warnings),
    content_source_id: sourceId,
    version: '1.0',
    meta_data: {
      bulk: {},
      // Kept as display text so nothing is lost when a trait has no WG id.
      display_traits: rawTraits,
      ...(isWeapon
        ? {
            damage: {
              ...(baseDamage ?? {}),
              dice: baseDamage.dice ?? 1,
              die:
                typeof customFile.damage === 'number'
                  ? `d${customFile.damage}`
                  : (baseDamage.die as string | null | undefined) ?? null,
              damageType: inferredDamageType,
            },
            category: (() => {
              const candidate =
                (customFile.group ?? '').toLowerCase().includes('brawling')
                  ? 'unarmed_attack'
                  : baseDamage.category ?? '';
              return ItemMetaCategorySchema.safeParse(candidate).success
                ? (candidate as NonNullable<NonNullable<Item['meta_data']>['category']>)
                : '';
            })(),
            group: mapMetaGroup(customFile.group) ?? inferredBaseWeapon?.meta_data?.group,
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
/**
 * Convert the subset of Pathbuilder custom effects whose targets are explicit in
 * the payload. Unknown numeric effect types stay preserved in raw metadata.
 *
 * Observed in the regression build:
 *   effectType 1 = Speed
 *   effectType 8 = Spell Attack
 */
const PATHBUILDER_EFFECT_VARIABLES: Record<number, string> = {
  1: 'SPEED',
  8: 'SPELL_ATTACK',
};

const PATHBUILDER_SKILL_NAMES = new Set([
  'ACROBATICS',
  'ARCANA',
  'ATHLETICS',
  'CRAFTING',
  'DECEPTION',
  'DIPLOMACY',
  'INTIMIDATION',
  'MEDICINE',
  'NATURE',
  'OCCULTISM',
  'PERFORMANCE',
  'RELIGION',
  'SOCIETY',
  'STEALTH',
  'SURVIVAL',
  'THIEVERY',
]);

function pathbuilderProficiencyVariable(name: string): string | undefined {
  const normalized = labelToVariable(name);
  if (PATHBUILDER_SKILL_NAMES.has(normalized)) return `SKILL_${normalized}`;
  return {
    SPELL_ATTACK: 'SPELL_ATTACK',
    SPELL_DC: 'SPELL_DC',
    CLASS_DC: 'CLASS_DC',
    PERCEPTION: 'PERCEPTION',
    FORTITUDE: 'SAVE_FORT',
    REFLEX: 'SAVE_REFLEX',
    WILL: 'SAVE_WILL',
  }[normalized];
}

function customEffectOperations(
  customFile: PathbuilderCustomFile,
  stackMultiplier: number,
  warnings: string[]
): Operation[] {
  const operations: Operation[] = [];
  const emitted = new Set<string>();

  const addBonusOperation = (variable: string, amount: number, text: string) => {
    const key = `${variable}:${amount}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    operations.push({
      id: crypto.randomUUID(),
      type: 'addBonusToValue',
      data: {
        variable,
        value: amount,
        type: 'item',
        text,
      },
    });
  };

  for (const [index, effect] of (customFile.listCustomEffects ?? []).entries()) {
    const amount =
      typeof effect.bonusAmount === 'number' && Number.isFinite(effect.bonusAmount)
        ? effect.bonusAmount * stackMultiplier
        : undefined;

    // A reference-only effect carries provenance for a Pathbuilder-side rule link but
    // no mechanical value. Preserve it in the raw Custom File without manufacturing
    // an "unmapped" warning for a non-numeric payload.
    if (amount === undefined || amount === 0) {
      if (effect.reference && Object.keys(effect).every((key) => key === 'reference')) continue;
      warnings.push(
        `custom effect "${customFile.name}": effect ${index + 1} has no directly executable bonus (reference ${effect.reference ?? 'unknown'})`
      );
      continue;
    }

    if (effect.proficiencyName) {
      const variable = pathbuilderProficiencyVariable(effect.proficiencyName);
      if (variable) {
        addBonusOperation(
          variable,
          amount,
          `${customFile.name ?? 'Pathbuilder Custom'} (Pathbuilder custom effect)`
        );
      } else {
        warnings.push(
          `custom effect "${customFile.name}": unsupported proficiency target "${effect.proficiencyName}"`
        );
      }
    }

    if (effect.effectType !== undefined && effect.effectType !== null) {
      const variable = PATHBUILDER_EFFECT_VARIABLES[effect.effectType];
      if (variable) {
        addBonusOperation(
          variable,
          amount,
          `${customFile.name ?? 'Pathbuilder Custom'} (Pathbuilder effect ${effect.effectType})`
        );
      } else if (!effect.proficiencyName) {
        warnings.push(
          `custom effect "${customFile.name}": unsupported effectType ${effect.effectType} (reference ${effect.reference ?? 'unknown'})`
        );
      }
    }
  }

  // Some Pathbuilder Custom Files contain effects in prose as well as in
  // listCustomEffects. Replay explicit numeric item bonuses from the prose so the
  // character sheet keeps the same currently-active totals.
  const description = customFile.description ?? '';
  for (const match of description.matchAll(/\\+(\\d+)\\s*item[- ]bonus\\s+to\\s+([^.]*(?:\\.)?)/gi)) {
    const amount = Number(match[1]) * stackMultiplier;
    const targets = match[2];
    for (const skill of [
      'Acrobatics','Arcana','Athletics','Crafting','Deception','Diplomacy',
      'Intimidation','Medicine','Nature','Occultism','Performance','Religion',
      'Society','Stealth','Survival','Thievery',
    ]) {
      if (targets.toLowerCase().includes(skill.toLowerCase())) {
        addBonusOperation(
          `SKILL_${labelToVariable(skill)}`,
          amount,
          `${customFile.name ?? 'Pathbuilder Custom'} (Pathbuilder custom description)`
        );
      }
    }
    if (targets.toLowerCase().includes('speed')) {
      addBonusOperation(
        'SPEED',
        amount,
        `${customFile.name ?? 'Pathbuilder Custom'} (Pathbuilder custom description)`
      );
    }
  }

  const speedMatch = /\\+(\\d+)\\s*(?:ft|feet)\\s*item[- ]bonus\\s+to\\s+speed/i.exec(description);
  if (speedMatch) {
    addBonusOperation(
      'SPEED',
      Number(speedMatch[1]) * stackMultiplier,
      `${customFile.name ?? 'Pathbuilder Custom'} (Pathbuilder custom description)`
    );
  }

  return operations;
}

function inferBaseWeapon(customFile: PathbuilderCustomFile, items: Item[]): Item | undefined {
  const haystack = labelToVariable(
    [customFile.name, customFile.description, customFile.weaponTraits].filter(Boolean).join(' ')
  );
  const candidates = items
    .filter((item) => item.group === 'WEAPON')
    .filter((item) => haystack.includes(labelToVariable(item.name)))
    .sort((a, b) => b.name.length - a.name.length);

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates[0].name.length > candidates[1].name.length ? candidates[0] : undefined;
}

function inferDamageTypeFromText(description: string | null | undefined): string | undefined {
  const textValue = labelToVariable(description ?? '');
  if (/\b(?:SWORD|AXE|SLASH|SLASHING)\b/.test(textValue)) return 'slashing';
  if (/\b(?:SPEAR|PIKE|RAPIER|PIERCING)\b/.test(textValue)) return 'piercing';
  if (/\b(?:CLUB|HAMMER|MACE|BLUDGEON|BLUDGEONING)\b/.test(textValue)) return 'bludgeoning';
  return undefined;
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
export async function buildCharacter(
  resolved: ResolvedBuild,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  customItems: Map<string, Item>,
  fallbackSpellsByName: Map<string, Spell>,
  customSourceId: number | null,
  warnings: string[],
  derived?: import('@schemas/pathbuilder').PathbuilderDerivedBuild | null
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

  const importedOperations = buildPathbuilderCustomOperations(resolved, content, warnings);
  if (importedOperations.length > 0) {
    character.options = {
      ...(character.options ?? {}),
      custom_operations: true,
    };
    character.custom_operations = importedOperations;
  }

  character.content_sources!.enabled = [
    ...(content.sources?.map((source) => source.id) ?? []),
    ...(customSourceId !== null ? [customSourceId] : []),
  ];

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
    if (!value) {
      throw new Error(`Pathbuilder 1:1 identity mapping failed: missing ${field}`);
    }
    if (!character.details?.[field]) {
      throw new Error(`Pathbuilder 1:1 identity mapping failed: WG has no ${field} matching "${value}"`);
    }
  }

  await resolveSelections(character, content, resolved, warnings);

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
    const resolvedSpell = found ?? fallbackSpellsByName.get(labelToVariable(spell.name));
    if (resolvedSpell) {
      character.spells.list.push({
        spell_id: resolvedSpell.id,
        rank: Math.max(spell.heighten, resolvedSpell.rank ?? 0),
        source: spell.source ? labelToVariable(spell.source) : '',
      });
    } else {
      warnings.push(`spell: could not resolve "${spell.name}" and it was not added to the character`);
    }
  }

  character.details!.conditions = [];

  if (derived) {
    await validatePathbuilderDerived(character, content, derived);
  }

  const mechanicalWarnings = warnings.filter((warning) => !warning.startsWith('provenance:'));
  if (mechanicalWarnings.length > 0) {
    throw new Error(
      `Pathbuilder 1:1 import blocked by unresolved mechanics: ${mechanicalWarnings.join('; ')}`
    );
  }

  return await makeRequest<Character>('create-character', {
    ...character,
    id: undefined, // remove the sentinel so the API creates a new row
  });
}

/**
 * Strictly compare the fields that Pathbuilder derives from the imported build
 * and that WG must reproduce through its native operation engine. A mismatch is
 * an import failure, never a warning: creating a character that silently differs
 * defeats 1:1 import.
 */
async function validatePathbuilderDerived(
  character: Character,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  derived: import('@schemas/pathbuilder').PathbuilderDerivedBuild
): Promise<void> {
  await executeOperations<OperationCharacterResultPackage>({
    type: 'CHARACTER',
    data: { character: cloneDeep(character), content, context: 'CHARACTER-SHEET' },
  });

  const mismatches: string[] = [];
  const abilities = derived.abilities;
  if (abilities) {
    for (const [ability, score] of Object.entries(abilities)) {
      if (typeof score !== 'number') continue;
      const variable = getFinalVariableValue('CHARACTER', `ATTRIBUTE_${ability.toUpperCase()}`);
      const expectedModifier = Math.floor((score - 10) / 2);
      if (variable.total !== expectedModifier) {
        mismatches.push(
          `ability ${ability}: Pathbuilder score ${score} (modifier ${expectedModifier}), WG modifier ${variable.total}`
        );
      }
    }
  }

  const armor = getBestArmor('CHARACTER', character.inventory)?.item;
  if (derived.acTotal?.acTotal !== undefined) {
    const actualAc = getFinalAcValue('CHARACTER', armor);
    if (actualAc !== derived.acTotal.acTotal) {
      mismatches.push(`AC: Pathbuilder ${derived.acTotal.acTotal}, WG ${actualAc}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Pathbuilder 1:1 validation failed: ${mismatches.join('; ')}`);
  }
}

function buildPathbuilderCustomOperations(
  resolved: ResolvedBuild,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  warnings: string[]
): Operation[] {
  const operations: Operation[] = [];
  const seenLanguages = new Set<number>();

  for (const languageName of resolved.languages) {
    const language = content.languages.find(
      (candidate) => labelToVariable(candidate.name) === labelToVariable(languageName)
    );
    if (!language) {
      warnings.push(`language: WG has no language matching "${languageName}"`);
      continue;
    }
    if (seenLanguages.has(language.id)) continue;
    seenLanguages.add(language.id);
    operations.push({
      id: crypto.randomUUID(),
      type: 'giveLanguage',
      data: { languageId: language.id },
    });
  }

  for (const buff of resolved.activeCustomBuffs) {
    if (!buff.custom) continue;
    operations.push(...customEffectOperations(buff.custom, Math.max(1, buff.stacks), warnings));
  }

  return operations;
}

const PATHBUILDER_ATTRIBUTE_VARIABLES = new Set([
  'ATTRIBUTE_STR',
  'ATTRIBUTE_DEX',
  'ATTRIBUTE_CON',
  'ATTRIBUTE_INT',
  'ATTRIBUTE_WIS',
  'ATTRIBUTE_CHA',
]);

/**
 * Detect an attribute selector from the actual WG options rather than from its
 * source path. This keeps feat, skill, heritage, and lore selectors out of the
 * ability-boost matcher.
 */
function isAttributeSelection(options: ObjectWithUUID[]): boolean {
  if (options.length === 0) return false;
  const labels = new Set(['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma']);
  return options.every((option) => {
    if (typeof option.variable === 'string' && PATHBUILDER_ATTRIBUTE_VARIABLES.has(option.variable)) return true;
    return typeof option.name === 'string' && labels.has(option.name);
  });
}

function isSkillSelection(options: ObjectWithUUID[]): boolean {
  if (options.length === 0) return false;
  return options.every((option) =>
    typeof option.name === 'string' && PATHBUILDER_SKILL_NAMES.has(labelToVariable(option.name))
  );
}

function isLanguageSelection(selection: { title?: string; description?: string } | undefined): boolean {
  return /\blanguage\b/i.test([selection?.title, selection?.description].filter(Boolean).join(' '));
}

/**
 * Identify WG's dedicated class key-ability selector without letting the key
 * ability satisfy an unrelated attribute-boost selector with the same label.
 */
function isKeyAbilitySelection(
  selection: { title?: string; description?: string } | undefined
): boolean {
  const text = [selection?.title, selection?.description].filter(Boolean).join(' ');
  return /\bkey\b.*\b(?:ability|attribute)\b|\b(?:ability|attribute)\b.*\bkey\b/i.test(text);
}

/** Feed the operation builder every choice the payload records, level by level. */
async function resolveSelections(
  character: Character,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  resolved: ResolvedBuild,
  warnings: string[]
): Promise<void> {
  // Levels for special selections come from the feat slot that owns them.
  const slotLevel = new Map<string, number>();
  for (const feat of resolved.feats) {
    if (feat.level !== undefined) slotLevel.set(feat.slot, feat.level);
  }

  const selections: { name: string; level: number }[] = [
    ...resolved.feats.map((feat) => ({ name: feat.name, level: feat.level ?? 1 })),
    ...resolved.skillIncreases.map((increase) => ({ name: increase.skill, level: increase.level })),
    // Class/background/ancestry operations often ask for additional trained skills at level 1.
    // The share payload records these independently from hashMapSkillIncreases.
    ...resolved.trainedSkills.map((skill) => ({ name: skill, level: 1 })),
    ...resolved.specialSelections.map((special) => ({
      name: special.value,
      level: slotLevel.get(special.slot) ?? 1,
    })),
  ];

  const chosen: Record<string, string> = {};
  const checked = new Set<string>();
  // Dynamic grants can rebuild the same selection with a different ancestry/source path.
  // The actual select-operation id is stable, so track it separately from the rendered path.
  const checkedSelectionIds = new Set<string>();
  const abilityBoostCursors = new Map<string, number>();
  const skillCursors = new Map<number, number>();
  let classAttributeSelectionIndex = 0;

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
      const selectionId = found.selection?.selection?.id ?? '';
      if (selectionId && checkedSelectionIds.has(selectionId)) {
        checked.add(found.path);
        if (++iteration > Math.max(64, selections.length + 16)) {
          throw new Error(
            `Pathbuilder 1:1 selection resolution did not converge after ${iteration} iterations`
          );
        }
        continue;
      }
      const options = found.selection?.selection?.options ?? [];
      const attributeSelection = isAttributeSelection(options);
      const skillSelection = isSkillSelection(options);
      const languageSelection = isLanguageSelection(found.selection?.selection);
      const keyAbilitySelection = isKeyAbilitySelection(found.selection?.selection);
      let requestedSelections = selections;
      let result: Pick<ObjectWithUUID, '_select_uuid'> | null = null;

      const freeArchetypeBranch = findFreeArchetypeBranch(options, selections, found.level);
      if (freeArchetypeBranch) {
        result = freeArchetypeBranch;
      }

      if (attributeSelection) {
        const isClassAttributeSelection = found.path.startsWith('class_');
        const implicitKeyAbilitySelection =
          isClassAttributeSelection && classAttributeSelectionIndex === 0;
        if (implicitKeyAbilitySelection) {
          if (resolved.identity.keyAbility) {
            requestedSelections = [{ name: pathbuilderAbilityLabel(resolved.identity.keyAbility), level: found.level }];
          } else if (options.length === 1) {
            result = options[0];
          } else {
            throw new Error(
              `Pathbuilder 1:1 key ability is not present in the share payload and WG exposes multiple key-ability candidates: ${options
                .map((option) => option.name ?? option.title ?? option._select_uuid)
                .join(', ')}; selection path: ${found.path}`
            );
          }
        } else if (keyAbilitySelection && resolved.identity.keyAbility) {
          requestedSelections = [{ name: pathbuilderAbilityLabel(resolved.identity.keyAbility), level: found.level }];
        } else {
          const origin = getAbilityBoostOriginForPath(found.path);
          if (origin) {
            const cursorKey = origin + ':' + found.level;
            const cursor = abilityBoostCursors.get(cursorKey) ?? 0;
            const candidates = resolved.abilityBoosts.filter(
              (boost) => boost.origin === origin && boost.level === found.level
            );
            const candidate = candidates[cursor];
            requestedSelections = candidate
              ? [{ name: pathbuilderAbilityLabel(candidate.ability), level: candidate.level }]
              : [];
          } else {
            requestedSelections = [];
          }
        }
      } else if (skillSelection) {
        const cursor = skillCursors.get(found.level) ?? 0;
        const candidates = [
          ...resolved.trainedSkills.map((skill) => ({ name: skill, level: 1 })),
          ...resolved.skillIncreases.map((increase) => ({ name: increase.skill, level: increase.level })),
        ].filter((selection) => selection.level === found.level);
        const candidate = candidates[cursor];
        requestedSelections = candidate ? [candidate] : [];
      } else if (languageSelection) {
        requestedSelections = resolved.languages.map((name) => ({ name, level: found.level }));
      }

      if (!result && resolved.identity.heritage) {
        const heritage = options.find(
          (option) => labelToVariable(option.name) === labelToVariable(resolved.identity.heritage!)
        );
        if (heritage) result = heritage;
      }

      if (!result) {
        result = findMatchingOption(requestedSelections, options, found.level);
      }
      if (result) {
        chosen[found.path] = result._select_uuid;
        character.operation_data!.selections = cloneDeep(chosen);

        if (attributeSelection) {
          if (found.path.startsWith('class_')) classAttributeSelectionIndex++;
        }
        if (attributeSelection && !keyAbilitySelection && !(found.path.startsWith('class_') && classAttributeSelectionIndex === 1)) {
          const origin = getAbilityBoostOriginForPath(found.path);
          if (origin) {
            const cursorKey = origin + ':' + found.level;
            abilityBoostCursors.set(cursorKey, (abilityBoostCursors.get(cursorKey) ?? 0) + 1);
          }
        }
        if (skillSelection) {
          const cursor = skillCursors.get(found.level) ?? 0;
          skillCursors.set(found.level, cursor + 1);
        }
      } else {
        const requested = requestedSelections
          .filter((selection) => selection.level === found.level)
          .map((selection) => selection.name)
          .join(', ');
        const available = options
          .map((option) => option.name ?? option.title ?? option._select_uuid ?? 'unnamed')
          .filter(Boolean)
          .join(', ');
        throw new Error(
          `Pathbuilder 1:1 selection mapping failed: level ${found.level}; requested: ${requested || 'none'}; available: ${available || 'none'}; selection path: ${found.path}; selector: ${found.selection?.selection?.title ?? found.selection?.selection?.description ?? 'untitled'}`
        );
      }
      checked.add(found.path);
      if (selectionId) checkedSelectionIds.add(selectionId);
    } else {
      hasSelections = false;
    }
    if (++iteration > Math.max(64, selections.length + 16)) {
      throw new Error(
        `Pathbuilder 1:1 selection resolution did not converge after ${iteration} iterations`
      );
    }
  }
}

/**
 * Resolve an inventory reference to a concrete WG item.
 */
function withPathbuilderWeaponState(item: Item, weapon: ResolvedBuild['weapons'][number]): Item {
  const copy = cloneDeep(item);
  const existing = copy.meta_data ?? ({ bulk: {} } as NonNullable<Item['meta_data']>);
  const existingPathbuilder = existing.pathbuilder;
  const pathbuilderState = {
    ...(existingPathbuilder ?? {
      uniqueIdentifier: crypto.randomUUID(),
      type: 0,
      raw: null,
    }),
    attackAbility: weapon.attackAbility,
    twoHanded: weapon.twoHanded,
  };
  copy.meta_data = {
    ...existing,
    pathbuilder: pathbuilderState,
  };
  return copy;
}

function findInventoryItem(
  ref: ResolvedItemRef,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  customItems: Map<string, Item>
): Item | undefined {
  if (ref.kind === 'custom' && ref.uuid) {
    const custom = customItems.get(ref.uuid.toLowerCase());
    if (custom) return custom;
  }

  if (ref.kind === 'standard') {
    // A Pathbuilder weapon can carry a display-only nameOverride (e.g. "Claw")
    // while weaponName remains the actual content reference ("Special Unarmed (1d4)").
    const found = findImportedItem(content.items, ref.name) ?? findImportedItem(content.items, ref.raw);
    if (found) return found;
    return (
      customItems.get(`ref:${labelToVariable(ref.name)}`) ??
      customItems.get(`ref:${labelToVariable(ref.raw)}`)
    );
  }

  if (ref.kind === 'unresolved') {
    return customItems.get(`unresolved:${ref.raw.toLowerCase()}`);
  }

  return undefined;
}

/** Apply Pathbuilder weapon rune state to a WG item without mutating the shared content cache. */
function withPathbuilderRunes(
  item: Item,
  potency: number,
  striking: number,
  propertyNames: string[],
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  warnings: string[]
): Item {
  if (potency <= 0 && striking <= 0 && propertyNames.length === 0) return item;

  const copy = cloneDeep(item);
  const existing = copy.meta_data ?? ({ bulk: {} } as NonNullable<Item['meta_data']>);
  const runes = { ...(existing.runes ?? {}) };

  if (potency > 0) runes.potency = potency;
  if (striking > 0) runes.striking = striking;

  const properties = [];
  for (const name of propertyNames) {
    const rune = content.items.find((candidate) => labelToVariable(candidate.name) === labelToVariable(name));
    if (rune) {
      properties.push({ name: rune.name, id: rune.id, rune });
    } else {
      warnings.push(`rune: WG has no property rune "${name}"`);
    }
  }
  if (properties.length > 0) runes.property = properties;

  copy.meta_data = { ...existing, bulk: existing.bulk ?? {}, runes };
  return copy;
}

/**
 * Rebuild the inventory, including the container hierarchy and Pathbuilder rune state.
 *
 * Pathbuilder stores quantities on references, while WG represents inventory quantity
 * by repeating InventoryItem rows. Expand each reference directly so duplicate names
 * in different locations cannot accidentally steal one another's quantity.
 */
function buildInventory(
  resolved: ResolvedBuild,
  content: Awaited<ReturnType<typeof fetchContentPackage>>,
  customItems: Map<string, Item>,
  warnings: string[]
): InventoryItem[] {
  const toInventoryItems = (
    ref: ResolvedItemRef,
    itemOverride?: Item,
    forceEquipped = false
  ): InventoryItem[] => {
    const item = itemOverride ?? findInventoryItem(ref, content, customItems);
    if (!item) {
      warnings.push(`item: could not resolve "${ref.name}"`);
      return [];
    }

    const entry: InventoryItem = {
      id: crypto.randomUUID(),
      item,
      is_formula: false,
      is_equipped: forceEquipped || isItemEquippable(item),
      is_invested: isItemInvestable(item),
      is_implanted: isItemImplantable(item),
      container_contents: [],
    };

    const quantity = Math.max(1, ref.quantity ?? 1);
    return Array.from({ length: quantity }, (_, index) =>
      index === 0 ? entry : { ...entry, id: crypto.randomUUID() }
    );
  };

  const items: InventoryItem[] = [];

  for (const container of resolved.containers) {
    const containerItem = findImportedItem(content.items, container.name);
    const contents = container.items.flatMap((ref) => toInventoryItems(ref));
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
      // Keep the children visible even when WG lacks the container record.
      warnings.push(
        `container: WG has no "${container.name}", so its ${contents.length} item(s) were moved to the top level`
      );
      items.push(...contents);
    }
  }

  for (const weapon of resolved.weapons) {
    const base = findInventoryItem(weapon, content, customItems);
    if (!base) {
      warnings.push(`item: could not resolve weapon "${weapon.name}"`);
      continue;
    }
    const item = withPathbuilderRunes(
      withPathbuilderWeaponState(base, weapon),
      weapon.potency,
      weapon.striking,
      weapon.runes,
      content,
      warnings
    );
    items.push(...toInventoryItems(weapon, item, true));
  }

  for (const ref of resolved.looseEquipment) {
    items.push(...toInventoryItems(ref));
  }

  if (resolved.shield) {
    items.push(...toInventoryItems(resolved.shield));
  }

  if (resolved.armor) {
    const armor = findInventoryItem(resolved.armor, content, customItems);
    if (armor) {
      const item = withPathbuilderRunes(
        armor,
        resolved.armorPotency,
        0,
        resolved.armorRunes,
        content,
        warnings
      );
      items.push(...toInventoryItems(resolved.armor, item, true));
    } else {
      warnings.push(`item: could not resolve armor "${resolved.armor.name}"`);
    }
  } else if (resolved.armorRunes.length > 0 || resolved.armorPotency > 0) {
    warnings.push(
      `armor: runes [${resolved.armorRunes.join(', ')}] and potency +${resolved.armorPotency} were recorded but there is no armor to attach them to`
    );
  }

  return items;
}
