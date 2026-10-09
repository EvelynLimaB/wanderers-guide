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
 * Request Pathbuilder's official calculated export through either a popup or an
 * embedded frame. The frame/popup only transports messages; it never grants
 * the WG page direct access to Pathbuilder's cross-origin DOM.
 */
export function requestPathbuilderDerivedViaBrowser(
  shareId: string,
  options: { timeoutMs?: number; retryIntervalMs?: number } = {}
): Promise<PathbuilderDerivedBuild> {
  return requestPathbuilderDerived(shareId, null, options);
}

/** Use an already-loaded Pathbuilder iframe. The caller must keep it mounted until this promise settles. */
export function requestPathbuilderDerivedViaIframe(
  shareId: string,
  iframe: HTMLIFrameElement,
  options: { timeoutMs?: number; retryIntervalMs?: number } = {}
): Promise<PathbuilderDerivedBuild> {
  if (!iframe?.contentWindow) {
    return Promise.reject(new Error('The Pathbuilder iframe is not ready yet. Load the character in the frame and retry.'));
  }
  return requestPathbuilderDerived(shareId, iframe, options);
}

function requestPathbuilderDerived(
  shareId: string,
  iframe: HTMLIFrameElement | null,
  options: { timeoutMs?: number; retryIntervalMs?: number }
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
  const popup = iframe ? null : window.open(
    new URL('/launch.html', PATHBUILDER_APP_ORIGIN).toString() + '?build=' + encodeURIComponent(shareId),
    '_blank',
    'popup,width=1100,height=850'
  );

  if (!iframe && !popup) {
    return Promise.reject(
      new Error('The browser blocked the Pathbuilder window. Allow popups for Wanderer’s Guide and retry.')
    );
  }

  const timeoutMs = options.timeoutMs ?? 60000;
  const retryIntervalMs = options.retryIntervalMs ?? 700;
  const targetWindow = iframe?.contentWindow ?? popup;

  if (!targetWindow) {
    if (popup && !popup.closed) popup.close();
    return Promise.reject(new Error('Could not access the Pathbuilder frame/window.'));
  }

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
        if (popup && !popup.closed) popup.close();
      } catch {
        // Cross-origin close may be restricted; the import does not depend on it.
      }
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('Pathbuilder browser export completed without a result.'));
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== PATHBUILDER_APP_ORIGIN || event.source !== targetWindow) return;
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
      if (popup?.closed) {
        finish(new Error('The Pathbuilder window was closed before the export completed.'));
        return;
      }
      if (iframe && !iframe.isConnected) {
        finish(new Error('The Pathbuilder iframe was closed before the export completed.'));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        finish(new Error(
          'Timed out waiting for Pathbuilder. Check whether the page is allowed in an iframe and whether the WG Pathbuilder helper is installed. You can retry using the separate-window option.'
        ));
        return;
      }
      try {
        // Retrying covers launch.html redirects and iframe navigation. Requests
        // sent before app.html is ready are intentionally retried.
        targetWindow.postMessage({ type: PATHBUILDER_EXPORT_REQUEST, nonce, shareId }, PATHBUILDER_APP_ORIGIN);
      } catch {
        // Retry after navigation completes.
      }
    };

    window.addEventListener('message', handleMessage);
    retryTimer = window.setInterval(sendRequest, retryIntervalMs);
    sendRequest();
  });
}
