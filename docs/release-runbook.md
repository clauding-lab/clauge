# Clauge Release Runbook

Operational doc for shipping Clauge releases. Covers Apple Developer ID signing,
notarization, and recovering from common failures.

**Cross-references:**
- `.github/workflows/release.yml` — the actual pipeline
- `AGENTS.md` (landmines #2, #17, #18, #19, #21)
- `~/.claude/projects/-Users-adnanrashid-Projects-clauge/memory/project_apple_developer_enrollment.md`

---

## 1. Apple Developer ID Application certificate

### Lifecycle

- **Issued by:** developer.apple.com → Certificates section.
- **Validity:** 5 years from issue date.
- **Team ID:** `CY4FK9S7X9`.
- **Signed app validity after cert expiry:** still validates indefinitely because
  Tauri 2.x timestamps signatures with Apple's timestamp authority.
- **Renewal trigger:** ~6 months before cert expiry, generate a new Developer ID
  Application cert and update GitHub secrets.

### Generate or rotate the certificate

(Same steps as the v1.0.0 prereq A. Replicated here for reference.)

1. Sign into developer.apple.com.
2. Certificates → "+" → Developer ID Application.
3. Use Keychain Access → Certificate Assistant → Request a Certificate to
   generate a CSR. Upload to developer.apple.com. Download `.cer`. Install.
4. Export from Keychain Access as `.p12` with strong password.
5. `base64 -i clauge-dev-id.p12 | pbcopy`.
6. Update GitHub secret `APPLE_CERTIFICATE` (paste the base64 string).
7. Update `APPLE_CERTIFICATE_PASSWORD` if the password changed.
8. Verify the **identity string** in Keychain Access matches `APPLE_SIGNING_IDENTITY`
   secret: `Developer ID Application: <name> (CY4FK9S7X9)`.
9. Delete the .p12 file from disk after upload.

---

## 2. App Store Connect API key (for notarization)

### Lifecycle

- **Issued by:** appstoreconnect.apple.com → Users and Access → Integrations.
- **Validity:** indefinite, but rotate annually for security hygiene.
- **Rotation cadence:** annual or after suspected compromise.

### Rotate

1. ASC → Users and Access → Integrations → App Store Connect API.
2. Click your existing key → Revoke. Then create a new one.
3. Download the new `.p8` file. Record the Key ID and Issuer ID.
4. Update GitHub secrets:
   - `APPLE_API_KEY` = paste the new .p8 contents.
   - `APPLE_API_KEY_ID` = the new Key ID.
   - `APPLE_API_ISSUER` = unchanged (Issuer ID is per-account, not per-key).
5. Re-run the next release pipeline as a smoke test.

---

## 3. Apple Developer Program membership

### Lifecycle

- **Cost:** $99/year.
- **Renewal cadence:** annual, around 2027-05-17 for the current cycle.
- **Failure mode if lapsed:** certs continue to validate signed apps (timestamped),
  but you can't generate new certs and notarization stops. **New releases will fail at notarization.**

### Renew

1. Login to developer.apple.com → Membership.
2. Click "Renew" — Apple charges $99 immediately.
3. No CI changes required as long as Team ID stays `CY4FK9S7X9`.
4. Smoke-test the next release pipeline.

---

## 4. Notarization failure debugging

### Common causes (ranked)

1. **API key expired or revoked** — symptom: `xcrun notarytool` returns 401.
   Fix: rotate per Section 2 above.
2. **2FA state issue on Apple ID account** — symptom: app-specific password
   stops working. (If using API-key path, this doesn't apply.)
3. **Hardened-runtime entitlement mismatch** — symptom: notarization rejects
   the bundle with "the executable does not have the hardened runtime
   enabled." Fix: confirm Tauri's auto-applied hardened-runtime entitlement
   is intact in `src-tauri/entitlements.plist`. If missing, regenerate by
   running `tauri build --bundles dmg` locally and observing the entitlements
   applied.
4. **Bundle ID mismatch** — symptom: notarization succeeds but Gatekeeper
   rejects. Fix: confirm `src-tauri/tauri.conf.json` `identifier` is
   `com.clauding.clauge` and matches your provisioning profile.
5. **Apple service outage** — symptom: notarization times out > 30 min.
   Check https://developer.apple.com/system-status/. Re-run later.

### Debug procedure

1. From the failed CI run, download the `submission.json` artifact if Tauri
   uploaded one (it tries to). Otherwise check the run log for the
   `xcrun notarytool submit` output.
2. Get the submission UUID. Then:
   ```bash
   xcrun notarytool log <submission-uuid> \
     --key AuthKey_<KEY_ID>.p8 \
     --key-id <KEY_ID> \
     --issuer <ISSUER_ID>
   ```
3. The log JSON tells you exactly what Apple rejected.

---

## 5. Smoke-testing a signed DMG locally

After download:

```bash
# Verify signature
codesign -dvvv ~/Downloads/Clauge_*.dmg | grep "TeamIdentifier"
# Expected: TeamIdentifier=CY4FK9S7X9

# Verify notarization (strict — must show "source=Notarized Developer ID")
spctl -a -v --type install ~/Downloads/Clauge_*.dmg
# Expected: accepted, source=Notarized Developer ID

# Verify the staple ticket is attached
xcrun stapler validate ~/Downloads/Clauge_*.dmg
# Expected: The validate action worked!

# Verify the app inside
hdiutil attach ~/Downloads/Clauge_*.dmg
codesign -dvvv "/Volumes/Clauge*/Clauge.app" | grep TeamIdentifier
spctl -a -v --type execute "/Volumes/Clauge*/Clauge.app"
hdiutil detach "/Volumes/Clauge*"
```

---

## 6. Rollback procedure

If a signed release ships broken:

1. `gh release delete v1.X.Y --yes` — removes from auto-updater consideration.
2. `git push origin --delete v1.X.Y` — removes the tag.
3. The auto-updater's `latest.json` reverts to the previous release on next
   gh-pages sync (the workflow updates it from the latest non-deleted tag).
4. Inform users in Discord / Slack / GitHub issues.

No data migration is required for any v1.0.x rollback — auth state stays
in user Keychain entries that survive app reinstalls.
