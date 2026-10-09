import { PathbuilderDerivedBuildSchema } from '@schemas/pathbuilder';
import type { PathbuilderDerivedBuild } from '@schemas/pathbuilder';
import { supabase } from '../../../supabase-client';

/**
 * Ask the WG backend to run Pathbuilder's official UI and intercept its
 * calculated JSON export. No iframe, popup, or user-installed browser helper
 * is required on the client.
 */
export async function requestPathbuilderDerivedAutomatically(
  shareId: string
): Promise<PathbuilderDerivedBuild> {
  if (!/^\d{1,12}$/.test(shareId)) {
    throw new Error('A valid numeric Pathbuilder share ID is required.');
  }

  const { data, error: sessionError } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error('Sign in to Wanderer’s Guide before importing from Pathbuilder.');
  }

  let response: Response;
  try {
    response = await fetch('/api/pathbuilder/derive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ shareId }),
    });
  } catch {
    throw new Error('Could not reach the automatic Pathbuilder importer. Check that the WG backend worker is running.');
  }

  const payload = await response.json().catch(() => null) as
    | { success?: unknown; build?: unknown; error?: unknown }
    | null;
  if (!response.ok || !payload || payload.success !== true) {
    throw new Error(
      typeof payload?.error === 'string'
        ? payload.error
        : `Automatic Pathbuilder import failed (HTTP ${response.status}).`
    );
  }

  const parsed = PathbuilderDerivedBuildSchema.safeParse(payload.build);
  if (!parsed.success) {
    throw new Error('The automatic Pathbuilder service returned an unexpected JSON structure.');
  }

  return parsed.data;
}
