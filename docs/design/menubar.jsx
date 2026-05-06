/* Clauge — Mac menu bar popover
   Compact, glanceable. Same design language as dashboard.
   Width ~360px, dynamic height.
*/
const { useState, useMemo, useEffect } = React;

const MB_GAUGES = [
  { label: "Session",   pct: 0.68, sub: "5h",  state: "ok",   reset: "2h 14m" },
  { label: "Weekly",    pct: 0.42, sub: "7d",  state: "ok",   reset: "4d 6h" },
  { label: "Sonnet",    pct: 0.58, sub: "7d",  state: "ok",   reset: "4d 6h" },
  { label: "Opus",      pct: 0.86, sub: "7d",  state: "warn", reset: "4d 6h" },
];

const MB_TODAY = {
  apiEquiv: 8.42,
  messages: 28,
  tools: 184,
  sessions: 3,
  hit: 0.74,
  topProject: "clauge",
  topProjectCost: 4.40,
};

const MB_RECENT = [
  { time: "14:22", project: "clauge",     model: "sonnet", dur: "1h 12m", cost: 6.40 },
  { time: "11:08", project: "the-brief",  model: "sonnet", dur: "48m",    cost: 3.92 },
  { time: "09:14", project: "clauge",     model: "opus",   dur: "32m",    cost: 4.10 },
];

const MB_SPARK = Array.from({ length: 24 }, (_, i) => {
  return Math.max(0.05, Math.exp(-Math.pow((i - 14) / 5, 2)) * 0.9 + Math.cos(i * 0.4) * 0.1 + 0.1);
});

function MiniRing({ pct, state, label, sub, reset }) {
  const size = 56, stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - pct * c;
  const colorMap = {
    ok: "var(--brand)",
    warn: "var(--warn)",
    crit: "var(--crit)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
          <circle cx={size/2} cy={size/2} r={r} fill="none"
            stroke={colorMap[state]} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset} />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {Math.round(pct * 100)}<span style={{ fontSize: 8, color: "var(--text-3)" }}>%</span>
          </span>
        </div>
      </div>
      <div style={{ textAlign: "center", lineHeight: 1.15 }}>
        <div style={{ fontSize: 10.5, color: "var(--text)", fontWeight: 500 }}>{label}</div>
        <div className="mono" style={{ fontSize: 9.5, color: "var(--text-3)", marginTop: 1 }}>{reset}</div>
      </div>
    </div>
  );
}

function MenuBar() {
  const [tab, setTab] = useState("today");

  return (
    <div style={{
      width: 380,
      background: "var(--surface)",
      border: "1px solid var(--hairline-2)",
      borderRadius: 14,
      boxShadow: "var(--shadow-pop)",
      overflow: "hidden",
      fontFamily: "var(--sans)",
      color: "var(--text)",
    }}>
      {/* Caret to menu bar */}
      <div style={{
        position: "absolute", top: -7, left: 38,
        width: 12, height: 12,
        background: "var(--surface)",
        border: "1px solid var(--hairline-2)",
        borderRight: 0, borderBottom: 0,
        transform: "rotate(45deg)",
      }} />

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px",
        borderBottom: "1px solid var(--hairline)",
        background: "linear-gradient(180deg, rgba(217,119,87,0.04), transparent)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="assets/clauge-icon.svg" width={18} height={18} style={{ display: "block" }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.01em" }}>Clauge</span>
          <span style={{
            fontSize: 9.5, padding: "1.5px 6px", borderRadius: 4,
            background: "var(--ok-tint)", color: "var(--ok)",
            display: "flex", alignItems: "center", gap: 5,
            letterSpacing: "0.04em",
          }}>
            <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--ok)" }} />
            live
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button title="Open dashboard" style={mbIconBtn}>↗</button>
          <button title="Refresh" style={mbIconBtn}>↻</button>
          <button title="Preferences" style={mbIconBtn}>⚙</button>
        </div>
      </div>

      {/* Big number — today */}
      <div style={{ padding: "16px 16px 4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)" }}>
            Today · API equivalent
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
            updated 28s ago
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div className="mono" style={{
            fontSize: 36, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1,
          }}>
            ${MB_TODAY.apiEquiv.toFixed(2)}
          </div>
          <div style={{
            fontSize: 10.5, color: "var(--brand-2)",
            display: "flex", alignItems: "center", gap: 4,
            padding: "2px 7px", borderRadius: 4,
            background: "var(--brand-tint)",
          }}>
            <span>↗</span> +18% vs yest
          </div>
        </div>

        {/* sparkline */}
        <div style={{ marginTop: 10, height: 28, display: "flex", alignItems: "flex-end", gap: 2 }}>
          {MB_SPARK.map((v, i) => {
            const max = Math.max(...MB_SPARK);
            const h = (v / max) * 100;
            const isNow = i === 14;
            return (
              <div key={i} style={{
                flex: 1, height: `${h}%`,
                background: isNow ? "var(--brand)" : "var(--surface-3)",
                borderRadius: 1,
                opacity: i > 14 ? 0.3 : 1,
              }} />
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 9, color: "var(--text-4)" }} className="mono">
          <span>00:00</span><span>now 14:22</span><span>23:00</span>
        </div>
      </div>

      {/* Plan ring strip */}
      <div style={{
        margin: "12px 12px 0",
        padding: "12px 6px",
        background: "var(--bg-2)",
        borderRadius: 10,
        border: "1px solid var(--hairline)",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-around", alignItems: "center",
        }}>
          {MB_GAUGES.map(g => <MiniRing key={g.label} {...g} />)}
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: "flex", gap: 2,
        margin: "14px 14px 0",
        padding: 2,
        background: "var(--bg-2)",
        borderRadius: 8,
        border: "1px solid var(--hairline)",
      }}>
        {[
          { id: "today",  label: "Today" },
          { id: "recent", label: "Recent" },
          { id: "models", label: "Models" },
        ].map(t => (
          <button key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, appearance: "none", border: 0, cursor: "pointer",
              padding: "5px 8px", fontSize: 11, fontWeight: 500,
              borderRadius: 6,
              background: tab === t.id ? "var(--surface)" : "transparent",
              color: tab === t.id ? "var(--text)" : "var(--text-3)",
              fontFamily: "inherit",
              boxShadow: tab === t.id ? "0 1px 0 rgba(255,240,230,0.04) inset, 0 1px 2px rgba(0,0,0,0.2)" : "none",
            }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: "10px 14px 14px", minHeight: 130 }}>
        {tab === "today" && <TodayTab />}
        {tab === "recent" && <RecentTab />}
        {tab === "models" && <ModelsTab />}
      </div>

      {/* Footer */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 14px",
        borderTop: "1px solid var(--hairline)",
        background: "var(--bg-2)",
      }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
          ⌘D dashboard · ⌘R refresh
        </span>
        <a href="#" style={{ fontSize: 11, color: "var(--brand-2)", textDecoration: "none" }}>
          Open dashboard →
        </a>
      </div>
    </div>
  );
}

