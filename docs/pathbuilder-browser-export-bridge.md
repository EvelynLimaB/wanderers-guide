# Pathbuilder browser-derived export bridge

This bridge requests Pathbuilder's **own calculated export payload** from the browser. It does not guess a JSON export ID or bypass Cloudflare. The official Pathbuilder app computes the stats and submits the normal `POST /app/post_json.php` request; the userscript forwards that request's `build` object to the WG tab that opened it.

## Why this exists

The share endpoint (`fetch_emailed.php`) preserves editor selections and custom files, but some shared payloads omit derived fields such as `keyability`. The legacy importer queried `json.php?id=<share-id>`, assuming the share ID was also a JSON export ID. That assumption is unsafe. The browser bridge triggers the official Export JSON action and captures the calculated payload directly from the request.

## Install

1. Install the **Violentmonkey** userscript manager in Firefox/Zen if it is not already installed.
2. Open your own running Wanderer's Guide instance and choose **Import from Pathbuilder**.
3. Click **Install helper from this WG**. The helper is served by that same WG instance at `/pathbuilder-wg-bridge.user.js`; no copying script text from GitHub is required.
4. Confirm the userscript installation prompt in Violentmonkey, then return to WG and refresh the page.
5. Choose **Import via browser**, allow the Pathbuilder popup if prompted, and approve the data-transfer dialog in the Pathbuilder tab.

## Security and correctness

- WG accepts replies only from the exact `https://pathbuilder2e.com` origin, from the popup it opened, and with a per-request nonce.
- The userscript responds only to messages from its opener and displays a consent dialog naming the recipient origin.
- The helper refuses to export unless the requested share ID was successfully loaded in that tab.
- The importer verifies share/export name, class and level; it also checks ancestry and heritage when both sources provide them. Any identity mismatch blocks import.
- Only the calculated export payload is sent back. The raw share payload and custom files remain sourced from `fetch_emailed.php`.
- The integration depends on the Pathbuilder UI continuing to use `#sidenav-json` and `POST /app/post_json.php`. It fails closed if the expected data or identity is absent.

## Validation

Run from `frontend/`:

```bash
npm run test:pathbuilder-import
npm run build
```

The helper is served from the WG frontend's `public/` assets, so a deployed frontend publishes it automatically alongside the app. A regular web page cannot silently install a userscript: a compatible manager must already be installed and the user must accept the manager's installation prompt. If the manager is absent, the import dialog still offers share-only import and browser-assisted import fails with an explicit timeout instead of silently claiming success.

The automated tests validate message nonces, share IDs, schema parsing and identity mismatch rejection. A real-browser smoke test is still required after installing the userscript; unit tests cannot guarantee the live Pathbuilder DOM/export behavior remains unchanged.
