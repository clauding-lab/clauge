// Clauge dashboard v0.4.0 — Liquid Glass.
//
// Vanilla JS, no framework, no build step. Mock data from the design handoff
// has been replaced with live calls to the existing /api/* endpoints. The
// initial-load retry-with-backoff (v0.3.1's Bug #5 fix, T32) is preserved
// because the WebView still races the SEA sidecar bind during cold start.

// ─── State ────────────────────────────────────────────────
const state = {
  period: '7d',
  tab: 'overview',
  // Cached so tab switches don't re-fetch when the user just toggled tabs.
  // refreshAll() repopulates these on every period switch / refresh.
  data: {
    summary: null,
    cache: null,
    sessions: null,
    daily: null,
    hours: null,
    projects: null,
    activity: null,
    tools: null,
    models: null,
    usage: null,
    expensive: null,
    health: null,
    roi: null,
    heatmap: null,
  },
};

const PERIOD_LABELS = {
  today: 'Today',
  '7d': '7d',
  '30d': '30d',
  month: 'Month',
  all: 'All',
};

// v0.8.2: claude.ai's /usage endpoint can return extra_usage.is_enabled: false
// with a disabled_reason explaining WHY it's currently gated (e.g. recent
// subscription, billing event, plan tier change). Map known enum values to
// user-friendly text; unknown values fall through to a generic message so
// the card never shows raw API jargon.
const DISABLED_REASON_TEXT = {
  org_level_disabled_until: 'Temporarily gated by Anthropic',
};
function disabledReasonText(reason) {
  return DISABLED_REASON_TEXT[reason] || 'Disabled by Anthropic';
}

// ─── Formatters ───────────────────────────────────────────
const fmtUSD = (n) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);

const fmtInt = (n) =>
  n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n));

const fmtPct = (frac, digits = 0) =>
  frac == null || !Number.isFinite(frac) ? '—' : `${(frac * 100).toFixed(digits)}%`;

const fmtTokens = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtAgo = (iso) => {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

const fmtRelative = (iso) => {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
};

// Absolute local reset time to pair beneath the relative "resets in …" line.
// Smart: time-only when the reset is today (e.g. "8:07 PM"), weekday + time when
// it's a later day (e.g. "Thu 5:00 AM"). Uses the machine's local timezone.
const fmtResetClock = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

const TZ_LABEL = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
})();

// ─── API ──────────────────────────────────────────────────
async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${path}?${qs}` : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
function commonParams() { return { period: state.period }; }

// ─── HTML helpers ─────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Surgical DOM helpers — mutate only when the value actually changed. Used by
// the auto-refreshing plan/finance render path so a 60s tick with unchanged
// data does NOT churn nodes (which would restart the .dot-live pulse animation
// in #plan-meta and add a one-frame paint gap on the SVG rings).
function setTextIfChanged(el, val) {
  if (!el) return;
  const next = String(val);
  // Prefer mutating an existing single text-node's `data` over reassigning
  // textContent — textContent always replaces all children with a *new* text
  // node, which fires childList mutations even when the text didn't change.
  if (el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE) {
    if (el.firstChild.data !== next) el.firstChild.data = next;
    return;
  }
  if (el.textContent !== next) el.textContent = next;
}
function setAttrIfChanged(el, name, val) {
  if (!el) return;
  const next = val == null ? null : String(val);
  if (el.getAttribute(name) !== next) {
    if (next == null) el.removeAttribute(name);
    else el.setAttribute(name, next);
  }
}

function modelClass(model) {
  if (!model) return '';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return '';
}
function modelColorVar(cls) {
  return cls === 'opus' ? 'var(--opus)'
       : cls === 'haiku' ? 'var(--haiku)'
       : 'var(--sonnet)';
}

function totalTokensOf(t) {
  return (t?.inputTokens || 0) + (t?.outputTokens || 0)
       + (t?.cacheRead || 0) + (t?.cacheCreate5m || 0) + (t?.cacheCreate1h || 0);
}

// ─── Big rings (overview plan-hero) ──────────────────────
function bigRingHtml({ label, sub, metric, gradId }) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const pctFrac = metric?.pct == null ? 0 : Math.max(0, Math.min(100, metric.pct)) / 100;
  const offset = c - pctFrac * c;
  const tone = pctFrac >= 0.85 ? 'crit'
             : pctFrac >= 0.6  ? 'amber'
             : pctFrac >= 0.05 ? 'healthy'
             : 'cool';
  const pctNum = metric?.pct == null ? '—' : Math.round(metric.pct);
  const reset = fmtRelative(metric?.resetsAt);
  return `
    <div class="ring-card">
      <div class="big-ring ${tone}">
        <svg viewBox="0 0 132 132" aria-hidden="true">
          <defs>
            <linearGradient id="${escapeHtml(gradId)}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#e89478"/>
              <stop offset="100%" stop-color="#b45c41"/>
            </linearGradient>
          </defs>
          <circle cx="66" cy="66" r="${r}" fill="none"
            stroke="rgba(255,240,230,0.06)" stroke-width="9"/>
          <circle cx="66" cy="66" r="${r}" fill="none"
            stroke="url(#${escapeHtml(gradId)})" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
        </svg>
        <div class="ring-pct"><span class="big">${pctNum}</span><span class="pct-sym">%</span></div>
      </div>
      <div class="ring-meta">
        <div class="ring-label">${escapeHtml(label)} <span class="ring-window">${escapeHtml(sub)}</span></div>
        <div class="ring-reset">resets in ${escapeHtml(reset)}</div>
        <div class="ring-reset-clock">${escapeHtml(fmtResetClock(metric?.resetsAt))}</div>
      </div>
    </div>`;
}

// ─── Topbar plan-inline mini rings ────────────────────────
function inlineMiniRingHtml({ pct, label }) {
  const r = 8.5;
  const c = 2 * Math.PI * r;
  const pctFrac = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  const offset = c - pctFrac * c;
  const num = pct == null ? '—' : Math.round(pct);
  return `
    <div class="mini-ring" title="${escapeHtml(label)} ${num}%">
      <svg viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="${r}" fill="none" stroke="rgba(255,240,230,0.10)" stroke-width="2.5"/>
        <circle cx="11" cy="11" r="${r}" fill="none" stroke="var(--brand)" stroke-width="2.5"
          stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
      </svg>
      <div class="lbl">${num}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  Refresh: plan capacity + finance
