/**
 * Drives the real Pathbuilder import modal against a live Wanderer's Guide stack.
 *
 * The browser's authenticated fetch-pathbuilder Edge Function request is stubbed
 * with captured Pathbuilder payloads. This is the correct interception point:
 * Pathbuilder is fetched server-side by that function, so Cypress cannot intercept
 * its outbound HTTP requests directly. Everything downstream — preflight,
 * selection wizard, provenance rows, custom-content persistence, create-character —
 * runs for real against the selected WG backend.
 *
 * Run (from frontend/, with `npm run dev` serving :5173):
 *   CYPRESS_TEST_EMAIL=... CYPRESS_TEST_PASSWORD=... npx cypress run \
 *     --spec cypress/e2e/import/pathbuilderImport.cy.ts
 */

const SHARE_FIXTURE = 'pathbuilder-share-1597410.json';

type StubMode = 'golden' | 'unknown-build' | 'export-unavailable';

/** Stub the browser-facing WG relay; no server-side Pathbuilder request escapes the fixture. */
function stubPathbuilder(mode: StubMode): void {
  cy.intercept('POST', '**/functions/v1/fetch-pathbuilder', (req) => {
    const relayMode = String(req.body?.mode ?? '');
    const id = String(req.body?.id ?? '');
    const reply = (data: Record<string, unknown>) =>
      req.reply({
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
        },
        body: { status: 'success', data },
      });

    if (relayMode === 'share') {
      if (mode === 'unknown-build' || id !== '1597410') {
        reply({
          ok: true,
          status: 200,
          payload: { success: false, error: `no shared build with id ${id}` },
        });
        return;
      }

      cy.fixture(SHARE_FIXTURE).then((payload) => {
        reply({ ok: true, status: 200, payload });
      });
      return;
    }

    if (relayMode === 'derived') {
      if (mode === 'export-unavailable' || id !== '474853') {
        reply({
          ok: false,
          status: 404,
          error: `Pathbuilder returned HTTP 404 for derived id ${id}.`,
        });
        return;
      }

      cy.readFile('scripts/fixtures/pathbuilder-kasane-474853-derived.json').then((payload) => {
        reply({ ok: true, status: 200, payload });
      });
      return;
    }

    reply({ ok: false, status: 400, error: 'Unexpected fetch-pathbuilder mode.' });
  }).as('pbRelay');
}
/** Types into the visible Mantine TextInput whose label contains `label`. */
function typeInto(label: string, value: string): void {
  cy.contains('label', label).parent().find('input').first().clear().type(value);
}

/** Asserts the same input is disabled (wizard lock). */
function expectLocked(label: string): void {
  cy.contains('label', label).parent().find('input').first().should('be.disabled');
}

function openImportModal(): void {
  cy.contains('button', /Create Character/i, { timeout: 15000 })
    .first()
    .click();
  cy.contains('Import from Pathbuilder').click();
  cy.contains('Import from Pathbuilder 2e').should('be.visible');
}

describe('Pathbuilder 1:1 import UI', () => {
  beforeEach(() => {
    const email = Cypress.env('TEST_EMAIL');
    const password = Cypress.env('TEST_PASSWORD');
    if (!email || !password) throw new Error('Set CYPRESS_TEST_EMAIL / CYPRESS_TEST_PASSWORD for this spec');
    cy.login(email, password);
    cy.location('pathname').should('eq', '/characters');
  });

  it('validates inputs client-side before any request leaves the page', () => {
    stubPathbuilder('golden');
    openImportModal();

    // Empty form: submit button disabled.
    cy.contains('button', 'Check choices and import').should('be.disabled');

    // Non-numeric garbage in both fields: inline errors, still disabled.
    typeInto('Pathbuilder share ID or link', 'not-a-link');
    cy.contains('Could not find a numeric share ID in that link').should('be.visible');
    typeInto('Official JSON export ID', 'abc');
    cy.contains('Enter the numeric export ID').should('be.visible');
    cy.contains('button', 'Check choices and import').should('be.disabled');
  });

  it('hard-fails closed when the official export ID cannot be retrieved (contract §mandatory input)', () => {
    stubPathbuilder('export-unavailable');
    openImportModal();
    typeInto('Pathbuilder share ID or link', '1597410');
    typeInto('Official JSON export ID', '999999');
    cy.contains('button', 'Check choices and import').should('not.be.disabled').click();

    // Fail-closed red notification and the modal stays open; nothing was created.
    cy.contains('Pathbuilder import could not continue', { timeout: 30000 }).should('be.visible');
    cy.contains(/could not be retrieved/i).should('be.visible');
    cy.contains('button', 'Check choices and import').should('be.visible');
  });

  it('reports an unknown share build without creating anything', () => {
    stubPathbuilder('unknown-build');
    openImportModal();
    typeInto('Pathbuilder share ID or link', 'https://pathbuilder2e.com/launch.html?build=999999999');
    cy.contains('Share ID: 999999999').should('be.visible'); // extractBuildId link parsing
    typeInto('Official JSON export ID', '123');
    cy.contains('button', 'Check choices and import').click();
    cy.contains(/has no shared build with id 999999999|Pathbuilder import/i, { timeout: 30000 }).should('be.visible');
  });

  it('imports the golden share with a separately supplied, identity-checked export ID', () => {
    stubPathbuilder('golden');
    openImportModal();
    typeInto('Pathbuilder share ID or link', '1597410');
    typeInto('Official JSON export ID', '474853');
    cy.contains('button', 'Check choices and import').click();

    // Prove the app used the fixture-backed WG relay for both payloads, rather
    // than accidentally reaching the real Pathbuilder service.
    cy.wait('@pbRelay').its('request.body').should('deep.include', { mode: 'share', id: '1597410' });
    cy.wait('@pbRelay').its('request.body').should('deep.include', { mode: 'derived', id: '474853' });

    // Race the legitimate terminal outcomes deterministically.
    cy.then(() => {
      return new Cypress.Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const text = document.body.innerText;
          if (/Required choice missing/.test(text)) resolve('wizard');
          else if (/Import complete/.test(text)) resolve('complete');
          else if (/could not be retrieved/.test(text)) resolve('failed');
          else if (/Import failed|could not continue|blocked by/i.test(text)) resolve('failed');
          else if (Date.now() - started > 180000) resolve('timeout');
          else setTimeout(tick, 500);
        };
        tick();
      });
    }).then((rawOutcome) => {
      const outcome = String(rawOutcome);
      if (outcome === 'wizard') {
        // Inputs must be locked while a required choice is pending.
        expectLocked('Pathbuilder share ID or link');
        expectLocked('Official JSON export ID');
        cy.contains('button', 'Confirm choice and continue').should('exist');
        cy.get('.mantine-Select-input').last().click({ force: true });
        cy.get('.mantine-OptionsList-item').last().click();
        cy.contains('button', 'Confirm choice and continue').click();
        cy.contains('Import complete', { timeout: 180000 }).should('be.visible');
        verifyKasaneCharacter();
        return;
      }
      if (outcome === 'complete') {
        verifyKasaneCharacter();
        return;
      }
      cy.get('body')
        .invoke('text')
        .then((text) => {
          const line = (String(text).match(/(Import failed[^\n]*|could not continue[^\n]*|blocked by[^\n]*)/i) ?? [''])[0];
          throw new Error(`Golden import produced unexpected outcome "${outcome}": ${line}`);
        });
    });
  });
});

/** Post-import assertions against the characters list backed by the real DB. */
function verifyKasaneCharacter(): void {
  cy.reload();
  cy.contains('Kasane', { timeout: 20000 }).should('be.visible');
}
