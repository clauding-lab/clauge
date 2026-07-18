// Clauge popover (v0.9.1 redesign).
//
// Loads inside the native NSPopover's WKWebView, served by the SEA sidecar at
// http://127.0.0.1:{port}/popover/index.html. /api/* fetches are same-origin.
// JS → Rust messages (open_dashboard, resize, quit) go through
// window.webkit.messageHandlers.clauge (see native_popover.rs::ClaugeScriptHandler).

// ────────────────────────────────────────────────────────────
// State + constants
// ────────────────────────────────────────────────────────────
let serverPort = 3456;
let serverVersion = '0.5.0';
let lastGoodUsage = null;       // SWR keep-last-good cache for /api/usage
let lastGoodProjection = null;  // SWR keep-last-good cache for /api/projection (own cache; pickUsage is payload-agnostic)
let refreshInFlight = false;    // overlap guard: skip a tick if a refresh is still running

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BURN_FAST_THRESHOLD = 10;       // usage% > time_elapsed% + 10 = burning_fast
const HEADROOM_THRESHOLD = 10;        // time_elapsed% > usage% + 10 = headroom
const ROUTINES_DAILY_CAP = 15;

// ────────────────────────────────────────────────────────────
// Pure helpers — exposed on window for testing in the dev console
// ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtUSD(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Translate Anthropic's machine-readable `extra_usage.disabled_reason` enum
 * into a short human-readable label for the popover.
 */
function humanizeDisabledReason(reason) {
  if (!reason) return '';
  const map = {
    org_level_disabled_until: t('extra.reasonOrgLevelDisabled'),
    plan_limit_reached: t('extra.reasonPlanLimit'),
    payment_required: t('extra.reasonPaymentRequired'),
    not_enrolled: t('extra.reasonNotEnrolled'),
    suspended: t('extra.reasonSuspended'),
  };
  return map[reason] ?? reason.replace(/_/g, ' ');
}

/**
 * Sum all token fields into a single number. summary.tokens has the shape
 * { inputTokens, outputTokens, cacheRead, cacheCreate5m, cacheCreate1h,
 *   webSearches, webFetches } — there's no precomputed `.total`.
 */
function sumTokens(t) {
  if (!t || typeof t !== 'object') return null;
  const fields = ['inputTokens', 'outputTokens', 'cacheRead', 'cacheCreate5m', 'cacheCreate1h'];
  let sum = 0;
  let any = false;
  for (const k of fields) {
    const v = t[k];
    if (Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function fmtRelative(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms)) return '—';
  // TODO(b1): duration fragments below (`now`, `Xd Yh`, etc.) are user-visible
  // micro-format strings flowed into session.resetsIn / sonnet.resets as the
  // {duration} param. Left inline as atomic time abbreviations — migrate to
  // copy.json if/when these get localized.
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// Absolute local reset time to pair beneath the relative "resets in …" line.
// Smart: time-only when the reset is today (e.g. "8:07 PM"), weekday + time when
// it's a later day (e.g. "Thu 5:00 AM"). Uses the machine's local timezone.
function fmtResetClock(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date(nowMs);
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/**
 * Map one /api/projection window to a forecast copy line.
 * Returns { key, params } for will_hit / safe / exhausted, or null when the
 * line must be hidden (warming_up / stale / unavailable / missing window).
 * Times reuse fmtResetClock so the forecast clock matches the reset captions
 * (local short time, weekday prefix when the moment is not today).
 */
function projectionLineCopy(win, nowMs = Date.now()) {
  if (!win || typeof win !== 'object') return null;
  switch (win.state) {
    case 'will_hit':
      return { key: 'projection.willHit', params: { time: fmtResetClock(win.etaAt, nowMs) } };
    case 'safe':
      return Number.isFinite(win.projectedEndPct)
        ? { key: 'projection.safe', params: { pct: win.projectedEndPct } }
        : null;
    case 'exhausted':
      return { key: 'projection.exhausted', params: { time: fmtResetClock(win.resetsAt, nowMs) } };
    default:
      return null; // warming_up | stale | unavailable — line hidden
  }
}

/**
 * "+15" / "-3" sign formatting for the week-over-week delta. Returns null
 * (line hidden) when weekOverWeek is absent — the server already gates it to
 * will_hit/safe states, so absence covers stale/warming_up/exhausted too.
 */
function wowLineCopy(weekOverWeek) {
  if (!weekOverWeek || !Number.isFinite(weekOverWeek.deltaPts)) return null;
  const d = weekOverWeek.deltaPts;
  return { key: 'projection.wow', params: { delta: d > 0 ? `+${d}` : String(d) } };
}

function renderForecastLine(elId, copy) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = copy ? t(copy.key, copy.params) : '';
}

// Render the hero-pair forecast lines from /api/projection. Only fiveHour +
// sevenDay are displayed in sub-project A; null projection (cold-start fetch
// failure with no last-good) empties all three lines (CSS :empty hides them).
function renderProjection(projection, nowMs) {
  const windows = projection?.windows ?? {};
  renderForecastLine('session-forecast', projectionLineCopy(windows.fiveHour, nowMs));
  renderForecastLine('weekly-forecast', projectionLineCopy(windows.sevenDay, nowMs));
  renderForecastLine('weekly-wow', wowLineCopy(windows.sevenDay?.weekOverWeek));
}

/**
 * Compute how much of a fixed-duration window has elapsed, as a 0..100
 * percentage. `resetsAt` is the END of the window; subtracting `windowMs`
 * gives the start. Returns 100 when the reset is past or unknown
 * (treat as fully-elapsed so the needle pins to the right rather than
 * snapping to 0 unexpectedly).
 */
function timeElapsedPct(resetsAtIso, windowMs, nowMs = Date.now()) {
  if (!resetsAtIso) return 100;
  const resetsAt = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsAt)) return 100;
  const startedAt = resetsAt - windowMs;
  const elapsed = nowMs - startedAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= windowMs) return 100;
  return (elapsed / windowMs) * 100;
}