// ═══════════════════════════════════════════════════════════
//
// The plan card auto-refreshes every 60s (see the boot section). The render
// is split into two phases to avoid flicker: a structural build runs only on
// shape transitions (placeholder ↔ ingested, balance line appearing), and a
// surgical update path mutates only the values that changed every other tick.
// Previously every tick rebuilt #plan-meta via assignment to .innerHTML, which
// re-created the <span class="dot-live"> child and restarted its CSS pulse
// animation from frame 0 — visible as a faint brightness snap.
let __planCardMode = null;          // 'placeholder' | 'ingested' | null
let __planStatusTone = null;        // 'crit' | 'amber' | 'healthy' | 'idle'
let __planInlineHasBalance = null;  // true if the bal line is rendered
let __planGaugeShape = null;        // gauge count — re-render (not surgical-update) when it changes
let __lastSuccessAt = null;         // epoch-ms of the last fully-successful refresh (SWR aging anchor)
let __lastRefreshFailed = false;    // did the most recent refresh attempt fail (drives the not-live dot)

function renderPlanCapacity() {
  const usage = state.data.usage;
  const planMeta = document.getElementById('plan-meta');
  const planTag = document.getElementById('plan-status-tag');
  const body = document.getElementById('plan-body');
  const inline = document.getElementById('plan-inline');

  if (!usage || !usage.ingested) {
    if (__planCardMode !== 'placeholder') {
      planMeta.innerHTML = `<span class="dot-live" style="background:var(--text-3);box-shadow:none;animation:none"></span>not synced`;
      // Empty-state: render 4 placeholder rings (so layout doesn't collapse)
      // PLUS an inline walkthrough explaining how to get the rings to populate.
      // Plan-ring data lives behind two paths in v0.8.0:
      //  - claude.ai signed-in (Architecture A — Mac only in v0.8.0)
      //  - Clauge Sync browser extension (cross-platform, only path on Windows)
      const isWindows = /windows/i.test(navigator.userAgent || '');
      const placeholders = ['Session', 'Weekly', 'Sonnet']
        .map((label, i) => bigRingHtml({ label, sub: i === 0 ? '5h' : '7d', metric: null, gradId: `dash-rg-${i}` }))
        .join('');
      const walkthrough = `
        <div class="plan-empty-hint">
          <p class="plan-empty-hint-title">No plan data yet${isWindows ? ' (install Clauge Sync)' : ''}</p>
          <ol class="plan-empty-hint-steps">
            <li>Install <a href="https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga" target="_blank" rel="noopener noreferrer">Clauge Sync</a> from the Chrome Web Store.</li>
            <li>Open <a href="https://claude.ai" target="_blank" rel="noopener noreferrer">claude.ai</a> in your browser and sign in (Edge users: extensions install from the Chrome Web Store too).</li>
            <li>The rings above populate within ~30 seconds — the extension posts usage snapshots back to this app.</li>
          </ol>
          ${isWindows ? '<p class="plan-empty-hint-aside">claude.ai sign-in inside Clauge is not yet supported on Windows — the browser extension is currently the only path.</p>' : '<p class="plan-empty-hint-aside">Alternative: sign in to claude.ai from Settings → Connections to pull plan data directly without the extension.</p>'}
        </div>
      `;
      body.innerHTML = placeholders + walkthrough;
      inline.hidden = true;
      __planCardMode = 'placeholder';
      __planInlineHasBalance = null;
    }
    if (__planStatusTone !== 'idle') {
      planTag.textContent = '○ Awaiting sync';
      planTag.style.background = 'var(--glass-2)';
      planTag.style.color = 'var(--text-3)';
      __planStatusTone = 'idle';
    }
    return;
  }

  const plan = usage.plan ?? {};
  const gauges = [
    { label: 'Session',    sub: '5h', metric: plan.fiveHour },
    { label: 'Weekly all', sub: '7d', metric: plan.sevenDay },
    { label: 'Sonnet',     sub: '7d', metric: plan.sevenDaySonnet },
  ];
  // Claude Design weekly bucket: Anthropic dropped it, so claudeDesign is null in
  // current payloads. Omit the ring rather than show a phantom 0% — it reappears
  // automatically if the bucket returns. Use the resolved claudeDesign (covers all
  // codename variants), not the raw sevenDayOmelette.
  if (plan.claudeDesign) {
    gauges.push({ label: 'Design', sub: '7d', metric: plan.claudeDesign });
  }

  // A change in the gauge count is a structural transition — re-render once. A
  // surgical in-place update on a changed set would leave a stale ring (and
  // restart the .dot-live pulse, the v0.9.9 flicker). Equal count → update in place.
  const shapeChanged = __planGaugeShape !== gauges.length;
  if (__planCardMode !== 'ingested' || shapeChanged) {
    body.innerHTML = gauges.map((g, i) => bigRingHtml({ ...g, gradId: `dash-rg-${i}` })).join('');
    __planCardMode = 'ingested';
  } else {
    updateBigRings(body, gauges);
  }

  // Status tag based on the highest pct. Only restyle when the tier actually
  // changes — saves a textContent + 2 style writes per 60s tick.
  const maxPct = Math.max(...gauges.map((g) => g.metric?.pct ?? 0));
  const newTone = maxPct >= 85 ? 'crit' : maxPct >= 60 ? 'amber' : 'healthy';
  if (newTone !== __planStatusTone) {
    if (newTone === 'crit') {
      planTag.textContent = '● Critical';
      planTag.style.background = 'rgba(224,123,110,0.14)';
      planTag.style.color = 'var(--crit)';
    } else if (newTone === 'amber') {
      planTag.textContent = '● Warming';
      planTag.style.background = 'var(--warn-tint)';
      planTag.style.color = 'var(--warn)';
    } else {
      planTag.textContent = '● Healthy';
      planTag.style.background = 'var(--ok-tint)';
      planTag.style.color = 'var(--ok)';
    }
    __planStatusTone = newTone;
  }

  // Sync line — preserve the .dot-live element so its CSS pulse animation
  // (styles.css: @keyframes pulse) doesn't restart at frame 0 every 60s. The
  // text + dot state come from SWR's syncMeta (aging + fetch-success), no
  // longer raw fmtAgo(ingestedAt) — data age and live-state are independent.
  updatePlanMeta(planMeta);

  // Topbar inline plan summary — rebuild only when the balance line appears
  // or disappears; otherwise update values in place.
  const sevenDayCost = state.data.summary?.cost;
  const balance = plan.claudeBalance?.currentBalance;
  const hasBalance = balance != null;
  inline.hidden = false;
  // Mirror the big-ring set: include the Design mini-ring only when the bucket
  // is present. Rebuild on a balance-line change OR a gauge-count change.
  const designMini = plan.claudeDesign
    ? inlineMiniRingHtml({ pct: plan.claudeDesign.pct, label: 'Design' })
    : '';
  if (__planInlineHasBalance !== hasBalance || shapeChanged) {
    inline.innerHTML = `
      ${inlineMiniRingHtml({ pct: plan.fiveHour?.pct, label: 'Session' })}
      ${inlineMiniRingHtml({ pct: plan.sevenDay?.pct, label: 'Weekly' })}
      ${inlineMiniRingHtml({ pct: plan.sevenDaySonnet?.pct, label: 'Sonnet' })}
      ${designMini}
      <span class="sep"></span>
      <span class="num-lbl" data-role="period-lbl">${escapeHtml(PERIOD_LABELS[state.period] ?? state.period)}</span>
      <span class="num" data-role="period-cost">${escapeHtml(sevenDayCost != null ? fmtUSD(sevenDayCost) : '—')}</span>
      ${hasBalance ? `<span class="sep"></span><span class="num-lbl">bal</span><span class="num" data-role="bal-num">${escapeHtml(fmtUSD(balance))}</span>` : ''}
    `;
    __planInlineHasBalance = hasBalance;
  } else {
    updatePlanInline(inline, gauges, sevenDayCost, balance);
  }
  // Record the rendered gauge count last, after both ring sets have consumed
  // `shapeChanged` for this tick.
  __planGaugeShape = gauges.length;
}

