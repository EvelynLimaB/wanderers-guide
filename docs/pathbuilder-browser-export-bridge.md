# Automatic Pathbuilder JSON import

Wanderer's Guide requests the calculated JSON directly from Pathbuilder's official web application through a small backend browser worker. The end user only supplies the Pathbuilder share ID/link and clicks **Import automatically**; no iframe, popup, userscript or browser extension is needed.

## Flow

1. The WG frontend obtains the active Supabase access token and sends the numeric share ID to the same-origin `POST /api/pathbuilder/derive` endpoint.
2. Nginx forwards that request to the internal `pathbuilder-automation` container. The worker validates the Supabase session through `/auth/v1/user`, applies rate limits and opens a fresh Chromium context.
3. The browser visits the fixed Pathbuilder URL `https://pathbuilder2e.com/launch.html?build=<share-id>`, verifies that the requested shared character was loaded, and waits for the official UI to become ready.
4. The worker clicks Pathbuilder's own **Export JSON** menu item. It intercepts the browser's `POST /app/post_json.php` locally, captures the calculated `build` object and returns a harmless success response to the UI. The JSON export payload is not uploaded to Pathbuilder's JSON storage endpoint by this workflow.
5. WG schema-validates the response, fetches the share payload, compares the character identity, then combines calculated data with the share's choices and Custom Files. The importer continues to block identity mismatches and unresolved mandatory selections.

## Deploy

The worker is part of the repository's Compose stack. Since this deployment uses Podman, rebuild with the Podman Compose provider after pulling this branch:

```bash
podman compose up -d --build
```

If your installation exposes the provider directly instead of through `podman compose`, use:

```bash
podman-compose up -d --build
```

Before starting the stack, you can validate the Compose file with `podman compose config` (or `podman-compose config`). The `podman compose` subcommand delegates to an installed Compose provider, so supported flags and Compose behavior depend on that provider. See the [official Podman Compose documentation](https://docs.podman.io/en/latest/markdown/podman-compose.1.html).

The worker reads `PUBLIC_SUPABASE_URL` and `ANON_KEY` from the existing Compose environment. For a self-hosted Supabase stack where the public URL is `http://localhost:8000`, set `PATHBUILDER_SUPABASE_URL=http://kong:8000` in `.env` so the worker can validate the user's session across the Compose network. For externally hosted Supabase, the default public URL is normally correct. The worker has no published host port; Nginx exposes only the authenticated same-origin route. If the deployment is using a static frontend without the Compose worker, automatic export is not available until the worker and reverse-proxy route are deployed.

## Reliability and security

- The API accepts a numeric share ID only; it never accepts an arbitrary navigation URL.
- The worker validates the Supabase user token, applies per-user and Nginx request limits, bounds request sizes and limits concurrent browser contexts.
- Browser contexts are isolated per request and closed afterwards. The worker does not save character exports.
- The frontend validates the returned JSON against the Pathbuilder-derived schema, then checks name, class and level against the share before using it. Ancestry and heritage are compared when both are present.
- The worker uses the official browser UI without anti-bot evasion. If Pathbuilder presents a challenge, changes its UI, or cannot load the share, the import fails closed with an error. It does not bypass those controls.
- The share's own data is still authoritative for character choices and Custom Files. If Pathbuilder omits a mandatory selection from both the share and the calculated export, the 1:1 importer may still reject that build rather than inventing the choice.

## Tests

Run the unit tests from the repository root:

```bash
cd pathbuilder-automation
npm test
```

The worker tests cover numeric share IDs, minimum export identity fields, endpoint input validation, health checks and authentication gating. They do not validate live Pathbuilder availability or the current production DOM. A real import is still required to verify that Pathbuilder allows the worker's browser session and that its current export control continues to work.
