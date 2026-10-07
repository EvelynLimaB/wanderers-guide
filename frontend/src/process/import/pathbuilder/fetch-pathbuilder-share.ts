/**
 * Network layer for Pathbuilder share links.
 *
 * The share endpoint is the source of truth because it carries the raw editor
 * state and the Custom Files attached to the character.
 *
 * The legacy json.php endpoint is optional enrichment only. Shared builds can
 * return 403 there, so that failure never aborts an import.
 */

import {
  PathbuilderDerivedBuild,
  PathbuilderDerivedResponseSchema,
  PathbuilderShareBuild,
  PathbuilderShareBuildSchema,
  PathbuilderShareResponseSchema,
} from '@schemas/pathbuilder';

export const PATHBUILDER_SHARE_ENDPOINT = 'https://pathbuilder2e.com/app/fetch_emailed.php';
export const PATHBUILDER_DERIVED_ENDPOINT = 'https://pathbuilder2e.com/json.php';

export type PathbuilderShareResult =
  | { ok: true; build: PathbuilderShareBuild; formatVersion?: string }
  | { ok: false; error: string };

/**
 * Pull a numeric build id out of a pasted id or share URL.
 *
 * Accepted examples include a bare numeric id, the Pathbuilder emailedBuildID
 * query parameter, and URLs whose last path segment is numeric.
 */
export function extractBuildId(input: string | number | undefined | null): string | null {
  if (typeof input === 'number') return Number.isFinite(input) ? String(Math.trunc(input)) : null;
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return text;

  try {
    const url = new URL(text);
    for (const param of ['emailedBuildID', 'emailedBuildId', 'buildID', 'buildId', 'jsonID', 'jsonId', 'id']) {
      const value = url.searchParams.get(param);
      if (value && /^\d+$/.test(value)) return value;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /^\d+$/.test(last)) return last;
    return null;
  } catch {
    const match = text.match(/\d+/);
    return match ? match[0] : null;
  }
}

/**
 * Fetch and validate a share payload. The outer response and inner build string
 * are each parsed by their own Zod schema.
 */
export async function fetchPathbuilderShare(
  buildId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<PathbuilderShareResult> {
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(PATHBUILDER_SHARE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: buildId }),
      signal: options.signal,
    });
  } catch (error) {
    console.warn(`Pathbuilder share request failed for build ${buildId}:`, error);
    return { ok: false, error: 'Could not reach Pathbuilder' };
  }

  if (!response.ok) {
    return { ok: false, error: `Pathbuilder returned HTTP ${response.status} for build ${buildId}` };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch (error) {
    console.warn(`Pathbuilder returned a non-JSON body for build ${buildId}:`, error);
    return { ok: false, error: 'Pathbuilder returned a non-JSON response' };
  }

  const envelope = PathbuilderShareResponseSchema.safeParse(rawJson);
  if (!envelope.success) {
    console.warn(`Pathbuilder envelope did not match the schema for build ${buildId}:`, envelope.error.issues);
    return { ok: false, error: 'Pathbuilder responded in an unexpected format' };
  }

  if (!envelope.data.success || typeof envelope.data.build !== 'string') {
    return { ok: false, error: envelope.data.error || `Pathbuilder has no shared build with id ${buildId}` };
  }

  let innerJson: unknown;
  try {
    innerJson = JSON.parse(envelope.data.build);
  } catch (error) {
    console.warn(`Pathbuilder build string was not valid JSON for build ${buildId}:`, error);
    return { ok: false, error: 'Pathbuilder build payload was not valid JSON' };
  }

  const parsed = PathbuilderShareBuildSchema.safeParse(innerJson);
  if (!parsed.success) {
    console.warn(`Pathbuilder build did not match the schema for build ${buildId}:`, parsed.error.issues);
    return { ok: false, error: 'Pathbuilder build payload did not match the expected shape' };
  }

  return { ok: true, build: parsed.data, formatVersion: envelope.data.version };
}

/**
 * Best-effort fetch of the derived json.php shape.
 */
export async function fetchPathbuilderDerived(
  buildId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<PathbuilderDerivedBuild | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${PATHBUILDER_DERIVED_ENDPOINT}?id=${encodeURIComponent(buildId)}`, {
      signal: options.signal,
    });
    if (!response.ok) {
      console.info(
        `Pathbuilder json.php unavailable for build ${buildId} (HTTP ${response.status}); continuing without it`
      );
      return null;
    }

    const parsed = PathbuilderDerivedResponseSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.success || !parsed.data.build) return null;
    return parsed.data.build;
  } catch (error) {
    console.info(`Pathbuilder json.php request failed for build ${buildId}; continuing without it`, error);
    return null;
  }
}