function renderFinanceSide() {
  const usage = state.data.usage;
  const plan = usage?.plan ?? {};
  const extra = plan.extraUsage;
  const consumerOverage = plan.consumerOverage;
  const usedEl = document.getElementById('extra-used');
  const capEl = document.getElementById('extra-cap');
  const barEl = document.getElementById('extra-bar');
  const pctEl = document.getElementById('extra-pct');
  const currEl = document.getElementById('extra-currency');

  const setBarWidth = (w) => {
    if (barEl && barEl.style.width !== w) barEl.style.width = w;
  };
  const setGated = (gated) => {
    if (!barEl) return;
    if (gated && !barEl.classList.contains('bar-fill--gated')) barEl.classList.add('bar-fill--gated');
    else if (!gated && barEl.classList.contains('bar-fill--gated')) barEl.classList.remove('bar-fill--gated');
  };

  // Render the spend layout for either source. consumerOverage and extraUsage
  // share { usedDollars, limitDollars, pct, currency } — see lib/usage-store.js.
  const renderSpend = (source) => {
    const used = source.usedDollars ?? 0;
    const limit = source.limitDollars ?? 0;
    setTextIfChanged(usedEl, used.toFixed(2));
    setTextIfChanged(capEl, limit > 0 ? `/ $${limit.toFixed(2)}` : '');
    let pct = source.pct;
    if ((pct == null || !Number.isFinite(pct)) && limit > 0) pct = (used / limit) * 100;
    pct = Math.max(0, pct ?? 0);
    // Bar represents "of cap" — clamp to 100. Label shows the true pct so an
    // over-cap reading (e.g. 196%) stays visible (matches popover.js).
    setBarWidth(`${Math.min(100, pct).toFixed(1)}%`);
    setTextIfChanged(pctEl, `${pct.toFixed(1)}% of cap`);
    setTextIfChanged(currEl, source.currency || 'USD');
    setGated(false);
  };

  // Prefer plan.consumerOverage (claude.ai /overage_spend_limit — the usage
  // credits visible at claude.ai/settings/usage) over plan.extraUsage (OAuth-API
  // extra_usage, gated at the org level for many users since 2026-05). Same
  // preference popover.js::renderExtra applies.
  const overageHasData =
    consumerOverage &&
    (Number.isFinite(consumerOverage.usedDollars) ||
      (Number.isFinite(consumerOverage.limitDollars) && consumerOverage.limitDollars > 0));

  if (overageHasData) {
    renderSpend(consumerOverage);
  } else if (extra && extra.enabled) {
    renderSpend(extra);
  } else if (extra && !extra.enabled && extra.disabledReason) {
    // v0.8.2: gated state — Anthropic disabled the feature at the org level.
    // Only reached when consumerOverage has no data either.
    setTextIfChanged(usedEl, '—');
    setTextIfChanged(capEl, '');
    setBarWidth('100%');
    setGated(true);
    setTextIfChanged(pctEl, disabledReasonText(extra.disabledReason));
    setTextIfChanged(currEl, extra.currency || 'USD');
  } else {
    setTextIfChanged(usedEl, '0.00');
    setTextIfChanged(capEl, '');
    setBarWidth('0%');
    setGated(false);
    setTextIfChanged(pctEl, 'not configured');
    setTextIfChanged(currEl, 'USD');
  }

  // claude.ai balance side card
  const bal = plan.claudeBalance;
  const valEl = document.getElementById('claude-balance-val');
  const ccyEl = document.getElementById('claude-balance-currency');
  const footEl = document.getElementById('claude-balance-foot');
  if (bal && Number.isFinite(bal.currentBalance)) {
    setTextIfChanged(valEl, bal.currentBalance.toFixed(2));
    setTextIfChanged(ccyEl, bal.currency || 'USD');
    setTextIfChanged(footEl, usage?.ingestedAt ? `refreshed ${fmtAgo(usage.ingestedAt)}` : '');
  } else {
    setTextIfChanged(valEl, '—');
    setTextIfChanged(ccyEl, 'USD');
    setTextIfChanged(footEl, 'sync to view');
  }
}

// ─── Plan-card surgical update helpers ─────────────────────
// These ONLY run after the first innerHTML build has populated the structure.
// They walk the existing DOM and update individual values; they do not
// add/remove children, so they don't restart CSS animations on siblings (the
// .dot-live pulse in #plan-meta) or trigger paint gaps on the SVG rings.

function updateBigRings(body, gauges) {
  const cards = body.querySelectorAll('.ring-card');
  for (let i = 0; i < gauges.length && i < cards.length; i++) {
    const g = gauges[i];
    const card = cards[i];
    const metric = g.metric;
    const r = 56;
    const c = 2 * Math.PI * r;
    const pctFrac = metric?.pct == null ? 0 : Math.max(0, Math.min(100, metric.pct)) / 100;
    const offset = c - pctFrac * c;
    const tone = pctFrac >= 0.85 ? 'crit'
               : pctFrac >= 0.6  ? 'amber'
               : pctFrac >= 0.05 ? 'healthy'
               : 'cool';
    const pctNum = metric?.pct == null ? '—' : String(Math.round(metric.pct));
    const reset = fmtRelative(metric?.resetsAt);

    const bigRing = card.querySelector('.big-ring');
    if (bigRing && !bigRing.classList.contains(tone)) {
      bigRing.classList.remove('amber', 'healthy', 'cool', 'crit');
      bigRing.classList.add(tone);
    }
    // Second <circle> (index 1) is the progress arc; the first is the track.
    const progressCircle = bigRing ? bigRing.querySelectorAll('circle')[1] : null;
    setAttrIfChanged(progressCircle, 'stroke-dashoffset', offset.toFixed(2));
    setTextIfChanged(card.querySelector('.ring-pct .big'), pctNum);
    setTextIfChanged(card.querySelector('.ring-reset'), `resets in ${reset}`);
    setTextIfChanged(card.querySelector('.ring-reset-clock'), fmtResetClock(metric?.resetsAt));
  }
}

