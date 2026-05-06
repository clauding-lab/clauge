/* Clauge dashboard prototype
   Modern, dense, mono-forward. Brand orange leads.
*/
const { useState, useMemo, useEffect, useRef } = React;

// ─────────────────────────────────────────────────────────
// Mock data
// ─────────────────────────────────────────────────────────
const PERIODS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "Month" },
  { id: "all", label: "All time" },
];

function mockSeries(period) {
  const len = period === "today" ? 24 : period === "7d" ? 7 : period === "30d" ? 30 : period === "month" ? 22 : 90;
  const seed = period.length * 13;
  const arr = [];
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const wave = 0.6 + Math.sin(i * 0.7 + seed) * 0.25 + Math.cos(i * 0.31) * 0.18;
    arr.push(Math.max(0.05, wave + (i === Math.floor(len * 0.7) ? 0.4 : 0)));
  }
  return arr;
}

function summaryFor(period) {
  const factor = { today: 0.04, "7d": 0.32, "30d": 1.4, month: 1.05, all: 8.7 }[period] || 1;
  return {
    apiEquiv: 84.62 * factor,
    subscription: 200,
    netSavings: 21.4 * factor,
    messages: Math.round(412 * factor),
    toolCalls: Math.round(2480 * factor),
    sessions: Math.round(38 * factor),
    subagents: Math.round(64 * factor),
    cacheHit: 0.71,
    tokens: 14.2e6 * factor,
    inputTokens: 1.8e6 * factor,
    outputTokens: 0.42e6 * factor,
    cacheRead: 8.6e6 * factor,
    cache5m: 2.4e6 * factor,
    cache1h: 1.0e6 * factor,
    primaryModel: "claude-sonnet-4.5",
  };
}

const PROJECTS = [
  { name: "clauding-lab/clauge",     cost: 38.42, sessions: 14, msgs: 162, tools: 980, tokens: 5.6e6, hit: 0.74 },
  { name: "clauding-lab/the-brief",  cost: 22.10, sessions:  9, msgs: 102, tools: 612, tokens: 3.2e6, hit: 0.69 },
  { name: "clauding-lab/yieldscope", cost: 12.90, sessions:  6, msgs:  74, tools: 401, tokens: 2.0e6, hit: 0.66 },
  { name: "clauding-lab/masthead",   cost:  6.84, sessions:  4, msgs:  41, tools: 220, tokens: 1.4e6, hit: 0.71 },
  { name: "clauding-lab/policy-pulse", cost: 4.36, sessions: 3, msgs:  22, tools: 158, tokens: 1.1e6, hit: 0.62 },
  { name: "personal/dotfiles",       cost:  0.84, sessions:  2, msgs:  11, tools: 109, tokens: 0.9e6, hit: 0.58 },
];

const ACTIVITIES = [
  { name: "Coding",         calls: 1208, color: "var(--brand)" },
  { name: "Debugging",      calls:  462, color: "var(--brand-2)" },
  { name: "Exploration",    calls:  308, color: "#c9967a" },
  { name: "Testing",        calls:  198, color: "#a8836f" },
  { name: "Git Ops",        calls:  154, color: "#8a7060" },
  { name: "Planning",       calls:   88, color: "#6f5a4f" },
  { name: "Build",          calls:   42, color: "#5e4e44" },
  { name: "Conversation",   calls:   20, color: "#4a3f37" },
];

const MODELS = [
  { name: "claude-sonnet-4.5", cost: 58.20, calls: 1842, hit: 0.73, color: "var(--sonnet)" },
  { name: "claude-opus-4",     cost: 22.10, calls:  402, hit: 0.62, color: "var(--opus)" },
  { name: "claude-haiku-4.5",  cost:  4.32, calls:  236, hit: 0.81, color: "var(--haiku)" },
];

const TOOLS = [
  { name: "Read",    calls: 612 },
  { name: "Edit",    calls: 408 },
  { name: "Bash",    calls: 312 },
  { name: "Grep",    calls: 240 },
  { name: "Write",   calls: 188 },
  { name: "Glob",    calls: 142 },
  { name: "Task",    calls:  86 },
];

