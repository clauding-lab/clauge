// Clauge Widget — PURE renderer for `clauge status`. Zero I/O, zero clock
// reads; every input is injected so the §4 locked render contract (spec:
// docs/superpowers/specs/2026-07-16-cli-statusline-widget-design.md rev 4)
// is testable byte-for-byte.
//
// Color grammar (owner-locked 2026-07-18; rev 6 recolor 2026-07-19):
//   magenta  model + git branch          yellow  hygiene base — Context Used
//   blue     working path, scoped gauges         <90% and Compactions 0–1
//   green/red lines added/removed        orange  hero-gauge warning ≥75% ONLY
//   cyan     session runtime             red     hero/Context ≥90%, compactions 2+
//   dim      separators, labels' context
// Hero gauges (Session / Weekly) color INDEPENDENTLY: green <75, orange ≥75,
// red ≥90. Scoped gauges are blue ALWAYS (rev 5.1). Money (Spend/ROI) left
// the widget in rev 6 — /v1 still serves those lines; the widget no longer
// reads them. Orange is 256-color (\x1b[38;5;208m) with plain yellow as the
// 8/16-color fallback — never collapse orange into the hygiene yellow on
// capable terminals. Everything must still read with colors stripped: the
// numbers carry the meaning, color is emphasis.
//
// ANSI is deliberately raw escape codes — no chalk (this file DEFINES the
// codebase's ANSI convention; see spec §3).

const CODES = {
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  orange256: '\x1b[38;5;208m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Rev 5 (2026-07-19, owner request): scoped-limit gauges. /v1 progress lines
// shaped `Weekly (<label>)` / `Session (<label>)` (e.g. `Weekly (Fable)`)
// render as gauges, wire order, capped at 2 for line-width protection.
// Rev 6 moved them from line 2 to the leading position of line 3.
const SCOPED_GAUGES_MAX = 2;
const SCOPED_LABEL_RE = /^(?:Session|Weekly) \((.+)\)$/;

// Externally-sourced text (stdin payload fields, git branch, cache//v1 line
// values) is printed to the HOST terminal every render. Strip every C0
// control (ESC, BEL, CR, LF, TAB, …), DEL, and C1 byte so a hostile repo
// directory name or a poisoned cache can't smuggle OSC52 clipboard writes,
// title-set, cursor movement, or forged widget lines (security review P1,
// 2026-07-18). The renderer adds its own SGR codes AFTER this.
function sanitize(text) {
  return String(text).replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

/**
 * Truncate a possibly-ANSI-colored string to `width` VISIBLE characters.
 * Escape sequences pass through uncounted; a reset is appended when the
 * cut output still carries any escape, so a mid-color cut can't bleed
 * into the host's own rendering.
 */
export function truncateAnsi(str, width) {
  let visible = 0;
  let out = '';
  let i = 0;
  let sawEscape = false;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (match) {
        out += match[0];
        sawEscape = true;
        i += match[0].length;
        continue;
      }
    }
    if (visible >= width) break;
    // Iterate by code point so multi-byte glyphs (▓ ░ ⧗ ×) count as one.
    const cp = String.fromCodePoint(str.codePointAt(i));
    out += cp;
    visible += 1;
    i += cp.length;
  }
  if (sawEscape && i < str.length) out += CODES.reset;
  return out;
}

function makePaint(ansi, orange256) {
  const orange = orange256 ? CODES.orange256 : CODES.yellow;
  const wrap = (code) => (text) => (ansi ? `${code}${text}${CODES.reset}` : `${text}`);
  return {
    magenta: wrap(CODES.magenta),
    blue: wrap(CODES.blue),
    green: wrap(CODES.green),
    red: wrap(CODES.red),
    cyan: wrap(CODES.cyan),
    yellow: wrap(CODES.yellow),
    orange: wrap(orange),
    dim: wrap(CODES.dim),
  };
}

function gaugePaint(pct, paint) {
  if (pct >= 90) return paint.red;
  if (pct >= 75) return paint.orange;
  return paint.green;
}

// Rev 6: the hygiene pair (Context Used, Compactions) renders yellow as its
// base and keeps only the red emergency tier — ≥90% context / 2+ compactions.
// The orange middle tier is hero-gauge-only now.
function hygienePaint(isCritical, paint) {
  return isCritical ? paint.red : paint.yellow;
}