function updatePlanMeta(planMeta) {
  // SWR sync line. Recompute every tick (incl. failures) so "synced ago" keeps
  // AGING and the dot reflects fetch-success, not data age. Preserve the
  // existing .dot-live element so its @keyframes pulse doesn't restart at frame
  // 0 (landmine #22 / v0.9.9 flicker): mutate the trailing text node's .data,
  // and toggle the not-live styling on the dot in place (grey + animation:none).
  const meta = window.ClaugeDashSwr.syncMeta({
    lastSuccessAt: __lastSuccessAt,
    lastRefreshFailed: __lastRefreshFailed,
    nowMs: Date.now(),
  });
  let dot = planMeta.querySelector('.dot-live');
  if (!dot) {
    planMeta.innerHTML = `<span class="dot-live"></span>${escapeHtml(meta.text)}`;
    dot = planMeta.querySelector('.dot-live');
  } else {
    let textNode = dot.nextSibling;
    while (textNode && textNode.nodeType !== Node.TEXT_NODE) textNode = textNode.nextSibling;
    if (textNode) {
      if (textNode.data !== meta.text) textNode.data = meta.text;
    } else {
      planMeta.appendChild(document.createTextNode(meta.text));
    }
  }
  // Live (pulsing green, default CSS) vs not-live (grey, no pulse) — the exact
  // not-live variant the placeholder branch uses (app.js:282 / styles.css:921).
  if (meta.live) {
    setAttrIfChanged(dot, 'style', null);
  } else {
    setAttrIfChanged(dot, 'style', 'background:var(--text-3);box-shadow:none;animation:none');
  }
}

function updatePlanInline(inline, gauges, sevenDayCost, balance) {
  const rings = inline.querySelectorAll('.mini-ring');
  for (let i = 0; i < gauges.length && i < rings.length; i++) {
    const miniRing = rings[i];
    const pct = gauges[i].metric?.pct;
    const num = pct == null ? '—' : String(Math.round(pct));
    const r = 8.5;
    const c = 2 * Math.PI * r;
    const pctFrac = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
    const offset = c - pctFrac * c;
    const progress = miniRing.querySelectorAll('circle')[1];
    setAttrIfChanged(progress, 'stroke-dashoffset', offset.toFixed(2));
    setTextIfChanged(miniRing.querySelector('.lbl'), num);
    setAttrIfChanged(miniRing, 'title', `${gauges[i].label} ${num}%`);
  }
  setTextIfChanged(inline.querySelector('[data-role="period-lbl"]'), PERIOD_LABELS[state.period] ?? state.period);
  setTextIfChanged(inline.querySelector('[data-role="period-cost"]'), sevenDayCost != null ? fmtUSD(sevenDayCost) : '—');
  if (balance != null) {
    setTextIfChanged(inline.querySelector('[data-role="bal-num"]'), fmtUSD(balance));
  }
}

// ═══════════════════════════════════════════════════════════
//  Refresh: code analytics digest strip
// ═══════════════════════════════════════════════════════════
function renderMetricStrip() {
  const summary = state.data.summary;
  const cache = state.data.cache;
  const sessions = state.data.sessions;
  const roi = state.data.roi;
  const health = state.data.health;

  document.getElementById('ms-period-chip').textContent = PERIOD_LABELS[state.period] ?? state.period;

  document.getElementById('ms-cost').textContent = fmtUSD(summary?.cost);
  const subCost = roi?.subscriptionCost ?? health?.subscriptionCost ?? 200;
  document.getElementById('ms-sub-cost').textContent = `${fmtUSD(subCost)}/mo`;

  const savings = cache?.netSavingsUSD;
  document.getElementById('ms-savings').textContent =
    savings != null ? `${fmtUSD(savings)} cache savings` : '—';

  document.getElementById('ms-messages').textContent = fmtInt(summary?.messageCount);
  document.getElementById('ms-tools').textContent = `${fmtInt(summary?.toolCallCount)} tool calls`;

  document.getElementById('ms-sessions').textContent = fmtInt(summary?.sessionCount ?? sessions?.count);
  document.getElementById('ms-subagents').textContent = `${fmtInt(summary?.subagentTurnCount)} subagents`;

  document.getElementById('ms-cachehit').textContent = fmtPct(cache?.hitRate, 1);
  const reads = summary?.tokens?.cacheRead;
  document.getElementById('ms-cachereads').textContent = `${fmtTokens(reads)} cached reads`;

  const totalTok = summary?.totalTokens ?? totalTokensOf(summary?.tokens ?? {});
  document.getElementById('ms-tokens').textContent = fmtTokens(totalTok);
  const inTok = summary?.tokens?.inputTokens;
  const outTok = summary?.tokens?.outputTokens;
  document.getElementById('ms-token-split').textContent =
    `${fmtTokens(inTok)} in · ${fmtTokens(outTok)} out`;

  // ROI: API returns roiPct + apiReplacementValue + subscriptionCost (see
  // server.js /api/roi). Show the percentage in the strip with a multiplier
  // sub-line. Frontend used to read roi.netValue/multiplier but the API
  // never exposed those names — fixed in v0.5.0.
  if (
    roi &&
    Number.isFinite(roi.apiReplacementValue) &&
    Number.isFinite(roi.subscriptionCost) &&
    roi.subscriptionCost > 0
  ) {
    document.getElementById('ms-roi').textContent = `${Math.round(roi.roiPct)}%`;
    const mult = roi.apiReplacementValue / roi.subscriptionCost;
    document.getElementById('ms-roi-sub').textContent =
      `${mult.toFixed(1)}× · ${fmtUSD(roi.apiReplacementValue)} net value`;
  } else {
    document.getElementById('ms-roi').textContent = '—';
    document.getElementById('ms-roi-sub').textContent = '—';
  }
}

// ═══════════════════════════════════════════════════════════
//  Refresh: cost over time chart
// ═══════════════════════════════════════════════════════════
function utcHoursToLocal(hours) {
  const out = new Array(24).fill(null).map((_, i) => ({ hour: i, calls: 0, cost: 0 }));
  for (const h of hours ?? []) {
    const d = new Date();
    d.setUTCHours(h.hour, 0, 0, 0);
    const localH = d.getHours();
    out[localH] = { hour: localH, calls: h.calls ?? 0, cost: h.cost ?? 0 };
  }
  return out;
}

function pickTicks(labels, count) {
  if (labels.length === 0) return [];
  if (labels.length <= count) {
    return labels.map((l) => shortDate(l));
  }
  const step = (labels.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => shortDate(labels[Math.round(i * step)]));
}

function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return m && d ? `${m}/${d}` : iso;
}

