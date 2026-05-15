# Empirical: where Windows Claude Code CLI stores OAuth credentials

**Date tested:** 2026-05-15 19:21 BDT
**Claude Code CLI version:** 2.1.142
**Node version:** v24.15.0
**npm version:** 11.12.1 (later upgraded to 11.14.1 mid-test)
**Windows build:** Windows 11 (test VM)
**Tested by:** adnanrashid

This note resolves the **Phase 7 Task A empirical-verify gate** in the Clauge
v0.6.0 Windows port plan
(`docs/superpowers/plans/2026-05-09-windows-implementation-plan.md`). All
subsequent Phase 7 work (CredentialStore trait + Windows backend, Task B) can
be designed with empirical certainty about the storage location.

## TL;DR

**Windows Claude Code CLI stores OAuth credentials in a per-user JSON file at:**

```text
%USERPROFILE%\.claude\.credentials.json
```

Concretely: `C:\Users\<username>\.claude\.credentials.json`.

NOT in Windows Credential Manager. NOT in `%APPDATA%\Anthropic\` or
`%LOCALAPPDATA%\Anthropic\` (the spec's first-guess candidate locations). The
file uses the Unix-style dot-prefix hidden-file convention (`.credentials.json`,
not `credentials.json`) — same convention as on macOS / Linux. The exact
filename including the leading dot matters.

## What I verified

### 1. Credential Manager: NOT used

Running `cmdkey /list` returned only two entries, both Microsoft system SSO
credentials unrelated to Claude Code:

```text
Target: MicrosoftAccount:target=SSO_POP_Device
Type: Generic
User: 02gfryqljlpibzpx
Saved for this logon only

Target: WindowsLive:target=virtualapp/didlogical
Type: Generic
User: 02gfryqljlpibzpx
Local machine persistence
```

`cmdkey /list | findstr /i "claude anthropic"` returned empty. Claude Code does
NOT write to Windows Credential Manager.

### 2. The first three candidate paths: NOT used

```text
%APPDATA%\Anthropic\Claude Code\credentials.json     → False
%LOCALAPPDATA%\Anthropic\Claude Code\credentials.json → False
%USERPROFILE%\.claude\credentials.json                → False  (no dot prefix)
```

### 3. Actual location

```text
%USERPROFILE%\.claude\.credentials.json  ← the dot-prefixed file
```

The full `%USERPROFILE%\.claude\` directory after `claude /login` contains:

```text
.claude\backups\          (empty during fresh test)
.claude\cache\            (changelog.md)
.claude\plugins\          (marketplace stubs)
.claude\projects\
.claude\sessions\
.claude\.credentials.json  ← the file
.claude\history.jsonl
.claude\settings.json
```

### 4. File metadata

```text
Length:        471 bytes
LastWriteTime: 5/15/2026 7:21:39 PM  (matches the `claude /login` completion)
Attributes:    Archive  (Windows default; readable by current user, no admin needed)
```

### 5. Schema (no secrets in this file)

PowerShell `ConvertFrom-Json` of the blob, walked recursively for
type-only display:

```text
claudeAiOauth : PSCustomObject
claudeAiOauth.accessToken     : String
claudeAiOauth.refreshToken    : String
claudeAiOauth.expiresAt       : Int64
claudeAiOauth.scopes          : Object[]
claudeAiOauth.subscriptionType: String
claudeAiOauth.rateLimitTier   : String
```

This is **byte-for-byte identical** to the schema Clauge already deserializes
from the macOS Keychain blob (`src-tauri/src/keychain.rs:27-52`,
`ClaudeCodeCreds` struct). Specifically:

| Field | Mac (Keychain blob) | Windows (file) | Note |
|---|---|---|---|
| `claudeAiOauth.accessToken` | String | String | OAuth bearer for api.anthropic.com |
| `claudeAiOauth.refreshToken` | Option<String> | String (observed present on fresh login) | Used to refresh access_token |
| `claudeAiOauth.expiresAt` | Option<i64> | Int64 (Unix epoch MILLIS) | Same units as Mac |
| `claudeAiOauth.scopes` | Option<Vec<String>> | Object[] | OAuth scopes granted |
| `claudeAiOauth.subscriptionType` | Option<String> | String | "max", "pro", "free" |
| `claudeAiOauth.rateLimitTier` | Option<String> | String | e.g. "default_claude_max_20x" |

**Implication: Clauge's existing `ClaudeCodeCreds` deserializer requires zero
schema changes to parse the Windows file.** The only Windows-specific code is
the file path resolution + `fs::read_to_string` call.

## Implications for Phase 7 Task B

The plan offered two branches based on Task A's outcome. **Branch 2 applies**:
"If Task A found a JSON file path." See plan lines 2179-2210.

The Windows backend in `src-tauri/src/credential_store/windows.rs` is a simple
filesystem reader, NOT a `keyring` crate wrapper. Sketch:

```rust
//! src-tauri/src/credential_store/windows.rs
use super::{ClaudeCodeCreds, CredentialError, CredentialStore};
use std::path::PathBuf;
use std::fs;

