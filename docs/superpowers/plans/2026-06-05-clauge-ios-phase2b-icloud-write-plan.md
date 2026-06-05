# Phase ②b — Production Mac-side iCloud Snapshot Write

**Status:** IMPLEMENTED 2026-06-05. All 3 decisions resolved — (1) **parent-writes** ✓, (2) verification via **TestFlight** (not a local Dev profile) ✓, (3) version → **1.1.0** (App Store had closed the 1.0.0 train, forcing the bump above the original "keep 1.0.0" plan). Shipped as **build 7 (1.1.0)**, uploaded to App Store Connect; the coordinated write proven end-to-end against the real iCloud container (lands + `isUploaded=true`) via an un-sandboxed integration test using the actual write code.
**Produced:** 2026-06-05 by the `clauge-phase2b-design-plan` workflow (10 agents, 4 readers → 3-approach design panel → adversarial review → fold). Every load-bearing objc2 binding was verified against vendored `objc2-foundation 0.3.2` source.
**Supersedes for ②b:** the one-line ②a-close-out architecture note (which said *sidecar* writes; the review found that unsafe — see Decision 1).

---

## CHOSEN MECHANISM (recommendation)

**The Rust PARENT performs the coordinated write via objc2** — `NSFileCoordinator::new()` + `coordinateWritingItemAtURL:options:ForReplacing:byAccessor:` wrapping `NSData.writeToURL:atomically:YES`. The **Node sidecar only ASSEMBLES** the snapshot JSON (new `GET /api/snapshot` route) which the parent fetches over the existing `127.0.0.1` loopback, then stamps `seq`+`writerId` and writes.

**Why:** only approach scoring 5/5 correctness. `NSFileCoordinator` is the sole mechanism that serializes the write against iCloud's `bird`/`fileproviderd` uploader (closing the torn-upload race a bare `fs.rename` leaves open). And parent-owns-the-write structurally eliminates the **real** second-writer race in the `kill_current_sidecar_for_respawn` window (verified: `sidecar.rs:414` fires kill WITHOUT awaiting reap; supervisor respawns only after observing `Terminated`) that the sidecar-writes approach cannot survive. Costs only a localhost round-trip of the ~8 KB JSON back to the parent. Un-gated by adding exactly 3 Cargo features (`NSFileManager`, `NSFileCoordinator`, `block2`) to a crate already compiled into both flavors — zero net-new downloads.