function renderCostChart() {
  const wrap = document.getElementById('cost-chart');
  const ticks = document.getElementById('cost-ticks');
  const meta = document.getElementById('cost-meta');
  const isToday = state.period === 'today';

  if (isToday) {
    const list = utcHoursToLocal(state.data.hours?.hours);
    meta.textContent = `24 hours (${TZ_LABEL})`;
    if (list.every((h) => h.cost === 0)) {
      wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
      ticks.innerHTML = '';
      return;
    }
    const max = Math.max(...list.map((h) => h.cost), 0.0001);
    const nowHour = new Date().getHours();
    let html = '<div class="gridline" style="bottom:25%"></div><div class="gridline" style="bottom:50%"></div><div class="gridline" style="bottom:75%"></div>';
    for (const h of list) {
      const heightPct = (h.cost / max) * 100;
      const cls = h.hour === nowHour ? 'now' : h.hour > nowHour ? 'dim' : '';
      html += `<div class="bar ${cls}" style="height:${Math.max(heightPct, 0.5).toFixed(1)}%" title="${String(h.hour).padStart(2,'0')}:00 — ${fmtUSD(h.cost)}"></div>`;
    }
    wrap.innerHTML = html;
    ticks.innerHTML = '<span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>';
    return;
  }

  const days = state.data.daily?.days ?? [];
  meta.textContent = `${days.length} day${days.length === 1 ? '' : 's'}`;
  if (days.length === 0) {
    wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
    ticks.innerHTML = '';
    return;
  }
  const max = Math.max(...days.map((d) => d.totalCost), 1);
  const todayDate = new Date().toISOString().slice(0, 10);
  let html = '<div class="gridline" style="bottom:25%"></div><div class="gridline" style="bottom:50%"></div><div class="gridline" style="bottom:75%"></div>';
  for (const d of days) {
    const h = (d.totalCost / max) * 100;
    const cls = d.date === todayDate ? 'now' : '';
    html += `<div class="bar ${cls}" style="height:${h.toFixed(1)}%" title="${escapeHtml(d.date)}: ${fmtUSD(d.totalCost)}"></div>`;
  }
  wrap.innerHTML = html;
  const labels = pickTicks(days.map((d) => d.date), 5);
  ticks.innerHTML = labels.map((l) => `<span>${escapeHtml(l)}</span>`).join('');
}

function renderPeakHours() {
  const data = state.data.hours;
  const wrap = document.getElementById('peak-chart');
  const meta = document.getElementById('peak-meta');
  meta.textContent = TZ_LABEL;
  if (!data) {
    wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
    return;
  }
  const hours = utcHoursToLocal(data.hours);
  if (hours.every((h) => h.calls === 0)) {
    wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
    return;
  }
  const max = Math.max(...hours.map((h) => h.calls), 1);
  wrap.innerHTML = hours
    .map((h) => {
      const pct = (h.calls / max) * 100;
      const hot = pct > 55;
      return `<div class="bar ${hot ? 'hot' : ''}" style="height:${Math.max(2, pct).toFixed(1)}%" title="${String(h.hour).padStart(2,'0')}:00 — ${h.calls} calls"></div>`;
    })
    .join('');
}

// ═══════════════════════════════════════════════════════════
//  Refresh: tables
// ═══════════════════════════════════════════════════════════
function renderProjectsTable() {
  const list = state.data.projects?.projects ?? [];
  const tb = document.getElementById('proj-body');
  const fullTb = document.getElementById('proj-full-body');
  document.getElementById('projects-count').textContent = `${list.length} project${list.length === 1 ? '' : 's'}`;

  if (list.length === 0) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">no projects</td></tr>';
    fullTb.innerHTML = '<tr><td colspan="8" class="empty">no projects</td></tr>';
    return;
  }
  const max = Math.max(...list.map((p) => p.totalCost), 1);
  const rowFor = (p) => {
    const proj = p.project ?? '—';
    const slashIdx = proj.indexOf('/');
    const projHtml = slashIdx > 0
      ? `${escapeHtml(proj.slice(0, slashIdx))}<span class="slash">/</span>${escapeHtml(proj.slice(slashIdx + 1))}`
      : escapeHtml(proj);
    const pct = (p.totalCost / max) * 100;
    return `<tr>
      <td class="proj">${projHtml}</td>
      <td><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div></td>
      <td class="num">${escapeHtml(fmtUSD(p.totalCost))}</td>
      <td class="num dim">${escapeHtml(fmtInt(p.sessionCount))}</td>
      <td class="num dim">${escapeHtml(fmtInt(p.messageCount))}</td>
      <td class="num dim">${escapeHtml(fmtInt(p.toolCallCount))}</td>
      <td class="num dim">${escapeHtml(fmtTokens(p.totalTokens))}</td>
      <td class="num ${p.cacheHitRate > 0.7 ? 'ok' : 'dim'}">${escapeHtml(fmtPct(p.cacheHitRate, 0))}</td>
    </tr>`;
  };
  tb.innerHTML = list.slice(0, 6).map(rowFor).join('');
  fullTb.innerHTML = list.map(rowFor).join('');
}

function renderActivityTable() {
  const list = state.data.activity?.tasks ?? [];
  const tb = document.getElementById('act-body');
  if (list.length === 0) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">no activity</td></tr>';
    return;
  }
  const total = list.reduce((s, x) => s + x.turns, 0);
  const colors = ['var(--act-1)', 'var(--act-2)', 'var(--act-3)', 'var(--act-4)', 'var(--act-5)', 'var(--act-6)', 'var(--act-7)', 'var(--act-8)'];
  tb.innerHTML = list
    .map((x, i) => {
      const c = colors[i] ?? colors[colors.length - 1];
      const pct = total === 0 ? 0 : (x.turns / total) * 100;
      return `<tr>
        <td><span class="dot" style="background:${c}"></span>${escapeHtml(x.category)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${c}"></div></div></td>
        <td class="num">${escapeHtml(fmtInt(x.turns))}</td>
        <td class="num dim-2">${escapeHtml(fmtPct(x.pctOfTotal, 1))}</td>
      </tr>`;
    })
    .join('');
}

function renderModelsTable() {
  const list = state.data.models?.models ?? [];
  const tb = document.getElementById('models-body');
  if (list.length === 0) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">no models</td></tr>';
    return;
  }
  const totalCost = list.reduce((s, m) => s + m.cost, 0) || 1;
  tb.innerHTML = list
    .map((m) => {
      const cls = modelClass(m.model);
      const c = modelColorVar(cls);
      const avg = m.turnCount > 0 ? m.cost / m.turnCount : null;
      const pct = (m.cost / totalCost) * 100;
      return `<tr>
        <td class="proj"><span class="dot" style="background:${c}"></span>${escapeHtml(m.model)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${c}"></div></div></td>
        <td class="num">${escapeHtml(fmtUSD(m.cost))}</td>
        <td class="num dim">${escapeHtml(fmtInt(m.turnCount))}</td>
        <td class="num ${m.cacheHitRate > 0.7 ? 'ok' : 'dim'}">${escapeHtml(fmtPct(m.cacheHitRate, 0))}</td>
        <td class="num dim">${avg == null ? '—' : escapeHtml(fmtUSD(avg))}</td>
      </tr>`;
    })
    .join('');
}

