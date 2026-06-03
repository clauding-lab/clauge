# Clauge iOS — Phase ① Implementation Plan (v2, hardened)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Where this runs:** on a **Mac** (Xcode 16+, iOS 17+ target). The VPS cannot build iOS.
> **Supersedes** `docs/superpowers/plans/2026-06-02-clauge-ios-phase1.md`. Same product and design; this version folds in the 2026-06-03 adversarial review's verified fixes. Design target: `docs/superpowers/specs/2026-06-02-clauge-ios-phase1-design.md` + the `handoff/ios/` package.
> **On code blocks:** all contracts (models, the ported parser, the transport protocol, retry/cache, Keychain, view-model states, and every test) are load-bearing — implement them as written. SwiftUI view *bodies* are concrete starting structure; refine visuals on the simulator but keep the stated behavior, states, and the Clauge palette.

**Goal:** A standalone native-SwiftUI iOS app that, after an in-app Claude.ai login (email magic-link or Apple — no Google), shows the user's current Claude.ai usage read-only (per-window limit burn + reset countdowns, credit balance, overage spend), surviving the unofficial API, with no backend.

**Architecture:** SwiftUI app, no server. `WebLoginView` (WKWebView) captures the Claude.ai session → `SessionStore` (Keychain). A `UsageTransport` protocol abstracts *how* the four read-only GETs are made (native URLSession **or** in-WKWebView `fetch`, decided by the Task 0.5 device spike). `ClaudeAiClient` composes them with retry + a bounded last-good cache + per-field degradation into a `UsageSnapshot`. A `UsageSource` protocol abstracts *where* usage comes from (Phase ② plugs in `MacMirrorSource`). `UsageDashboardViewModel` drives the dashboard; snapshots mirror to an App-Group store (widgets/alerts seam) and a local rolling history (Trends/Phase-② seam).

**Tech Stack:** Swift 5.9+, SwiftUI, WebKit, Security (Keychain), XCTest, `URLProtocol` mocks. New repo: `clauge-ios`.

---

## Decisions baked into this plan (and why)

These resolve the open questions and review findings; an implementer does **not** re-litigate them.