const SHELL = [
  { name: "git",   calls: 142 },
  { name: "ls",    calls: 108 },
  { name: "node",  calls:  64 },
  { name: "rg",    calls:  52 },
  { name: "npm",   calls:  41 },
  { name: "find",  calls:  28 },
];

const MCP = [
  { name: "filesystem",  calls: 84 },
  { name: "github",      calls: 62 },
  { name: "linear",      calls: 38 },
  { name: "puppeteer",   calls: 14 },
];

const SESSIONS = [
  { started: "Today 14:22", project: "clauge",        model: "sonnet-4.5", task: "Coding",      dur: "1h 12m", calls: 184, tok: "412k", hit: 0.78, cost: 6.40, hot: true },
  { started: "Today 11:08", project: "the-brief",     model: "sonnet-4.5", task: "Debugging",   dur: "48m",    calls: 122, tok: "284k", hit: 0.71, cost: 3.92 },
  { started: "Today 09:14", project: "clauge",        model: "opus-4",     task: "Planning",    dur: "32m",    calls:  68, tok: "192k", hit: 0.62, cost: 4.10 },
  { started: "Yest 22:42",  project: "yieldscope",    model: "sonnet-4.5", task: "Coding",      dur: "2h 04m", calls: 248, tok: "512k", hit: 0.74, cost: 7.84, hot: true },
  { started: "Yest 18:30",  project: "the-brief",     model: "haiku-4.5",  task: "Exploration", dur: "22m",    calls:  42, tok: " 88k", hit: 0.81, cost: 0.42 },
  { started: "Yest 14:12",  project: "policy-pulse",  model: "sonnet-4.5", task: "Testing",     dur: "1h 08m", calls: 102, tok: "208k", hit: 0.69, cost: 2.84 },
  { started: "May 4 22:18", project: "masthead",      model: "sonnet-4.5", task: "Coding",      dur: "1h 32m", calls: 158, tok: "342k", hit: 0.72, cost: 5.21 },
  { started: "May 4 14:02", project: "clauge",        model: "opus-4",     task: "Debugging",   dur: "44m",    calls:  82, tok: "224k", hit: 0.58, cost: 5.62, hot: true },
];

const HOURS = Array.from({ length: 24 }, (_, h) => {
  // peak around 14-22 UTC
  const peak = Math.exp(-Math.pow((h - 18) / 4.5, 2)) * 0.9 + 0.05;
  const morning = Math.exp(-Math.pow((h - 9) / 3, 2)) * 0.4;
  return Math.max(0.02, peak + morning + Math.sin(h * 0.7) * 0.05);
});

const PLAN_GAUGES = [
  { label: "Session",     pct: 0.68, sub: "5h",  reset: "in 2h 14m",  state: "ok" },
  { label: "Weekly all",  pct: 0.42, sub: "7d",  reset: "in 4d 6h",   state: "ok" },
  { label: "Sonnet",      pct: 0.58, sub: "7d",  reset: "in 4d 6h",   state: "ok" },
  { label: "Opus",        pct: 0.86, sub: "7d",  reset: "in 4d 6h",   state: "warn" },
  { label: "Design",      pct: 0.21, sub: "7d",  reset: "in 4d 6h",   state: "ok" },
];

// ─────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────
const fmt$ = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt$0 = (n) => "$" + Math.round(n).toLocaleString();
const fmtN = (n) => n.toLocaleString();
const fmtTok = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Math.round(n).toString();
};
const fmtPct = (n) => Math.round(n * 100) + "%";

