# Pathbuilder browser-derived export bridge

This bridge requests Pathbuilder's **own calculated export payload** from the official browser UI. It does not guess a JSON export ID or bypass Cloudflare. The official Pathbuilder app computes the stats and submits the normal `POST /app/post_json.php` request; the userscript forwards that request's `build` object to the WG page.

## Import flow

1. In Wanderer's Guide, paste a Pathbuilder share ID or link.
2. Choose **Load in iframe** to display the character inside the import modal.
3. Choose **Import via iframe**. WG sends a nonce-bound request to the frame; the userscript waits for the requested share to load, asks for consent, triggers Pathbuilder's official Export JSON action, then sends the calculated object back to WG.
4. WG verifies the message origin, source window, nonce and share ID, parses the schema, and checks the export identity against the share before using derived fields.
5. If Pathbuilder refuses to load in an iframe, choose **Import in separate window** instead. The popup path uses the same helper and validation.

The helper requires a userscript manager such as Violentmonkey. A normal WG web page cannot silently install it.

## Why this exists

The share endpoint (`fetch_emailed.php`) preserves editor selections and custom files, but some shared payloads omit derived fields such as `keyability`. The old importer queried `json.php?id=<share-id>`, assuming the share ID was also a JSON export ID. That assumption is unsafe because export IDs can be reused. The browser bridge triggers Pathbuilder's official Export JSON action and captures the calculated payload from that request.

## Install

1. Install **Violentmonkey** (or a compatible userscript manager) in Firefox/Zen.
2. Open your running WG instance and choose **Import from Pathbuilder**.
3. Click **Install helper from this WG** and accept the userscript manager's installation prompt.
4. Return to WG and refresh the page.
5. Load the share in an iframe or choose the separate-window path, then approve the transfer dialog shown by Pathbuilder.

## Security and correctness

- WG accepts responses only from the exact `https://pathbuilder2e.com` origin and the exact iframe/popup window it contacted, with a per-request cryptographic nonce.
- The userscript replies only to the parent frame or opener that requested the export and shows a consent dialog naming the recipient origin.
- The helper refuses to export unless the requested share ID was successfully loaded in the Pathbuilder UI.
- The importer compares share/export name, class and level; it also checks ancestry and heritage when both sources provide them. Any identity mismatch blocks import.
- Only the calculated export payload is sent to WG. The raw share payload and Custom Files remain sourced from `fetch_emailed.php`.
- Cross-origin policy still applies: the iframe does not grant WG direct access to Pathbuilder's DOM or storage. Messages work because the installed helper explicitly relays the data.
- Pathbuilder's current `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` behavior has not been confirmed here. If framing is blocked, the separate-window path is the fallback; the import times out with an actionable error instead of claiming success.
- The helper depends on the Pathbuilder UI continuing to use `#sidenav-json` and `POST /app/post_json.php`. It fails closed if expected data or identity is absent.

## Validation

Run from `frontend/`:

```bash
npm run test:pathbuilder-import
npm run build
```

Automated tests cover message nonces, share IDs, schema parsing and identity mismatch rejection. A live-browser smoke test is still required to verify frame permissions, userscript injection and the current Pathbuilder DOM/export behavior.