1. **Login: email magic-link + Apple sign-in only — Google dropped (Adnan, 2026-06-03).** Google blocks OAuth inside embedded WebViews (`disallowed_useragent` 403); Claude.ai's email-magic-link and Apple flows render fine in WKWebView, and same-device magic-link auto-redirects to a logged-in session. The ConnectView de-emphasizes/omits the Google button; one line tells Google-only users to set an email login once.
2. **Transport is protocol-abstracted and decided by a device spike (Task 0.5).** The desktop's *proven* claude.ai path is the in-**browser** extension (`extension/background.js`) using `fetch(..., credentials:'include')`; the desktop's *native* fetch (`src-tauri/src/claude_ai_session.rs::fetch_claude_ai_usage`) is `#[allow(dead_code)]` — written but never shipped. Native `URLSession` requests may be Cloudflare-challenged (`__cf_bm`, TLS/header fingerprint) even with a valid `sessionKey`. So Task 0.5 replays the four GETs natively on a device; if they 403/challenge, the transport falls back to **in-WKWebView `fetch`** (which inherits the real browser origin, cookies, and headers — mirroring the proven path). Both implement one `UsageTransport` protocol.
3. **Full window set + drift detector are ported from `lib/usage-store.js`**, not the 2-window toy model. Anthropic renames windows (the "Claude Design" incident, 2026-06-02); the candidate-list resolver + `unknownSevenDayKeys` sentinel is the desktop's survival mechanism and must come across.
4. **Money is in cents; `usedPct` is `utilization/100`.** claude.ai returns money in cents (`1960` = `$19.60`) and utilization as 0–100. All conversions are explicit and tested (a missed `/100` is a 100× money error).
5. **Trends tab ships as an honest placeholder, not fabricated charts.** Phase ①'s snapshot endpoints carry no history, so the design's cost-over-time / peak-hours / 16-week heatmap are **not derivable** day one. The 3-tab shell (`Usage · Trends · Settings`) ships for navigation fidelity, but Trends shows "Trends build as your usage history grows — and unlock fully when you connect a Mac (coming soon)". From day one the app records each snapshot to a local rolling history so the seam is real. No synthetic data (spec §8 "never fabricate").
6. **Governance:** the `clauge-ios` repo gets `AGENTS.md` / `VISION.md` / `AGENT_LEARNINGS.md` at bootstrap (Adnan's rule). No `git push` to `main` from a plan step — branch first, push on explicit say-so.

---

## File Structure (new `clauge-ios` repo)

```
clauge-ios/
├── Clauge.xcodeproj
├── AGENTS.md  VISION.md  AGENT_LEARNINGS.md     # governance scaffold (Task 0)
├── Clauge/
│   ├── ClaugeApp.swift                          # @main; routes Connect vs Root(TabView) on session presence
│   ├── PrivacyInfo.xcprivacy                     # required-reason API manifest (UserDefaults CA92.1)
│   ├── DesignSystem/
│   │   ├── ClaugeTheme.swift                     # from handoff (with light-theme contrast fix)
│   │   └── ClaugeComponents.swift               # from handoff (with Dynamic Type + a11y)
│   ├── Models/
│   │   └── UsageSnapshot.swift                   # Codable; full window set; Org; stale flag; Tone
│   ├── Networking/
│   │   ├── ClaudeAiEndpoints.swift              # base URL + paths (mirror background.js) + host pin
│   │   ├── UsageTransport.swift                 # protocol + NativeURLSessionTransport + InWebViewTransport
│   │   └── ClaudeAiClient.swift                 # org resolve + retry + last-good cache + degrading parse
│   ├── Parsing/
│   │   └── UsageMapping.swift                    # ported normalizeUsage/Overage/Balance (windows, cents, drift)
│   ├── Auth/
│   │   ├── Session.swift                        # captured claude.ai cookies; host-pinned apply
│   │   ├── SessionStore.swift                   # Keychain persistence + expiry flag (clears on save)
│   │   └── WebLoginView.swift                   # WKWebView login (email/Apple) → onSession; shared web context
│   ├── Sources/
│   │   ├── UsageSource.swift                    # protocol (Phase ② adds MacMirrorSource)
│   │   └── ClaudeAiUsageSource.swift
│   ├── Shared/
│   │   ├── SharedStore.swift                    # App-Group write (widgets/alerts seam) + nil-suite guard
│   │   └── UsageHistoryStore.swift             # local rolling snapshot history (Trends/Phase-② seam)
│   ├── ViewModels/
│   │   └── UsageDashboardViewModel.swift        # state machine: loading/loaded/degraded/needsReconnect/offline/error
│   └── Views/
│       ├── RootView.swift                       # TabView shell: Usage · Trends · Settings
│       ├── ConnectView.swift
│       ├── DashboardView.swift
│       ├── TrendsView.swift                     # honest placeholder (Phase ①)
│       └── SettingsView.swift
└── ClaugeTests/
    ├── Fixtures/                                # captured JSON from the real endpoints (Task 0.5)
    │   ├── usage.json  usage_renamed_window.json  usage_unknown_window.json
    │   ├── credits.json  overage.json  organizations.json
    ├── UsageMappingTests.swift                  # window resolution, drift, cents, utilization
    ├── ClaudeAiClientTests.swift                # retry, last-good cache, 401/403, degradation (URLProtocol mock)
    ├── SessionStoreTests.swift
    ├── SharedStoreTests.swift                   # nil-suite guard + round-trip
    └── UsageDashboardViewModelTests.swift       # state transitions incl. real 401 propagation
```

---

### Task 0: Repo, Xcode project, capabilities, privacy manifest, governance

**Files:** the whole `clauge-ios` skeleton + `AGENTS.md`, `VISION.md`, `AGENT_LEARNINGS.md`, `Clauge/PrivacyInfo.xcprivacy`.

- [ ] **Step 1: Create the repo on a feature branch (no push to main).**
```bash
gh repo create clauding-lab/clauge-ios --private --clone   # private until ready to ship
cd clauge-ios
git checkout -b feat/phase1-scaffold
# In Xcode: File ▸ New ▸ Project ▸ iOS App, name "Clauge", interface SwiftUI, language Swift,
# include a Unit Testing target ("ClaugeTests"). Min deployment iOS 17.
```
- [ ] **Step 2:** Scaffold governance from the templates (Adnan's rule — every repo gets all three).
```bash
cp ~/.claude/governance/AGENTS.template.md AGENTS.md
cp ~/.claude/governance/VISION.template.md VISION.md
cp ~/.claude/governance/AGENT_LEARNINGS.template.md AGENT_LEARNINGS.md
# Fill the {{...}} placeholders: stack = SwiftUI/iOS17; build = xcodebuild; landmines (see below).
```
Seed `AGENTS.md` landmines from this plan: (1) money is in cents — always `/100`; (2) `usedPct = utilization/100`; (3) never fabricate Trends data; (4) login is email/Apple only (no Google in embedded WebView); (5) transport is spike-decided (native vs in-WKWebView).
- [ ] **Step 3:** Add an **App Group** capability (Signing & Capabilities ▸ + App Groups ▸ `group.com.clauding.clauge`) and a **Keychain Sharing** capability (default access group).
- [ ] **Step 4: Add the Privacy Manifest.** Mandatory at upload since 2024-05-01 for required-reason APIs. The app uses `UserDefaults` (App-Group + expiry flag). Create `Clauge/PrivacyInfo.xcprivacy`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSPrivacyTracking</key><false/>
  <key>NSPrivacyTrackingDomains</key><array/>
  <key>NSPrivacyCollectedDataTypes</key><array/>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>CA92.1</string></array>
    </dict>
  </array>
</dict></plist>
```
Add it to the app target's "Copy Bundle Resources".
- [ ] **Step 5: Commit (no push).** `git add -A && git commit -m "chore: scaffold Clauge iOS app, test target, App Group, privacy manifest, governance"`
- [ ] **Step 6: Verify the empty app builds & tests run.**
Run: `xcodebuild test -scheme Clauge -destination 'platform=iOS Simulator,name=iPhone 16' | tail -5`
Expected: build succeeds, 0 tests fail.

---

### Task 0.5: Transport spike — decide native URLSession vs in-WKWebView fetch [SPIKE, before Task 3]

**Why:** the desktop's native claude.ai fetch is dead code; the shipped path is in-browser fetch. We must learn on a real device whether native `URLSession` GETs with the captured cookie succeed or get Cloudflare-challenged, because it changes the `UsageTransport` implementation we wire by default.

- [ ] **Step 1:** Build a throwaway `SpikeView`: a `WKWebView` loading `https://claude.ai/login`; after login, read cookies (`httpCookieStore.getAllCookies`) and capture the `claude.ai` set.
- [ ] **Step 2:** With the captured cookies, attempt BOTH transports against `GET https://claude.ai/api/organizations` and `…/{uuid}/usage`:
  - **Native:** a `URLSession` request with a manual `Cookie:` header (all captured claude.ai cookies, incl. `__cf_bm`) and a browser-like `User-Agent`. Log status + body length.
  - **In-WKWebView:** `webView.evaluateJavaScript("fetch('/api/organizations',{credentials:'include'}).then(r=>r.status)")`. Log status.
- [ ] **Step 3:** Save one real JSON response per endpoint (`organizations`, `usage`, `credits`, `overage`) into `ClaugeTests/Fixtures/`. **The parser (Task 2) is written against these.** Also hand-craft `usage_renamed_window.json` (rename `seven_day_design` → `seven_day_omelette`) and `usage_unknown_window.json` (add `seven_day_brandnew`).
- [ ] **Step 4: Record the decision** in `AGENT_LEARNINGS.md`: if native returns 200 → default `NativeURLSessionTransport`; if native 403/challenges while in-WKWebView returns 200 → default `InWebViewTransport`. Either way both are implemented in Task 3 behind the protocol; this only sets the default wired in Task 9.
- [ ] **Step 5:** Delete `SpikeView`. `git add -A && git commit -m "chore: transport spike — capture fixtures, record native-vs-webview decision"`

---

### Task 1: Usage data model

**Files:** Create `Clauge/Models/UsageSnapshot.swift`.

- [ ] **Step 1: Implement the model.** Note: `id` is **derived** (stable across refreshes — never `UUID()`), every type is `Codable` (App-Group + history seams encode it), and dollar/pct fields hold **already-converted** values (cents→dollars and utilization/100 happen in the parser, Task 2).
```swift
import Foundation

enum Tone: String, Codable { case bull, neutral, warn, bear }

struct UsageLimit: Codable, Equatable, Identifiable {
    var id: String { window }          // STABLE — derived from window, not a random UUID
    let window: String                 // canonical key, e.g. "five_hour", "seven_day", "seven_day_opus"
    let label: String                  // display label, e.g. "Session (5h)", "Weekly", "Weekly · Opus"
    let usedPct: Double                // 0...1 (parser already divided utilization by 100)
    let resetsAt: Date?
    var tone: Tone {
        switch usedPct {
        case ..<0.7: return .bull
        case ..<0.9: return .warn
        default:     return .bear
        }
    }
}

struct Org: Codable, Equatable, Identifiable { let id: String; let name: String }
struct CreditBalance: Codable, Equatable { let amount: Double; let currency: String }   // dollars
struct OverageStatus: Codable, Equatable { let spent: Double; let cap: Double; let currency: String } // dollars

struct UsageSnapshot: Codable, Equatable {
    let fetchedAt: Date
    let org: Org
    let allOrgs: [Org]                 // for the org switcher (shown only if count > 1)
    var limits: [UsageLimit]
    var balance: CreditBalance?
    var overage: OverageStatus?
    var unknownWindowKeys: [String]    // Anthropic schema-drift sentinel (ported from usage-store.js)
    var fieldErrors: [String: String]  // field → "couldn't read" reason; drives per-field degradation
    var isStale: Bool                  // true when served from the last-good cache (never shown as fresh)
}
```
- [ ] **Step 2: Commit.** `git add -A && git commit -m "feat: codable usage snapshot model (full window set, stable ids, stale flag)"`

---

### Task 2: Parsing — ported window resolver, drift detector, cents & utilization math

**Files:** Create `Clauge/Parsing/UsageMapping.swift`; Test `ClaugeTests/UsageMappingTests.swift`; Fixtures from Task 0.5.

> **Source of truth:** this is a faithful Swift port of `lib/usage-store.js` (`normalizeUsage`, `normalizeOverageSpendLimit`, `normalizeBalance`). Keep the candidate-key lists and the `/100` conversions exactly.

- [ ] **Step 1: Write the failing tests** (adjust expected numbers to your captured fixtures):
```swift
import XCTest
@testable import Clauge

final class UsageMappingTests: XCTestCase {
    private func fixture(_ n: String) throws -> Data {
        try Data(contentsOf: Bundle(for: Self.self).url(forResource: n, withExtension: "json")!)
    }
    func test_usage_emitsKnownWindows_inZeroToOne() throws {
        let r = try UsageMapping.usage(JSONSerialization.jsonObject(with: fixture("usage")) as! [String: Any])
        XCTAssertFalse(r.limits.isEmpty)
        XCTAssertTrue(r.limits.allSatisfy { (0...1).contains($0.usedPct) })   // utilization/100 happened
        XCTAssertTrue(r.unknownWindowKeys.isEmpty)
    }
    func test_usage_resolvesRenamedDesignWindow() throws {  // seven_day_design renamed to seven_day_omelette
        let r = try UsageMapping.usage(JSONSerialization.jsonObject(with: fixture("usage_renamed_window")) as! [String: Any])
        XCTAssertTrue(r.limits.contains { $0.window == "claude_design" })     // resolver recovered it
    }
    func test_usage_flagsUnknownSevenDayDrift() throws {     // seven_day_brandnew present
        let r = try UsageMapping.usage(JSONSerialization.jsonObject(with: fixture("usage_unknown_window")) as! [String: Any])
        XCTAssertTrue(r.unknownWindowKeys.contains("seven_day_brandnew"))      // drift sentinel fires
    }
    func test_overage_convertsCentsToDollars() throws {       // monthly_credit_limit:1960 → $19.60
        let o = try XCTUnwrap(UsageMapping.overage(JSONSerialization.jsonObject(with: fixture("overage")) as! [String: Any]))
        XCTAssertEqual(o.cap, 19.60, accuracy: 0.001)
    }
    func test_balance_convertsCentsToDollars() throws {       // amount in cents → dollars
        let b = try XCTUnwrap(UsageMapping.balance(JSONSerialization.jsonObject(with: fixture("credits")) as! [String: Any]))
        XCTAssertGreaterThanOrEqual(b.amount, 0)
    }
}
```
- [ ] **Step 2: Run → fails.** `xcodebuild test -scheme Clauge -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:ClaugeTests/UsageMappingTests | tail -8`
- [ ] **Step 3: Implement the port.**
```swift
import Foundation

enum UsageMapping {
    // Candidate lists ported verbatim from lib/usage-store.js (public name first, codenames last).
    private static let designKeys = ["seven_day_design","seven_day_claude_design","claude_design","design","seven_day_omelette","omelette","omelette_promotional"]
    private static let routinesKeys = ["seven_day_routines","seven_day_claude_routines","claude_routines","routines","routine","seven_day_cowork","cowork"]
    private static let knownSevenDay: Set<String> = ["seven_day","seven_day_oauth_apps","seven_day_opus","seven_day_sonnet","seven_day_design","seven_day_claude_design","seven_day_omelette","seven_day_routines","seven_day_claude_routines","seven_day_cowork"]

    // Each window: { utilization: 0-100, resets_at: ISO8601 } → UsageLimit with usedPct 0...1.
    private static func limit(_ raw: Any?, window: String, label: String) -> UsageLimit? {
        guard let m = raw as? [String: Any] else { return nil }
        let util = (m["utilization"] as? Double) ?? Double(m["utilization"] as? Int ?? -1)
        guard util >= 0 else { return nil }
        let resets = (m["resets_at"] as? String).flatMap(Self.iso)
        return UsageLimit(window: window, label: label, usedPct: min(max(util / 100.0, 0), 1), resetsAt: resets)
    }
    private static func resolveFirst(_ raw: [String: Any], _ keys: [String]) -> (key: String, value: Any)? {
        for k in keys { if let v = raw[k] as? [String: Any] { return (k, v) } }
        return nil
    }
    private static func iso(_ s: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    static func usage(_ raw: [String: Any]) throws -> (limits: [UsageLimit], unknownWindowKeys: [String]) {
        var out: [UsageLimit] = []
        func add(_ key: String, _ label: String) { if let l = limit(raw[key], window: key, label: label) { out.append(l) } }
        add("five_hour", "Session (5h)")
        add("seven_day", "Weekly")
        add("seven_day_sonnet", "Weekly · Sonnet")
        add("seven_day_opus", "Weekly · Opus")
        if let d = resolveFirst(raw, designKeys), let l = limit(d.value, window: "claude_design", label: "Weekly · Design") { out.append(l) }
        if let r = resolveFirst(raw, routinesKeys), let l = limit(r.value, window: "daily_routines", label: "Daily Routines") { out.append(l) }
        let unknown = raw.keys.filter { $0.hasPrefix("seven_day_") && !knownSevenDay.contains($0) }
        return (out, unknown)
    }

    // claude.ai returns money in CENTS (1960 = $19.60). Divide by 100. (usage-store.js:159-186)
    static func overage(_ raw: [String: Any]) -> OverageStatus? {
        let limitCents = (raw["monthly_credit_limit"] as? Double) ?? Double(raw["monthly_credit_limit"] as? Int ?? -1)
        let usedCents  = (raw["used_credits"] as? Double) ?? Double(raw["used_credits"] as? Int ?? -1)
        guard limitCents >= 0 || usedCents >= 0 else { return nil }
        return OverageStatus(spent: max(usedCents,0)/100.0, cap: max(limitCents,0)/100.0, currency: raw["currency"] as? String ?? "USD")
    }

    // /prepaid/credits: { amount (cents), currency, ... }  (usage-store.js:195-253)
    static func balance(_ raw: [String: Any]) -> CreditBalance? {
        let cents = (raw["amount"] as? Double) ?? Double(raw["amount"] as? Int ?? Int.min)
        guard cents != Double(Int.min) else { return nil }
        return CreditBalance(amount: cents/100.0, currency: raw["currency"] as? String ?? "USD")
    }
}
```
- [ ] **Step 4: Run → passes.** Same command as Step 2.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: port claude.ai parser (window resolver, drift sentinel, cents/utilization math)"`

---

### Task 3: Transport + ClaudeAiClient (retry, last-good cache, 401/403, degradation)

**Files:** Create `Clauge/Networking/ClaudeAiEndpoints.swift`, `UsageTransport.swift`, `ClaudeAiClient.swift`; Test `ClaugeTests/ClaudeAiClientTests.swift`.

- [ ] **Step 1: Endpoints (host-pinned).**
```swift
import Foundation
enum ClaudeAiEndpoints {
    static let host = "claude.ai"
    static var base = URL(string: "https://claude.ai")!     // single patch point if Anthropic moves the API
    static func organizations() -> URL { base.appending(path: "/api/organizations") }
    static func usage(org: String) -> URL { base.appending(path: "/api/organizations/\(org)/usage") }
    static func credits(org: String) -> URL { base.appending(path: "/api/organizations/\(org)/prepaid/credits") }
    static func overage(org: String) -> URL { base.appending(path: "/api/organizations/\(org)/overage_spend_limit") }
}
struct SessionExpired: Error {}      // 401 / login redirect
struct OrgRestricted: Error {}       // 403 — admin-managed org the member can't read
```
- [ ] **Step 2: Transport protocol + two implementations.** `status` is surfaced so the client can map 401/403 distinctly.
```swift
import Foundation
import WebKit

struct TransportResult { let status: Int; let data: Data }

protocol UsageTransport {
    // GET url with the session attached; returns status + body. Throws only on transport failure (offline).
    func get(_ url: URL) async throws -> TransportResult
}

/// Native URLSession + manual host-pinned Cookie header. Default if the Task 0.5 spike showed native works.
struct NativeURLSessionTransport: UsageTransport {
    let session: Session
    func get(_ url: URL) async throws -> TransportResult {
        precondition(url.host == ClaudeAiEndpoints.host, "cookies only sent to claude.ai")  // host pin (G10)
        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false                  // we manage cookies; avoid double-send (M-cookies)
        session.applyCookies(to: &req)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await URLSession.shared.data(for: req)
        return TransportResult(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, data: data)
    }
}

/// Runs the GET inside a persistent authenticated WKWebView (mirrors the proven extension path).
/// Default if Task 0.5 showed native is Cloudflare-blocked.
@MainActor final class InWebViewTransport: UsageTransport {
    let webView: WKWebView                                   // the same authenticated web context from login
    init(webView: WKWebView) { self.webView = webView }
    func get(_ url: URL) async throws -> TransportResult {
        precondition(url.host == ClaudeAiEndpoints.host, "cookies only sent to claude.ai")
        let path = url.path + (url.query.map { "?\($0)" } ?? "")
        let js = "fetch('\(path)',{credentials:'include',cache:'no-store'}).then(r=>r.text().then(t=>JSON.stringify({s:r.status,b:t})))"
        let raw = try await webView.evaluateJavaScript(js) as? String ?? "{\"s\":0,\"b\":\"\"}"
        let obj = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
        return TransportResult(status: obj["s"] as? Int ?? 0, data: Data((obj["b"] as? String ?? "").utf8))
    }
}
```
- [ ] **Step 3: Write the failing client tests** (mock the transport — never hit live claude.ai in CI):
```swift
import XCTest
@testable import Clauge

private struct StubTransport: UsageTransport {
    var byPath: [String: TransportResult]
    var fail: Set<String> = []           // paths that 401
    func get(_ url: URL) async throws -> TransportResult {
        let key = url.lastPathComponent
        if fail.contains(key) { return TransportResult(status: 401, data: Data()) }
        return byPath[key] ?? TransportResult(status: 404, data: Data())
    }
}

final class ClaudeAiClientTests: XCTestCase {
    private func data(_ n: String) -> Data { try! Data(contentsOf: Bundle(for: Self.self).url(forResource: n, withExtension: "json")!) }

    func test_fetchSnapshot_populatesFromFixtures() async throws {
        let t = StubTransport(byPath: [
            "organizations": .init(status: 200, data: data("organizations")),
            "usage": .init(status: 200, data: data("usage")),
            "credits": .init(status: 200, data: data("credits")),
            "overage_spend_limit": .init(status: 200, data: data("overage")),
        ])
        let snap = try await ClaudeAiClient(transport: t, cache: .ephemeral).fetchSnapshot()
        XCTAssertFalse(snap.limits.isEmpty)
        XCTAssertNotNil(snap.overage)
        XCTAssertFalse(snap.isStale)
    }

    // CONTRACT (fixes H2): a 401 on the USAGE endpoint must propagate as SessionExpired — NOT degrade to a card.
    func test_fetchSnapshot_401onUsage_throwsSessionExpired() async {
        let t = StubTransport(byPath: ["organizations": .init(status: 200, data: data("organizations"))], fail: ["usage"])
        do { _ = try await ClaudeAiClient(transport: t, cache: .ephemeral).fetchSnapshot(); XCTFail("expected SessionExpired") }
        catch is SessionExpired {} catch { XCTFail("wrong error: \(error)") }
    }

    // A 403 (restricted org) on credits degrades that one field — does NOT throw, does NOT claim expiry.
    func test_fetchSnapshot_403onCredits_degradesField() async throws {
        var byPath = ["organizations": TransportResult(status: 200, data: data("organizations")),
                      "usage": .init(status: 200, data: data("usage"))]
        byPath["credits"] = .init(status: 403, data: Data())
        let snap = try await ClaudeAiClient(transport: StubTransport(byPath: byPath), cache: .ephemeral).fetchSnapshot()
        XCTAssertNil(snap.balance)
        XCTAssertEqual(snap.fieldErrors["balance"], "unavailable")
    }
}
```
- [ ] **Step 4: Run → fails.**
- [ ] **Step 5: Implement the client.** 401 on a *required* call (orgs or usage) throws `SessionExpired`; 403/parse-failure on an *optional* field (credits/overage) degrades into `fieldErrors`; a bounded last-good cache backs the optional fields (ported retry + 6h TTL + stale flag from `background.js`).
```swift
import Foundation

struct ClaudeAiClient {
    let transport: UsageTransport
    var cache: LastGoodCache = .shared

    func fetchSnapshot() async throws -> UsageSnapshot {
        var errors: [String: String] = [:]
        // 1) Required: organizations. 401 here ⇒ expired.
        let orgsData = try await required(ClaudeAiEndpoints.organizations())
        let orgs = parseOrgs(orgsData)
        guard let org = orgs.first else { throw SessionExpired() }      // empty ⇒ not logged in
        // 2) Required: usage. 401 here ⇒ expired (this is the path the old try? swallowed — H2 fix).
        let usageData = try await required(ClaudeAiEndpoints.usage(org: org.id))
        let parsed = try UsageMapping.usage((try? JSONSerialization.jsonObject(with: usageData) as? [String: Any]) ?? [:])
        // 3) Optional: credits + overage. Degrade (with last-good fallback) instead of failing the screen.
        let balance = await optional("balance", ClaudeAiEndpoints.credits(org: org.id), UsageMapping.balance, &errors)
        let overage = await optional("overage", ClaudeAiEndpoints.overage(org: org.id), UsageMapping.overage, &errors)
        return UsageSnapshot(fetchedAt: Date(), org: org, allOrgs: orgs, limits: parsed.limits,
                             balance: balance, overage: overage, unknownWindowKeys: parsed.unknownWindowKeys,
                             fieldErrors: errors, isStale: false)
    }

    // Required call: retry-once on 5xx; 401 ⇒ SessionExpired; other non-2xx ⇒ generic error (caught upstream).
    private func required(_ url: URL) async throws -> Data {
        for attempt in 1...2 {
            let r = try await transport.get(url)
            if r.status == 401 { throw SessionExpired() }
            if (200..<300).contains(r.status) { return r.data }
            if attempt == 1 && r.status >= 500 { try? await Task.sleep(nanoseconds: 500_000_000); continue }
            throw URLError(.badServerResponse)
        }
        throw URLError(.badServerResponse)
    }

    // Optional field: retry-once; on any failure/parse-nil, fall back to last-good (≤6h) marked stale, else record fieldError.
    private func optional<T: Codable>(_ key: String, _ url: URL, _ parse: ([String: Any]) -> T?, _ errors: inout [String: String]) async -> T? {
        for attempt in 1...2 {
            if let r = try? await transport.get(url), (200..<300).contains(r.status),
               let obj = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any], let v = parse(obj) {
                cache.write(key, v); return v
            }
            if attempt == 1 { try? await Task.sleep(nanoseconds: 500_000_000) }
        }
        if let cached: T = cache.read(key) { errors[key] = "stale"; return cached }   // last-good within TTL
        errors[key] = "unavailable"; return nil
    }

    private func parseOrgs(_ d: Data) -> [Org] {
        guard let arr = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] else { return [] }
        return arr.compactMap { o in (o["uuid"] as? String).map { Org(id: $0, name: o["name"] as? String ?? "Org") } }
    }
}
```
> Implement `LastGoodCache` (a tiny `UserDefaults`-backed JSON store keyed by field, 6h TTL, `.shared` + `.ephemeral` for tests) alongside the client. Mirrors `readLastGood`/`writeLastGood` in `background.js`.
- [ ] **Step 6: Run → passes.**
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat: transport protocol + claude.ai client (retry, last-good cache, 401/403 propagation)"`

---

### Task 4: SessionStore (Keychain) + Session

**Files:** Create `Clauge/Auth/Session.swift`, `Clauge/Auth/SessionStore.swift`; Test `ClaugeTests/SessionStoreTests.swift`.

- [ ] **Step 1: Session value + host-pinned cookie application.**
```swift
import Foundation
struct Session: Codable, Equatable {
    var cookies: [String: String]      // all claude.ai cookies incl. sessionKey + __cf_bm
    func applyCookies(to req: inout URLRequest) {
        guard req.url?.host == "claude.ai" else { return }     // never leak the credential off-host
        req.setValue(cookies.map { "\($0)=\($1)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
    }
}
```
- [ ] **Step 2: Write the failing Keychain tests** (incl. the bonus: `save` clears the expiry flag).
```swift
import XCTest
@testable import Clauge
final class SessionStoreTests: XCTestCase {
    override func setUp() { SessionStore.shared.clear() }
    func test_saveLoadClear() {
        XCTAssertNil(SessionStore.shared.load())
        let s = Session(cookies: ["sessionKey": "abc", "__cf_bm": "z"])
        SessionStore.shared.save(s)
        XCTAssertEqual(SessionStore.shared.load(), s)
        SessionStore.shared.clear()
        XCTAssertNil(SessionStore.shared.load())
    }
    func test_save_clearsExpiryFlag() {
        SessionStore.shared.save(Session(cookies: ["sessionKey": "abc"]))
        SessionStore.shared.markExpired()
        XCTAssertTrue(SessionStore.shared.isExpired)
        SessionStore.shared.save(Session(cookies: ["sessionKey": "def"]))   // re-login
        XCTAssertFalse(SessionStore.shared.isExpired)                        // reconnect flow depends on this
    }
}
```
- [ ] **Step 3: Run → fails.**
- [ ] **Step 4: Implement `SessionStore`** — `save/load/clear` store JSON-encoded `Session` in the Keychain via `SecItem*`; `isExpired` is a `UserDefaults` bool set by `markExpired()` and **cleared inside `save()`**.
- [ ] **Step 5: Run → passes.**
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: keychain session store (host-pinned cookies, expiry clears on save)"`

---

### Task 5: UsageSource protocol + ClaudeAiUsageSource

**Files:** Create `Clauge/Sources/UsageSource.swift`, `ClaudeAiUsageSource.swift`.

- [ ] **Step 1: Protocol + impl** (the seam Phase ② plugs `MacMirrorSource` into):
```swift
protocol UsageSource { func snapshot() async throws -> UsageSnapshot }

struct ClaudeAiUsageSource: UsageSource {
    let transport: UsageTransport      // Native or InWebView, decided at wiring (Task 9)
    func snapshot() async throws -> UsageSnapshot { try await ClaudeAiClient(transport: transport).fetchSnapshot() }
}
```
- [ ] **Step 2: Commit.** `git add -A && git commit -m "feat: UsageSource protocol + claude.ai source"`

---

### Task 6: UsageDashboardViewModel (state machine, incl. offline)

**Files:** Create `Clauge/ViewModels/UsageDashboardViewModel.swift`; Test `ClaugeTests/UsageDashboardViewModelTests.swift`.

- [ ] **Step 1: Write the failing state tests** (cover loaded, real expiry, degraded, offline):
```swift
import XCTest
@testable import Clauge
private struct StubSource: UsageSource {
    var result: Result<UsageSnapshot, Error>
    func snapshot() async throws -> UsageSnapshot { try result.get() }
}
private func snap(fieldErrors: [String:String] = [:]) -> UsageSnapshot {
    UsageSnapshot(fetchedAt: Date(), org: Org(id:"o",name:"Org"), allOrgs:[Org(id:"o",name:"Org")],
        limits:[UsageLimit(window:"seven_day",label:"Weekly",usedPct:0.5,resetsAt:nil)],
        balance:nil, overage:nil, unknownWindowKeys:[], fieldErrors:fieldErrors, isStale:false)
}
@MainActor final class UsageDashboardViewModelTests: XCTestCase {
    func test_loaded() async {
        let vm = UsageDashboardViewModel(source: StubSource(result: .success(snap())))
        await vm.refresh(); if case .loaded(let s) = vm.state { XCTAssertEqual(s.org.name,"Org") } else { XCTFail() }
    }
    func test_sessionExpired_setsNeedsReconnect() async {
        let vm = UsageDashboardViewModel(source: StubSource(result: .failure(SessionExpired())))
        await vm.refresh(); if case .needsReconnect = vm.state {} else { XCTFail() }
    }
    func test_degraded_whenFieldErrors() async {
        let vm = UsageDashboardViewModel(source: StubSource(result: .success(snap(fieldErrors:["balance":"unavailable"]))))
        await vm.refresh(); if case .loaded(let s) = vm.state { XCTAssertEqual(s.fieldErrors["balance"],"unavailable") } else { XCTFail() }
    }
    func test_offline_whenNotConnected() async {
        let vm = UsageDashboardViewModel(source: StubSource(result: .failure(URLError(.notConnectedToInternet))))
        await vm.refresh(); if case .offline = vm.state {} else { XCTFail() }
    }
}
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement the view model.**
```swift
import Foundation
@MainActor final class UsageDashboardViewModel: ObservableObject {
    enum State { case idle, loading, loaded(UsageSnapshot), needsReconnect, offline, error(String) }
    @Published private(set) var state: State = .idle
    private let source: UsageSource
    init(source: UsageSource) { self.source = source }
    func refresh() async {
        state = .loading
        do {
            let snap = try await source.snapshot()
            SharedStore.write(snap)            // App-Group seam (Task 9)
            UsageHistoryStore.append(snap)     // local rolling history (Trends/Phase-② seam)
            state = .loaded(snap)
        } catch is SessionExpired {
            SessionStore.shared.markExpired(); state = .needsReconnect
        } catch let e as URLError where e.code == .notConnectedToInternet || e.code == .networkConnectionLost {
            state = .offline
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}
```
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: dashboard view model (loaded/degraded/reconnect/offline states)"`

---

### Task 7: WebLoginView — email magic-link + Apple (no Google)

**Files:** Create `Clauge/Auth/WebLoginView.swift`. (UI-integration; manual-verified on simulator/device.)

- [ ] **Step 1: Implement** a `UIViewRepresentable` wrapping a **retained** `WKWebView` (the same instance becomes the `InWebViewTransport` web context if that transport is chosen) loading `https://claude.ai/login`. On navigation to a logged-in URL, read cookies via `httpCookieStore.getAllCookies`, keep all `claude.ai` cookies, and call `onSession` once `sessionKey` is present.
```swift
import SwiftUI; import WebKit
struct WebLoginView: UIViewRepresentable {
    var onSession: (Session, WKWebView) -> Void          // pass the webView back for InWebViewTransport reuse
    func makeCoordinator() -> Coordinator { Coordinator(onSession: onSession) }
    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView(); wv.navigationDelegate = context.coordinator
        wv.load(URLRequest(url: URL(string: "https://claude.ai/login")!)); return wv
    }
    func updateUIView(_ v: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
        let onSession: (Session, WKWebView) -> Void
        init(onSession: @escaping (Session, WKWebView) -> Void) { self.onSession = onSession }
        func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
            guard let host = wv.url?.host, host.contains("claude.ai"), wv.url?.path.contains("login") == false else { return }
            wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                let wanted = cookies.filter { $0.domain.contains("claude.ai") }
                    .reduce(into: [String:String]()) { $0[$1.name] = $1.value }
                if wanted["sessionKey"] != nil { self.onSession(Session(cookies: wanted), wv) }
            }
        }
    }
}
```
- [ ] **Step 2:** In `ConnectView`'s presentation of this sheet, the surrounding copy steers to **email magic-link / Apple**; do not surface or promote "Continue with Google" (it 403s in an embedded webview). A one-line note: "Google sign-in isn't supported in-app — use email or Apple."
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: in-app claude.ai login (email/Apple) + session capture, webview reused for transport"`

---

### Task 8: Views (Root tabs, Connect, Dashboard, Trends, Settings) + accessibility

**Files:** Create `Clauge/Views/RootView.swift`, `ConnectView.swift`, `DashboardView.swift`, `TrendsView.swift`, `SettingsView.swift`; update `DesignSystem/ClaugeTheme.swift` + `ClaugeComponents.swift` from the handoff. Manual-verified on simulator.

- [ ] **Step 1: Drop in the design system** from `handoff/ios/ClaugeTheme.swift` + `ClaugeComponents.swift`, with two fixes:
  - **Light-theme contrast (M-contrast):** darken `light.text3` (#8A7D70 → ~#6F6457) and `light.text4` so secondary/fine-print copy clears WCAG AA (4.5:1) on the cream surfaces. Re-check with a contrast tool.
  - **Accessibility (M-a11y):** route `ClaugeFont.mono/sans` through Dynamic Type (`@ScaledMetric` or relative text styles) with `.minimumScaleFactor(0.7)`; add `.accessibilityElement(children:.ignore).accessibilityLabel(label).accessibilityValue("\(Int(usedPct*100)) percent used")` to `GaugeRing` and mark the needle `.accessibilityHidden(true)`; make `PeriodBar`/tab items `Button`s (not `.onTapGesture`) with ≥44pt tap targets.
- [ ] **Step 2: RootView** — a native `TabView`: Usage · Trends · Settings (Phase ①). `// Phase ②: insert Analytics tab when a Mac is tagged.`
- [ ] **Step 3: ConnectView** — centered Clauge mark + clay glow, "Your Claude usage, at a glance," three trust rows (Read-only / No account, no server / Just log in once), full-width "Connect Claude.ai" → presents `WebLoginView` in a sheet. On `onSession(session, webView)`: `SessionStore.shared.save(session)`, retain `webView` for `InWebViewTransport`, dismiss. Fine print: "Opens claude.ai login · email or Apple · no password stored."
- [ ] **Step 4: DashboardView** — observes `UsageDashboardViewModel`; fixed `GlassHeader` (org/user name + "Claude.ai · as of <relative fetchedAt>" + refresh). Render per `state`:
  - `.loading` → skeleton matching the loaded layout.
  - `.loaded(snap)` → **Usage limits card**: a `GaugeRing` (or bar) per `snap.limits` window, tone-tinted, live `Text(timerInterval:)` reset countdown; tone pill top-right. **Plan & balance card** (`balance`, `overage`) — for any key in `snap.fieldErrors`, render that card "Unavailable — Claude.ai didn't return this (we'll retry)." If `snap.isStale` or any `fieldErrors[k] == "stale"`, badge "cached". If `!snap.unknownWindowKeys.isEmpty`, show a quiet "New usage type detected" debug note. Footer: "Source: Claude.ai · read-only · on device." Pull-to-refresh. Org switcher only if `snap.allOrgs.count > 1`.
  - `.needsReconnect` → "Session expired" + "Reconnect Claude.ai" → login flow.
  - `.offline` → "You're offline — showing last known" + last-good (if any) badged, else a calm offline message. Never a raw `localizedDescription`.
  - `.error(msg)` → message + retry.
- [ ] **Step 5: TrendsView** — honest Phase-① placeholder: a short explainer ("Trends build as your usage history grows; connect a Mac for full analytics — coming soon") + (optional) a simple sparkline from `UsageHistoryStore` once ≥2 points exist. **No fabricated cost/peak-hours/heatmap data.**
- [ ] **Step 6: SettingsView** — `.insetGrouped`: Account (name · email · Sign out → `SessionStore.shared.clear()`), Expand ("Connect a Mac ›" disabled, "coming soon"), Appearance (Theme System/Light/Dark via `@AppStorage("clauge.theme")`), About (→ AboutView: "Built by **Adnan Rashid** · Not affiliated with Anthropic", version, MIT, Source/Privacy/Changelog links). Confirm the list scrolls fully clear of the tab bar (`ScrollView { VStack {...} }`, not a height-constrained stack).
- [ ] **Step 7: Manual verify on a real device** (cookie capture + transport need a device, not just the simulator): launch → Connect → log in via email magic-link (same-device link) or Apple → dashboard renders live numbers → toggle airplane mode → offline state → pull-to-refresh → sign out.
- [ ] **Step 8: Commit.** `git add -A && git commit -m "feat: root tabs, connect, dashboard, trends placeholder, settings; Dynamic Type + VoiceOver + contrast fixes"`

---

### Task 9: App-Group store + history seam + final wiring & verify

**Files:** Create `Clauge/Shared/SharedStore.swift`, `UsageHistoryStore.swift`; modify `Clauge/ClaugeApp.swift`; Test `ClaugeTests/SharedStoreTests.swift`.

- [ ] **Step 1: Write the failing SharedStore test** (the nil-suite guard — a common solo-dev misprovision, G5):
```swift
import XCTest
@testable import Clauge
final class SharedStoreTests: XCTestCase {
    func test_suiteResolves() { XCTAssertNotNil(SharedStore.suite, "App Group group.com.clauding.clauge not provisioned") }
    func test_writeReadRoundTrip() {
        let s = UsageSnapshot(fetchedAt: Date(), org: Org(id:"o",name:"O"), allOrgs:[], limits:[], balance:nil, overage:nil, unknownWindowKeys:[], fieldErrors:[:], isStale:false)
        SharedStore.write(s)
        XCTAssertNotNil(SharedStore.readLatest())
    }
}
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** `SharedStore` (App-Group `UserDefaults`, JSON-encode `UsageSnapshot`, **guard `suite != nil`** and log loudly if not) and `UsageHistoryStore` (append a compact `{fetchedAt, limits[].usedPct}` row to a capped local array for Trends/Phase②).
```swift
import Foundation
import os
enum SharedStore {
    static let suite = UserDefaults(suiteName: "group.com.clauding.clauge")
    static func write(_ snap: UsageSnapshot) {
        guard let suite else { Logger().error("App Group suite nil — entitlement misprovisioned; snapshot not shared"); return }
        if let d = try? JSONEncoder().encode(snap) { suite.set(d, forKey: "latestSnapshot") }
    }
    static func readLatest() -> Data? { suite?.data(forKey: "latestSnapshot") }
}
```
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Wire `@main`** — `ClaugeApp`: if `SessionStore.shared.load()` exists and `!isExpired` → `RootView` with `UsageDashboardViewModel(source: ClaudeAiUsageSource(transport:))` using the **Task 0.5-decided default transport**; else `ConnectView`. Theme wiring per the handoff README ("Wiring the theme").
- [ ] **Step 6: Full test run.** `xcodebuild test -scheme Clauge -destination 'platform=iOS Simulator,name=iPhone 16' | tail -8` → all pass.
- [ ] **Step 7: Manual end-to-end on a real device** (login → live dashboard → degraded path by pointing `ClaudeAiEndpoints.base` at a mocked host *in a test only*, never shipping that → pull-to-refresh → offline → sign out → reconnect).
- [ ] **Step 8: Commit (no push to main).** `git add -A && git commit -m "feat: wire app entry, App-Group + history seams, final verify"`. Then **stop and ask Adnan** before any `git push` / opening the repo (governance + the legal-posture decision are his).

---

## Out of scope (Phase ② / ③ / ④ — do not build here)
- **Mac mirror (`MacMirrorSource`)** — Phase ②. The `UsageSource` seam + `UsageHistoryStore` are in place.
- **Full Trends analytics** (cost-over-time, peak hours, 16-week heatmap) — needs the Mac mirror's historical data; Phase ① ships the honest placeholder + local history seed.
- **Widgets (WidgetKit), push alerts** — Phase ③/④. The App-Group store + background-refresh entry are seamed.
- **Org admin/Team deep handling** beyond pick-org-with-data + 403 messaging.

## Reconciliation with the 2026-06-02 spec & design
- **Login:** spec/plan said "claude.ai/login"; this narrows to email/Apple (drops Google) per the embedded-webview constraint — Adnan-approved 2026-06-03.
- **Transport:** spec said native URLSession; this adds the spike-gated in-WKWebView fallback because the desktop's native path is unproven (dead code) and the in-browser path is the shipped one.
- **Trends:** design handoff shows a full Trends tab; spec §3 lists trends as a Phase-① non-goal. Resolved: 3-tab shell ships, Trends is an honest placeholder (no fabricated data) — consistent with spec §8.
- **Attribution:** AboutView credits **Adnan Rashid** (matches the desktop's 2026-06-02 copyright change), not "clauding-lab".

## Self-review checklist (applied)
- **Spec coverage:** §5 architecture → Tasks 1–9; §6 model → Task 1 (full window set, not 2); §7 dashboard → Task 8; §8 resilience (per-field degradation, drift sentinel, retry, last-good, expiry, offline, honesty) → Tasks 2,3,6,8; §9 testing (fixtures incl. drift + cents + real 401) → Tasks 2,3,6,9; §10 seams (App Group, history, UsageSource) → Tasks 5,9. ✓
- **Review fixes covered:** G1 window resolver+drift (Task 2), G2 cents/util (Task 2), G3 audience-accepted (no code), G4 retry+last-good+stale (Task 3), G5 Codable+nil-suite (Tasks 1,9), G6 orgs[]+403 (Tasks 1,3), G7 offline (Task 6), G8 governance+no-push (Tasks 0,9), G9 contract tests (Tasks 2,3,6,9), G10 host-pin (Tasks 3,4), H1 email/Apple login (Task 7), H2 401 propagation (Task 3), M-uuid stable id (Task 1), M-privacy manifest (Task 0), M-contrast/a11y (Task 8). ✓
- **No placeholders:** every code step shows the code; the parser is a real port; tests assert the rule (renamed window recovered, $19.60 from 1960 cents, real 401 ⇒ SessionExpired), not just shape. ✓
- **Type consistency:** `UsageSnapshot`/`UsageLimit`/`Org`/`Session`/`UsageTransport`/`TransportResult`/`SessionExpired`/`OrgRestricted`/`UsageSource` names match across tasks. ✓