function renderSessionsTable() {
  const sessions = state.data.sessions;
  const expensive = state.data.expensive;
  if (!sessions) return;
  const all = sessions.sessions ?? [];
  const expensiveIds = new Set((expensive?.top ?? []).map((t) => t.sessionId));
  document.getElementById('sessions-count').textContent =
    `${all.length} session${all.length === 1 ? '' : 's'}`;

  const sorted = [...all].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const rowFor = (s) => {
    const hot = expensiveIds.has(s.sessionId);
    const dur = s.durationMs ? `${Math.round(s.durationMs / 60000)}m` : '—';
    const model = s.byModel?.[0]?.model ?? '—';
    const cls = modelClass(model);
    return `<tr>
      <td class="dim">${hot ? '<span class="hot-mark">★</span>' : ''}<span class="mono" style="font-size:11px">${escapeHtml(fmtTime(s.startedAt))}</span></td>
      <td class="proj">${escapeHtml(s.project ?? '—')}</td>
      <td class="proj model-color ${cls}" style="font-size:11px">${escapeHtml(model)}</td>
      <td><span class="tag">${escapeHtml(s.tasks?.primary ?? '—')}</span></td>
      <td class="num dim">${escapeHtml(dur)}</td>
      <td class="num dim">${escapeHtml(fmtInt(s.turnCount))}</td>
      <td class="num ${s.cacheHitRate > 0.7 ? 'ok' : 'dim'}">${escapeHtml(fmtPct(s.cacheHitRate, 0))}</td>
      <td class="num" style="font-weight:600">${escapeHtml(fmtUSD(s.cost))}</td>
    </tr>`;
  };
  // Full table: top 80 by recency (matches v0.3.x cap to avoid jank at 5000 rows)
  document.getElementById('sess-full-body').innerHTML = sorted.length
    ? sorted.slice(0, 80).map(rowFor).join('')
    : '<tr><td colspan="9" class="empty">no sessions in this period</td></tr>';
}

function renderToolLists() {
  const data = state.data.tools;
  function fill(key, items) {
    const wrap = document.getElementById(`${key}-tools`);
    if (!items || items.length === 0) {
      wrap.innerHTML = '<div class="empty">none</div>';
      return;
    }
    const max = Math.max(...items.map((x) => x.count), 1);
    wrap.innerHTML = items
      .slice(0, 12)
      .map((x) => {
        const pct = (x.count / max) * 100;
        return `<div class="tool-row">
          <span class="tool-name">${escapeHtml(x.name)}</span>
          <div class="bar-track" style="height:4px"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="tool-count">${escapeHtml(fmtInt(x.count))}</span>
        </div>`;
      })
      .join('');
  }
  fill('core', data?.coreTools);
  fill('shell', data?.shellCommands);
  fill('mcp', data?.mcpServers);
}

// ═══════════════════════════════════════════════════════════
//  Settings tab — read-only mirror of /api/health + /api/usage
// ═══════════════════════════════════════════════════════════
function renderSettings() {
  const health = state.data.health;
  const usage = state.data.usage;
  if (health) {
    document.getElementById('set-port').value = String(health.pid ? location.port || 3456 : 3456);
    if (health.subscriptionCost != null) {
      document.getElementById('set-sub-cost').value = `$${Number(health.subscriptionCost).toFixed(2)}`;
    }
    if (health.pricing?.source) {
      const tag = document.getElementById('set-pricing-source');
      tag.textContent = health.pricing.source;
      tag.style.background = 'var(--ok-tint)';
      tag.style.color = 'var(--ok)';
    }
  }
  // v0.7.0: claude.ai sync card removed; Connections panel (connections.js)
  // owns the sync/extension/keychain state. Old set-sync-* IDs are gone.
  // About version line — populate from /api/health.
  const aboutVersion = document.getElementById('set-about-version');
  if (aboutVersion && health?.version) aboutVersion.textContent = `v${health.version}`;
  initSettingsGeneralControls();
}

// Tauri 2 ACL: dashboard is loaded via WebviewUrl::External (HTTP). Plugin
// commands (e.g. tauri-plugin-autostart, tauri-plugin-updater) flow through
// their plugin permissions (autostart:allow-*, updater:default). Custom
// `#[tauri::command]` functions are blocked from a non-local origin unless
// the app declares an AppManifest — v0.7.0 wires this up in build.rs
// (APP_COMMANDS) and capabilities/main.json (allow-<cmd-kebab>), so
// connections.js can call get_connection_status, open_claude_ai_login,
// signout_claude_ai, and has_claude_ai_session through ClaugeBridge.
let settingsGeneralInitialized = false;

// v0.9.0: shared promise + cached result of the is_mas_flavor IPC. We resolve
// it once at module load (initFlavorGate below) and `await flavorGatePromise`
// from any site that needs the MAS-vs-DMG/NSIS distinction (currently:
// initSettingsGeneralControls, to decide the Updates button copy + Restart
// Now visibility). Awaiting the shared promise — instead of re-firing the IPC
// — avoids a race where renderSettings runs before initFlavorGate's IPC has
// resolved.
let isFlavorMas = false;
let flavorGatePromise = null;

/**
 * v0.9.0: query the is_mas_flavor IPC and add `body.is-flavor-mas` if true.
 * Mirrors the onboarding wizard's initFlavorGate (public/onboarding/onboarding.js)
 * so the same CSS rules (.flavor-mas / .flavor-dmg-nsis in styles.css) gate
 * dashboard surfaces — specifically the 4th Connections row "Claude Code logs".
 *
 * The returned promise is cached in `flavorGatePromise` so callers that need
 * the resolved boolean (initSettingsGeneralControls) can await it without
 * triggering a second IPC. The CSS default hides `.flavor-mas`, so a slow
 * or failing IPC still degrades gracefully (DMG/NSIS view stays visible
 * even during the in-flight window).
 */
function initFlavorGate() {
  if (flavorGatePromise) return flavorGatePromise;
  flavorGatePromise = (async () => {
    if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return false;
    try {
      const isMas = await ClaugeBridge.isMasFlavor();
      if (isMas) {
        isFlavorMas = true;
        document.body.classList.add('is-flavor-mas');
      }
      return !!isMas;
    } catch (e) {
      // Defensive default (CSS hides .flavor-mas) keeps the DMG/NSIS copy
      // visible. Log so we can spot regressions.
      console.warn('[clauge] is_mas_flavor IPC failed; defaulting to non-MAS:', e);
      return false;
    }
  })();
  return flavorGatePromise;
}
initFlavorGate();

