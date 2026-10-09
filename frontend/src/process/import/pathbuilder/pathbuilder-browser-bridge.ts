import type { PathbuilderDerivedBuild, PathbuilderShareBuild } from '@schemas/pathbuilder';

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/**
 * Fail closed when the derived export and share payload are not demonstrably the
 * same character. Export IDs are not treated as globally unique character IDs.
 */
export function assertPathbuilderDerivedMatchesShare(
  characterData: PathbuilderShareBuild['characterData'],
  derived: PathbuilderDerivedBuild
): void {
  const checks: Array<{
    label: string;
    share: string | number | null | undefined;
    derived: string | number | null | undefined;
  }> = [
    { label: 'name', share: characterData.characterName, derived: derived.name },
    { label: 'class', share: characterData.className, derived: derived.class },
    { label: 'level', share: characterData.characterLevel, derived: derived.level },
  ];

  for (const check of checks) {
    if (check.share === undefined || check.share === null || String(check.share).trim() === '') {
      throw new Error(`Cannot verify Pathbuilder export identity: share payload is missing ${check.label}.`);
    }
    if (check.derived === undefined || check.derived === null || String(check.derived).trim() === '') {
      throw new Error(`Cannot verify Pathbuilder export identity: JSON export is missing ${check.label}.`);
    }

    const matches =
      check.label === 'level'
        ? Number(check.share) === Number(check.derived)
        : normalizeIdentity(String(check.share)) === normalizeIdentity(String(check.derived));

    if (!matches) {
      throw new Error(
        `Pathbuilder share/export mismatch for ${check.label}: share="${check.share}", export="${check.derived}". Import blocked.`
      );
    }
  }

  for (const key of ['ancestry', 'heritage'] as const) {
    const fromShare = characterData[key];
    const fromDerived = derived[key];
    if (fromShare && fromDerived && normalizeIdentity(fromShare) !== normalizeIdentity(fromDerived)) {
      throw new Error(
        `Pathbuilder share/export mismatch for ${key}: share="${fromShare}", export="${fromDerived}". Import blocked.`
      );
    }
  }
}
