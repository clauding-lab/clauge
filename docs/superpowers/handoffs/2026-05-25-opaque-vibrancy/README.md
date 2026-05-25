# Translucent dashboard — patch for Claude Code

Make the main dashboard window look like the **v0.9.1 popover**: cool-slate vibrancy base + brand-orange specular sheen, heavy blur, content stays legible. Same recipe `popover.css` already uses for `#root`.

**Touches:** `src-tauri/src/windows.rs` · `public/styles.css` · (optional) `public/splash.html`
**Deps:** none new — `window-vibrancy = "0.6"` is already in `src-tauri/Cargo.toml`.
**Risk:** low — all changes are isolated to the dashboard surface. Popover (`popover/`) is untouched.

---

## 1. `src-tauri/src/windows.rs`

### 1a. Add the import (top of file, near the existing `use tauri::…` line)

```rust
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[cfg(target_os = "windows")]
use window_vibrancy::{apply_acrylic, apply_mica};
```

### 1b. Flip the builder to transparent + drop the legacy background

Inside `create_dashboard`, find the `WebviewWindowBuilder::new(...)` chain and add `.transparent(true)`:

```rust
let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
    .title("Clauge")
    .inner_size(1100.0, 800.0)
    .min_inner_size(900.0, 600.0)
    .resizable(true)
    .transparent(true)   // ← NEW: lets the OS vibrancy layer show through
    .visible(true);
```

### 1c. Apply the vibrancy material after `.build()?`

Right after `let win = builder.…build()?;` (and before the macOS `on_window_event` hide-on-close handler), add:

```rust
// v0.9.3: translucent dashboard. NSVisualEffectView on macOS, Mica on
// Windows 11, Acrylic fallback for Windows 10. window-vibrancy already
// in Cargo.toml; macOSPrivateApi is on in tauri.conf.json.
#[cfg(target_os = "macos")]
{
    // Match the v0.9.1 popover: HudWindow material gives the cool dark
    // base the popover sits on; Sidebar or UnderWindowBackground are
    // lighter alternatives. FollowsWindowActiveState dims when the window
    // loses focus, which reads native; pass NSVisualEffectState::Active
    // for constant tint.
    if let Err(e) = apply_vibrancy(
        &win,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        Some(14.0), // matches our card corner radius
    ) {
        log::warn!("Failed to apply macOS vibrancy to dashboard: {}", e);
    }
}

#[cfg(target_os = "windows")]
{
    // Mica is Windows 11 only; falls through to Acrylic on Windows 10.
    if apply_mica(&win, Some(true)).is_err() {
        let tint = Some((26, 24, 32, 56)); // cool slate, low alpha
        if let Err(e) = apply_acrylic(&win, tint) {
            log::warn!("Failed to apply Windows vibrancy to dashboard: {}", e);
        }
    }
}
```

> **Why `FollowsWindowActiveState`?** macOS conventionally dims background-window vibrancy. Constant tint reads like a webapp; following active state reads like a native window. Use `NSVisualEffectState::Active` if you want it always lit.

---

## 2. `public/styles.css`

Two small edits to the `body { … }` block. Currently the linear-gradient is fully opaque — that's what's hiding the desktop.

### Replace this:

```css
body {
  min-height: 100vh;
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.45;
  color: var(--text);
  font-feature-settings: var(--tnum);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(50% 40% at 18% 0%, rgba(217, 119, 87, 0.18), transparent 60%),
    radial-gradient(40% 50% at 92% 18%, rgba(180, 92, 65, 0.10), transparent 60%),
    radial-gradient(60% 40% at 50% 100%, rgba(60, 40, 80, 0.10), transparent 70%),
    linear-gradient(180deg, #1a1410 0%, #110d0a 50%, #0d0a08 100%);
  background-attachment: fixed;
}
```

### With this (mirrors popover.css `#root` recipe):

```css
html, body { background: transparent; }

body {
  min-height: 100vh;
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.45;
  color: var(--text);
  font-feature-settings: var(--tnum);
  -webkit-font-smoothing: antialiased;
  /* v0.9.3: translucent dashboard. Cool-slate wash sits on top of the OS
   * vibrancy layer (NSVisualEffectView / Mica). Mirrors the v0.9.1 popover
   * recipe at popover.css `#root`. */
  background: rgba(26, 24, 32, 0.22);
  background-attachment: fixed;
  position: relative;
}

