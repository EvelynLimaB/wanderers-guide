/**
 * Pure Pathbuilder -> WG selection routing helpers.
 *
 * This module deliberately has no app/runtime imports so it can be tested with
 * plain Node + tsx without Vite's import.meta.env or the Supabase client.
 */

export type PathbuilderSelectionOption = {
  _select_uuid: string;
  title?: string;
  name?: string;
};

export type PathbuilderSelectionChoice = {
  name: string;
  level: number;
};

export function getAbilityBoostOriginForPath(
  path: string
): 'levelled' | 'ancestry' | 'background' | null {
  if (path.startsWith('background_')) return 'background';
  if (path.startsWith('ancestry_')) return 'ancestry';
  // Pathfinder 2e's four level-1 ability boosts are part of WG's class
  // operation tree. Later boosts are emitted as class-feature-* sources.
  if (path.startsWith('class_') || path.startsWith('class-feature-')) return 'levelled';
  return null;
}

/**
 * Free Archetype slots are represented by a two-stage custom selector:
 * first WG asks whether the user is adding a dedication or an archetype feat,
 * then it exposes the actual feat selector. Pathbuilder stores only the actual
 * feat, so the importer infers the outer branch from the level's selected feat.
 */
export function findFreeArchetypeBranch(
  options: PathbuilderSelectionOption[],
  feats: PathbuilderSelectionChoice[],
  level: number
): PathbuilderSelectionOption | null {
  const titles = new Set(
    options
      .map((option) => option.title ?? option.name ?? '')
      .filter((title) => title === 'Add Dedication' || title === 'Add Archetype Feat')
  );
  if (titles.size === 0) return null;

  const hasDedication = feats.some(
    (feat) => feat.level === level && /\\bdedication\\b/i.test(feat.name)
  );
  const target = hasDedication ? 'Add Dedication' : 'Add Archetype Feat';
  return options.find((option) => (option.title ?? option.name) === target) ?? null;
}