/**
 * Compact form for the paired hero gauges (each column ~150px wide).
 * Session: "3h 12m of 5h" / Weekly: "Day 5 of 7".
 */
function formatElapsedCompact(resetsAtIso, windowMs, mode, nowMs = Date.now()) {
  if (!resetsAtIso) return mode === 'weekly' ? t('weekly.dayUnknown') : t('session.elapsedEmpty');
  const resetsAt = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsAt)) return t('common.dash');
  const startedAt = resetsAt - windowMs;
  const elapsedMs = Math.max(0, Math.min(windowMs, nowMs - startedAt));
  if (mode === 'weekly') {
    const day = Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1;
    return t('weekly.dayOf7', { day });
  }
  const h = Math.floor(elapsedMs / 3600000);
  const m = Math.floor((elapsedMs % 3600000) / 60000);
  if (h > 0) return t('session.elapsedOf5h', { hours: h, minutes: m });
  return t('session.elapsedOf5hShort', { minutes: m });
}

/**
 * Format the "X of Y elapsed" label for the Session/Weekly gauges.
 * Returns "Xh Ym of 5h elapsed" for sessions, "Day X of 7 elapsed" for weekly.
 *
 * TODO(b1): dev-console helper only (exposed on window.__clauge for ad-hoc
 * testing) — not rendered anywhere in the UI. Migrate to copy.json if/when
 * this becomes a displayed label.
 */
