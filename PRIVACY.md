# Clauge Privacy Policy

**Last updated:** 2026-06-06

Clauge is a free, read-only app for viewing your own Anthropic Claude Code and claude.ai usage, on **macOS** (a menu-bar utility, `com.clauding.clauge`) and **iPhone** (a companion app, `com.clauding.clauge.ios`). This document explains what data the apps touch, where it lives, and what network requests they make. Clauge is an independent, unofficial companion and is **not affiliated with, endorsed by, or sponsored by Anthropic.**

**Short version:** Clauge has no backend, no analytics, no telemetry, and no third-party data collection. Everything stays on your Mac. The only network requests Clauge makes are to Anthropic's own servers using your own credentials.

---

## What Clauge does NOT collect

- Clauge has **no server, no backend, no database**. There is nothing for Clauge to collect data into.
- **No analytics.** No third-party SDKs (Google Analytics, Sentry, Firebase, etc.) are included in the app.
- **No telemetry.** Clauge does not report crashes, usage, or any other signal to its developer.
- **No advertising identifiers.** Clauge does not request `IDFA`, does not use App Tracking Transparency, and does not share any data across apps or websites.
- **No tracking** as defined by Apple's App Tracking Transparency framework.

---

## What Clauge reads locally on your Mac

Clauge reads two categories of data, both of which are placed on your Mac by Anthropic's official Claude Code CLI:

1. **Your Claude Code OAuth token.** Stored by Anthropic's CLI in macOS Keychain Services under the service name `Claude Code-credentials` (Mac) or in `%USERPROFILE%\.claude\.credentials.json` (Windows). Clauge reads this token to authenticate API calls to `api.anthropic.com` on your behalf.
2. **Your per-session JSONL files** at `~/.claude/projects/*.jsonl` (Mac) or `%USERPROFILE%\.claude\projects\*.jsonl` (Windows). These files are written by Claude Code during normal use and contain prompt counts, model identifiers, and timing data. Clauge parses them locally to compute per-session and aggregate usage statistics.

On the Mac App Store version of Clauge (sandboxed):
- The Keychain read triggers a standard macOS prompt the first time, with "Always Allow / Allow / Deny" buttons. Clicking "Always Allow" persists the consent.
- Access to `~/.claude/` requires the user to grant the folder once via a folder picker during the first-launch wizard. The folder grant is persisted as a security-scoped bookmark inside Clauge's sandbox container.

---

## What Clauge writes locally on your Mac

- **Tauri store** at `~/Library/Application Support/com.clauding.clauge/` (DMG) or `~/Library/Containers/com.clauding.clauge/Data/Library/Application Support/com.clauding.clauge/` (MAS). Contains the user's app preferences, the security-scoped bookmark blob (MAS only), and a cached snapshot of the last successful API response.
- **macOS Keychain** entry `com.clauding.clauge.claude-ai-session` (DMG only). Stores the claude.ai session cookie captured when the user signs in via Clauge's in-app login flow. This feature is unavailable on the Mac App Store version; MAS users connect to claude.ai data via the Clauge Sync browser extension instead.

---

## What network requests Clauge makes

Clauge makes HTTPS requests to the following endpoints **only with the user's own credentials**:

1. **`api.anthropic.com/api/oauth/usage`** — Anthropic's official OAuth usage endpoint. Authenticated with the user's OAuth token read from local storage. Returns the user's plan tier, rate-limit bucket, and current period usage. Anthropic operates this endpoint and is the only party that sees this request.
2. **`claude.ai/api/.../usage`** (optional, opt-in) — claude.ai's web usage endpoint. Used only when the user has installed the Clauge Sync browser extension AND signed in to claude.ai, OR when the user has used Clauge's in-app claude.ai sign-in (DMG only). Authenticated with the user's claude.ai session cookie. claude.ai operates this endpoint.

**No request is ever sent to a server operated by Clauge or its developer.** Clauge has no such server.

---

## Clauge Sync browser extension

Clauge Sync is a separate, optional browser extension (published on the Chrome Web Store, Edge Add-ons, and Firefox Add-ons) that captures the user's claude.ai usage from the user's own claude.ai browser session and forwards it to the locally running Clauge app over `127.0.0.1:3456` loopback only. The extension does NOT send data to any external server. Its source is available at the same GitHub repository as Clauge.

---

## App permissions

| Permission | Why |
|---|---|
| **Network: Outbound HTTPS** | To call `api.anthropic.com` and `claude.ai` as described above |
| **Network: Local server (127.0.0.1:3456)** | To receive data from the Clauge Sync browser extension and to serve the dashboard webview |
| **macOS Keychain** (MAS: standard runtime prompt; DMG: implicit) | To read the Claude Code OAuth token Anthropic's CLI wrote |
| **`~/.claude/` folder access** (MAS: user-selected file entitlement via NSOpenPanel; DMG: implicit) | To read the per-session JSONL files Anthropic's CLI writes |
| **Notifications** | To notify the user of available updates (DMG only; the Mac App Store handles updates on MAS) |
| **Launch at Login** | Optional, user-toggleable. Lets Clauge start automatically at login so the menu bar icon is always present |

Clauge does NOT request the following permissions:
- `keychain-access-groups` (no cross-team Keychain access is requested; the runtime prompt is the user's consent)
- Camera, microphone, location, contacts, calendar, reminders, photos, full disk access, or any other personal-data entitlement

---

## Clauge for iPhone (iOS)

Clauge for iPhone (`com.clauding.clauge.ios`) is a free, read-only companion that shows your own Claude usage on your phone. It has the same privacy posture as the Mac app: **no backend, no analytics, no tracking, and no data collection.**

- **Sign-in.** You log in once to *your own* claude.ai account inside the app (email magic code or Sign in with Apple). The captured claude.ai session is stored in the **iOS Keychain**, on your device only, excluded from backups, and is used solely to fetch your own usage from claude.ai. It is never sent anywhere else — there is no Clauge server.
- **Analytics via iCloud.** If you also run Clauge for Mac under the same Apple ID, the Mac app publishes a small analytics summary into **your own private iCloud** (container `iCloud.com.clauding.clauge`, iCloud Documents). The iPhone app reads that file to mirror your analytics. It is a single-user private container — no public database, no cross-user access. The file contains only your own computed statistics (counts, costs, activity), never credentials or message content.
- **Network.** The iPhone app connects only to **claude.ai** (your own account) and **Apple iCloud** (your own storage). It has no other network destinations.
- **No tracking / no IDFA / no third-party SDKs.** The app's privacy manifest declares no tracking and no collected data types.
- **Sample preview.** A "Take a look with sample data" option lets you explore the app with clearly-labelled example data and requires no account; it transmits nothing.

App Store privacy label: **Data Not Collected.**

## Children's privacy

Clauge is intended for developers using Anthropic's Claude Code product. It is not directed at children under 13 and does not knowingly collect any data from children.

---

## Source code

Clauge is fully open source. All data-handling code can be inspected and verified at:

**https://github.com/clauding-lab/clauge**

If anything in this privacy policy is inconsistent with what the source code actually does, the source code is the authoritative description; please open a GitHub issue and we will correct the policy.

---

## Contact

For privacy questions or concerns:
- Open a GitHub issue: https://github.com/clauding-lab/clauge/issues
- Email: adnan_du@yahoo.com

---

## Changes to this policy

Material changes to this policy will be announced in the CHANGELOG and on the GitHub repository's Releases page. The `Last updated` date at the top of this file reflects the most recent revision.