/* Brand-orange specular sheen, top-left — Clauge's identity touch on top
 * of the cool-slate base. Same pattern as `#root::before` in popover.css. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  background: radial-gradient(60% 40% at 0% 0%, rgba(217, 119, 87, 0.10), transparent 60%);
  pointer-events: none;
  z-index: -1;
}
```

**What changed:**
- `html, body { background: transparent }` ensures Tauri's transparent window paints through.
- The 4-stop warm-dark gradient is gone. The new base is **one solid cool-slate wash at 22% alpha** — same as `popover.css` line 67 (`rgba(26, 24, 32, 0.22)`).
- The brand-orange radial moves to `body::before` so it reads as a specular sheen instead of a baked-in tint, matching the popover's `#root::before`.

### Bump backdrop-filter on `.glass` (recommended)

The popover uses `blur(100px) saturate(200%)` on `#root`. Dashboard cards currently use `blur(40px) saturate(160%)` — too crisp for the new translucent base. Match the popover heaviness on the outer cards:

```css
.glass {
  background: var(--glass-1);
  -webkit-backdrop-filter: blur(100px) saturate(200%);  /* was: 40px / 160% */
          backdrop-filter: blur(100px) saturate(200%);
  /* …rest unchanged… */
}
```

Leave `.glass-pill` (30px) and `.icon-btn` (20px) as-is — those are smaller surfaces where a heavier blur reads muddy.

---

## 3. `public/splash.html` (optional but recommended)

The splash screen flashes for ~200–500ms on cold launch. If its background is opaque, the user sees a brief solid rectangle before the dashboard fades in translucent. Open `public/splash.html` and ensure its `body` / wrapper has `background: transparent` (or just a very thin tint).

Quick check:
```bash
grep -n background public/splash.html public/splash.css 2>/dev/null
```

If you see `#1a1410` or similar solid colors, swap them for `rgba(20, 16, 14, 0.35)` to match the dashboard's wash.

---

## 4. Verify

```bash
cd src-tauri
cargo build --release
cd ..
npm test                       # should stay green; no logic changed
cargo test                     # rust-side still green
npm run tauri dev              # eyeball it
```

Drag the dashboard window over a colorful wallpaper or a Finder window — you should see content bleed through behind the cards. The cards themselves stay legible because of the backdrop-filter blur.

---

## 5. Known gotchas

- **Linux**: `window-vibrancy` is a no-op on Linux (libappindicator/Wayland portals don't expose vibrancy uniformly). The `#[cfg]` blocks handle this — Linux falls back to the thin wash, which still looks reasonable.
- **macOS < 12**: `NSVisualEffectMaterial::HudWindow` requires 10.14+. Your `minimumSystemVersion: "12.0"` is well above that.
- **Windows 10 without acrylic**: `apply_acrylic` falls through silently on unsupported builds. The thin wash + backdrop-filter on cards still reads okay.
- **First-paint flash**: if you see a brief white flash before vibrancy kicks in, add `visible(false)` to the builder and `.show()` it after the vibrancy call. Tradeoff: ~50ms slower perceived launch.
- **Title-bar contrast**: the macOS traffic lights might get harder to see on bright wallpapers. The existing `TitleBarStyle::Overlay` + `hidden_title: true` is fine; if it becomes a complaint, switch to `TitleBarStyle::Transparent` and add a small dark wash to the topbar specifically.
- **Performance on intel Macs**: heavy backdrop-filter blur (60px) on a large window can cost ~5-10% GPU on older hardware. If you see frame drops, dial back to 40px.

---

## 6. Tuning knobs

If you want a `Settings → Appearance → Translucency` slider in v0.9.4+, the relevant levers:

| Knob | File | Default | CodexBar/Popover parity |
|---|---|---|---|
| macOS material | `windows.rs` | `HudWindow` | matches popover |
| Vibrancy state | `windows.rs` | `FollowsWindowActiveState` | `Active` for always-lit |
| Body wash | `styles.css` `body` background | `rgba(26, 24, 32, 0.22)` | identical to popover `#root` |
| Card blur | `styles.css` `.glass` | `100px / 200%` | identical to popover `#root` |
| Brand sheen | `styles.css` `body::before` | `0.10` brand radial | identical to popover `#root::before` |

If the wallpaper bleed is too much for some users, bump body to `rgba(26, 24, 32, 0.42)`; if it's too opaque, drop to `rgba(26, 24, 32, 0.14)`. The popover's `0.22` is the sweet spot we already validated.