function formatElapsed(resetsAtIso, windowMs, mode, nowMs = Date.now()) {
  if (!resetsAtIso) return mode === 'weekly' ? 'Day — of 7 elapsed' : '— of 5h elapsed';
  const resetsAt = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsAt)) return '— elapsed';
  const startedAt = resetsAt - windowMs;
  const elapsedMs = Math.max(0, Math.min(windowMs, nowMs - startedAt));
  if (mode === 'weekly') {
    const day = Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1;
    return `Day ${day} of 7 elapsed`;
  }
  // session mode: hours + minutes
  const h = Math.floor(elapsedMs / 3600000);
  const m = Math.floor((elapsedMs % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m of 5h elapsed`;
  return `${m}m of 5h elapsed`;
}

/**
 * Compare usage vs time-elapsed to classify burn rate.
 * 'burning_fast' → usage outpacing time by >10pp (over-burn red tint applies)
 * 'headroom'     → time outpacing usage by >10pp
 * 'on_pace'      → within 10pp either way
 */
function burnState(usagePct, timeElapsedPctValue) {
  if (!Number.isFinite(usagePct) || !Number.isFinite(timeElapsedPctValue)) return 'on_pace';
  if (usagePct > timeElapsedPctValue + BURN_FAST_THRESHOLD) return 'burning_fast';
  if (timeElapsedPctValue > usagePct + HEADROOM_THRESHOLD) return 'headroom';
  return 'on_pace';
}

// ────────────────────────────────────────────────────────────
// Fetch
// ────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 5000; // frontend per-call abort budget (Item 6)

async function fetchJson(path) {
  const { signal, clear } = window.ClaugeSwr.fetchTimeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(path, { signal });
    if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
    return await res.json();
  } finally {
    clear();
  }
}

// ────────────────────────────────────────────────────────────
// Render: circle gauge (used for both Session and Weekly hero panes)
// ────────────────────────────────────────────────────────────
function renderCircleGauge({ elId, usagePct, timeElapsedPctValue, label }) {
  const el = document.getElementById(elId);
  if (!el) return;
  const usage = Math.max(0, Math.min(100, usagePct ?? 0));
  const elapsed = Math.max(0, Math.min(100, timeElapsedPctValue ?? 0));
  const burn = burnState(usage, elapsed);

  // Geometry: SVG viewBox 120x120 (room for outer marker), ring r=46 stroke
  // 8px → ring outer edge at radius 50. Marker triangle lives in the 50–58
  // band, pointing inward from outside.
  const cx = 60;
  const cy = 60;
  const r = 46;
  const c = 2 * Math.PI * r;
  const usageArc = (usage / 100) * c;
  const usageOffset = c - usageArc;

  // Time-elapsed angle: 0% = 12 o'clock, clockwise.
  const angleRad = (elapsed / 100) * 2 * Math.PI - Math.PI / 2;

  // Triangle marker pointing inward, sitting just outside the ring stroke.
  // Tip at radius 51, base at radius 57, base half-width 3 — gives a 6-unit
  // deep × 6-unit wide marker that reads as a clear external needle.
  const tipR = 51;
  const baseR = 57;
  const baseHalf = 3;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const tipX = cx + tipR * cosA;
  const tipY = cy + tipR * sinA;
  // Base center then ±perpendicular for the two base corners.
  const baseCX = cx + baseR * cosA;
  const baseCY = cy + baseR * sinA;
  const base1X = baseCX - baseHalf * sinA;
  const base1Y = baseCY + baseHalf * cosA;
  const base2X = baseCX + baseHalf * sinA;
  const base2Y = baseCY - baseHalf * cosA;
  const markerPoints = `${tipX.toFixed(2)},${tipY.toFixed(2)} ${base1X.toFixed(2)},${base1Y.toFixed(2)} ${base2X.toFixed(2)},${base2Y.toFixed(2)}`;

  // Over-burn segment: red arc from the needle position past the rim.
  const overflowVisible = burn === 'burning_fast';
  const overflowArc = Math.max(0, (usage - elapsed) / 100) * c;
  const overflowOffset = c - overflowArc;
  const overflowRotation = (elapsed / 100) * 360;

  el.innerHTML = `
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(244, 236, 228, 0.10)" stroke-width="8"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#d97757"
        stroke-width="8"
        stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}"
        stroke-dashoffset="${usageOffset.toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})"/>
      ${overflowVisible ? `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
          stroke="#c97a7a"
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray="${c.toFixed(2)}"
          stroke-dashoffset="${overflowOffset.toFixed(2)}"
          transform="rotate(${(-90 + overflowRotation).toFixed(2)} ${cx} ${cy})"/>
      ` : ''}
      <polygon points="${markerPoints}"
        fill="rgba(244, 236, 228, 0.92)"
        stroke="rgba(0, 0, 0, 0.45)"
        stroke-width="0.5"
        stroke-linejoin="round"/>
    </svg>
    <div class="gauge-center">
      <div>
        <span class="gauge-pct">${Math.round(usage)}</span><span class="gauge-pct-suffix">%</span>
      </div>
      <div class="gauge-sub-label">${escapeHtml(label)}</div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// Render: needle bar (Weekly)
// ────────────────────────────────────────────────────────────
function renderNeedleBar({ wrapId, needleId, fillId, overflowId, usagePct, timeElapsedPctValue }) {
  const usage = Math.max(0, Math.min(100, usagePct ?? 0));
  const elapsed = Math.max(0, Math.min(100, timeElapsedPctValue ?? 0));
  const burn = burnState(usage, elapsed);

  const needle = document.getElementById(needleId);
  const fill = document.getElementById(fillId);
  const overflow = document.getElementById(overflowId);

  if (needle) needle.style.left = `${elapsed.toFixed(1)}%`;

  if (burn === 'burning_fast') {
    // Orange fill stops at elapsed%; red overflow takes over from there to usage%.
    if (fill) fill.style.width = `${elapsed.toFixed(1)}%`;
    if (overflow) {
      overflow.style.left = `${elapsed.toFixed(1)}%`;
      overflow.style.width = `${(usage - elapsed).toFixed(1)}%`;
    }
  } else {
    if (fill) fill.style.width = `${usage.toFixed(1)}%`;
    if (overflow) overflow.style.width = '0%';
  }
}

// ────────────────────────────────────────────────────────────
// Render: simple bar (Sonnet only, Claude Design, Daily Routines, Extra)
// ────────────────────────────────────────────────────────────
function renderSimpleBar({ fillId, overflowId, usagePct, capPct = 100 }) {
  const usage = Math.max(0, usagePct ?? 0);
  const fill = document.getElementById(fillId);
  const overflow = document.getElementById(overflowId);

  if (usage <= capPct) {
    // Normal: orange fill at usage%, no red overflow.
    if (fill) fill.style.width = `${usage.toFixed(1)}%`;
    if (overflow) {
      overflow.style.left = `${usage.toFixed(1)}%`;
      overflow.style.width = '0%';
    }
    return;
  }

  // Over the cap: REPROPORTION the bar so the visible 100% represents 0..usage.
  // Orange covers capPct/usage of the bar (the cap), red covers the rest (the
  // overage). For 196% on a 100% cap: orange 51%, red 49%.
  const orangePct = (capPct / usage) * 100;
  if (fill) fill.style.width = `${orangePct.toFixed(1)}%`;
  if (overflow) {
    overflow.style.left = `${orangePct.toFixed(1)}%`;
    overflow.style.width = `${(100 - orangePct).toFixed(1)}%`;
  }
}

// ────────────────────────────────────────────────────────────
// Render: full popover from /api/usage payload
// ────────────────────────────────────────────────────────────
function renderPlanBadge(plan) {
  // Extract a plan name. Without a dedicated server field, best-effort
  // from common signals: extraUsage.enabled + non-zero limit suggests "Max"
  // or similar paid tier; otherwise show "—".
  const extra = plan?.extraUsage;
  const el = document.getElementById('po-plan-badge');
  if (!el) return;
  // Default to Max (most Clauge users); future: surface a real subscription
  // tier field from the server.
  el.textContent = extra && extra.enabled ? t('header.planMax') : t('header.planUnknown');
}

function renderSession(plan, nowMs) {
  const fiveHour = plan?.fiveHour;
  const usagePct = fiveHour?.pct ?? 0;
  const resetsAt = fiveHour?.resetsAt;
  const elapsed = timeElapsedPct(resetsAt, FIVE_HOURS_MS, nowMs);
  renderCircleGauge({
    elId: 'session-gauge',
    usagePct,
    timeElapsedPctValue: elapsed,
    label: t('session.label'),
  });
  // Compact meta for the paired hero gauges: "Xh Ym of 5h" + "resets in Yh Zm".
  document.getElementById('session-elapsed').textContent = formatElapsedCompact(resetsAt, FIVE_HOURS_MS, 'session', nowMs);
  document.getElementById('session-reset').textContent = t('session.resetsIn', { duration: fmtRelative(resetsAt, nowMs) });
  document.getElementById('session-reset-clock').textContent = fmtResetClock(resetsAt, nowMs);
}

function renderWeekly(plan, nowMs) {
  const sevenDay = plan?.sevenDay;
  const usagePct = sevenDay?.pct ?? 0;
  const resetsAt = sevenDay?.resetsAt;
  const elapsed = timeElapsedPct(resetsAt, SEVEN_DAYS_MS, nowMs);
  renderCircleGauge({
    elId: 'weekly-gauge',
    usagePct,
    timeElapsedPctValue: elapsed,
    label: t('weekly.label'),
  });
  document.getElementById('weekly-elapsed').textContent = formatElapsedCompact(resetsAt, SEVEN_DAYS_MS, 'weekly', nowMs);
  document.getElementById('weekly-reset').textContent = t('session.resetsIn', { duration: fmtRelative(resetsAt, nowMs) });
  document.getElementById('weekly-reset-clock').textContent = fmtResetClock(resetsAt, nowMs);
}

/**
 * Build one scoped-limit bar (label, simple-bar fill, percent/reset meta rows)
 * reusing the same classes as the old static Sonnet-only markup so existing
 * CSS applies unchanged. Wire-sourced label text goes in via textContent only
 * — never innerHTML — per the wire-data discipline for this payload.
 */
function buildScopedWindowEl(win, nowMs) {
  const pct = Math.max(0, Number.isFinite(win?.pct) ? win.pct : 0);
  const qualifier = win?.group === 'session' ? t('scoped.windowSession') : t('scoped.windowWeekly');

  const wrap = document.createElement('div');
  wrap.className = 'scoped-window';

  const labelEl = document.createElement('h2');
  labelEl.className = 'sect-label';
  labelEl.textContent = `${win?.label ?? ''} · ${qualifier}`;
  wrap.appendChild(labelEl);

  const bar = document.createElement('div');
  bar.className = 'simple-bar';
  const fill = document.createElement('div');
  fill.className = 'simple-bar-fill';
  fill.style.width = `${pct.toFixed(1)}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const meta = document.createElement('div');
  meta.className = 'bar-meta';
  const pctEl = document.createElement('span');
  pctEl.className = 'bar-meta-pct mono';
  pctEl.textContent = t('sonnet.percentUsed', { percent: Math.round(pct) });
  meta.appendChild(pctEl);
  const resetEl = document.createElement('span');
  resetEl.className = 'mono';
  resetEl.textContent = win?.resetsAt
    ? t('session.resetsIn', { duration: fmtRelative(win.resetsAt, nowMs) })
    : '';
  meta.appendChild(resetEl);
  wrap.appendChild(meta);

  const metaSub = document.createElement('div');
  metaSub.className = 'bar-meta bar-meta-sub';
  metaSub.appendChild(document.createElement('span'));
  const clockEl = document.createElement('span');
  clockEl.className = 'mono reset-clock';
  clockEl.textContent = fmtResetClock(win?.resetsAt, nowMs);
  metaSub.appendChild(clockEl);
  wrap.appendChild(metaSub);

  return wrap;
}

function renderScoped(plan, nowMs) {
  const section = document.getElementById('scoped-section');
  const container = document.getElementById('scoped-bars');
  if (!section || !container) return;

  // Preferred: the normalized scopedWindows list (labels from the wire).
  // Legacy fallback: synthesize a single weekly window from sevenDaySonnet so
  // old stored/cached records (ingested before this release) still render
  // something instead of going blank.
  const sonnet = plan?.sevenDaySonnet;
  const windows = Array.isArray(plan?.scopedWindows) && plan.scopedWindows.length > 0
    ? plan.scopedWindows
    : (sonnet?.pct != null
      ? [{ label: t('sonnet.label'), pct: sonnet.pct, resetsAt: sonnet.resetsAt, group: 'weekly' }]
      : []);

  // Mirror renderDesign's gate style: hide the whole section when the list is
  // empty instead of showing a phantom bar.
  section.hidden = windows.length === 0;

  // Rebuild children every tick — no long-lived CSS-animated children live
  // inside #scoped-bars (landmine #22 documented exception for the popover).
  container.textContent = '';
  for (const win of windows) {
    container.appendChild(buildScopedWindowEl(win, nowMs));
  }
}

function renderDesign(plan, nowMs) {
  const design = plan?.claudeDesign;
  // Anthropic dropped the Claude Design weekly bucket; when the payload has no
  // claudeDesign window, hide the whole section instead of showing a phantom
  // "0% used · resets —" bar. It reappears automatically if the bucket returns.
  const section = document.getElementById('design-section');
  if (section) section.hidden = !design;
  if (!design) return;
  const pct = design.pct ?? 0;
  renderSimpleBar({ fillId: 'design-fill', usagePct: pct });
  document.getElementById('design-pct').textContent = t('sonnet.percentUsed', { percent: Math.round(pct) });
  document.getElementById('design-reset').textContent = design.resetsAt
    ? t('session.resetsIn', { duration: fmtRelative(design.resetsAt, nowMs) })
    : '';
}

function renderRoutines(plan, nowMs) {
  const r = plan?.dailyRoutines;
  // Mirror renderDesign's gate: when the payload has no dailyRoutines bucket,
  // hide the section instead of phantoming "0 of 15 runs" (a dropped bucket on
  // a failed/partial fetch must not read as a real zero). Reappears if it
  // returns.
  const section = document.getElementById('routines-section');
  if (section) section.hidden = !r;
  if (!r) return;
  // Routines is a daily count, capped at 15. The pct field is the upstream's
  // utilization. If we have raw count later, swap to count/15 directly.
  const pct = r?.pct ?? 0;
  const count = Math.round((pct / 100) * ROUTINES_DAILY_CAP);
  renderSimpleBar({ fillId: 'routines-fill', usagePct: pct });
  document.getElementById('routines-count').textContent = t('routines.runsToday', { count, cap: ROUTINES_DAILY_CAP });
  document.getElementById('routines-reset').textContent = r?.resetsAt
    ? t('session.resetsIn', { duration: fmtRelative(r.resetsAt, nowMs) })
    : '';
  document.getElementById('routines-reset-clock').textContent = fmtResetClock(r?.resetsAt, nowMs);
}

function renderExtra(plan, nowMs) {
  const extra = plan?.extraUsage;
  const balance = plan?.claudeBalance;
  const consumerOverage = plan?.consumerOverage;

  // Preference order:
  //   1. consumerOverage (claude.ai /overage_spend_limit — actual usage credits)
  //   2. plan.extraUsage (OAuth-API extra_usage — per-org API spend)
  // The two report different things; consumerOverage is what the user sees
  // at claude.ai/settings/usage and what they actually want to track.
  const primary = consumerOverage ?? extra;
  const used = Number.isFinite(primary?.usedDollars) ? primary.usedDollars : null;
  const limit = Number.isFinite(primary?.limitDollars) ? primary.limitDollars : null;
  const hasSpendData = used != null || (limit != null && limit > 0);

  if (hasSpendData) {
    let pctNum = primary?.pct;
    if ((pctNum == null || !Number.isFinite(pctNum)) && limit && limit > 0 && used != null) {
      pctNum = (used / limit) * 100;
    }
    const pct = pctNum ?? 0;
    renderSimpleBar({
      fillId: 'extra-fill',
      overflowId: 'extra-overflow',
      usagePct: pct,
      capPct: 100,
    });
    const usedStr = used != null ? fmtUSD(used) : t('common.dash');
    const extraPctEl = document.getElementById('extra-pct');
    if (limit && limit > 0) {
      extraPctEl.textContent = t('extra.spendOverLimit', { used: usedStr, limit: limit.toFixed(0) });
    } else {
      extraPctEl.textContent = t('extra.noLimit', { used: usedStr });
    }
    document.getElementById('extra-pct-used').textContent = pct > 0 ? t('extra.percentUsedShort', { percent: Math.round(pct) }) : '';
  } else {
    // No OAuth-API extra-usage spend data. The disabledReason field tells
    // us *why* — surface it so the user isn't confused by an empty bar.
    // Common values from Anthropic:
    //   org_level_disabled_until → org admin disabled the OAuth-API
    //     extra-usage feature
    //   <other> → server-side gate, plan upgrade required, etc.
    // Note: claude.ai consumer "Usage credits" (the $X.XX spent / $Y limit
    // visible at claude.ai/settings/usage) is a SEPARATE feature not yet
    // captured by Clauge Sync.
    renderSimpleBar({ fillId: 'extra-fill', overflowId: 'extra-overflow', usagePct: 0 });
    const reason = extra?.disabledReason;
    if (reason) {
      document.getElementById('extra-pct').textContent = t('extra.disabled', { reason: humanizeDisabledReason(reason) });
    } else {
      document.getElementById('extra-pct').textContent = balance ? t('common.dash') : t('extra.noData');
    }
    document.getElementById('extra-pct-used').textContent = '';
  }

  // Balance + auto-reload status line. normalizeBalance() emits the field as
  // `autoReloadEnabled` (boolean) — not `autoReload`. Read both for safety
  // since claude.ai sometimes returns auto_reload_settings.enabled.
  const balEl = document.getElementById('extra-balance');
  if (balance && Number.isFinite(balance.currentBalance)) {
    const autoOn = balance.autoReloadEnabled === true || balance.autoReload === true;
    balEl.textContent = t('extra.balanceLine', {
      balance: fmtUSD(balance.currentBalance),
      state: autoOn ? t('extra.autoReloadOn') : t('extra.autoReloadOff'),
    });
  } else {
    balEl.textContent = t('extra.balanceUnknown');
  }

  // Extra usage reset (calendar month — use 1st of next month if no signal).
  const resetEl = document.getElementById('extra-reset');
  if (extra?.resetsAt) {
    resetEl.textContent = t('sonnet.resets', { when: fmtRelative(extra.resetsAt, nowMs) });
  } else {
    resetEl.textContent = '';
  }
}

function renderStats({ summary, cache, period30d }) {
  // Two-column layout: today + last 30 days. Each column stacks cost (big)
  // over tokens (smaller). tokens shape has no precomputed .total so we
  // sum input + output + cacheRead + cacheCreate5m + cacheCreate1h.
  document.getElementById('stat-today-cost').textContent =
    summary?.cost != null ? `$${fmtUSD(summary.cost)}` : t('common.dash');
  document.getElementById('stat-30d-cost').textContent =
    period30d?.cost != null ? `$${fmtUSD(period30d.cost)}` : t('common.dash');

  const tokToday = sumTokens(summary?.tokens);
  document.getElementById('stat-today-tokens').textContent =
    tokToday != null ? t('stats.tokensSuffix', { count: fmtCompact(tokToday) }) : t('stats.tokensUnknown');

  const tok30d = sumTokens(period30d?.tokens);
  document.getElementById('stat-30d-tokens').textContent =
    tok30d != null ? t('stats.tokensSuffix', { count: fmtCompact(tok30d) }) : t('stats.tokensUnknown');
}

/**
 * Convert /api/daily's `days: [{ date, totalCost, ... }]` (sparse — missing
 * zero-usage days) into a contiguous 30-day spend array ending today.
 */
function buildDailySpendBuckets(daily30d, nowMs = Date.now()) {
  const byDate = new Map();
  for (const d of daily30d?.days ?? []) {
    if (d?.date) byDate.set(d.date, d.totalCost ?? 0);
  }
  const buckets = [];
  const today = new Date(nowMs);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.push(byDate.get(key) ?? 0);
  }
  return buckets;
}

function renderSpendChart(daily30d) {
  const el = document.getElementById('spend-chart');
  if (!el) return;
  const buckets = buildDailySpendBuckets(daily30d);
  const max = Math.max(...buckets, 0.01);
  // If literally no spend at all, hide rather than render a wall of 2px stubs.
  if (max <= 0.01) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const todayIdx = buckets.length - 1;
  el.innerHTML = buckets
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * 100));
      const cls = i === todayIdx ? 'spend-chart-bar today' : 'spend-chart-bar';
      return `<div class="${cls}" style="height:${h}%"></div>`;
    })
    .join('');
}

function renderDisclaimer({ topModel }) {
  const el = document.getElementById('disclaimer');
  if (!el) return;
  if (topModel) {
    el.textContent = t('stats.topModelDisclaimer', { model: escapeHtml(topModel) });
  } else {
    el.textContent = t('stats.disclaimerOnly');
  }
}

function renderHeaderSubhead(ingestedAt, healthOk, fetchFailed) {
  const el = document.getElementById('po-subhead');
  if (!el) return;
  // Offline (no /api/health) still wins — the backend is unreachable at all.
  if (!healthOk && !lastGoodUsage) {
    el.textContent = t('header.offline');
    el.classList.toggle('po-subhead-stale', true);
    return;
  }
  const s = window.ClaugeSwr.subheadState({ ingestedAt, fetchFailed, nowMs: Date.now() });
  // params:undefined on the stale/no-age path → strip the unresolved {minutes}
  // fragment so the line reads cleanly ("Reconnecting — last update").
  const text = s.params ? t(s.key, s.params) : t(s.key, {}).replace(/\s*—?\s*last update \{minutes\}m ago/, '').replace(/\{minutes\}m ago/, '').trim();
  el.textContent = text;
  el.classList.toggle('po-subhead-stale', s.stale);
}

// v0.9.4: renderStatusAction removed — the status row was retired alongside
// the rest of the action-items panel. Health state still surfaces through
// renderHeaderSubhead's "Updated …" line.

// ────────────────────────────────────────────────────────────
// Activity heatmap (v0.9.4 Phase A)
// ────────────────────────────────────────────────────────────
async function refreshHeatmap() {
  if (!window.ClaugeHeatmap) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    const data = await fetchJson(`/api/activity?period=180d&tz=${encodeURIComponent(tz)}`);
    renderPopoverHeatmap(data);
  } catch (err) {
    console.error('[Clauge popover] heatmap fetch failed:', err);
    renderPopoverHeatmap(null);
  }
}

function renderPopoverHeatmap(data) {
  const root = document.getElementById('po-heatmap-root');
  if (root && window.ClaugeHeatmap) {
    window.ClaugeHeatmap.render(root, data, {
      variant: 'popover',
      showDayLabels: true,
      showMonthLabels: true,
      // Explicit cellSize overrides auto-fit. The popover container's
      // clientWidth measures wider than the visual width (due to padding/
      // scrollbar interaction with .po-heatmap-host), so auto-fit kept
      // hitting the 32px cap and produced an overflowing grid with chunky
      // cells. 14px is small enough to fit 17 weeks (120 days) + 40px
      // label column inside the 340px popover with breathing room.
      cellSize: 9,
    });
  }
  const activeEl = document.getElementById('po-heatmap-active');
  const streakEl = document.getElementById('po-heatmap-streak');
  const longestEl = document.getElementById('po-heatmap-longest');
  if (activeEl) {
    activeEl.textContent = data
      ? t('heatmap.activeDays', { count: data.activeDays, plural: data.activeDays === 1 ? '' : 's' })
      : t('heatmap.activeDaysUnknown');
  }
  if (streakEl) {
    streakEl.textContent = data && data.currentStreak > 0
      ? t('heatmap.streak', { count: data.currentStreak, plural: data.currentStreak === 1 ? '' : 's' })
      : t('heatmap.streakUnknown');
  }
  if (longestEl) {
    longestEl.textContent = data && data.longestStreak > 0
      ? t('heatmap.longest', { count: data.longestStreak, plural: data.longestStreak === 1 ? '' : 's' })
      : t('heatmap.longestUnknown');
  }
  // v0.9.10 build 5 (Apple Design 4.2 fix): the heatmap renders AFTER the main
  // refresh's resizeToContent() already measured, so re-measure now that the
  // 180-day grid is in the DOM. Without this the popover stayed at its
  // pre-heatmap height and the bottom rows were clipped.
  resizeToContent();
}

// ────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────
function showLoading() {
  const el = document.getElementById('po-loading');
  if (!el) return;
  el.removeAttribute('hidden');
  el.classList.remove('fading');
}

async function refresh() {
  if (window.ClaugeSwr.fetchTimeoutSignal && refreshInFlight) return;
  refreshInFlight = true;
  let healthOk = false;
  let loadingHidden = false;
  const hideLoading = () => {
    if (loadingHidden) return;
    loadingHidden = true;
    const el = document.getElementById('po-loading');
    if (!el) return;
    el.classList.add('fading');
    setTimeout(() => el.setAttribute('hidden', ''), 220);
  };
  try {
    const [health, summary, cache, usage, period30d, daily30d, projection] = await Promise.all([
      fetchJson('/api/health').catch(() => null),
      fetchJson('/api/summary?period=today').catch(() => null),
      fetchJson('/api/cache?period=today').catch(() => null),
      fetchJson('/api/usage').catch(() => null),
      fetchJson('/api/summary?period=30d').catch(() => null),
      fetchJson('/api/daily?period=30d').catch(() => null),
      fetchJson('/api/projection').catch(() => null),
    ]);
    if (health?.version) serverVersion = health.version;
    healthOk = !!health;

    const picked = window.ClaugeSwr.pickUsage(usage, lastGoodUsage);
    lastGoodUsage = picked.lastGood;
    const effectiveUsage = picked.usage;
    // /api/projection gets its OWN keep-last-good cache through the same
    // generic pickUsage helper (it is payload-agnostic — null-or-not is all
    // it inspects). A failed projection fetch must not blank the lines.
    const pickedProjection = window.ClaugeSwr.pickUsage(projection, lastGoodProjection);
    lastGoodProjection = pickedProjection.lastGood;
    const plan = effectiveUsage?.plan ?? {};
    const nowMs = Date.now();

    renderHeaderSubhead(effectiveUsage?.ingestedAt, healthOk, picked.fetchFailed);
    renderPlanBadge(plan);
    renderSession(plan, nowMs);
    renderWeekly(plan, nowMs);
    renderProjection(pickedProjection.usage, nowMs);
    renderScoped(plan, nowMs);
    renderDesign(plan, nowMs);
    renderRoutines(plan, nowMs);
    renderExtra(plan, nowMs);
    renderStats({ summary, cache, period30d });
    renderSpendChart(daily30d);
    renderDisclaimer({ topModel: summary?.topModel });

    // Update footer version label.
    const aboutEl = document.getElementById('footer-about-version');
    if (aboutEl) aboutEl.textContent = t('footer.version', { version: serverVersion });
    const aboutEl2 = document.getElementById('about-version');
    if (aboutEl2) aboutEl2.textContent = t('footer.version', { version: serverVersion });
  } catch (err) {
    console.error('[Clauge popover] refresh failed:', err);
    renderHeaderSubhead(lastGoodUsage?.ingestedAt ?? null, false, true);
  } finally {
    refreshInFlight = false;
    hideLoading();
    resizeToContent();
  }
  // Heatmap is independent of the main refresh — fire-and-forget so a slow
  // /api/activity doesn't block the rest of the popover from rendering.
  refreshHeatmap();
}

function resizeToContent() {
  if (!window.webkit?.messageHandlers?.clauge) return;
  requestAnimationFrame(() => {
    try {
      const root = document.getElementById('root');
      if (!root) return;
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const measured = Math.ceil(root.offsetHeight * zoom);
      // Clamp into the native popover's allowed range instead of bailing.
      // Bailing on tall content (e.g. the 180-day heatmap) left the popover at
      // its prior height and clipped the overflow — the Apple Design 4.2
      // rejection on v0.9.10 build 4. The body scroll net (popover.css) covers
      // the rare >1200px case so text is never cut off.
      const height = Math.min(1200, Math.max(200, measured));
      window.webkit.messageHandlers.clauge.postMessage({ cmd: 'resize', height });
    } catch (err) {
      console.warn('[Clauge popover] resizeToContent failed:', err);
    }
  });
}

function openDashboard() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'open_dashboard' });
  } catch (err) {
    console.error('open_dashboard postMessage failed:', err);
  }
}

function openSettings() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'open_settings' });
  } catch (err) {
    // Fallback: open dashboard if no settings handler.
    openDashboard();
  }
}

function quitApp() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'quit' });
  } catch (err) {
    console.error('quit postMessage failed:', err);
  }
}

// ────────────────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────────────────
async function init() {
  // v0.9.4 Phase B.1: wait for the copy registry to load before any render
  // path so t() calls (when callers start migrating to them) never race the
  // copy.json fetch. Today the registry is wired but no string is yet routed
  // through t() — the await is a no-op fast-path while the migration
  // proceeds across follow-up commits.
  if (typeof window !== 'undefined' && window.__claugeCopyReady) {
    try { await window.__claugeCopyReady; } catch { /* fallback baked into copy.js */ }
  }

  const locPort = parseInt(window.location.port, 10);
  if (Number.isFinite(locPort) && locPort > 0) serverPort = locPort;

  // v0.9.4: the Action items panel (Add Account / Usage Dashboard / Status)
  // and the footer's Refresh + Settings buttons were retired. Auto-refresh
  // runs every 10s; Settings is still reachable via the tray's right-click
  // Preferences menu item (src-tauri/src/menu.rs).

  // Footer
  document.getElementById('footer-dashboard')?.addEventListener('click', openDashboard);
  document.getElementById('footer-about')?.addEventListener('click', () => {
    // Open prefs panel (legacy About flow).
    document.getElementById('prefs')?.removeAttribute('hidden');
    resizeToContent();
  });
  document.getElementById('footer-quit')?.addEventListener('click', quitApp);

  // Prefs panel back button
  document.getElementById('prefs-back')?.addEventListener('click', () => {
    document.getElementById('prefs')?.setAttribute('hidden', '');
    resizeToContent();
  });
  document.getElementById('prefs-dashboard-btn')?.addEventListener('click', openDashboard);
  document.getElementById('check-updates-btn')?.addEventListener('click', () => {
    // Triggered via the Tauri IPC layer in the dashboard window; in the
    // popover we just open the dashboard to its Updates pane.
    openDashboard();
  });

  // Native-side popover-show entry points dispatch this event via webview.eval.
  window.addEventListener('show-loading', () => {
    showLoading();
    refresh();
  });

  // Keyboard shortcuts. v0.9.4 dropped ⌘R (Refresh button retired — auto-
  // refresh is the canonical path) and ⌘, (Settings button retired —
  // Preferences lives on the tray right-click menu).
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey) return;
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      openDashboard();
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      quitApp();
    }
  });

  // Boot-order: the 5s per-call abort means the first fetch can no longer hang
  // forever. Don't let a failed first refresh block setInterval — start the
  // interval regardless so the popover self-heals on the next tick (the failed
  // first refresh already lands on a recoverable state: hideLoading() runs in
  // refresh()'s finally, and the keep-last-good/stale subhead path renders).
  refresh().catch((err) => console.error('[Clauge popover] initial refresh failed:', err));
  setInterval(refresh, 10_000);
}

// Expose pure helpers on window for ad-hoc testing in the dev console.
if (typeof window !== 'undefined') {
  window.__clauge = {
    timeElapsedPct,
    formatElapsed,
    burnState,
    fmtUSD,
    fmtCompact,
    fmtRelative,
  };
}

document.addEventListener('DOMContentLoaded', init);
