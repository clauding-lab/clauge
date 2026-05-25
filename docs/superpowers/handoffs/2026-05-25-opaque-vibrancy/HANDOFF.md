# Clauge v0.9.3 — opaque vibrancy design handoff

CodexBar-style opaque vibrancy treatment for the dashboard and v0.9.1 popover. Wallpaper hue tints faintly through; surface reads near-solid.

## Files

- **`Translucent Preview.html`** — visual reference. Open in a browser. Shows the dashboard (Overview tab) and the v0.9.1 popover side-by-side on a high-contrast checkered backdrop so the translucency reads clearly.
- **`README.md`** — patch instructions for Claude Code. Three touchpoints (`windows.rs` · `styles.css` · optional `splash.html`); no new Cargo deps.

## Design recipe (single source of truth)

| Layer | Value |
|---|---|
| **Window background** | `linear-gradient(180deg, rgba(30, 26, 38, 0.78) 0%, rgba(20, 18, 26, 0.82) 100%)` |
| **Backdrop filter** | `blur(60px) saturate(180%)` |
| **macOS material** | `NSVisualEffectMaterial::HudWindow`, `FollowsWindowActiveState` |
| **Brand sheen** | `radial-gradient(80% 50% at 0% 0%, rgba(217, 119, 87, 0.06), transparent 60%)` on `body::before` |
| **Card blur (inner glass)** | `blur(60px) saturate(180%)` |
| **Rim lights** | `inset 0 1px 0 rgba(244,236,228,0.10)` (top) + `inset 0 -1px 0 rgba(0,0,0,0.4)` (bottom) |
| **Border radius** | 14px (window), 18px (cards), 999px (pills) |

This is the **CodexBar parity** recipe — heavier than the earlier `rgba(26,24,32,0.22)` we tried. The deeper alpha (0.78–0.82) keeps text legible on any wallpaper while still letting hue bleed through via `saturate(180%)`.

## How to use with Claude Code

```
@handoff/v0.9.3-opaque/Translucent Preview.html
@handoff/v0.9.3-opaque/README.md

apply the patch in README.md. the preview HTML is the visual target — match
that opaque vibrancy feel on the dashboard window AND propagate to popover.css.
```

## Tuning knobs

If the look needs to drift:

| To get | Adjust |
|---|---|
| **More opaque** | bump body alpha to `0.85 → 0.90` |
| **More glassy** | drop to `0.55 → 0.65` |
| **More wallpaper hue** | bump `saturate()` to `220%` |
| **Less brand bleed** | drop brand sheen alpha from `0.06` → `0.03` |
| **Crisper edges** | drop blur to `40px` |