function TodayTab() {
  const items = [
    { label: "Messages",    value: MB_TODAY.messages },
    { label: "Tool calls",  value: MB_TODAY.tools },
    { label: "Sessions",    value: MB_TODAY.sessions },
    { label: "Cache hit",   value: Math.round(MB_TODAY.hit * 100) + "%", accent: "var(--ok)" },
  ];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        {items.map(i => (
          <div key={i.label} style={{
            padding: "8px 10px", background: "var(--bg-2)",
            border: "1px solid var(--hairline)", borderRadius: 8,
          }}>
            <div style={{ fontSize: 9, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)" }}>
              {i.label}
            </div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 600, marginTop: 2, color: i.accent || "var(--text)", letterSpacing: "-0.01em" }}>
              {i.value}
            </div>
          </div>
        ))}
      </div>
      <div style={{
        marginTop: 10, padding: "9px 10px",
        background: "var(--brand-tint)",
        border: "1px solid rgba(217,119,87,0.18)",
        borderRadius: 8,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--brand-2)" }}>Top project</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{MB_TODAY.topProject}</span>
        </div>
        <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--brand)" }}>
          ${MB_TODAY.topProjectCost.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function RecentTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {MB_RECENT.map((s, i) => (
        <div key={i} style={{
          display: "grid", gridTemplateColumns: "auto 1fr auto auto",
          gap: 10, alignItems: "center",
          padding: "8px 4px",
          borderBottom: i < MB_RECENT.length - 1 ? "1px solid var(--hairline)" : "none",
          fontSize: 11.5,
        }}>
          <span className="mono" style={{ color: "var(--text-3)", fontSize: 11 }}>{s.time}</span>
          <span className="mono" style={{ color: "var(--text)" }}>{s.project}</span>
          <span style={{
            fontSize: 9.5, padding: "1px 5px", borderRadius: 3,
            color: s.model === "opus" ? "var(--opus)" : s.model === "haiku" ? "var(--haiku)" : "var(--sonnet)",
            background: "var(--surface-2)",
            fontFamily: "var(--mono)",
          }}>{s.model}</span>
          <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>${s.cost.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

function ModelsTab() {
  const models = [
    { name: "sonnet-4.5", cost: 5.82, share: 0.69, color: "var(--sonnet)" },
    { name: "opus-4",     cost: 2.21, share: 0.26, color: "var(--opus)" },
    { name: "haiku-4.5",  cost: 0.39, share: 0.05, color: "var(--haiku)" },
  ];
  return (
    <div>
      {/* Stacked bar */}
      <div style={{
        display: "flex", height: 6, borderRadius: 999, overflow: "hidden",
        marginBottom: 14, background: "var(--surface-3)",
      }}>
        {models.map(m => (
          <div key={m.name} style={{
            width: `${m.share * 100}%`, background: m.color,
          }} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {models.map(m => (
          <div key={m.name} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 10, alignItems: "center" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color }} />
            <span className="mono" style={{ fontSize: 11.5 }}>{m.name}</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{Math.round(m.share * 100)}%</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, minWidth: 48, textAlign: "right" }}>${m.cost.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const mbIconBtn = {
  appearance: "none",
  width: 24, height: 24,
  border: 0,
  background: "transparent",
  color: "var(--text-3)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  display: "grid", placeItems: "center",
  fontFamily: "inherit",
  transition: "background 120ms",
};

window.ClaugeMenuBar = MenuBar;