async function initSettingsGeneralControls() {
  const bridgeAvailable = window.ClaugeBridge && ClaugeBridge.isTauriAvailable();
  const autoToggle = document.getElementById('set-autostart-toggle');
  const updatesBtn = document.getElementById('set-check-updates-btn');
  const updatesStatus = document.getElementById('set-updates-status');
  if (!autoToggle || !updatesBtn) return;

  if (!bridgeAvailable) {
    // Browser mode (no Tauri host) — disable IPC-backed controls.
    autoToggle.disabled = true;
    autoToggle.title = 'Available in the desktop app';
    updatesBtn.disabled = true;
    updatesBtn.title = 'Available in the desktop app';
    if (updatesStatus) updatesStatus.textContent = 'desktop only';
    return;
  }

  try {
    autoToggle.checked = !!(await ClaugeBridge.getAutostart());
  } catch (err) {
    console.warn('autostart is_enabled failed; defaulting toggle off:', err);
    autoToggle.checked = false;
  }

  if (settingsGeneralInitialized) return;
  settingsGeneralInitialized = true;

  autoToggle.addEventListener('change', async () => {
    const desired = autoToggle.checked;
    try {
      await ClaugeBridge.setAutostart(desired);
    } catch (err) {
      console.error('autostart toggle failed; reverting:', err);
      autoToggle.checked = !desired;
    }
  });

  const restartBtn = document.getElementById('restart-btn');

  // v0.9.0 MAS: Apple App Store policy forbids in-app self-updates. On MAS
  // builds, relabel the Check Now button to make it clear the update path
  // routes through the App Store, and hide the Restart Now button entirely
  // — `check_for_updates` returns `{status: "opened_storefront"}` instead of
  // `{status: "installed", version: "..."}` on MAS, so there's nothing to
  // restart into. The button still hits the same IPC; the Rust side branches
  // on the `mas` Cargo feature to choose its action.
  //
  // Await the shared flavor gate (don't re-fire is_mas_flavor) so we always
  // see a settled result by the time we relabel. flavorGatePromise was kicked
  // off at module load; this await typically resolves in <1ms because the IPC
  // has already returned by the time renderSettings runs.
  await initFlavorGate();
  if (isFlavorMas) {
    updatesBtn.textContent = 'Get latest version on the App Store';
    if (restartBtn) restartBtn.hidden = true;
  }

  updatesBtn.addEventListener('click', async () => {
    if (updatesBtn.disabled) return;
    updatesBtn.disabled = true;
    if (updatesStatus) updatesStatus.textContent = 'Checking…';
    try {
      // v0.7.3: switched from `plugin:updater|check` (returns Update | null) to
      // the `check_for_updates` IPC, which downloads + installs in one shot
      // and returns a tagged enum:
      //   {status: "up_to_date"}                          → nothing changed
      //   {status: "installed", version: "X.Y.Z"}         → restart to apply
      //   {status: "opened_storefront"}                   → v0.9.0 MAS only
      // The previous handler shipped in v0.7.0 buggy (`update.available`),
      // got patched in v0.7.1 to truthy-check `update`, and is now superseded
      // by the install-on-check flow plus a Restart Now button.
      const result = await ClaugeBridge.checkForUpdates();
      if (result?.status === 'opened_storefront') {
        // v0.9.0 MAS: the Rust side already opened the Mac App Store storefront
        // via shell.open(macappstore://…). Nothing more to do here beyond
        // setting status text so the user knows the click took effect. No
        // restart button — updates land via Apple's normal mechanism.
        if (updatesStatus) {
          updatesStatus.textContent = 'Opened the Mac App Store — updates ship through Apple.';
        }
      } else if (result?.status === 'installed') {
        if (restartBtn) {
          restartBtn.textContent = `↻ Restart Now to apply v${result.version}`;
          restartBtn.hidden = false;
        }
        if (updatesStatus) {
          updatesStatus.textContent = `v${result.version} installed — restart to apply`;
        }
      } else if (updatesStatus) {
        updatesStatus.textContent = 'Up to date';
      }
    } catch (err) {
      console.error('updater check failed:', err);
      if (updatesStatus) updatesStatus.textContent = 'Check failed';
    } finally {
      updatesBtn.disabled = false;
    }
  });

  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      // Fire-and-forget: the Tauri shell exec()s itself before any response
      // can come back. The .catch is only reached if the IPC layer rejects
      // before the kill (which `app.restart()` shouldn't do — it returns ()).
      ClaugeBridge.restartApp().catch((err) => {
        console.error('[updates] restart_app rejected', err);
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  Tab + period segmented control morphing indicator
// ═══════════════════════════════════════════════════════════
function moveIndicator(seg, indId) {
  const ind = document.getElementById(indId);
  const sel = seg.querySelector('[aria-selected="true"]');
  if (!sel || !ind) return;
  const segRect = seg.getBoundingClientRect();
  const r = sel.getBoundingClientRect();
  ind.style.left = (r.left - segRect.left) + 'px';
  ind.style.width = r.width + 'px';
}

function bindSegments() {
  const periodSeg = document.getElementById('period-seg');
  periodSeg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      periodSeg.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-selected'));
      btn.setAttribute('aria-selected', 'true');
      state.period = btn.dataset.period;
      moveIndicator(periodSeg, 'period-ind');
      refreshAll();
    });
  });

  const tabs = document.getElementById('tabs');
  function switchTab(name) {
    state.tab = name;
    tabs.querySelectorAll('button').forEach((b) => {
      b.removeAttribute('aria-selected');
      if (b.dataset.tab === name) b.setAttribute('aria-selected', 'true');
    });
    document.querySelectorAll('[data-panel]').forEach((p) => {
      p.hidden = p.dataset.panel !== name;
    });
    moveIndicator(tabs, 'tab-ind');
    if (name === 'settings') renderSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  tabs.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-jump]').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.jump));
  });

  // v0.8.1: When the first-launch wizard completes via the Connect button,
  // the dashboard should land on Settings → Connections so the user sees
  // their freshly-read credentials. Uses a persisted flag (not a Tauri
  // event) because the dashboard webview may not have loaded yet when
  // wizard_complete runs on macOS first-launch — events don't buffer for
  // late subscribers.
  (async function checkPendingFocusConnections() {
    if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return;
    try {
      var pending = await ClaugeBridge.takePendingFocusConnections();
      if (pending) {
        switchTab('settings');
        // Settings sub-nav button for Connections — attribute is data-set="sync"
        // (legacy name from v0.5.x extension-autodetect era).
        var btn = document.querySelector('.set-side button[data-set="sync"]');
        if (btn) btn.click();
      }
    } catch (err) {
      console.warn('[app] take_pending_focus_connections failed:', err);
    }
  })();

  // Settings sub-nav
  document.querySelectorAll('.set-side button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.set-side button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('[data-set-panel]').forEach((p) => {
        p.hidden = p.dataset.setPanel !== b.dataset.set;
      });
    });
  });

  // Native menu (tray right-click "Preferences…", App menu Settings, Cmd+,)
  // dispatches this event via webview.eval — switch to the Settings tab.
  window.addEventListener('show-settings', () => {
    const settingsBtn = document.querySelector('[data-tab="settings"]');
    if (settingsBtn) settingsBtn.click();
  });

  // Initialize indicator positions after layout settles. Two passes — once
  // immediately so the user sees something, once after fonts have loaded so
  // tab widths are correct on first paint.
  requestAnimationFrame(() => {
    moveIndicator(periodSeg, 'period-ind');
    moveIndicator(tabs, 'tab-ind');
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      moveIndicator(periodSeg, 'period-ind');
      moveIndicator(tabs, 'tab-ind');
    });
  }
  window.addEventListener('resize', () => {
    moveIndicator(periodSeg, 'period-ind');
    moveIndicator(tabs, 'tab-ind');
  });
}

