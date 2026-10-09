import { PathbuilderDerivedBuildSchema } from '@schemas/pathbuilder';
import type { PathbuilderDerivedBuild, PathbuilderShareBuild } from '@schemas/pathbuilder';

export const PATHBUILDER_APP_ORIGIN = 'https://pathbuilder2e.com';
export const PATHBUILDER_EXPORT_REQUEST = 'WG_PATHBUILDER_EXPORT_REQUEST';
export const PATHBUILDER_EXPORT_RESULT = 'WG_PATHBUILDER_EXPORT_RESULT';
export const PATHBUILDER_EXPORT_ERROR = 'WG_PATHBUILDER_EXPORT_ERROR';

export type PathbuilderBrowserExport = {
  derived: PathbuilderDerivedBuild;
  exportId: string;
};

type BridgeMessage = {
  type?: unknown;
  nonce?: unknown;
  shareId?: unknown;
  exportId?: unknown;
  derived?: unknown;
  error?: unknown;
};

export function parsePathbuilderBrowserExport(
  input: unknown,
  expectedNonce: string,
  expectedShareId: string
): PathbuilderBrowserExport {
  if (!input || typeof input !== 'object') {
    throw new Error('Pathbuilder browser helper returned an invalid message.');
  }

  const message = input as BridgeMessage;
  if (message.type !== PATHBUILDER_EXPORT_RESULT) {
    throw new Error('Pathbuilder browser helper returned an unexpected message type.');
  }
  if (message.nonce !== expectedNonce) {
    throw new Error('Pathbuilder browser helper response did not match this import request.');
  }
  if (String(message.shareId ?? '') !== expectedShareId) {
    throw new Error('The Pathbuilder tab loaded a different share ID than the one requested.');
  }
  if (
    (typeof message.exportId !== 'number' && typeof message.exportId !== 'string') ||
    !/^\d+$/.test(String(message.exportId))
  ) {
    throw new Error('Pathbuilder did not return a valid JSON export ID.');
  }

  const parsed = PathbuilderDerivedBuildSchema.safeParse(message.derived);
  if (!parsed.success) {
    throw new Error('Pathbuilder returned a JSON export with an unexpected structure.');
  }

  return { derived: parsed.data, exportId: String(message.exportId) };
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/**
 * Fail closed when the derived export and share payload are not demonstrably the
 * same character. The export ID is not treated as a globally unique character ID.
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

/**
 * Open Pathbuilder's official UI and request its calculated Export JSON through
 * the installed userscript. The share remains authoritative for choices/custom files.
 */
export function requestPathbuilderDerivedViaBrowser(
  shareId: string,
  options: { timeoutMs?: number; retryIntervalMs?: number } = {}
): Promise<PathbuilderDerivedBuild> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Browser-assisted Pathbuilder export requires a browser window.'));
  }
  if (!/^\d+$/.test(shareId)) {
    return Promise.reject(new Error('A numeric Pathbuilder share ID is required.'));
  }

  const nonceBytes = new Uint8Array(24);
  window.crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const url = new URL('/launch.html', PATHBUILDER_APP_ORIGIN);
  url.searchParams.set('build', shareId);

  const popup = window.open(url.toString(), '_blank', 'popup,width=1100,height=850');
  if (!popup) {
    return Promise.reject(
      new Error('The browser blocked the Pathbuilder window. Allow popups for Wanderer’s Guide and retry.')
    );
  }

  const timeoutMs = options.timeoutMs ?? 60000;
  const retryIntervalMs = options.retryIntervalMs ?? 700;

  return new Promise<PathbuilderDerivedBuild>((resolve, reject) => {
    let finished = false;
    let retryTimer: number | undefined;
    const startedAt = Date.now();

    const cleanup = () => {
      window.removeEventListener('message', handleMessage);
      if (retryTimer !== undefined) window.clearInterval(retryTimer);
    };

    const finish = (error?: Error, result?: PathbuilderDerivedBuild) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        if (!popup.closed) popup.close();
      } catch {
        // Cross-origin close may be restricted; request completion does not depend on it.
      }
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('Pathbuilder browser export completed without a result.'));
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== PATHBUILDER_APP_ORIGIN || event.source !== popup) return;
      const data = event.data as BridgeMessage | null;
      if (!data || typeof data !== 'object' || data.nonce !== nonce) return;

      if (data.type === PATHBUILDER_EXPORT_ERROR) {
        finish(new Error(typeof data.error === 'string' ? data.error : 'Pathbuilder browser helper failed.'));
        return;
      }
      if (data.type !== PATHBUILDER_EXPORT_RESULT) return;

      try {
        const parsed = parsePathbuilderBrowserExport(data, nonce, shareId);
        finish(undefined, parsed.derived);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const sendRequest = () => {
      if (finished) return;
      if (popup.closed) {
        finish(new Error('The Pathbuilder window was closed before the export completed.'));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        finish(new Error(
          'Timed out waiting for Pathbuilder. Install/enable the Wanderer’s Guide Pathbuilder browser helper, then retry.'
        ));
        return;
      }
      try {
        // Retrying is required because launch.html redirects to app.html. Messages
        // sent while the popup is navigating are intentionally retried.
        popup.postMessage({ type: PATHBUILDER_EXPORT_REQUEST, nonce, shareId }, PATHBUILDER_APP_ORIGIN);
      } catch {
        // The next interval retries after navigation completes.
      }
    };

    window.addEventListener('message', handleMessage);
    retryTimer = window.setInterval(sendRequest, retryIntervalMs);
    sendRequest();
  });
}
