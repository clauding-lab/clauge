# Chrome Web Store listing — copy & paste

Everything you need to fill in the CWS dev console for **Clauge Sync** v0.2.0.

## What's new in v0.2.0

Adds claude.ai consumer "Usage credits" scraping — the `$X spent / $Y monthly limit` data visible at claude.ai/settings/usage. Endpoint: `GET /api/organizations/{uuid}/overage_spend_limit`. Fetched in the same poll cycle as the existing `/usage` + `/prepaid/credits` endpoints; included in the POST body to `/api/usage/ingest` as `overageSpendLimit`. Requires Clauge v0.9.1+ on the desktop side to consume the new field.

## To package and submit

```bash
cd ~/Projects/clauge
zip -r clauge-sync-0.2.0.zip extension -x '*.DS_Store' -x 'extension/.*'
```

Then upload `clauge-sync-0.2.0.zip` at https://chrome.google.com/webstore/devconsole → Clauge Sync → "Package" → "Upload new package".

---

## Item

- **Item type:** Extension
- **ZIP file:** `clauge-sync-0.2.0.zip` (in `~/Projects/clauge/`)

## Store listing

### Name (max 45 chars)
```
Clauge Sync
```

### Short description (max 132 chars)
```
Auto-sync claude.ai plan usage (session, weekly, Sonnet, extra usage) to your local Clauge dashboard. Polls every minute.
```

### Detailed description (paste verbatim)
```
Clauge Sync feeds your claude.ai plan-usage statistics into your local Clauge dashboard so the meters always reflect reality without you having to refresh anything.

What it does
- Polls https://claude.ai/api/organizations/{your-org}/usage every minute (configurable)
- Posts the snapshot to your locally-running Clauge instance at http://localhost:3456 (configurable port)
- Updates the toolbar badge with your current 5-hour session utilization
- Click the toolbar icon for an immediate sync — opening the popup IS the sync trigger

Why it exists
claude.ai sits behind Cloudflare's bot challenge, so server-side fetch can't reach the API directly. The extension uses your already-authenticated claude.ai session in your browser, where Cloudflare lets the request through, and ferries the result to your local machine.

What it does NOT do
- Does not read or store your claude.ai cookie. The browser sends cookies automatically; the extension never touches them.
- Does not send your data anywhere except your own local machine (loopback address).
- No analytics. No telemetry. No third-party servers.
- Open source under the MIT license: https://github.com/clauding-lab/clauge

Install Clauge first
The extension is paired with the Clauge dashboard. Install it via:
  npx clauge

The dashboard runs locally on your own machine and reads your Claude Code session JSONL files from ~/.claude/projects/ to provide token analytics, model breakdown, cache savings, and subscription value calculations.

Privacy & permissions
- Reads claude.ai usage API (the same endpoint the claude.ai web UI calls for its own usage page).
- Posts only to http://localhost:* (your own machine).
- Stores only the port and polling interval in chrome.storage.local.

Privacy policy: https://github.com/clauding-lab/clauge/blob/main/docs/PRIVACY.md
Source code: https://github.com/clauding-lab/clauge
```

### Category
```
Developer Tools
```

### Language
```
English (United States)
```

---

## Graphic assets

| Slot | File path | Spec |
|---|---|---|
| Store icon (small) | `extension/icons/icon-128.png` | 128×128 PNG (already in zip) |
| Promotional tile (small) | `docs/cws-assets/promo-440x280.png` | 440×280 PNG |
| Screenshot 1 (dashboard) | `docs/cws-assets/screenshot-dashboard.png` | 1280×800 PNG |
| Screenshot 2 (popup) | `docs/cws-assets/screenshot-popup.png` | 1280×800 PNG |
| Screenshot 3 (gauges) | `docs/cws-assets/screenshot-gauges.png` | 1280×800 PNG |

(See the prep script for how to regenerate.)

---

## Privacy practices (the mandatory CWS questionnaire)

When the dev console asks "Why do you need this permission?" answer:

| Permission | Justification |
|---|---|
| `host_permissions: https://claude.ai/*` | Read the user's own plan-usage statistics from claude.ai's API. The data is read using the user's existing browser session and immediately forwarded to the user's own local Clauge instance — it never leaves the user's machine. |
| `host_permissions: http://localhost/*` and `http://127.0.0.1/*` | POST the usage snapshot to the user's locally-running Clauge dashboard. Loopback only. |
| `alarms` | Schedule the periodic sync (default 1 minute). |
| `storage` | Persist the user's configured local port and polling interval. |

### Single purpose statement
```
Auto-sync the user's claude.ai plan-usage statistics to their local Clauge analytics dashboard so the dashboard reflects current usage without manual refresh.
```

### Are you using remote code? `No`
(Everything is bundled in the zip. No `eval`, no remote scripts.)

### Data usage disclosures
- Personally identifiable information: **No**
- Health information: **No**
- Financial / payment information: **No**
- Authentication information: **No** (we never read the claude.ai cookie — the browser handles it)
- Personal communications: **No**
- Location: **No**
- Web history: **No**
- User activity: **No**
- Website content: **Yes** — usage statistics from claude.ai (aggregated counts, no message content). *Used to provide the extension's core functionality. Not sold or transferred. Not used for purposes unrelated to the extension.*

### Privacy policy URL
```
https://github.com/clauding-lab/clauge/blob/main/docs/PRIVACY.md
```

---

## Distribution

- **Visibility:** Public
- **Distribution regions:** All regions
- **Pricing:** Free

---

## Submit

Click **Submit for Review**. First-time review typically takes 1-3 days. You'll get an email when approved.

After approval, paste the listing URL (looks like `https://chromewebstore.google.com/detail/clauge-sync/<id>`) into me and I'll wire the dashboard's install button.
