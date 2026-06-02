# Clauge iOS — Phase ① Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Where this runs:** on a **Mac** (Xcode 16+, iOS 17+ target). The VPS cannot build iOS. Spec: `docs/superpowers/specs/2026-06-02-clauge-ios-phase1-design.md` (in the `clauge` repo).
> **Note on code blocks:** contracts (models, protocols, client signatures, parsing/degradation, Keychain, view-model state, and all test code) are given in full and are load-bearing — implement them as written. SwiftUI view bodies are given as concrete starting structure; refine visuals against the simulator, but keep the stated behavior and the Clauge palette.

**Goal:** A standalone native-SwiftUI iOS app that, after an in-app Claude.ai login, shows the user's current Claude.ai usage (limit burn + reset countdown, plan/credit balance, overage) read-only, with no backend.

**Architecture:** SwiftUI app, no server. `WebLoginView` (WKWebView) captures the Claude.ai session → `SessionStore` (Keychain). A `UsageSource` protocol abstracts data; Phase ① ships `ClaudeAiUsageSource` backed by `ClaudeAiClient` (read-only GETs to Claude.ai's internal endpoints, per-field-degrading parser). `UsageDashboardViewModel` drives the dashboard; snapshots are mirrored to an App-Group store (seam for later widgets/alerts).

**Tech Stack:** Swift 5.9+, SwiftUI, WebKit, Security (Keychain), XCTest. New repo: `clauge-ios`.

---

## File Structure (new `clauge-ios` repo)

```
clauge-ios/
├── Clauge.xcodeproj
├── Clauge/
│   ├── ClaugeApp.swift                 # @main; routes Connect vs Dashboard on session presence
│   ├── Models/
│   │   └── UsageSnapshot.swift         # UsageSnapshot, UsageLimit, CreditBalance, OverageStatus, Tone
│   ├── Networking/
│   │   ├── ClaudeAiEndpoints.swift     # centralized base URL + paths (mirror desktop extension/background.js)
│   │   └── ClaudeAiClient.swift        # read-only GETs; per-field-degrading decode → UsageSnapshot
│   ├── Auth/
│   │   ├── Session.swift               # the captured claude.ai session value
│   │   ├── SessionStore.swift          # Keychain persistence + expiry flag
│   │   └── WebLoginView.swift          # WKWebView login → onSession callback
│   ├── Sources/
│   │   ├── UsageSource.swift           # protocol
│   │   └── ClaudeAiUsageSource.swift   # protocol impl over ClaudeAiClient
│   ├── Shared/
│   │   └── SharedStore.swift           # App Group write (widgets/alerts seam)
│   ├── ViewModels/
│   │   └── UsageDashboardViewModel.swift
│   └── Views/
│       ├── ConnectView.swift
│       ├── DashboardView.swift
│       └── SettingsView.swift
└── ClaugeTests/
    ├── Fixtures/                       # captured JSON from the real endpoints
    │   ├── usage.json
    │   ├── credits.json
    │   ├── overage.json
    │   └── usage_missing_field.json
    ├── ClaudeAiClientTests.swift
    ├── SessionStoreTests.swift
    └── UsageDashboardViewModelTests.swift
```

---

### Task 0: Repo + Xcode project scaffold

**Files:** the whole `clauge-ios` repo skeleton.

- [ ] **Step 1:** Create the repo and project.
```bash
gh repo create clauding-lab/clauge-ios --private --clone   # private until ready to ship
cd clauge-ios
# In Xcode: File ▸ New ▸ Project ▸ iOS App, name "Clauge", interface SwiftUI, language Swift,
# include a Unit Testing target ("ClaugeTests"). Min deployment iOS 17.
```
- [ ] **Step 2:** Add an **App Group** capability (Signing & Capabilities ▸ + App Groups ▸ `group.com.clauding.clauge`) — needed for the widgets/alerts seam in later phases.
- [ ] **Step 3:** Add a Keychain Sharing capability (default access group is fine).
- [ ] **Step 4:** Commit.
```bash
git add -A && git commit -m "chore: scaffold Clauge iOS SwiftUI app + test target + App Group"
```
- [ ] **Step 5:** Verify the empty app builds & the test target runs:
```bash
xcodebuild test -scheme Clauge -destination 'platform=iOS Simulator,name=iPhone 16' | tail -5
```
Expected: build succeeds, 0 tests fail.

---

### Task 1: Usage data model

**Files:** Create `Clauge/Models/UsageSnapshot.swift`; Test `ClaugeTests/UsageDashboardViewModelTests.swift` (model used there).

- [ ] **Step 1: Implement the model** (no test needed for plain value types; it's exercised by later tasks):
```swift
import Foundation

enum Tone { case bull, neutral, warn, bear }

struct UsageLimit: Equatable, Identifiable {
    let id = UUID()
    let window: String        // e.g. "5-hour", "weekly"
    let usedPct: Double       // 0...1
    let resetsAt: Date?
    var tone: Tone {          // utilization → color intent
        switch usedPct {
        case ..<0.7: return .bull
        case ..<0.9: return .warn
        default:     return .bear
        }
    }
}

struct CreditBalance: Equatable { let amount: Double; let currency: String }
struct OverageStatus: Equatable { let spent: Double; let cap: Double; let currency: String }

struct UsageSnapshot: Equatable {
    let fetchedAt: Date
    let orgId: String
    let orgName: String
    var limits: [UsageLimit]
    var balance: CreditBalance?
    var overage: OverageStatus?
    var fieldErrors: [String: String]   // field name → "couldn't read" reason; drives per-field degradation
    static func == (l: UsageSnapshot, r: UsageSnapshot) -> Bool {
        l.fetchedAt == r.fetchedAt && l.orgId == r.orgId && l.limits == r.limits
            && l.balance == r.balance && l.overage == r.overage && l.fieldErrors == r.fieldErrors
    }
}
```
- [ ] **Step 2: Commit.** `git add -A && git commit -m "feat: usage snapshot model"`

---

### Task 2: Endpoints + ClaudeAiClient (fixture-driven, per-field degradation)

**Files:** Create `Clauge/Networking/ClaudeAiEndpoints.swift`, `Clauge/Networking/ClaudeAiClient.swift`; Test `ClaugeTests/ClaudeAiClientTests.swift`; Fixtures in `ClaugeTests/Fixtures/`.

> **Before coding:** open the desktop repo's `extension/background.js` and copy the EXACT request shapes (paths, query params, required headers) for: list organizations, `/api/organizations/{uuid}/usage`, `/api/organizations/{uuid}/prepaid/credits`, `/api/organizations/{uuid}/overage_spend_limit`. Save one real JSON response per endpoint into `ClaugeTests/Fixtures/`. The parser is written against those fixtures.

- [ ] **Step 1: Centralize endpoints.**
```swift
import Foundation
enum ClaudeAiEndpoints {
    // Single source of truth — patch here when Anthropic moves the internal API.
    static var base = URL(string: "https://claude.ai")!
    static func organizations() -> URL { base.appending(path: "/api/organizations") }
    static func usage(org: String) -> URL { base.appending(path: "/api/organizations/\(org)/usage") }
    static func credits(org: String) -> URL { base.appending(path: "/api/organizations/\(org)/prepaid/credits") }
    static func overage(org: String) -> URL { base.appending(path: "/api/organizations/\(org)/overage_spend_limit") }
}
```
- [ ] **Step 2: Write the failing parser test** (use your captured fixtures; adjust the expected values to match them):
```swift
import XCTest
@testable import Clauge

final class ClaudeAiClientTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = Bundle(for: Self.self).url(forResource: name, withExtension: "json")!
        return try Data(contentsOf: url)
    }
    func test_parseUsage_populatesLimits() throws {
        let limits = try ClaudeAiClient.parseUsage(try fixture("usage"))
        XCTAssertFalse(limits.isEmpty)
        XCTAssertTrue(limits.allSatisfy { (0...1).contains($0.usedPct) })
    }
    func test_parseCredits_and_overage() throws {
        XCTAssertNotNil(try ClaudeAiClient.parseCredits(try fixture("credits")))
        XCTAssertNotNil(try ClaudeAiClient.parseOverage(try fixture("overage")))
    }
    // Degradation: a renamed/missing field must NOT throw the whole parse away.
    func test_missingField_degradesGracefully() throws {
        let limits = try ClaudeAiClient.parseUsage(try fixture("usage_missing_field"))
        XCTAssertNotNil(limits) // parses what it can; caller records fieldErrors
    }
}
```
- [ ] **Step 3: Run → fails** (`parseUsage` undefined). `xcodebuild test -scheme Clauge -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:ClaugeTests/ClaudeAiClientTests | tail -8`
- [ ] **Step 4: Implement the client.** Static `parseUsage/parseCredits/parseOverage` (pure, fixture-testable) decode leniently — each uses `try?`/optionals so one bad field doesn't nuke the rest. The async `fetchSnapshot(session:)` composes them, recording any nil/throwing field into `fieldErrors`, and maps a 401/login-redirect to a `SessionExpired` error.
```swift
import Foundation
struct SessionExpired: Error {}
struct ClaudeAiClient {
    let session: Session
    // --- pure parsers (decode the fixtures; shape these to your real JSON) ---
    static func parseUsage(_ data: Data) throws -> [UsageLimit] {
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        // Map each rate-limit window the endpoint returns into a UsageLimit.
        // Use optional chaining per field; skip windows that don't parse.
        // (Fill in against the real `usage.json` shape from the extension.)
        return UsageMapping.limits(from: obj)
    }
    static func parseCredits(_ data: Data) throws -> CreditBalance? { CreditMapping.balance(from: data) }
    static func parseOverage(_ data: Data) throws -> OverageStatus? { OverageMapping.status(from: data) }
    // --- live fetch ---
    func fetchSnapshot() async throws -> UsageSnapshot {
        var errors: [String: String] = [:]
        let org = try await firstOrg()                              // GET /organizations
        async let usageD = get(ClaudeAiEndpoints.usage(org: org.id))
        async let creditD = get(ClaudeAiEndpoints.credits(org: org.id))
        async let overD  = get(ClaudeAiEndpoints.overage(org: org.id))
        let limits = (try? Self.parseUsage(try await usageD)) ?? { errors["limits"] = "unavailable"; return [] }()
        let balance = (try? Self.parseCredits(try await creditD)) ?? { errors["balance"] = "unavailable"; return nil }()
        let overage = (try? Self.parseOverage(try await overD)) ?? { errors["overage"] = "unavailable"; return nil }()
        return UsageSnapshot(fetchedAt: Date(), orgId: org.id, orgName: org.name,
                             limits: limits, balance: balance, overage: overage, fieldErrors: errors)
    }
    private func get(_ url: URL) async throws -> Data {
        var req = URLRequest(url: url)
        session.applyCookies(to: &req)                  // attach the captured claude.ai session
        let (data, resp) = try await URLSession.shared.data(for: req)
        if (resp as? HTTPURLResponse)?.statusCode == 401 { throw SessionExpired() }
        return data
    }
    private func firstOrg() async throws -> (id: String, name: String) { /* parse /organizations */ }
}
```
> `UsageMapping`/`CreditMapping`/`OverageMapping` are tiny helpers you write against the real fixture JSON. Keep them in `ClaudeAiClient.swift`.
- [ ] **Step 5: Run → passes.** Same command as Step 3. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: claude.ai client with fixture-tested, degrading parser"`

---

### Task 3: SessionStore (Keychain) + Session

**Files:** Create `Clauge/Auth/Session.swift`, `Clauge/Auth/SessionStore.swift`; Test `ClaugeTests/SessionStoreTests.swift`.

- [ ] **Step 1: Session value + cookie application.**
```swift
import Foundation
struct Session: Codable, Equatable {
    var cookies: [String: String]   // e.g. ["sessionKey": "..."]
    func applyCookies(to req: inout URLRequest) {
        req.setValue(cookies.map { "\($0)=\($1)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
    }
}
```
- [ ] **Step 2: Write failing Keychain round-trip test.**
```swift
import XCTest
@testable import Clauge
final class SessionStoreTests: XCTestCase {
    override func setUp() { SessionStore.shared.clear() }
    func test_saveLoadClear() {
        XCTAssertNil(SessionStore.shared.load())
        let s = Session(cookies: ["sessionKey": "abc"])
        SessionStore.shared.save(s)
        XCTAssertEqual(SessionStore.shared.load(), s)
        SessionStore.shared.clear()
        XCTAssertNil(SessionStore.shared.load())
    }
    func test_expiryFlag() {
        SessionStore.shared.save(Session(cookies: ["sessionKey": "abc"]))
        SessionStore.shared.markExpired()
        XCTAssertTrue(SessionStore.shared.isExpired)
    }
}
```
- [ ] **Step 3: Run → fails.** `... -only-testing:ClaugeTests/SessionStoreTests`
- [ ] **Step 4: Implement `SessionStore`** — `save/load/clear` storing JSON-encoded `Session` in the Keychain via `SecItem*`; an `isExpired` flag (UserDefaults is fine) set by `markExpired()` and cleared on `save`.
- [ ] **Step 5: Run → passes.**
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: keychain session store"`

---

### Task 4: UsageSource protocol + ClaudeAiUsageSource

**Files:** Create `Clauge/Sources/UsageSource.swift`, `Clauge/Sources/ClaudeAiUsageSource.swift`.

- [ ] **Step 1: Protocol + impl** (the seam Phase ② plugs a `MacMirrorSource` into):
```swift
protocol UsageSource { func snapshot() async throws -> UsageSnapshot }

struct ClaudeAiUsageSource: UsageSource {
    let session: Session
    func snapshot() async throws -> UsageSnapshot {
        try await ClaudeAiClient(session: session).fetchSnapshot()
    }
}
```
- [ ] **Step 2: Commit.** `git add -A && git commit -m "feat: UsageSource protocol + claude.ai source"`

---

### Task 5: UsageDashboardViewModel (state machine)

**Files:** Create `Clauge/ViewModels/UsageDashboardViewModel.swift`; Test `ClaugeTests/UsageDashboardViewModelTests.swift`.

- [ ] **Step 1: Write failing state-machine test** (using a stub `UsageSource`):
```swift
import XCTest
@testable import Clauge
private struct StubSource: UsageSource {
    var result: Result<UsageSnapshot, Error>
    func snapshot() async throws -> UsageSnapshot { try result.get() }
}
@MainActor final class UsageDashboardViewModelTests: XCTestCase {
    func test_loadsSnapshot() async {
        let snap = UsageSnapshot(fetchedAt: Date(), orgId: "o", orgName: "Org",
            limits: [UsageLimit(window: "weekly", usedPct: 0.5, resetsAt: nil)],
            balance: nil, overage: nil, fieldErrors: [:])
        let vm = UsageDashboardViewModel(source: StubSource(result: .success(snap)))
        await vm.refresh()
        if case .loaded(let s) = vm.state { XCTAssertEqual(s.orgName, "Org") } else { XCTFail() }
    }
    func test_sessionExpired_setsNeedsReconnect() async {
        let vm = UsageDashboardViewModel(source: StubSource(result: .failure(SessionExpired())))
        await vm.refresh()
        if case .needsReconnect = vm.state {} else { XCTFail() }
    }
    func test_degraded_whenFieldErrors() async {
        var snap = UsageSnapshot(fetchedAt: Date(), orgId: "o", orgName: "Org", limits: [], balance: nil, overage: nil, fieldErrors: ["balance": "unavailable"])
        let vm = UsageDashboardViewModel(source: StubSource(result: .success(snap)))
        await vm.refresh()
        if case .loaded(let s) = vm.state { XCTAssertEqual(s.fieldErrors["balance"], "unavailable") } else { XCTFail() }
    }
}
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement the view model:**
```swift
import Foundation
@MainActor final class UsageDashboardViewModel: ObservableObject {
    enum State { case idle, loading, loaded(UsageSnapshot), needsReconnect, error(String) }
    @Published private(set) var state: State = .idle
    private let source: UsageSource
    init(source: UsageSource) { self.source = source }
    func refresh() async {
        state = .loading
        do {
            let snap = try await source.snapshot()
            SharedStore.write(snap)            // App-Group seam (Task 8)
            state = .loaded(snap)
        } catch is SessionExpired {
            SessionStore.shared.markExpired(); state = .needsReconnect
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}
```
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: dashboard view model state machine"`

---

### Task 6: WebLoginView (capture the Claude.ai session)

**Files:** Create `Clauge/Auth/WebLoginView.swift`. (UI-integration code; manual-verified on simulator, no unit test.)

- [ ] **Step 1: Implement** a `UIViewRepresentable` wrapping `WKWebView` that loads `https://claude.ai/login`. After navigation to a logged-in URL, read cookies via `webView.configuration.websiteDataStore.httpCookieStore.getAllCookies`, pick the `claude.ai` auth cookie(s) (e.g. `sessionKey`), build a `Session`, and call `onSession(session)`. Detect "logged in" by URL host/path leaving the login flow.
```swift
import SwiftUI; import WebKit
struct WebLoginView: UIViewRepresentable {
    var onSession: (Session) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onSession: onSession) }
    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView(); wv.navigationDelegate = context.coordinator
        wv.load(URLRequest(url: URL(string: "https://claude.ai/login")!)); return wv
    }
    func updateUIView(_ v: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
        let onSession: (Session) -> Void
        init(onSession: @escaping (Session) -> Void) { self.onSession = onSession }
        func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
            guard let host = wv.url?.host, host.contains("claude.ai"),
                  wv.url?.path.contains("login") == false else { return }
            wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                let wanted = cookies.filter { $0.domain.contains("claude.ai") }
                    .reduce(into: [String:String]()) { $0[$1.name] = $1.value }
                if wanted["sessionKey"] != nil { self.onSession(Session(cookies: wanted)) }
            }
        }
    }
}
```
- [ ] **Step 2: Commit.** `git add -A && git commit -m "feat: in-app claude.ai login + session capture"`

---

### Task 7: Views (Connect, Dashboard, Settings)

**Files:** Create `Clauge/Views/ConnectView.swift`, `DashboardView.swift`, `SettingsView.swift`. Manual-verified on simulator.

- [ ] **Step 1: ConnectView** — a "Connect Claude.ai" button presenting `WebLoginView` in a sheet; on `onSession`, `SessionStore.shared.save(session)` and dismiss.
- [ ] **Step 2: DashboardView** — observes `UsageDashboardViewModel`. Render per `state`:
  - `.loading` → skeleton.
  - `.loaded(snap)` → **Headline card**: for each `UsageLimit`, a labelled progress ring/bar showing `usedPct` tinted by `.tone`, with `resetsAt` as a live countdown. Then **Plan & balance** card (`balance`, `overage`) — for any key in `snap.fieldErrors`, render that card as "Unavailable" instead. **Org** name; "as of <relative fetchedAt>"; pull-to-refresh; a quiet "Source: Claude.ai" footnote.
  - `.needsReconnect` → message + "Reconnect" button → ConnectView flow.
  - `.error(msg)` → message + retry.
  Use the desktop Clauge palette spirit (`docs/design/tokens.css` in the `clauge` repo): warm near-black bg, Claude-clay accent, tone colors for utilization.
- [ ] **Step 3: SettingsView** — "Sign out" (`SessionStore.shared.clear()`); a disabled "Connect a Mac (coming soon)" row (Phase ② placeholder, non-functional).
- [ ] **Step 4: Manual verify** on simulator: launch → Connect → (log into a real Claude.ai test account) → dashboard renders with live numbers. Confirm degraded + reconnect paths by temporarily pointing `ClaudeAiEndpoints.base` at a bad URL.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: connect, dashboard, settings views"`

---

### Task 8: App-Group shared store (seam)

**Files:** Create `Clauge/Shared/SharedStore.swift`.

- [ ] **Step 1: Implement** — encode the latest `UsageSnapshot` to JSON in the App-Group container (`group.com.clauding.clauge`) so later widget/alert targets read the same data:
```swift
import Foundation
enum SharedStore {
    static let suite = UserDefaults(suiteName: "group.com.clauding.clauge")
    static func write(_ snap: UsageSnapshot) {
        // Encode a Codable mirror of UsageSnapshot; store under "latestSnapshot".
    }
    static func readLatest() -> Data? { suite?.data(forKey: "latestSnapshot") }
}
```
(Make `UsageSnapshot` + members `Codable` for this; it's also handy for tests.)
- [ ] **Step 2: Commit.** `git add -A && git commit -m "feat: app-group shared store seam for widgets/alerts"`

---

### Task 9: App wiring + final verify

**Files:** Modify `Clauge/ClaugeApp.swift`.

- [ ] **Step 1:** `@main` app: if `SessionStore.shared.load()` exists and not expired → `DashboardView` (with `UsageDashboardViewModel(source: ClaudeAiUsageSource(session:))`); else `ConnectView`.
- [ ] **Step 2:** Full test run: `xcodebuild test -scheme Clauge -destination 'platform=iOS Simulator,name=iPhone 16' | tail -6` → all pass.
- [ ] **Step 3:** Manual end-to-end on simulator (real Claude.ai login → live dashboard → pull-to-refresh → sign out).
- [ ] **Step 4: Commit + push.** `git add -A && git commit -m "feat: wire app entry on session presence" && git push -u origin main`

---

## Out of scope (Phase ② / ③ / ④ — do not build here)
- Mac mirror (`MacMirrorSource`), widgets (WidgetKit target), push alerts. The seams (`UsageSource`, App-Group store, refresh) are in place for them.

## Self-review checklist (already applied)
- Spec coverage: §5 architecture → Tasks 0–9; §6 model → Task 1; §7 dashboard → Task 7; §8 resilience (degradation/expiry/honesty) → Tasks 2,5,7; §9 testing → Tasks 2,3,5; §10 seams → Tasks 4,8. ✓
- No vague "handle errors" steps — degradation + expiry are concretely tested (Tasks 2,5). ✓
- Type consistency: `UsageSnapshot`/`UsageLimit`/`Session`/`UsageSource`/`SessionExpired` names match across tasks. ✓
