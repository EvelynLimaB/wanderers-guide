import http from 'node:http';
import { isIP } from 'node:net';
import { chromium } from 'playwright';

export const PATHBUILDER_ORIGIN = 'https://pathbuilder2e.com';
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;
export const USER_RATE_LIMIT = 5;
export const USER_RATE_WINDOW_MS = 60_000;
export const BROWSER_TIMEOUT_MS = 60_000;

const PORT = Number(process.env.PORT ?? 8080);
const SUPABASE_URL = String(process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY ?? '');
const MAX_CONCURRENT_BROWSERS = 2;
const activeByUser = new Map();
const userRequests = new Map();
let browserPromise;

export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
  }
}

export function parseShareId(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) {
    throw new ServiceError(400, 'Enter a valid numeric Pathbuilder share ID.');
  }
  return id;
}

export function extractCalculatedBuild(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ServiceError(502, 'Pathbuilder returned an invalid export payload.');
  }
  const build = payload.build;
  if (
    !build ||
    typeof build !== 'object' ||
    Array.isArray(build) ||
    typeof build.name !== 'string' ||
    !build.name.trim() ||
    typeof build.class !== 'string' ||
    !build.class.trim() ||
    !Number.isInteger(build.level) ||
    build.level < 1 ||
    build.level > 30
  ) {
    throw new ServiceError(502, 'Pathbuilder export is missing the character identity or level.');
  }
  return build;
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new ServiceError(415, 'Content-Type must be application/json.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new ServiceError(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServiceError(400, 'Request body must be valid JSON.');
  }
}

function bearerToken(request) {
  const authorization = String(request.headers.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new ServiceError(401, 'Sign in to Wanderer’s Guide before importing.');
  return match[1];
}

async function validateSupabaseUser(token) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new ServiceError(503, 'Pathbuilder automation is not configured on this WG instance.');
  }

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ServiceError(503, 'Could not validate your WG session. Retry in a moment.');
  }

  if (!response.ok) {
    throw new ServiceError(401, 'Your WG session is invalid or expired. Sign in and retry.');
  }

  const user = await response.json().catch(() => null);
  if (!user || typeof user.id !== 'string' || !user.id) {
    throw new ServiceError(401, 'Your WG session could not be verified.');
  }
  return user.id;
}

