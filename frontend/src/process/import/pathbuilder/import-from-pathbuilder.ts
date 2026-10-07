/**
 * Entry point for "Import from Pathbuilder".
 *
 * This used to fetch `json.php`, squeeze the result through the FTC intermediate
 * (`convertPathbuilderToFTC` -> `importFromFTC`) and look content up by name. The
 * FTC shape can only express an item as `{ name, level? }`, so every Custom File
 * was lost, quantities were dropped, containers were flattened and the raw
 * payload was thrown away.
 *
 * It now delegates to `pathbuilder-share-importer`, which reads the share payload
 * (`fetch_emailed.php`) directly. The legacy conversion is recoverable from git
 * history if the two paths ever need comparing.
 *
 * The signature stays `string | number -> Character | null` so existing callers
 * (CharactersPage) are unaffected. Callers that want the list of details that
 * could not be mapped use `importFromPathbuilderShare` directly.
 */

import { Character } from '@schemas/content';

import { importFromPathbuilderShare } from './pathbuilder-share-importer';

export async function importFromPathbuilder(pathbuilderInput: string | number): Promise<Character | null> {
  const result = await importFromPathbuilderShare(pathbuilderInput);

  if (!result.ok) {
    console.error(`Pathbuilder import failed: ${result.error}`);
    return null;
  }

  if (result.warnings.length > 0) {
    console.warn(`Pathbuilder import left ${result.warnings.length} detail(s) unmapped:`, result.warnings);
  }

  return result.character;
}

export { importFromPathbuilderShare };
export type { PathbuilderImportOutcome } from './pathbuilder-share-importer';