function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function formatResets(resetsAtIso, nowMs) {
  const at = Date.parse(resetsAtIso);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  const minutes = Math.floor((at - nowMs) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatAge(ageMs) {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

function abbreviateHome(dir, homeDir) {
  if (homeDir && (dir === homeDir || dir.startsWith(homeDir + '/'))) {
    return `~${dir.slice(homeDir.length)}`;
  }
  return dir;
}

// ── Line 1: working context — every segment stdin- or git-sourced, each
//    omitted independently when its field is missing (parse defensively,
//    never crash on someone else's payload).
function buildLine1(payload, branch, paint, homeDir) {
  const segments = [];
  const model = payload?.model?.display_name;
  if (typeof model === 'string' && model !== '') segments.push(paint.magenta(sanitize(model)));

  const dir = payload?.workspace?.current_dir ?? payload?.cwd;
  if (typeof dir === 'string' && dir !== '') {
    segments.push(paint.blue(sanitize(abbreviateHome(dir, homeDir))));
  }

  const added = payload?.cost?.total_lines_added;
  const removed = payload?.cost?.total_lines_removed;
  if (Number.isFinite(added) && Number.isFinite(removed)) {
    segments.push(`${paint.green(`+${added}`)}${paint.dim('/')}${paint.red(`-${removed}`)}`);
  }

  const durationMs = payload?.cost?.total_duration_ms;
  if (Number.isFinite(durationMs)) {
    segments.push(paint.cyan(`⧗ ${formatDuration(durationMs)}`));
  }

  // git forbids control chars in refnames, but sanitize anyway — defense
  // in depth costs nothing here.
  if (typeof branch === 'string' && branch !== '') segments.push(paint.magenta(sanitize(branch)));
  return segments;
}

// Shared by hero (Session/Weekly) and scoped (`Weekly (<label>)`) gauges so
// their output stays byte-identical: `<Label> <10-cell bar> <pct>% (resets
// <rel>)`, resets suffix omitted when resets_at is absent. Returns null when
// `used` isn't a finite number. `colorize` defaults to the threshold-based
// gaugePaint (hero gauges); scoped gauges pass a fixed paint (rev 5.1 —
// always blue, never the warning thresholds) so hero call sites stay
// byte-identical without passing anything new.
function buildGaugeSegment(label, line, paint, nowMs, colorize) {
  if (!Number.isFinite(line.used)) return null;
  const paintFn = colorize ?? gaugePaint(line.used, paint);
  let segment = `${label} ${paintFn(bar(line.used))} ${paintFn(`${line.used}%`)}`;
  const resets = line.resets_at != null ? formatResets(line.resets_at, nowMs) : null;
  if (resets) segment += ` ${paint.dim(`(resets ${resets})`)}`;
  return segment;
}

// ── Line 2: hero quota gauges — Session and Weekly progress lines from the
//    /v1 snapshot, each colored independently on its own value. Rev 6
//    (2026-07-19, owner request): hero-only again — the rev-5 scoped gauges
//    moved to line 3.
function buildLine2(snapshot, paint, nowMs) {
  const segments = [];
  for (const label of ['Session', 'Weekly']) {
    const line = snapshot.lines?.find((l) => l?.type === 'progress' && l?.label === label);
    if (!line) continue;
    const segment = buildGaugeSegment(label, line, paint, nowMs);
    if (segment) segments.push(segment);
  }
  return segments;
}

// ── Line 3: scoped gauges + hygiene. Rev 6 (2026-07-19, owner request):
//    the money pair (Spend / ROI) left the widget — /v1 still serves those
//    text lines (frozen surface, landmine #47); this renderer no longer
//    reads them. Scoped-limit gauges (rev 5 shape: wire order, cap
//    SCOPED_GAUGES_MAX, blue always per rev 5.1) lead the line, followed by
//    Context Used and Compactions — yellow base, red at ≥90% / 2+.
function buildLine3(snapshot, payload, compactions, paint, nowMs) {
  const segments = [];

  let scopedCount = 0;
  for (const line of snapshot.lines ?? []) {
    if (scopedCount >= SCOPED_GAUGES_MAX) break;
    if (line?.type !== 'progress' || typeof line.label !== 'string') continue;
    const match = SCOPED_LABEL_RE.exec(line.label);
    if (!match) continue;
    // Wire data — same defense-in-depth as the git-branch/model segments.
    const segment = buildGaugeSegment(sanitize(match[1]), line, paint, nowMs, paint.blue);
    if (!segment) continue;
    segments.push(segment);
    scopedCount += 1;
  }

  const ctx = payload?.context_window?.used_percentage;
  if (Number.isFinite(ctx)) {
    segments.push(`Context Used ${hygienePaint(ctx >= 90, paint)(`${ctx}%`)}`);
  }

  if (Number.isFinite(compactions)) {
    segments.push(`Compactions ${hygienePaint(compactions >= 2, paint)(String(compactions))}`);
  }
  return segments;
}

/**
 * Render the Clauge Widget. Returns the full multi-line string (no trailing
 * newline). Never throws on missing fields — segments are omitted instead.
 *
 * inputs: {
 *   payload      parsed statusLine stdin JSON | null
 *   snapshot     /v1/usage claude snapshot | null (live or cache)
 *   branch       git branch | null
 *   compactions  compact_boundary count | null
 *   cacheAgeMs   non-null ⇒ snapshot came from the stale cache; age shown
 *   nowMs        injected clock
 *   homeDir      for ~ path abbreviation
 * }
 * opts: { ansi = true, orange256 = true, maxWidth = null }
 */
export function renderStatus(inputs, opts = {}) {
  const { payload, snapshot, branch, compactions, cacheAgeMs, nowMs, homeDir } = inputs;
  const { ansi = true, orange256 = true, maxWidth = null } = opts;
  const paint = makePaint(ansi, orange256);
  const sep = ` ${paint.dim('·')} `;

  const lines = [];
  const line1 = buildLine1(payload, branch, paint, homeDir);
  if (line1.length > 0) lines.push(line1.join(sep));

  if (!snapshot) {
    // Degrade ladder floor: no live data, no cache. The stdin-sourced line
    // still renders; the notice replaces the API-sourced lines wholesale.
    lines.push(paint.dim('clauge: app not running'));
    return lines.join('\n');
  }

  const line2 = buildLine2(snapshot, paint, nowMs);
  if (line2.length > 0) lines.push(line2.join(sep));

  const line3 = buildLine3(snapshot, payload, compactions, paint, nowMs);
  if (line3.length > 0) lines.push(line3.join(sep));

  if (lines.length === 0) {
    lines.push(paint.dim('clauge: app not running'));
  } else if (Number.isFinite(cacheAgeMs)) {
    lines[lines.length - 1] += ` ${paint.dim(`· ${formatAge(cacheAgeMs)}`)}`;
  }

  const out = lines.join('\n');
  if (!Number.isInteger(maxWidth) || maxWidth <= 0) return out;
  return out
    .split('\n')
    .map((line) => truncateAnsi(line, maxWidth))
    .join('\n');
}