function enforceUserRateLimit(userId) {
  const now = Date.now();
  const current = (userRequests.get(userId) ?? []).filter((time) => now - time < USER_RATE_WINDOW_MS);
  if (current.length >= USER_RATE_LIMIT) {
    throw new ServiceError(429, 'Too many Pathbuilder imports in a short period. Wait a minute and retry.');
  }
  current.push(now);
  userRequests.set(userId, current);

  // Keep this in-memory map bounded by dropping expired users opportunistically.
  if (userRequests.size > 2_000) {
    for (const [id, timestamps] of userRequests) {
      if (!timestamps.some((time) => now - time < USER_RATE_WINDOW_MS)) userRequests.delete(id);
    }
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ServiceError(504, message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requestHasShareId(request, shareId) {
  if (request.method() !== 'POST' || !request.url().includes('/app/fetch_emailed.php')) return false;
  try {
    return String(request.postDataJSON()?.id ?? '') === shareId;
  } catch {
    return false;
  }
}

function looksLikeChallenge(text, title) {
  return /just a moment|verify you are human|checking your browser|cloudflare/i.test(`${title}\n${text}`);
}

/**
 * Open the share in an ordinary Playwright browser and invoke Pathbuilder's own
 * Export JSON action. We intercept post_json.php locally and never upload the
 * character's export back to Pathbuilder as part of this WG import.
 *
 * This does not try to solve, evade, or bypass an anti-bot challenge. If one is
 * presented, the service fails closed with a clear error for the UI to display.
 */
export async function derivePathbuilderBuild(shareId) {
  const id = parseShareId(shareId);
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: 'en-US',
    acceptDownloads: false,
  });
  const page = await context.newPage();

  page.setDefaultTimeout(15_000);
  page.on('dialog', (dialog) => {
    // Pathbuilder may show a standard confirmation after export. The request
    // has already been initiated by this service; no user dialog is needed.
    void dialog.accept().catch(() => {});
  });
  page.on('popup', (popup) => void popup.close().catch(() => {}));

  const shareResponsePromise = page.waitForResponse(
    (response) => requestHasShareId(response.request(), id),
    { timeout: BROWSER_TIMEOUT_MS }
  );

  const captured = createDeferred();
  let exportRequestSeen = false;

  await page.route('**/app/post_json.php', async (route) => {
    try {
      const requestBody = route.request().postDataJSON();
      const build = extractCalculatedBuild(requestBody);
      if (exportRequestSeen) {
        throw new ServiceError(502, 'Pathbuilder attempted more than one export during this import.');
      }
      exportRequestSeen = true;
      captured.resolve(build);

      // Return a harmless success response to the UI. The captured character
      // data stays in this service and is returned only to the authenticated WG
      // request; it is not posted to Pathbuilder's JSON storage endpoint.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1 }),
      });
    } catch (error) {
      captured.reject(error instanceof ServiceError ? error : new ServiceError(502, 'Pathbuilder export could not be parsed.'));
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'WG could not parse Pathbuilder’s export request.' }),
      }).catch(() => {});
    }
  });

  try {
    await page.goto(`${PATHBUILDER_ORIGIN}/launch.html?build=${encodeURIComponent(id)}`, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS,
    });

    const shareResponse = await shareResponsePromise;
    if (!shareResponse.ok()) {
      throw new ServiceError(502, `Pathbuilder share endpoint returned HTTP ${shareResponse.status()}.`);
    }
    const envelope = await shareResponse.json().catch(() => null);
    if (!envelope || envelope.success !== true || typeof envelope.build !== 'string') {
      throw new ServiceError(404, 'Pathbuilder did not return the requested shared character.');
    }
    let sharedBuild;
    try {
      sharedBuild = JSON.parse(envelope.build);
    } catch {
      throw new ServiceError(502, 'Pathbuilder returned an invalid shared character payload.');
    }
    if (!sharedBuild?.characterData || typeof sharedBuild.characterData !== 'object') {
      throw new ServiceError(502, 'Pathbuilder share did not contain character data.');
    }

    try {
      await page.waitForFunction(() => {
        const main = document.getElementById('main-container');
        const levels = document.getElementById('divBuildLevels');
        return document.readyState !== 'loading' &&
          main &&
          !main.classList.contains('hidden') &&
          levels &&
          levels.children.length > 0 &&
          document.getElementById('sidenav-json');
      }, null, { timeout: BROWSER_TIMEOUT_MS });
    } catch {
      const title = await page.title().catch(() => '');
      const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
      if (looksLikeChallenge(body, title)) {
        throw new ServiceError(503, 'Pathbuilder presented an anti-bot challenge. WG cannot complete this automatic import until Pathbuilder permits the request.');
      }
      throw new ServiceError(504, 'Pathbuilder did not finish loading the shared character. Retry later; no data was imported.');
    }

    await page.locator('#sidenav-json').click({ timeout: 15_000 });
    return await withTimeout(
      captured.promise,
      20_000,
      'Pathbuilder did not produce its calculated JSON export in time.'
    );
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown browser automation failure.';
    if (/timeout|timed out/i.test(message)) {
      throw new ServiceError(504, 'Pathbuilder did not respond in time. Retry later; no data was imported.');
    }
    throw new ServiceError(502, 'Could not open or export the character from Pathbuilder. Check connectivity and retry.');
  } finally {
    await context.close().catch(() => {});
  }
}

export function createHttpServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end(JSON.stringify({ success: true }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/derive') {
      response.writeHead(404).end(JSON.stringify({ success: false, error: 'Not found.' }));
      return;
    }

    let activeKey;
    try {
      const body = await readJsonBody(request);
      const shareId = parseShareId(body?.shareId);
      const userId = await validateSupabaseUser(bearerToken(request));
      enforceUserRateLimit(userId);

      const active = activeByUser.get(userId) ?? 0;
      if (active >= 1) {
        throw new ServiceError(429, 'One Pathbuilder import is already running for your account.');
      }
      const totalActive = [...activeByUser.values()].reduce((sum, value) => sum + value, 0);
      if (totalActive >= MAX_CONCURRENT_BROWSERS) {
        throw new ServiceError(503, 'The automatic importer is busy. Retry in a few seconds.');
      }
      activeByUser.set(userId, active + 1);
      activeKey = userId;

      const build = await derivePathbuilderBuild(shareId);
      response.writeHead(200).end(JSON.stringify({ success: true, build }));
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 500;
      const message = error instanceof ServiceError
        ? error.message
        : 'Unexpected automatic Pathbuilder import failure.';
      response.writeHead(status).end(JSON.stringify({ success: false, error: message }));
    } finally {
      if (activeKey) {
        const active = Math.max(0, (activeByUser.get(activeKey) ?? 1) - 1);
        if (active === 0) activeByUser.delete(activeKey);
        else activeByUser.set(activeKey, active);
      }
    }
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname) {
  const server = createHttpServer();
  server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`WG Pathbuilder automation listening on port ${PORT}\n`);
  });
  const shutdown = async () => {
    server.close();
    if (browserPromise) await (await browserPromise).close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