// ─────────────────────────────────────────────────────────
// Atoms
// ─────────────────────────────────────────────────────────
function Spark({ data, color = "var(--brand)", height = 28, fill = true }) {
  const max = Math.max(...data) * 1.05;
  const min = 0;
  const W = 100, H = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((v - min) / (max - min)) * H;
    return [x, y];
  });
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const fillPath = path + ` L ${W},${H} L 0,${H} Z`;
  const id = "sp" + Math.random().toString(36).slice(2, 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={fillPath} fill={`url(#${id})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Ring({ pct, state = "ok", size = 92, label, sub, reset }) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - pct * c;
  const colorMap = {
    ok: "var(--brand)",
    warn: "var(--warn)",
    crit: "var(--crit)",
  };
  const color = colorMap[state];
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--surface-3)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 600ms var(--ease)" }} />
        </svg>
        <div style={{
          position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 0,
        }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {Math.round(pct * 100)}<span style={{ fontSize: 11, color: "var(--text-3)" }}>%</span>
          </div>
          <div style={{ fontSize: 9.5, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{sub}</div>
        </div>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11.5, color: "var(--text)", fontWeight: 500 }}>{label}</div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 2 }}>{reset}</div>
      </div>
    </div>
  );
}

function Card({ children, style, padded = true, ...rest }) {
  return (
    <div {...rest} style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-3)",
      boxShadow: "var(--shadow-1)",
      padding: padded ? 18 : 0,
      ...style,
    }}>{children}</div>
  );
}

function CardHeader({ title, sub, action }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h3 style={{
          margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.10em",
          textTransform: "uppercase", color: "var(--text-2)",
        }}>{title}</h3>
        {sub && <span style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</span>}
      </div>
      {action}
    </div>
  );
}

function Stat({ label, value, sub, accent, mono = true }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "2px 0" }}>
      <div style={{ fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)" }}>
        {label}
      </div>
      <div className={mono ? "mono" : ""} style={{
        fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em",
        color: accent || "var(--text)", lineHeight: 1.05,
      }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</div>}
    </div>
  );
}

function Bar({ pct, color = "var(--brand)", height = 6 }) {
  return (
    <div style={{
      height, width: "100%", background: "var(--surface-3)",
      borderRadius: 999, overflow: "hidden",
    }}>
      <div style={{
        height: "100%", width: `${Math.min(100, pct * 100)}%`,
        background: color, borderRadius: 999,
        transition: "width 600ms var(--ease)",
      }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Topbar
// ─────────────────────────────────────────────────────────
function Topbar({ period, setPeriod, projectFilter, setProjectFilter }) {
  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "16px 24px", borderBottom: "1px solid var(--border)",
      background: "linear-gradient(180deg, rgba(217,119,87,0.025), transparent)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: "var(--surface-2)",
          display: "grid", placeItems: "center",
          border: "1px solid var(--hairline-2)",
        }}>
          <img src="assets/clauge-icon.svg" alt="" width={22} height={22} style={{ display: "block" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "-0.01em" }}>Clauge</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: "0.04em" }}>
            v0.2.0 · localhost:3456
          </div>
        </div>
        <span style={{
          marginLeft: 6,
          fontSize: 10.5, padding: "3px 8px", borderRadius: 999,
          background: "var(--ok-tint)", color: "var(--ok)",
          letterSpacing: "0.04em",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ok)" }} />
          synced 28s ago
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* period switcher */}
        <div style={{
          display: "inline-flex", padding: 3, gap: 2,
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 999,
        }}>
          {PERIODS.map(p => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              style={{
                appearance: "none", border: 0, cursor: "pointer",
                padding: "5px 11px", fontSize: 11.5, fontWeight: 500,
                borderRadius: 999,
                background: period === p.id ? "var(--brand)" : "transparent",
                color: period === p.id ? "#1c100a" : "var(--text-2)",
                fontFamily: "inherit",
                letterSpacing: "0.01em",
                transition: "all 160ms var(--ease)",
              }}
            >{p.label}</button>
          ))}
        </div>
        {/* project filter */}
        <div style={{ position: "relative" }}>
          <input
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            placeholder="filter project…"
            style={{
              appearance: "none",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              padding: "6px 12px 6px 28px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              width: 180,
              outline: "none",
            }}
          />
          <div style={{
            position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
            color: "var(--text-3)", fontSize: 11,
          }}>⌕</div>
        </div>
        {/* export */}
        <div style={{ display: "flex", gap: 4 }}>
          <button className="ghost-btn">CSV</button>
          <button className="ghost-btn">JSON</button>
        </div>
        {/* refresh */}
        <button className="ghost-btn" title="Refresh">↻</button>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────
// Headline strip — hero metric + secondary
// ─────────────────────────────────────────────────────────
function Headline({ s, period, series }) {
  return (
    <Card padded={false} style={{
      background: "linear-gradient(180deg, rgba(217,119,87,0.08), rgba(217,119,87,0.02) 60%, transparent), var(--surface)",
      borderColor: "rgba(217,119,87,0.18)",
      padding: 0,
      overflow: "hidden",
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1.6fr 1fr 1fr 1fr",
        gap: 0,
      }}>
        {/* Hero — API equivalent */}
        <div style={{ padding: "22px 24px", borderRight: "1px solid var(--hairline)", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 18 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)" }}>API equivalent</span>
              <span style={{
                fontSize: 9.5, padding: "1px 6px", borderRadius: 4,
                background: "var(--brand-tint)", color: "var(--brand-2)",
                letterSpacing: "0.06em",
              }}>{PERIODS.find(p=>p.id===period)?.label}</span>
            </div>
            <div className="mono" style={{
              fontSize: 56, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1,
              color: "var(--text)",
            }}>
              ${s.apiEquiv.toFixed(2)}
            </div>
            <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--text-2)", maxWidth: 460 }}>
              At observed token usage, your <span style={{ color: "var(--brand)" }}>${s.subscription}/mo</span> subscription
              replaces this much retail API spend.
              <span style={{ color: "var(--text-3)" }}> Net cache savings <span className="mono">{fmt$(s.netSavings)}</span>.</span>
            </div>
          </div>
          <div>
            <Spark data={series} height={42} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10.5, color: "var(--text-3)" }} className="mono">
              <span>{period === "today" ? "00:00" : "start"}</span>
              <span>now</span>
            </div>
          </div>
        </div>

        {/* Secondary stats */}
        <SecondaryCell label="Messages"   value={fmtN(s.messages)} sub={`${fmtN(s.toolCalls)} tool calls`} spark={mockSeries(period+"a")} />
        <SecondaryCell label="Sessions"   value={fmtN(s.sessions)} sub={`${fmtN(s.subagents)} subagents`} spark={mockSeries(period+"b")} />
        <SecondaryCell label="Cache hit"  value={fmtPct(s.cacheHit)} sub={`${fmtTok(s.cacheRead)} cached reads`} spark={mockSeries(period+"c")} accent="var(--ok)" />
      </div>

      {/* Token breakdown row */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(6, 1fr)",
        borderTop: "1px solid var(--hairline)",
      }}>
        <TokenCell label="Input"          value={fmtTok(s.inputTokens)} />
        <TokenCell label="Output"         value={fmtTok(s.outputTokens)} />
        <TokenCell label="Cache read"     value={fmtTok(s.cacheRead)} />
        <TokenCell label="Cache 5m"       value={fmtTok(s.cache5m)} />
        <TokenCell label="Cache 1h"       value={fmtTok(s.cache1h)} />
        <TokenCell label="Total tokens"   value={fmtTok(s.tokens)} accent="var(--brand)" />
      </div>
    </Card>
  );
}

function SecondaryCell({ label, value, sub, spark, accent }) {
  return (
    <div style={{ padding: "22px 22px", borderRight: "1px solid var(--hairline)", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 14 }}>
      <div>
        <div style={{ fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 8 }}>{label}</div>
        <div className="mono" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: accent || "var(--text)" }}>{value}</div>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>{sub}</div>
      </div>
      <Spark data={spark} height={28} color="var(--text-3)" fill={false} />
    </div>
  );
}

function TokenCell({ label, value, accent }) {
  return (
    <div style={{ padding: "12px 22px", borderRight: "1px solid var(--hairline)" }}>
      <div style={{ fontSize: 9.5, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)" }}>{label}</div>
      <div className="mono" style={{ fontSize: 15, fontWeight: 500, letterSpacing: "-0.01em", color: accent || "var(--text)", marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Plan usage card — the 5 ring gauges
// ─────────────────────────────────────────────────────────
function PlanCard() {
  return (
    <Card>
      <CardHeader
        title="claude.ai plan usage"
        sub="auto-synced via extension"
        action={
          <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>updated 32s ago</span>
        }
      />
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(5, 1fr) 1.4fr",
        gap: 18, alignItems: "center",
      }}>
        {PLAN_GAUGES.map(g => (
          <Ring key={g.label} {...g} />
        ))}
        {/* Extra usage */}
        <div style={{
          padding: "16px 18px",
          background: "var(--surface-2)",
          borderRadius: "var(--r-2)",
          border: "1px solid var(--hairline)",
        }}>
          <div style={{ fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--text-3)" }}>Extra usage</div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>$3.40</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>of $40 cap</span>
          </div>
          <div style={{ marginTop: 10 }}>
            <Bar pct={0.085} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10.5, color: "var(--text-3)" }} className="mono">
            <span>8.5% of cap</span>
            <span>resets May 12</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────────────────
function DailyChart({ period, series }) {
  const max = Math.max(...series);
  const labels = period === "today"
    ? Array.from({ length: 24 }, (_, i) => (i % 4 === 0 ? `${i.toString().padStart(2, "0")}:00` : ""))
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].slice(0, series.length);

  return (
    <Card>
      <CardHeader
        title="Cost over time"
        sub="hover for details"
        action={
          <div style={{ display: "flex", gap: 6 }}>
            <ToggleChip active label="Cost" />
            <ToggleChip label="Calls" />
            <ToggleChip label="Tokens" />
          </div>
        }
      />
      <div style={{ position: "relative", height: 200, display: "flex", alignItems: "flex-end", gap: period === "today" ? 4 : 8 }}>
        {/* gridlines */}
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", pointerEvents: "none" }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ height: 1, background: "var(--hairline)", opacity: i === 3 ? 0 : 1 }} />
          ))}
        </div>
        {series.map((v, i) => {
          const h = (v / max) * 100;
          const today = period === "today" && i === series.length - 1;
          return (
            <div key={i} style={{
              flex: 1, height: "100%",
              display: "flex", flexDirection: "column", justifyContent: "flex-end",
              position: "relative", cursor: "default",
            }}
              title={`${fmt$(v * 12)}`}
            >
              <div style={{
                height: `${h}%`,
                background: today ? "var(--brand)" : `linear-gradient(180deg, var(--brand-2), var(--brand))`,
                opacity: today ? 1 : 0.55,
                borderRadius: "3px 3px 1px 1px",
                transition: "opacity 200ms var(--ease)",
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 10.5, color: "var(--text-3)" }} className="mono">
        {labels.length > 0 && labels.map((l, i) => <span key={i} style={{ flex: 1, textAlign: i === 0 ? "left" : i === labels.length - 1 ? "right" : "center" }}>{l}</span>)}
      </div>
    </Card>
  );
}

function ToggleChip({ active, label }) {
  return (
    <button style={{
      appearance: "none", border: "1px solid " + (active ? "var(--brand)" : "var(--border)"),
      background: active ? "var(--brand-tint)" : "transparent",
      color: active ? "var(--brand-2)" : "var(--text-3)",
      padding: "3px 9px", fontSize: 11, borderRadius: 999, cursor: "pointer",
      fontFamily: "inherit",
    }}>{label}</button>
  );
}

function PeakHours() {
  const max = Math.max(...HOURS);
  return (
    <Card>
      <CardHeader title="Peak hours" sub="distribution by hour (UTC)" />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 100 }}>
        {HOURS.map((v, h) => {
          const isPeak = v / max > 0.7;
          return (
            <div key={h} style={{
              flex: 1,
              height: `${(v / max) * 100}%`,
              background: isPeak ? "var(--brand)" : "var(--surface-3)",
              borderRadius: 2,
              minHeight: 3,
              opacity: isPeak ? 1 : 0.7,
            }} title={`${h}:00`} />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10.5, color: "var(--text-3)" }} className="mono">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────
function TableShell({ title, sub, action, children }) {
  return (
    <Card>
      <CardHeader title={title} sub={sub} action={action} />
      <div style={{ overflowX: "auto" }}>{children}</div>
    </Card>
  );
}

const thStyle = {
  textAlign: "left", padding: "6px 10px",
  borderBottom: "1px solid var(--border)",
  fontSize: 10, fontWeight: 600, letterSpacing: "0.10em",
  textTransform: "uppercase", color: "var(--text-3)",
  whiteSpace: "nowrap",
};
const tdStyle = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--hairline)",
  fontSize: 12, color: "var(--text)",
  whiteSpace: "nowrap",
};

function ProjectsTable() {
  const max = Math.max(...PROJECTS.map(p => p.cost));
  return (
    <TableShell title="By project" sub="cost · sessions · messages · tools">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={thStyle}>Project</th>
          <th style={{...thStyle, width: "20%"}}></th>
          <th style={{...thStyle, textAlign: "right"}}>Cost</th>
          <th style={{...thStyle, textAlign: "right"}}>Sess</th>
          <th style={{...thStyle, textAlign: "right"}}>Msgs</th>
          <th style={{...thStyle, textAlign: "right"}}>Tools</th>
          <th style={{...thStyle, textAlign: "right"}}>Tokens</th>
          <th style={{...thStyle, textAlign: "right"}}>Hit</th>
        </tr></thead>
        <tbody>
          {PROJECTS.map(p => (
            <tr key={p.name} style={{ transition: "background 120ms" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <td style={{...tdStyle, fontFamily: "var(--mono)", fontSize: 11.5}}>
                {p.name.split("/")[0]}<span style={{ color: "var(--text-3)" }}>/</span>{p.name.split("/")[1]}
              </td>
              <td style={tdStyle}><Bar pct={p.cost / max} /></td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)"}}>{fmt$(p.cost)}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{p.sessions}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{p.msgs}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{p.tools}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{fmtTok(p.tokens)}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: p.hit > 0.7 ? "var(--ok)" : "var(--text-2)"}}>{fmtPct(p.hit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

function ActivityTable() {
  const total = ACTIVITIES.reduce((s, a) => s + a.calls, 0);
  return (
    <TableShell title="By activity" sub="primary intent (heuristic)">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={thStyle}>Activity</th>
          <th style={{...thStyle, width: "40%"}}></th>
          <th style={{...thStyle, textAlign: "right"}}>Calls</th>
          <th style={{...thStyle, textAlign: "right"}}>Share</th>
        </tr></thead>
        <tbody>
          {ACTIVITIES.map(a => (
            <tr key={a.name}>
              <td style={{...tdStyle, color: "var(--text)"}}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: 2,
                  background: a.color, marginRight: 8, verticalAlign: "middle",
                }} />
                {a.name}
              </td>
              <td style={tdStyle}>
                <div style={{ height: 4, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(a.calls / total) * 100}%`, background: a.color }} />
                </div>
              </td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)"}}>{fmtN(a.calls)}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-3)"}}>{fmtPct(a.calls / total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

function ModelsTable() {
  const totalCost = MODELS.reduce((s, m) => s + m.cost, 0);
  return (
    <TableShell title="By model" sub="cost · cache · share">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={thStyle}>Model</th>
          <th style={{...thStyle, width: "30%"}}></th>
          <th style={{...thStyle, textAlign: "right"}}>Cost</th>
          <th style={{...thStyle, textAlign: "right"}}>Calls</th>
          <th style={{...thStyle, textAlign: "right"}}>Hit</th>
        </tr></thead>
        <tbody>
          {MODELS.map(m => (
            <tr key={m.name}>
              <td style={{...tdStyle, fontFamily: "var(--mono)", fontSize: 11.5}}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: 2,
                  background: m.color, marginRight: 8, verticalAlign: "middle",
                }} />
                {m.name}
              </td>
              <td style={tdStyle}>
                <Bar pct={m.cost / totalCost} color={m.color} />
              </td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)"}}>{fmt$(m.cost)}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{fmtN(m.calls)}</td>
              <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{fmtPct(m.hit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

function ToolList({ title, sub, items }) {
  const max = Math.max(...items.map(i => i.calls));
  return (
    <Card>
      <CardHeader title={title} sub={sub} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map(t => (
          <div key={t.name} style={{ display: "grid", gridTemplateColumns: "70px 1fr auto", gap: 10, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>{t.name}</span>
            <Bar pct={t.calls / max} color="var(--brand)" height={4} />
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", minWidth: 40, textAlign: "right" }}>{fmtN(t.calls)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SessionsTable() {
  return (
    <Card>
      <CardHeader
        title="Sessions"
        sub={`${SESSIONS.length} shown · ★ in top-cost`}
        action={
          <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--text-3)" }}>
            <span>Sort by</span>
            <span style={{ color: "var(--brand)", cursor: "pointer" }}>cost ↓</span>
          </div>
        }
      />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={thStyle}>Started</th>
            <th style={thStyle}>Project</th>
            <th style={thStyle}>Model</th>
            <th style={thStyle}>Task</th>
            <th style={{...thStyle, textAlign: "right"}}>Duration</th>
            <th style={{...thStyle, textAlign: "right"}}>Calls</th>
            <th style={{...thStyle, textAlign: "right"}}>Tokens</th>
            <th style={{...thStyle, textAlign: "right"}}>Hit</th>
            <th style={{...thStyle, textAlign: "right"}}>Cost</th>
          </tr></thead>
          <tbody>
            {SESSIONS.map((s, i) => (
              <tr key={i} style={{ transition: "background 120ms" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <td style={{...tdStyle, fontFamily: "var(--mono)", color: "var(--text-2)"}}>
                  {s.hot && <span style={{ color: "var(--brand)", marginRight: 6 }}>★</span>}
                  {s.started}
                </td>
                <td style={{...tdStyle, fontFamily: "var(--mono)", fontSize: 11.5}}>{s.project}</td>
                <td style={{...tdStyle, fontFamily: "var(--mono)", fontSize: 11}}>
                  <span style={{ color: s.model.startsWith("opus") ? "var(--opus)" : s.model.startsWith("haiku") ? "var(--haiku)" : "var(--sonnet)" }}>{s.model}</span>
                </td>
                <td style={tdStyle}>
                  <span style={{
                    fontSize: 10.5, padding: "2px 7px", borderRadius: 4,
                    background: "var(--surface-2)", border: "1px solid var(--hairline-2)", color: "var(--text-2)",
                  }}>{s.task}</span>
                </td>
                <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{s.dur}</td>
                <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{s.calls}</td>
                <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-2)"}}>{s.tok}</td>
                <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", color: s.hit > 0.7 ? "var(--ok)" : "var(--text-2)"}}>{fmtPct(s.hit)}</td>
                <td style={{...tdStyle, textAlign: "right", fontFamily: "var(--mono)", fontWeight: 600}}>{fmt$(s.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────
function Dashboard() {
  const [period, setPeriod] = useState("7d");
  const [projectFilter, setProjectFilter] = useState("");
  const s = useMemo(() => summaryFor(period), [period]);
  const series = useMemo(() => mockSeries(period), [period]);

  return (
    <div className="clauge-app" style={{ minHeight: "100vh" }}>
      <Topbar period={period} setPeriod={setPeriod} projectFilter={projectFilter} setProjectFilter={setProjectFilter} />
      <main style={{
        maxWidth: 1480, margin: "0 auto", padding: "20px 24px 64px",
        display: "grid", gap: 16,
      }}>
        <PlanCard />
        <Headline s={s} period={period} series={series} />

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
          <DailyChart period={period} series={series} />
          <PeakHours />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
          <ProjectsTable />
          <ActivityTable />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
          <SessionsTable />
          <ModelsTable />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <ToolList title="Core tools" sub="claude-code primitives" items={TOOLS} />
          <ToolList title="Shell commands" sub="via Bash tool" items={SHELL} />
          <ToolList title="MCP servers" sub="connected providers" items={MCP} />
        </div>

        <footer style={{
          textAlign: "center", padding: "20px 0",
          fontSize: 11, color: "var(--text-4)",
        }} className="mono">
          clauge v0.2.0 · localhost:3456 · <a href="#" style={{ color: "var(--text-3)" }}>health</a> · <a href="#" style={{ color: "var(--text-3)" }}>config</a>
        </footer>
      </main>
    </div>
  );
}

// expose for canvas
window.ClaugeDashboard = Dashboard;