// ═══════════════════════════════════════════════════════════
//  Export link
// ═══════════════════════════════════════════════════════════
function setExportLinks() {
  const params = new URLSearchParams({ period: state.period });
  document.getElementById('export-csv').setAttribute('href', `/api/export?format=csv&${params}`);
}

// ═══════════════════════════════════════════════════════════
//  Header version
// ═══════════════════════════════════════════════════════════
function renderHeaderMeta() {
  const v = state.data.health?.version ?? '0.4.0';
  document.getElementById('brand-meta').textContent = `v${v} · localhost:${location.port || 3456}`;
  document.getElementById('about-version').textContent = `v${v} · MIT · clauding-lab`;
  document.getElementById('foot-version').textContent = `v${v}`;
}

// ═══════════════════════════════════════════════════════════
//  Refresh orchestration (preserves v0.3.1 retry-with-backoff)
// ═══════════════════════════════════════════════════════════
async function refreshAll() {
  document.body.classList.add('loading');
  try {
    setExportLinks();
    const isToday = state.period === 'today';
    const [health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi] =
      await Promise.all([
        api('/api/health'),
        api('/api/summary', commonParams()),
        api('/api/cache', commonParams()),
        api('/api/sessions', commonParams()),
        api('/api/daily', commonParams()),
        // peak-hours panel always shows today's hour distribution; the
        // cost-over-time chart re-uses /api/hours when state.period === 'today'.
        api('/api/hours', commonParams()),
        api('/api/projects', commonParams()),
        api('/api/tasks', commonParams()),
        api('/api/tools', commonParams()),
        api('/api/models', commonParams()),
        api('/api/usage'),
        api('/api/sessions/expensive', { ...commonParams(), limit: 5 }),
        api('/api/roi', commonParams()),
      ]);

    state.data = { health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi };

    __lastSuccessAt = Date.now();
    __lastRefreshFailed = false;

    renderHeaderMeta();
    renderPlanCapacity();
    renderFinanceSide();
    renderMetricStrip();
    renderCostChart();
    renderPeakHours();
    renderProjectsTable();
    renderActivityTable();
    renderModelsTable();
    renderSessionsTable();
    renderToolLists();
    if (state.tab === 'settings') renderSettings();
    // Heatmap fetches its own range (independent of state.period). Fire and
    // forget so a transient /api/activity failure doesn't fail the whole
    // refresh — the heatmap card has its own error handling.
    refreshHeatmap();
    return true;
  } catch (err) {
    console.error('refreshAll failed', err);
    __lastRefreshFailed = true;
    renderPlanCapacity();
    return false;
  } finally {
    document.body.classList.remove('loading');
  }
}

// ═══════════════════════════════════════════════════════════
//  Activity heatmap (v0.9.4 Phase A)
// ═══════════════════════════════════════════════════════════
async function refreshHeatmap() {
  const range = document.getElementById('heatmap-range')?.value ?? '365d';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    state.data.heatmap = await api('/api/activity', { period: range, tz });
    renderActivityHeatmap();
  } catch (err) {
    console.error('heatmap fetch failed', err);
  }
}

function renderActivityHeatmap() {
  const root = document.getElementById('heatmap-root');
  const statsEl = document.getElementById('heatmap-stats');
  if (!root || !window.ClaugeHeatmap) return;
  const data = state.data.heatmap;
  window.ClaugeHeatmap.render(root, data, { variant: 'dashboard' });
  if (statsEl) {
    if (!data || data.totalDays === 0) {
      statsEl.textContent = '—';
      return;
    }
    const parts = [`${data.activeDays} active day${data.activeDays === 1 ? '' : 's'}`];
    if (data.currentStreak > 0) parts.push(`${data.currentStreak}-day streak`);
    if (data.longestStreak > 0 && data.longestStreak !== data.currentStreak) {
      parts.push(`longest ${data.longestStreak}`);
    }
    statsEl.textContent = parts.join(' · ');
  }
}

/**
 * Initial load helper (preserved from v0.3.1, Bug #5 fix / T32).
 *
 * The Tauri dashboard window opens before the SEA sidecar is guaranteed to
 * have parsed all JSONL files and bound its port (a 100–500ms race in v0.3.0
 * smoke testing). The first refreshAll() therefore frequently threw
 * `Failed to fetch`, the dashboard stayed blank, and the user had to manually
 * reload.
 *
 * Strategy: keep retrying initial load with exponential backoff
 * (300ms, 600ms, 1.2s, 2.4s, capped at 4s) for up to 30s. Once the first
 * refresh succeeds, switch to the normal user-driven model. Subsequent
 * user-triggered refreshes (period switch, refresh button) DO NOT retry —
 * the user would rather see an obvious empty state than a silently-frozen UI.
 */
async function initialLoad() {
  const MAX_TOTAL_MS = 30_000;
  const start = Date.now();
  let delay = 300;
  while (true) {
    const ok = await refreshAll();
    if (ok) {
      // (Stripped success-log: DevTools ships in v0.4.0, but routine
      // success messages were just noise. Failures still warn below.)
      return;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= MAX_TOTAL_MS) {
      console.warn(
        `[Clauge] Dashboard could not reach the API after ${Math.round(elapsed / 1000)}s. ` +
        'Check that clauge-server is running on the expected port.'
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 2), 4_000);
  }
}

// ═══════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════
function bindControls() {
  document.getElementById('btn-refresh').addEventListener('click', () => {
    refreshAll();
  });
  // v0.7.0: claude.ai sync card removed; Connections panel (connections.js)
  // owns the sync/extension/keychain state. Old set-sync-* IDs are gone.

  // v0.9.4: heatmap range dropdown.
  document.getElementById('heatmap-range')?.addEventListener('change', () => {
    refreshHeatmap();
  });
}

bindSegments();
bindControls();
initialLoad();

// Auto-refresh the plan-usage card every 60s — picks up new bookmarklet/
// extension ingest without a full dashboard refresh.
setInterval(async () => {
  try {
    state.data.usage = await api('/api/usage');
    __lastSuccessAt = Date.now();
    __lastRefreshFailed = false;
    renderPlanCapacity();
    renderFinanceSide();
    if (state.tab === 'settings') renderSettings();
  } catch (err) {
    console.error('plan auto-refresh', err);
    __lastRefreshFailed = true;
    renderPlanCapacity();
  }
}, 60_000);