pub struct PlatformStore;

fn cli_creds_path() -> PathBuf {
    let userprofile = std::env::var("USERPROFILE").expect("USERPROFILE not set");
    PathBuf::from(userprofile).join(".claude").join(".credentials.json")
}

impl CredentialStore for PlatformStore {
    fn read_claude_code_creds(&self) -> Result<ClaudeCodeCreds, CredentialError> {
        let path = cli_creds_path();
        let blob = fs::read_to_string(&path)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => CredentialError::NotFound,
                _ => CredentialError::Backend(e.to_string()),
            })?;
        let parsed: ClaudeCodeCreds = serde_json::from_str(&blob)?;
        Ok(parsed)
    }
    // session cookie: Clauge-owned, separate concern.
    // Recommended: write to %USERPROFILE%\.claude\.clauge-session-cookie
    // (same .claude directory, separate Clauge-owned dot-file).
}
```

**No `keyring` crate dependency needed.** The Mac side keeps using
`security-framework` (already in tree); the Windows side uses `std::fs` only.

### Session cookie storage on Windows

For the v0.7.0 claude.ai sign-in path (Architecture A), the Mac side stores the
captured `sessionKey` cookie under a Clauge-owned Keychain service
`com.clauding.clauge.claude-ai-session` (see `src-tauri/src/claude_ai_session.rs:16`).
On Windows we don't have an analog vault, but we can mirror Claude Code's own
convention: write to a Clauge-owned dot-file alongside Claude Code's:

```text
%USERPROFILE%\.claude\.clauge-session-cookie
```

This puts both files in the same directory the user already trusts Claude Code
to read/write. Permissions inherit from the parent (current user only). The
filename's `.clauge-` prefix distinguishes it clearly from Claude Code's
`.credentials.json`. No collision risk.

Decision deferred to Phase 7 Task D (WebView2 cookie capture verification) —
if that task ships at all on Windows for v0.6.0, the session cookie persistence
will live here.

## Reproducing this finding

```powershell
# 1. Install + login
npm install -g @anthropic-ai/claude-code
claude /login          # complete browser OAuth

# 2. Confirm absence in Credential Manager
cmdkey /list           # scan for claude/anthropic — none present

# 3. Confirm presence at the dot-prefixed path
Test-Path "$env:USERPROFILE\.claude\.credentials.json"
# True

# 4. Inspect schema without exposing secrets
$creds = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
function ShowKeys($obj, $prefix = "") {
    if ($obj -is [PSCustomObject]) {
        foreach ($prop in $obj.PSObject.Properties) {
            $name = "$prefix$($prop.Name)"
            $type = if ($null -eq $prop.Value) { "null" } else { $prop.Value.GetType().Name }
            Write-Output "$name : $type"
            if ($prop.Value -is [PSCustomObject]) { ShowKeys $prop.Value "$name." }
        }
    }
}
ShowKeys $creds
```

## Open questions intentionally not answered here

- **Does Claude Code on Mac ALSO write to `~/.claude/.credentials.json`** as a
  fallback / mirror? Clauge currently reads from macOS Keychain Services and
  ignores `~/.claude/.credentials.json` if it exists. Worth a quick `ls -la
  ~/.claude/.credentials.json` check on a Mac with `claude /login` complete —
  but the answer is academic for the Windows port; Clauge can keep reading
  Keychain on Mac.
- **Refresh-token rotation**: does Claude Code automatically refresh the
  access token in-place when it expires? If yes, the file's
  `LastWriteTime` will tick; Clauge's `keychain_cache` invalidation logic on
  v0.7.2 might need to learn to watch mtime on Windows. Out of scope for
  v0.6.0; the cache TTL handles staleness.
- **Concurrent access**: what happens if Clauge reads the file while Claude
  Code is rewriting it (rare race during OAuth refresh)? Windows file locking
  semantics differ from POSIX. Acceptable risk for v0.6.0 — failure mode is
  one bad parse, retry on the next poll cycle.
