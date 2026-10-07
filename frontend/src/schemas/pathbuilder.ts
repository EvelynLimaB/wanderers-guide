import { z } from 'zod';

/**
 * Zod schemas for the Pathbuilder 2e wire format.
 *
 * Pathbuilder is a third-party service we do not control, so this is exactly the
 * boundary core guideline 4 is about: the response is parsed here and every
 * downstream module consumes the inferred type. Nothing casts a Pathbuilder
 * response into shape.
 *
 * Two endpoints, two shapes:
 *
 *   POST /app/fetch_emailed.php {"id":"N"} -> { success, version, build: "<JSON string>" }
 *   GET  /json.php?id=N                    -> { success, build: <derived object> }
 *
 * The share endpoint's build is a JSON string, so it is parsed twice: once by
 * PathbuilderShareResponseSchema, then again through PathbuilderShareBuildSchema.
 *
 * Every object schema here is loose (.passthrough()). Pathbuilder adds fields
 * between releases and the importer persists the payload verbatim, so an unknown
 * key must survive parsing rather than be stripped or rejected.
 */

/**
 * Pathbuilder stores ability scores as small integers. Confirmed against build
 * 1596127: hashMapAncestryFreeBoostSelections {"0":2} is an Automaton's free
 * boost to Constitution, and the level-1 boosts [2,0,1,5] are four distinct
 * boosts to Con/Str/Dex/Cha.
 */
export const PATHBUILDER_ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type PathbuilderAbility = (typeof PATHBUILDER_ABILITIES)[number];

/** A Custom File UUID, which is how Pathbuilder references custom content. */
export const PATHBUILDER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Custom Files ─────────────────────────────────────────────────────────────

export const PathbuilderCustomEffectSchema = z
  .object({
    effectType: z.number().optional(),
    bonusAmount: z.number().optional(),
    reference: z.string().optional(),
    proficiencyName: z.string().optional(),
  })
  .passthrough();
export type PathbuilderCustomEffect = z.infer<typeof PathbuilderCustomEffectSchema>;

/**
 * A parsed Custom File. Field presence depends on type, which has only been
 * observed as 1 (custom buff/effect) and 3 (custom weapon).
 *
 * Note the misspelling: custom weapons carry uniqueIdentiier while custom
 * buffs carry the correctly spelled uniqueIdentifier. Both appear in the same
 * payload (build 1596127), so both are accepted and neither can be dropped.
 */
export const PathbuilderCustomFileSchema = z
  .object({
    uniqueIdentifier: z.string(),
    type: z.number(),
    name: z.string().optional(),
    description: z.string().optional(),
    itemLevel: z.number().optional(),
    price: z.number().optional(),
    hands: z.string().optional(),
    src: z.string().optional(),
    proficiencyType: z.number().optional(),
    damage: z.number().optional(),
    damageType: z.string().optional(),
    group: z.string().optional(),
    weaponTraits: z.string().optional(),
    action0: z.number().optional(),
    action0desc: z.string().optional(),
    listCustomEffects: z.array(PathbuilderCustomEffectSchema).optional(),
  })
  .passthrough();
export type PathbuilderCustomFile = z.infer<typeof PathbuilderCustomFileSchema>;

/**
 * One Custom File as it arrives in listCustomFiles.
 *
 * json is a string containing JSON, and Pathbuilder is inconsistent about how
 * deeply it escapes it. Always go through parseCustomFileJson() rather than
 * calling JSON.parse directly.
 */
export const PathbuilderCustomFileEntrySchema = z
  .object({
    type: z.number(),
    json: z.string(),
    timestamp: z.string().optional(),
    uniqueIdentifier: z.string().optional(),
  })
  .passthrough();
export type PathbuilderCustomFileEntry = z.infer<typeof PathbuilderCustomFileEntrySchema>;

// ─── characterData ────────────────────────────────────────────────────────────

export const PathbuilderPlayerWeaponSchema = z
  .object({
    weaponName: z.string(),
    amount: z.number().optional(),
    attackAbilityRef: z.number().optional(),
    itemStriking: z.number().optional(),
    potency: z.number().optional(),
    listPropertyRunes: z.array(z.string()).optional(),
    nameOverride: z.string().optional(),
    use2H: z.boolean().optional(),
  })
  .passthrough();
export type PathbuilderPlayerWeapon = z.infer<typeof PathbuilderPlayerWeaponSchema>;

export const PathbuilderArmorSchema = z
  .object({
    armorName: z.string().optional(),
    potency: z.number().optional(),
    listPropertyRunes: z.array(z.string()).optional(),
  })
  .passthrough();
export type PathbuilderArmor = z.infer<typeof PathbuilderArmorSchema>;

export const PathbuilderShieldSchema = z
  .object({
    shieldName: z.string().optional(),
    shieldDamage: z.number().optional(),
    potency: z.number().optional(),
  })
  .passthrough();
export type PathbuilderShield = z.infer<typeof PathbuilderShieldSchema>;

export const PathbuilderEquipmentEntrySchema = z
  .object({
    name: z.string(),
    quantity: z.number().optional(),
    inContainerID: z.string().optional(),
  })
  .passthrough();