**Rejected alternatives:**
- **Sidecar does atomic temp-then-rename (no NSFileCoordinator)** — lowest cost but its "single writer" premise is FALSE (respawn race above); `fs.rename` also happens outside iCloud's coordination protocol → `bird` can upload a mid-rename state. False-green locally, intermittent phone desync after Review passes. This is the exact ②a-close-out trap.
- **Swift shim (CLI/dylib)** — ties on correctness but adds a THIRD nested Mach-O to the repo's most-scarred surface (entitlements-sidecar.mas.plist = monument to 3 rejections + 2 SIGTRAPs). Reject.
- **`NSFileCoordinator::initWithFilePresenter(alloc, None)`** (the draft's construction) — REJECTED: needs the `NSFilePresenter` feature + an un-inferable `None`; app has no presenter. Use plain `NSFileCoordinator::new()`.

---

## DECISIONS PENDING (Adnan) — gates implementation

1. **Write owner — DEVIATION from locked ②a wording.** ②a said *forward `CLAUGE_ICLOUD_DIR` to the sidecar for the sidecar to write*. Review found that exposes a real two-writer race on sidecar respawn. Recommendation: **PARENT writes**, sidecar only assembles. (If kept sidecar-writes, a process file-lock is required and correctness drops.) → bundles Decision: **parent owns `seq`+`writerId`**.
2. **Mint a Development provisioning profile (with the iCloud container)** so `--local-test` can exercise the REAL coordinated write on this Mac BEFORE App Review. Recommendation: **yes** — it's the only pre-Review proof of the one genuinely-new path (②a only proved a RAW write synced). Cost: one extra portal step.
3. **App version:** keep **v1.0.0** (pure resubmission, only `bundleVersion 6→7`) vs cut **v1.1.0** (marks the feature; triggers landmine #21 four-file lockstep + fresh DMG cycle). Recommendation: **keep 1.0.0 + bundleVersion 7**.

(Decision 5 from the workflow — *proceed on the LIVE App ID `com.clauding.clauge`* — is **already done**: Adnan enabled iCloud + attached `iCloud.com.clauding.clauge` to the live App ID on 2026-06-05. Remaining: regenerate the **Distribution** profile, and — if Decision 2 = yes — mint the **Development** profile.)

---

## NEW LANDMINES (AGENTS.md #33–#37) — guards

- **#33** iCloud entitlements on `entitlements.mas.plist` (PARENT) ONLY — never `entitlements-sidecar.mas.plist`. Helper inherits via `com.apple.security.inherit=true`; adding iCloud keys to the helper re-introduces the Transporter 90885 nested-profile risk. GUARD: post-build `codesign -d --entitlements -` on the helper shows NO icloud/ubiquity/application-identifier keys.
- **#34** `embedded.provisionprofile` MUST carry iCloud BEFORE the plist declares it, and the plist declares EXACTLY the profile's iCloud key set — no more (extra keys = Transporter-90889 rejection vector). GUARD: `security cms -D -i src-tauri/embedded.provisionprofile | plutil -extract Entitlements xml1 -o - -` is the source of truth; empty iCloud grep → STOP + regenerate.
- **#35** NEVER compute the container path from `os.homedir()`/`NSHomeDirectory()` in any process — under the sandbox both redirect to `~/Library/Containers/com.clauding.clauge/Data` (silent dead-write). Path MUST come from `NSFileManager.URLForUbiquityContainerIdentifier`. GUARD: grep the diff for `homedir`/`Mobile Documents` string-building in the write path — none allowed.
- **#36** `NSFileCoordinator` blocks the calling thread on `filecoordinationd` and is NOT main-thread-bound (unlike all objc2 in `native_popover.rs`). EVERY `forUbiquityContainerIdentifier` resolve (incl. per-tick re-resolve) AND the coordinated write run inside `tauri::async_runtime::spawn_blocking`. Accessor is synchronous (`Fn(...)+'_`, no Send bound) so a `Cell<bool>` for the write-result is safe; the `Retained<NSURL>` never crosses threads (resolve+write in the SAME spawn_blocking).
- **#37** Build the child URL with `NSURL.URLByAppendingPathComponent` on the retained container NSURL — NEVER Rust string-concat over percent-DECODED `NSURL.path()`. Create `Documents/` first via `createDirectoryAtURL_withIntermediateDirectories(true)` (ubiquity container does NOT auto-create it → write returns `false`). GUARD: writer takes `&NSURL` not `PathBuf`; check BOTH the `writeToURL_atomically` bool AND the `NSError` out-param.

---

## ADVERSARIAL VERDICT (summary)

**APPROVE WITH REQUIRED CHANGES.** No CRITICAL show-stoppers. Architecture (parent-side coordinated write via objc2) confirmed correct against vendored source. The respawn two-writer race used to reject the sidecar-writes approach is REAL (`sidecar.rs:414`, `:608`). Three HIGH issues were folded into this final plan: (1) use `NSFileCoordinator::new()` not `initWithFilePresenter`; (2) build child URL via `URLByAppendingPathComponent`, not string concat over percent-decoded `path()`; (3) create `Documents/` + reconcile the write path with ②a's proven `Documents/clauge-spike.json` (②b uses `Documents/clauge-snapshot.json` — same proven subpath). Most important untested claim: there is NO local end-to-end verification of the coordinated write unless Decision 2 (Development profile) is taken — do NOT submit on inference; gate on the local-test build proving the file appears AND syncs to the iPhone.

---

<!-- The execution-ready task plan follows verbatim from the workflow. -->

# Phase ②b — Production Mac-side iCloud Snapshot Write (Implementation Plan, FINAL)

**Branch:** cut a fresh branch off `main` (e.g. `feat/icloud-snapshot-write-2b`). Do NOT work on the spike branch `docs/clauge-ios-phase2a-icloud-spike`.

**Chosen mechanism:** The PARENT (Rust) performs a coordinated atomic write via objc2 (`NSFileCoordinator::new()` + `coordinateWritingItemAtURL:options:ForReplacing:byAccessor:` wrapping `NSData.writeToURL:atomically:`). The Node sidecar only ASSEMBLES the snapshot JSON (minus seq/writerId); the parent fetches it over the existing loopback, stamps `seq`+`writerId`, then writes. This makes the parent the single authoritative writer (eliminates the sidecar-respawn two-writer race).

## VERIFIED FACTS THIS PLAN RESTS ON (re-checked against source THIS session — cite, don't re-derive)

- **②a-proven write path = `Documents/`.** `scripts/icloud-spike-write.cjs:11-12` wrote to `~/Library/Mobile Documents/iCloud~com~clauding~clauge/Documents/clauge-spike.json` and that synced to Adnan's iPhone. So `Documents/` is the PROVEN transport path — ②b keeps it (filename `clauge-snapshot.json`). NOT a behavior change; reuses the proven subpath.
- objc2-foundation 0.3.2 bindings (all confirmed in vendored crate):
  - `NSFileManager::URLForUbiquityContainerIdentifier(Option<&NSString>) -> Option<Retained<NSURL>>` (`generated/NSFileManager.rs:855`; un-gated by feature `NSFileManager`).
  - `NSFileManager::createDirectoryAtURL_withIntermediateDirectories_attributes_error(...)` (`generated/NSFileManager.rs:374`).
  - `NSFileCoordinator::new() -> Retained<Self>` (`generated/NSFileCoordinator.rs:112`) — USE THIS, not `initWithFilePresenter` (`:152`).
  - `coordinateWritingItemAtURL_options_error_byAccessor(&self, &NSURL, NSFileCoordinatorWritingOptions, Option<&mut Option<Retained<NSError>>>, &block2::DynBlock<dyn Fn(NonNull<NSURL>) + '_>)` (`generated/NSFileCoordinator.rs:205`). Accessor SYNCHRONOUS, no Send bound.
  - `NSFileCoordinatorWritingOptions::ForReplacing = 1<<3` (`generated/NSFileCoordinator.rs:49`).
  - `NSURL::URLByAppendingPathComponent(&NSString) -> Option<Retained<NSURL>>` (`generated/NSURL.rs:2164`).
  - `NSData::with_bytes(&[u8]) -> Retained<NSData>` (`src/data.rs:39`) + `writeToURL_atomically(&self, &NSURL, bool) -> bool` (`generated/NSData.rs:279`).
  - `NSString::from_str(&str)` (`src/string.rs:113`); `NSURL::path()` is percent-DECODED (`generated/NSURL.rs:1314`) — used ONLY for PathBuf cache/logging.
- Cargo feature gates: `NSFileManager` (Cargo.toml:282), `NSFileCoordinator` (:280), `block2` (:407). `block2 0.6.2` already in `Cargo.lock:366`.
- Current `objc2-foundation` features (`src-tauri/Cargo.toml:72`): `["NSGeometry","NSString","NSURL","NSURLRequest","NSValue","NSData","NSDictionary","NSError","NSArray","NSProcessInfo"]`.
- `security_scoped_bookmark.rs:26` is `#![cfg(feature = "mas")]`. `MAS_CLAUDE_DIR` static `:50`; imports `NSData, NSString, NSURL` `:33-35`.
- `sidecar.rs:274-276` = `CLAUDE_DIR` env-forward inside `#[cfg(feature="mas")] spawn_native_helper`. `:520-549` = `_mas_scope_guard` sets `MAS_CLAUDE_DIR` before `loop {` at `:550`.
- **Supervisor launch site = `lib.rs:333`** — `sidecar::spawn_and_supervise(app_handle).await` inside a `tauri::async_runtime::spawn` block (lib.rs:303). Publish task spawns as a SIBLING here. `AppState.shutdown` (`tokio::sync::Notify`, `sidecar.rs:484`) is the clean-exit signal to race.
- `ipc.rs:152` = `read_port(&state) -> Result<u16,String>`; `ipc.rs:470` = `reqwest::get(&url).await`. `proxy_fetch` (`ipc.rs:459`) is webview-facing — do NOT route the publish through it.
- `server.js:156` = `READ_ONLY_API_PATHS` array (`/api/summary`, `/api/models`, `/api/usage`); loop `:193` registers each GET-allowlisted route.
- `entitlements.mas.plist` currently has NO iCloud keys. `embedded.provisionprofile` carries `application-identifier` but NO iCloud/ubiquity keys (confirmed ②a). `tauri.mas.conf.json:7` = `bundleVersion: "6"`. `entitlements.local-test.plist` has no iCloud keys.
- AGENTS.md landmines run to **#32**; new ones start at **#33**.

---

## TASK ORDER (riskiest-first)

### Task 1 — Container resolver + cache (`MAS_ICLOUD_DIR` + `resolve_icloud_container`)
**Riskiest: new objc2 surface.**

**Files:**
- `src-tauri/Cargo.toml:72` — extend `objc2-foundation` features to add **exactly** `"NSFileManager", "NSFileCoordinator", "block2"`. **DO NOT add `NSFilePresenter`.**
- `src-tauri/src/security_scoped_bookmark.rs:33-35` — add `NSFileManager` to the `objc2_foundation` import group.
- `src-tauri/src/security_scoped_bookmark.rs:50` — add a sibling static after `MAS_CLAUDE_DIR`: `pub static MAS_ICLOUD_DIR: OnceLock<PathBuf>` (memo for env/logging only; the WRITE path re-resolves fresh each tick — no ScopedHandle needed, container is entitlement-granted).
- End of module — `resolve_icloud_container() -> Option<Retained<NSURL>>`: `NSFileManager::defaultManager()` → `NSString::from_str("iCloud.com.clauding.clauge")` (DOTTED) → `URLForUbiquityContainerIdentifier(Some(&id))`. `None` cleanly encodes both nil causes. Companion `resolve_icloud_container_path() -> Option<PathBuf>` maps via `.path()` for memo+logging ONLY (never feed back into URL construction).

**Verification:** `cargo build --features mas` compiles; `#[cfg(test)] #[ignore]` resolve test (entitlement-gated — real check happens from the built `.app` in Task 6); DMG untouched (`cargo build` without `--features mas` compiles — module is `#![cfg(feature="mas")]`).

### Task 2 — Coordinated atomic write module (`icloud_writer.rs`)
**Second-riskiest: the `RcBlock`/`DynBlock` idiom is new to this repo.**

**Files:**
- NEW `src-tauri/src/icloud_writer.rs` (top `#![cfg(feature = "mas")]`). `pub fn write_snapshot_coordinated(container_url: &NSURL, payload: &[u8]) -> Result<(), String>` — takes the retained `NSURL`, not a PathBuf.
  1. Child URLs via NSURL append: `docs_dir = container_url.URLByAppendingPathComponent("Documents")`; `target_url = docs_dir.URLByAppendingPathComponent("clauge-snapshot.json")`.
  2. Create `Documents/` first: `createDirectoryAtURL_withIntermediateDirectories_attributes_error(&docs_dir, true, None)` (idempotent). Surface its error.
  3. `let coordinator = NSFileCoordinator::new();` (plain `new()`).
  4. Hoist the write result out of the block via `Cell<bool>` (accessor runs synchronously on this thread); `RcBlock::new(|coord_url| { write to the URL the coordinator hands you; wrote.set(data.writeToURL_atomically(url, true)) })`.
  5. Check BOTH layers: `err.is_some()` → Err; else `!wrote.get()` → Err("write returned false (disk full / dir missing?)"); else Ok.
- `src-tauri/src/lib.rs` — `#[cfg(feature = "mas")] mod icloud_writer;`.

**Threading contract (landmine #36):** caller MUST invoke inside `tauri::async_runtime::spawn_blocking`.

**Verification:** `cargo build --features mas`; `#[cfg(test)] #[ignore]` integration test (round-trip + missing-dir returns Err); manual `cat` after Task 6.

### Task 3 — Snapshot assembly route in the sidecar (`/api/snapshot` + `lib/snapshot.js`)
**Pure Node, no native surface, no SEA manifest change** (esbuild bundles `lib/` via `entryPoints:['server.js']`).

**Files:**
- NEW `lib/snapshot.js` — `buildSnapshot(store, usageStore)`: load summaries + usage ONCE, reuse existing rollups, emit ONE object `{ schemaVersion, generatedAt, summary, projects, daily, activity, models, tools, roi, usage }`. **`seq`/`writerId` NOT set here — the parent stamps them.** Size discipline (measured): cap `shellCommands` top-15, activity 120–180d (drop per-day tokens/cost), drop nested byProject/byModel, projects top-10, round costs 2dp. Target ~6–10 KB.
- `server.js:~420` — add read-only `GET /api/snapshot` calling `buildSnapshot`; add `'/api/snapshot'` to `READ_ONLY_API_PATHS` (`server.js:156`).

**Verification (TDD):** `npm test` green; new tests: shellCommands ≤15, activity ≤180, costs 2dp, seq/writerId ABSENT; `curl -s .../api/snapshot | wc -c` < 10 KB on real data; run the `.cjs` validators.

### Task 4 — Parent fetch + seq stamp + scheduled publish (SEPARATE task, NOT in the supervisor loop)
**Files:**
- `src-tauri/src/sidecar.rs:274-276` — `CLAUGE_ICLOUD_DIR` env-forward: **OMIT** (parent-writes design).
- `src-tauri/src/lib.rs:~333` (sibling to `spawn_and_supervise`, inside the existing `tauri::async_runtime::spawn` at `:303`) — `#[cfg(feature="mas")]` publish task: `tokio::time::interval` (~5 min) racing `state.shutdown.notified()`; each tick re-resolve container via `spawn_blocking(resolve_icloud_container)` (skip tick if None — no restart footgun); fetch `read_port` + `reqwest::get('/api/snapshot')` (NOT `proxy_fetch`); parent stamps `seq` (monotonic, from the Tauri store the parent owns) + `writerId` (per-install UUID); write via `spawn_blocking(write_snapshot_coordinated)`. Re-resolve INSIDE the same `spawn_blocking` that writes so the `Retained<NSURL>` never crosses threads.

**Verification:** `cargo build --features mas` + `cargo clippy --features mas -- -D warnings`; parent-side seq tests (`seq strictly increases`, `writerId stable`); respawn single-writer check via `lsof` (only parent writes); end-to-end after Task 5/6.

### Task 5 — iCloud entitlements (parent only) + portal/profile gate
**Deliberately AFTER the code.**

**PORTAL GATE (Adnan, do FIRST):**
1. ✅ DONE — iCloud capability enabled on App ID `CY4FK9S7X9.com.clauding.clauge` + container `iCloud.com.clauding.clauge` attached (2026-06-05).
2. **Regenerate** the "Clauge Mac App Store" **Distribution** profile (now carrying iCloud), download, replace `src-tauri/embedded.provisionprofile`.
3. **Gate check:** `security cms -D -i src-tauri/embedded.provisionprofile | plutil -extract Entitlements xml1 -o - - | grep -iE "icloud|ubiquity"` MUST return keys; empty → STOP.
4. **Read the EXACT iCloud key set the profile carries** — the plist must match it byte-for-byte (extra keys = Transporter-90889 vector).
5. **(If Decision 2 = yes)** mint a **Development** profile carrying the iCloud container + this Mac, for `--local-test` verification.

**Files (ONLY after the gate passes — declare what the profile declares):**
- `src-tauri/entitlements.mas.plist` — add exactly the iCloud keys the profile carries (typically all three: `icloud-container-identifiers`, `ubiquity-container-identifiers` = `["iCloud.com.clauding.clauge"]`, `icloud-services` = `["CloudDocuments"]`; if the profile carries a subset, declare only that subset). Keep the per-key comment style.
- `src-tauri/entitlements-sidecar.mas.plist` — **NO CHANGE** (helper inherits; landmine #33).
- `src-tauri/entitlements.local-test.plist` — **ADD the iCloud keys** (Decision 2) + pair with the Development profile so `--local-test` exercises the REAL coordinated write locally. Only pre-Review proof path.
- `src-tauri/tauri.mas.conf.json:7` — bump `bundleVersion "6" → "7"`. Semantic `version` stays `1.0.0` unless Decision 3 = cut version (then landmine #21 four-file lockstep).

**Verification:** post-build, parent shows iCloud keys; helper shows NONE (codesign entitlement dumps).

### Task 6 — Build, local-test verify, real-device gate, submit
**iCloud local-test (the only pre-Review path):**
```
/Users/adnanrashid/Projects/clauge/scripts/build-mas-clean.sh --local-test
pkill -TERM -f '/Applications/Clauge.app/Contents/MacOS/clauge' 2>/dev/null || true
rm -rf ~/Library/Containers/com.clauding.clauge   # fresh sandbox container
open src-tauri/target/universal-apple-darwin/release/bundle/macos/Clauge.app
```
Verify: wizard + sidecar boot; respawn single-writer check; coordinated write appears at `~/Library/Mobile Documents/iCloud~com~clauding~clauge/Documents/clauge-snapshot.json` with `seq` incrementing.

**Production .pkg:** `build-mas-clean.sh` (keeps `embedded.provisionprofile` — must carry iCloud). Gate submission on the local-test build proving the file appears AND syncs to the iPhone (②a only proved a RAW write). Submit via Transporter as **build 7** with the App-Review justification below.

**CI parity before any tag (landmine #29 + #21):** run `npm run check` VERBATIM (validators + `cargo fmt` + `clippy -D warnings` + `cargo test` + `npm test`). If a version cut happens, `cargo check --locked` before tagging.

---

## APP-REVIEW APP-SANDBOX JUSTIFICATION (submission notes)

> **iCloud Documents (CloudDocuments) capability justification.** Clauge writes a single compact analytics snapshot file (`clauge-snapshot.json`, ~6–10 KB) into its own iCloud Documents container (`iCloud.com.clauding.clauge`) so the user's companion Clauge iPhone app — signed in under the same Apple ID — can display the same Claude usage analytics the Mac app shows. The file contains only the user's own locally-computed Claude-usage statistics (token counts, session counts, cost rollups). There is no third-party data, no public CloudKit database, and no shared container — `CloudDocuments` is scoped strictly to the app's own ubiquity container. The write is performed by the sandboxed parent process under the app's own iCloud entitlement, coordinated via `NSFileCoordinator` for safe concurrent iCloud sync; the bundled helper process inherits the sandbox via `com.apple.security.inherit` and declares no entitlements of its own. This mirrors the rationale already documented for the app's `network.server` entitlement (local-only loopback): a minimal capability scoped to the user's own data, used solely to sync the user's analytics between their own devices.

---

## OUT OF SCOPE for ②b
- iPhone-side reader changes (existing iOS app / ②c).
- `NSMetadataQuery` download orchestration on the Mac (read side) — write-only producer.
- Any new Tauri IPC command (publish is supervisor-spawned/internal; IPC triple-registration does NOT apply unless a future `get_icloud_status` IPC is added — flag then).