export type PathbuilderEquipmentEntry = z.infer<typeof PathbuilderEquipmentEntrySchema>;

export const PathbuilderContainerSchema = z
  .object({
    containerName: z.string().optional(),
    backpack: z.boolean().optional(),
  })
  .passthrough();
export type PathbuilderContainer = z.infer<typeof PathbuilderContainerSchema>;

export const PathbuilderSpellEntrySchema = z
  .object({
    spellList: z.number().optional(),
    spellName: z.string().optional(),
    heighten: z.number().optional(),
  })
  .passthrough();
export type PathbuilderSpellEntry = z.infer<typeof PathbuilderSpellEntrySchema>;

/**
 * Raw editor state. Only the fields the importer reads are declared. Everything
 * else survives through passthrough so the persisted snapshot stays lossless.
 */
export const PathbuilderCharacterDataSchema = z
  .object({
    characterName: z.string().optional(),
    characterLevel: z.number().optional(),
    ancestry: z.string().optional(),
    className: z.string().optional(),
    background: z.string().optional(),
    heritage: z.string().optional(),
    gender: z.string().optional(),
    alignment: z.string().optional(),
    deity: z.string().optional(),
    age: z.string().optional(),
    gold: z.number().optional(),
    notes: z.string().optional(),
    webID: z.string().optional(),
    emailedBuildID: z.number().optional(),

    classOptionalTrainedSkill: z.string().optional(),
    listLanguages: z.array(z.string()).optional(),
    dialects: z.array(z.string().nullish()).optional(),

    hashMapAbilityBoosts: z.record(z.string(), z.array(z.number())).optional(),
    hashMapAncestryFreeBoostSelections: z.record(z.string(), z.number()).optional(),
    hashMapSkillIncreases: z.record(z.string(), z.array(z.string())).optional(),
    hashMapCustomSkillIncreases: z.record(z.string(), z.number()).optional(),
    hashMapTrainedOnlySkillChoices: z.record(z.string(), z.array(z.string())).optional(),

    hashMapFeatSelections: z.record(z.string(), z.string()).optional(),
    hashMapSpecialSelections: z.record(z.string(), z.record(z.string(), z.string())).optional(),

    listPlayerWeapons: z.array(PathbuilderPlayerWeaponSchema).optional(),
    playerArmor: PathbuilderArmorSchema.optional(),
    playerShieldNew: PathbuilderShieldSchema.optional(),
    listPlayerEquipment: z.array(PathbuilderEquipmentEntrySchema).optional(),
    hashMapEquipmentContainers: z.record(z.string(), PathbuilderContainerSchema).optional(),

    hashMapPlayerSpells: z.record(z.string(), PathbuilderSpellEntrySchema).optional(),
    spentSpellPoints: z.number().optional(),

    hashMapActiveCustomBuffs: z.record(z.string(), z.number()).optional(),

    freeArchetype: z.boolean().optional(),
    ancestryParagon: z.boolean().optional(),
    gradualAbilityBoost: z.boolean().optional(),
    remastered: z.boolean().optional(),
    useUpdatedSpells: z.boolean().optional(),
    allowHalfHeritages: z.boolean().optional(),
    listDisabledRulebooks: z.array(z.string()).optional(),
    listOptInBooks: z.array(z.string()).optional(),
  })
  .passthrough();
export type PathbuilderCharacterData = z.infer<typeof PathbuilderCharacterDataSchema>;

// ─── envelopes ────────────────────────────────────────────────────────────────

export const PathbuilderShareBuildSchema = z.object({
  characterData: PathbuilderCharacterDataSchema,
  listCustomFiles: z.array(PathbuilderCustomFileEntrySchema).optional(),
});
export type PathbuilderShareBuild = z.infer<typeof PathbuilderShareBuildSchema>;

/** Response body of POST /app/fetch_emailed.php. build is still a string here. */
export const PathbuilderShareResponseSchema = z
  .object({
    success: z.boolean(),
    version: z.string().optional(),
    build: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type PathbuilderShareResponse = z.infer<typeof PathbuilderShareResponseSchema>;

/**
 * The derived json.php shape. Optional enrichment: it is unavailable for many
 * shared builds, and the importer must produce a complete result without it.
 */
export const PathbuilderDerivedBuildSchema = z
  .object({
    name: z.string().optional(),
    class: z.string().optional(),
    ancestry: z.string().optional(),
    heritage: z.string().optional(),
    background: z.string().optional(),
    level: z.number().optional(),
    alignment: z.string().optional(),
    deity: z.string().optional(),
    gender: z.string().optional(),
    age: z.string().optional(),
    money: z
      .object({
        cp: z.number().optional(),
        sp: z.number().optional(),
        gp: z.number().optional(),
        pp: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();
export type PathbuilderDerivedBuild = z.infer<typeof PathbuilderDerivedBuildSchema>;

export const PathbuilderDerivedResponseSchema = z
  .object({
    success: z.boolean().optional(),
    build: PathbuilderDerivedBuildSchema.optional(),
  })
  .passthrough();
export type PathbuilderDerivedResponse = z.infer<typeof PathbuilderDerivedResponseSchema>;
