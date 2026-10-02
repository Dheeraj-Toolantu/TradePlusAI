"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { BacktestCandles, type CandleRow } from "./backtest-candles";
import type { BacktestResult, BacktestSettings, BacktestTrade, StrategyId } from "../../../../services/backtest/src/strategy-backtest";

type Result = BacktestResult & { candles: CandleRow[]; candleMinutes?: number; strategyLabel: string; source: string; sessions: number; issues: string[]; elapsedMs: number };
type Source = "groww" | "yahoo" | "synthetic";
type Symbol = "NIFTY" | "BANKNIFTY" | "SENSEX";

const STRATEGIES: Array<{ id: StrategyId; title: string; detail: string }> = [
  { id: "MTF_AI", title: "AI multi-timeframe", detail: "1D context · 15m direction · 5m pullback · 1m candle trigger, with the AI monitor's entry/stop/target rules." },
  { id: "ORB_RETEST", title: "V5 ORB retest", detail: "Opening-range break, retest and hold with a structural stop and 2R target capped at PDH/PDL." },
  { id: "SMC_SWEEP", title: "SMC liquidity sweep", detail: "S/R + liquidity sweep → CHoCH with displacement → retrace into the FVG / order block → 1m candle confirmation. Stop beyond the sweep, targets at opposing liquidity." },
];
const LOT_SIZE: Record<Symbol, number> = { NIFTY: 65, BANKNIFTY: 30, SENSEX: 20 };
const THETA: Record<Symbol, number> = { NIFTY: 12, BANKNIFTY: 30, SENSEX: 40 };
const DEFAULTS: BacktestSettings = { capital: 100_000, lots: 1, lotSize: 65, pnlMode: "OPTION", delta: 0.5, thetaPerDay: 12, slippagePoints: 1, chargesPerTrade: 60, partialAtT1: true, timeStopMinutes: 15, maxTradesPerDay: 3, maxDailyLoss: 3000, maxConsecutiveLosses: 2, cooldownMinutes: 15, minConfidence: 60, entryStart: "09:35", entryEnd: "14:45", squareOff: "15:15" };

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekday = (day: string) => { const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); return dow !== 0 && dow !== 6; };
/** Per-strategy time stop: the SMC entry needs room to retrace from the zone before it runs. */
const TIME_STOP: Record<StrategyId, number> = { MTF_AI: 15, ORB_RETEST: 15, SMC_SWEEP: 30 };
type Preset = { key: string; label: string; sessions?: number; months?: number };
const PRESETS: Preset[] = [{ key: "5", label: "5 sessions", sessions: 5 }, { key: "20", label: "20 sessions", sessions: 20 }, { key: "3m", label: "3 months", months: 3 }, { key: "6m", label: "6 months", months: 6 }];
function lastMonths(months: number) {
  const { to } = lastSessions(1);
  const date = new Date(`${to}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCDate(date.getUTCDate() + 1);
  return { from: date.toISOString().slice(0, 10), to };
}
const rangeFor = (preset: Preset) => (preset.months ? lastMonths(preset.months) : lastSessions(preset.sessions ?? 10));
type RunError = { message: string; issues: string[] };

/** The last `sessions` weekdays ending today (or the last weekday). */
function lastSessions(sessions: number) {
  let to = istToday();
  while (!weekday(to)) to = shiftDay(to, -1);
  let from = to; let count = 1;
  while (count < sessions) { from = shiftDay(from, -1); if (weekday(from)) count += 1; }
  return { from, to };
}

const inr = (value: number, sign = true) => `${sign && value > 0 ? "+" : value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const pct = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}%`;
const r = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}R`;
const clockOf = (epochS: number) => new Date(epochS * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const reasonLabel = (reason: string) => reason.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function BacktestPanel() {
  const [strategy, setStrategy] = useState<StrategyId>("MTF_AI");
  const [symbol, setSymbol] = useState<Symbol>("NIFTY");
  const [range, setRange] = useState(() => lastSessions(20));
  const [preset, setPreset] = useState<string | null>("20");
  const [source, setSource] = useState<Source>("groww");
  const [settings, setSettings] = useState<BacktestSettings>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<RunError | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const update = <K extends keyof BacktestSettings>(key: K, value: BacktestSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const chooseSymbol = (next: Symbol) => { setSymbol(next); setSettings((current) => ({ ...current, lotSize: LOT_SIZE[next], thetaPerDay: THETA[next] })); };
  const choosePreset = (item: Preset) => { setPreset(item.key); setRange(rangeFor(item)); };
  const chooseStrategy = (next: StrategyId) => { setStrategy(next); setSettings((current) => ({ ...current, timeStopMinutes: TIME_STOP[next] })); };
  const spanDays = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;

  async function run() {
    // Clear the previous run so an error is never shown above stale results from another period.
    setRunning(true); setError(null); setResult(null);
    try {
      const response = await fetch("/api/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy, symbol, from: range.from, to: range.to, source, settings }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError({ message: body.error ?? `Backtest failed (HTTP ${response.status})`, issues: Array.isArray(body.issues) ? body.issues : [] }); return; }
      setResult(body as Result);
    } catch (reason) {
      setError({ message: reason instanceof Error ? reason.message : "Backtest failed", issues: [] });
    } finally { setRunning(false); }
  }

  return (
    <div className="bt">
      <section className="paper-panel bt-config" aria-label="Backtest configuration">
        <div className="paper-panel-heading"><div><span className="paper-kicker">STRATEGY BACKTEST · WALK-FORWARD ON 1-MINUTE BARS</span><h2>Test a strategy on past sessions</h2></div><span className="paper-lab-badge">SIMULATION ONLY</span></div>
        <div className="bt-strategies" role="radiogroup" aria-label="Strategy">
          {STRATEGIES.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={strategy === item.id} className={`bt-strategy${strategy === item.id ? " selected" : ""}`} onClick={() => chooseStrategy(item.id)}>
              <b>{item.title}</b><span>{item.detail}</span>
            </button>
          ))}
        </div>
        <div className="bt-row">
          <label>Index<select value={symbol} onChange={(event) => chooseSymbol(event.target.value as Symbol)}><option>NIFTY</option><option>BANKNIFTY</option><option>SENSEX</option></select></label>
          <div className="bt-field"><span>Period</span><div className="bt-presets">{PRESETS.map((item) => <button key={item.key} type="button" className={preset === item.key ? "active" : ""} onClick={() => choosePreset(item)}>{item.label}</button>)}</div></div>
          <label>From<input type="date" value={range.from} max={range.to} onChange={(event) => { setPreset(null); setRange((current) => ({ ...current, from: event.target.value })); }} /></label>
          <label>To<input type="date" value={range.to} max={istToday()} onChange={(event) => { setPreset(null); setRange((current) => ({ ...current, to: event.target.value })); }} /></label>
          <label>Data<select value={source} onChange={(event) => setSource(event.target.value as Source)}><option value="groww">Groww history</option><option value="yahoo">Yahoo (last ~30 days only)</option><option value="synthetic">Synthetic demo data</option></select></label>
        </div>
        <details className="bt-settings">
          <summary>Risk &amp; execution settings <small>{settings.lots} lot × {settings.lotSize} · {settings.pnlMode === "OPTION" ? `option est. Δ ${settings.delta}` : "index points"} · max {settings.maxTradesPerDay} trades/day · daily loss ₹{settings.maxDailyLoss.toLocaleString("en-IN")}</small></summary>
          <div className="bt-grid">
            <NumberField label="Capital (₹)" value={settings.capital} step={10000} onChange={(value) => update("capital", value)} />
            <NumberField label="Lots" value={settings.lots} min={1} onChange={(value) => update("lots", value)} />
            <NumberField label="Lot size" value={settings.lotSize} min={1} onChange={(value) => update("lotSize", value)} />
            <label>P&amp;L model<select value={settings.pnlMode} onChange={(event) => update("pnlMode", event.target.value as BacktestSettings["pnlMode"])}><option value="OPTION">Option buyer (estimate)</option><option value="POINTS">Index points (exact)</option></select></label>
            <NumberField label="Option delta" value={settings.delta} step={0.05} min={0.05} max={1} disabled={settings.pnlMode !== "OPTION"} onChange={(value) => update("delta", value)} />
            <NumberField label="Time decay (pts/day)" value={settings.thetaPerDay} disabled={settings.pnlMode !== "OPTION"} onChange={(value) => update("thetaPerDay", value)} />
            <NumberField label="Slippage (pts/side)" value={settings.slippagePoints} step={0.5} onChange={(value) => update("slippagePoints", value)} />
            <NumberField label="Charges / trade (₹)" value={settings.chargesPerTrade} step={10} onChange={(value) => update("chargesPerTrade", value)} />
            <NumberField label="Time stop (min, 0 = off)" value={settings.timeStopMinutes} onChange={(value) => update("timeStopMinutes", value)} />
            <NumberField label="Max trades / day" value={settings.maxTradesPerDay} min={1} onChange={(value) => update("maxTradesPerDay", value)} />
            <NumberField label="Daily loss limit (₹)" value={settings.maxDailyLoss} step={500} onChange={(value) => update("maxDailyLoss", value)} />
            <NumberField label="Stop after N losses" value={settings.maxConsecutiveLosses} min={1} onChange={(value) => update("maxConsecutiveLosses", value)} />
            <NumberField label="Cooldown after loss (min)" value={settings.cooldownMinutes} onChange={(value) => update("cooldownMinutes", value)} />
            <NumberField label="Min confidence (%)" value={settings.minConfidence} min={0} max={100} disabled={strategy === "ORB_RETEST"} onChange={(value) => update("minConfidence", value)} />
            <label>Entry from<input type="time" value={settings.entryStart} onChange={(event) => update("entryStart", event.target.value)} /></label>
            <label>Entry until<input type="time" value={settings.entryEnd} onChange={(event) => update("entryEnd", event.target.value)} /></label>
            <label>Square-off<input type="time" value={settings.squareOff} onChange={(event) => update("squareOff", event.target.value)} /></label>
            <label className="bt-check"><input type="checkbox" checked={settings.partialAtT1} onChange={(event) => update("partialAtT1", event.target.checked)} /> Book 50% at T1, stop to breakeven</label>
          </div>
          <button type="button" className="paper-button secondary bt-reset" onClick={() => setSettings({ ...DEFAULTS, lotSize: LOT_SIZE[symbol], thetaPerDay: THETA[symbol] })}>Reset to defaults</button>
        </details>
        <div className="bt-actions">
          <button type="button" className="paper-button primary" onClick={() => void run()} disabled={running}>{running ? "Running backtest…" : "Run backtest"}</button>
          <span className="bt-hint">{running ? `Fetching 1-minute history for ${range.from} → ${range.to} and replaying every minute. ${spanDays > 45 ? "Several months of data can take 1–2 minutes." : "This can take 10–40 seconds."}` : `${spanDays} calendar days selected (max 190). Signals only see candles that were complete at that moment; entries fill on the next 1-minute bar.`}</span>
        </div>
        {error ? (
          <div className="bt-error" role="alert">
            <strong>{error.message}</strong>
            {error.issues.length ? <details><summary>Details ({error.issues.length})</summary><ul>{error.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details> : null}
          </div>
        ) : null}
      </section>

      {result ? <BacktestResults result={result} /> : !running ? <section className="paper-panel bt-empty"><strong>No backtest yet</strong><p>Pick a strategy and period, then run. Use “Synthetic demo data” to explore the tool without a market-data connection.</p></section> : null}
    </div>
  );
}

function NumberField({ label, value, onChange, step = 1, min = 0, max, disabled }: { label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number; disabled?: boolean }) {
  return <label>{label}<input type="number" value={value} step={step} min={min} max={max} disabled={disabled} onChange={(event) => { const parsed = Number(event.target.value); if (Number.isFinite(parsed)) onChange(parsed); }} /></label>;
}

function BacktestResults({ result }: { result: Result }) {
  const m = result.metrics;
  const [openTrade, setOpenTrade] = useState<number | null>(null);
  const [chartTrade, setChartTrade] = useState<number | null>(null);
  const chartPanel = useRef<HTMLElement>(null);
  const showOnChart = (id: number) => { setChartTrade(id); chartPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const synthetic = result.source === "synthetic";
  const exportCsv = () => {
    const header = ["#", "day", "side", "entry_time", "entry", "stop", "target1", "target2", "exit_time", "exit", "exit_reason", "points", "r_multiple", "pnl", "hold_min", "confidence", "reason"];
    const rows = result.trades.map((t) => [t.id, t.day, t.side, clockOf(t.entryTime), t.entryPrice, t.stop, t.target1, t.target2, clockOf(t.exitTime), t.exitPrice, t.exitReason, t.points, t.rMultiple, t.pnl, t.holdMinutes, t.confidence ?? "", `"${t.reason.replaceAll('"', "'")}"`]);
    const blob = new Blob([[header, ...rows].map((row) => row.join(",")).join("\n")], { type: "text/csv" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `backtest-${result.strategy}-${result.symbol}-${result.from}-${result.to}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return (
    <>
      <section className={`paper-notice bt-notes${synthetic ? " delayed" : ""}`}>
        <div><strong>{result.strategyLabel} · {result.symbol} · {dayLabel(result.from)} → {dayLabel(result.to)}</strong><span>{result.sessions} sessions · {result.source} data · {result.signalsSeen} signals · {(result.elapsedMs / 1000).toFixed(1)}s</span></div>
        <ul>{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>
      </section>

      <section className="bt-kpis" aria-label="Backtest summary">
        <Kpi label="Net P&L" value={inr(m.netPnl)} detail={`${pct(m.returnPct)} on ₹${result.settings.capital.toLocaleString("en-IN")} · charges ₹${m.totalCharges.toLocaleString("en-IN")}`} />
        <Kpi label="Win rate" value={`${m.winRate.toFixed(0)}%`} detail={`${m.wins} wins · ${m.losses} losses · ${m.trades} trades`} />
        <Kpi label="Profit factor" value={m.profitFactor === null ? "∞" : m.profitFactor.toFixed(2)} detail={`avg win ${inr(m.averageWin)} · avg loss ${inr(m.averageLoss)}`} />
        <Kpi label="Expectancy" value={`${inr(m.expectancy)}`} detail={`${r(m.expectancyR)} per trade`} />
        <Kpi label="Max drawdown" value={inr(-m.maxDrawdown)} detail={`${pct(-m.maxDrawdownPct)} · worst streak ${m.maxConsecutiveLosses} losses`} />
        <Kpi label="Days" value={`${m.profitableDays}/${m.tradingDays}`} detail={`profitable · best ${inr(m.bestDay)} · worst ${inr(m.worstDay)}`} />
      </section>

      {result.candles?.length ? (
        <section className="paper-panel bt-chart-panel bt-candles-panel" ref={chartPanel}>
          <div className="paper-panel-heading"><div><span className="paper-kicker">PRICE CHART</span><h2>{result.symbol} candles with every simulated entry and exit</h2></div></div>
          <BacktestCandles symbol={result.symbol} candles={result.candles} candleMinutes={result.candleMinutes} trades={result.trades} focusId={chartTrade} onFocus={setChartTrade} />
        </section>
      ) : null}

      {result.trades.length === 0 ? (
        <section className="paper-panel bt-empty"><strong>No trades in this period</strong><p>The strategy found {result.signalsSeen} signal{result.signalsSeen === 1 ? "" : "s"}{result.skipped.length ? ", all blocked by the risk rules below" : ""}. Try a longer period or relax the settings.</p></section>
      ) : (
        <>
          <section className="paper-panel bt-chart-panel">
            <div className="paper-panel-heading"><div><span className="paper-kicker">EQUITY CURVE</span><h2>Cumulative P&amp;L after each trade</h2></div><span className="bt-legend-note">Hover for details</span></div>
            <EquityChart points={result.equity} trades={result.trades} />
            <span className="paper-kicker bt-sub">DRAWDOWN FROM PEAK</span>
            <DrawdownChart points={result.equity} />
          </section>
          <div className="bt-two">
            <section className="paper-panel bt-chart-panel">
              <div className="paper-panel-heading"><div><span className="paper-kicker">DAILY P&amp;L</span><h2>Result per session</h2></div><span className="bt-key"><i className="gain-swatch" /> gain <i className="loss-swatch" /> loss</span></div>
              <DailyBars days={result.daily} />
            </section>
            <section className="paper-panel bt-chart-panel">
              <div className="paper-panel-heading"><div><span className="paper-kicker">R-MULTIPLE DISTRIBUTION</span><h2>How far trades ran vs the risk taken</h2></div></div>
              <RHistogram buckets={result.rDistribution} />
            </section>
          </div>
          <div className="bt-two">
            <section className="paper-panel">
              <div className="paper-panel-heading"><div><span className="paper-kicker">EXITS</span><h2>Why trades closed</h2></div></div>
              <table className="bt-table"><thead><tr><th>Exit</th><th className="num">Trades</th><th className="num">P&amp;L</th></tr></thead>
                <tbody>{result.exitReasons.map((item) => <tr key={item.reason}><td>{reasonLabel(item.reason)}</td><td className="num">{item.count}</td><td className="num">{inr(item.pnl)}</td></tr>)}</tbody></table>
            </section>
            <section className="paper-panel">
              <div className="paper-panel-heading"><div><span className="paper-kicker">TIME OF DAY</span><h2>Entries by hour (IST)</h2></div></div>
              <table className="bt-table"><thead><tr><th>Hour</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">P&amp;L</th></tr></thead>
                <tbody>{result.byHour.map((item) => <tr key={item.hour}><td>{item.hour}</td><td className="num">{item.trades}</td><td className="num">{item.winRate.toFixed(0)}%</td><td className="num">{inr(item.pnl)}</td></tr>)}</tbody></table>
            </section>
          </div>
          <section className="paper-panel bt-trades">
            <div className="paper-panel-heading"><div><span className="paper-kicker">TRADE LOG</span><h2>{result.trades.length} simulated trades</h2></div><button type="button" className="paper-button secondary" onClick={exportCsv}>Export CSV</button></div>
            <div className="bt-table-wrap">
              <table className="bt-table">
                <thead><tr><th>#</th><th>Day</th><th>Side</th><th>Entry</th><th className="num">Price</th><th className="num">Stop</th><th className="num">T1</th><th>Exit</th><th className="num">Exit price</th><th>Reason</th><th className="num">R</th><th className="num">P&amp;L</th><th className="num">Hold</th></tr></thead>
                <tbody>{result.trades.map((trade) => <TradeRow key={trade.id} trade={trade} open={openTrade === trade.id} onToggle={() => setOpenTrade(openTrade === trade.id ? null : trade.id)} onChart={result.candles?.length ? () => showOnChart(trade.id) : undefined} />)}</tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {result.skipped.length || result.issues.length ? (
        <section className="paper-panel bt-skipped">
          <div className="paper-panel-heading"><div><span className="paper-kicker">RISK RULES &amp; DATA</span><h2>Signals not taken</h2></div></div>
          {result.skipped.length ? <ul>{aggregateSkipped(result.skipped).map((item) => <li key={item.reason}><b>{item.count}×</b> {item.reason}</li>)}</ul> : <p>Every signal was taken.</p>}
          {result.issues.length ? <details><summary>Data issues ({result.issues.length})</summary><ul>{result.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details> : null}
        </section>
      ) : null}
    </>
  );
}

function aggregateSkipped(items: BacktestResult["skipped"]) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.reason, (totals.get(item.reason) ?? 0) + item.count);
  return [...totals.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="paper-metric bt-kpi"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function TradeRow({ trade, open, onToggle, onChart }: { trade: BacktestTrade; open: boolean; onToggle: () => void; onChart?: () => void }) {
  return (
    <Fragment>
      <tr className={`bt-trade${open ? " open" : ""}`} onClick={onToggle} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }} aria-expanded={open}>
        <td>{trade.id}</td><td>{dayLabel(trade.day)}</td><td><span className={`bt-side ${trade.side === "LONG" ? "long" : "short"}`}>{trade.side === "LONG" ? "▲ CE" : "▼ PE"}</span></td>
        <td>{clockOf(trade.entryTime)}</td><td className="num">{trade.entryPrice.toFixed(1)}</td><td className="num">{trade.stop.toFixed(1)}</td><td className="num">{trade.target1.toFixed(1)}</td>
        <td>{clockOf(trade.exitTime)}</td><td className="num">{trade.exitPrice.toFixed(1)}</td><td>{reasonLabel(trade.exitReason)}</td>
        <td className="num">{r(trade.rMultiple)}</td><td className="num"><b>{inr(trade.pnl)}</b></td><td className="num">{trade.holdMinutes}m</td>
      </tr>
      {open ? (
        <tr className="bt-trade-detail"><td colSpan={13}>
          <p><b>Why it entered:</b> {trade.reason}{trade.confidence !== null ? ` (confidence ${trade.confidence}%)` : ""}</p>
          <p><b>Plan:</b> stop {trade.stop.toFixed(1)} · T1 {trade.target1.toFixed(1)} · T2 {trade.target2.toFixed(1)} · best excursion {r(trade.mfeR)} · worst {r(-trade.maeR)}</p>
          <p><b>Exits:</b> {trade.legs.map((leg) => `${Math.round(leg.fraction * 100)}% at ${leg.price.toFixed(1)} (${reasonLabel(leg.reason)}, ${clockOf(leg.time)})`).join(" · ")}</p>
          {onChart ? <button type="button" className="paper-button secondary bt-chart-link" onClick={onChart}>Show on chart</button> : null}
        </td></tr>
      ) : null}
    </Fragment>
  );
}

// ------------------------------------------------------------------ charts

type Tip = { x: number; y: number; h: number; lines: string[] } | null;

function niceTicks(min: number, max: number, count = 4) {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(raw)));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}
const compact = (value: number) => (Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(Math.abs(value) >= 10000 ? 0 : 1)}k` : value.toFixed(0));

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  return <div className="bt-tip" style={{ left: `${(tip.x / width) * 100}%`, top: `${(tip.y / tip.h) * 100}%` }}>{tip.lines.map((line, index) => <span key={index} className={index === 0 ? "bt-tip-head" : ""}>{line}</span>)}</div>;
}

// viewBox widths roughly match the rendered panel width so 10-11px text stays legible.
const FULL = 1140;
const HALF = 560;

function EquityChart({ points, trades }: { points: BacktestResult["equity"]; trades: BacktestTrade[] }) {
  const [tip, setTip] = useState<Tip>(null);
  const W = FULL; const H = 240; const P = { l: 52, r: 12, t: 12, b: 24 };
  const series = useMemo(() => [{ equity: 0 }, ...points], [points]);
  const values = series.map((p) => p.equity);
  const min = Math.min(0, ...values); const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => P.l + (i / Math.max(1, series.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - min) / span) * (H - P.t - P.b);
  const path = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
  const hover = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const i = Math.max(1, Math.min(series.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (series.length - 1))));
    const trade = trades[i - 1];
    if (!trade) return setTip(null);
    setTip({ x: x(i), y: y(series[i].equity) - 8, h: H, lines: [`Trade #${trade.id} · ${dayLabel(trade.day)} ${clockOf(trade.exitTime)}`, `${trade.side === "LONG" ? "CE" : "PE"} ${inr(trade.pnl)} (${r(trade.rMultiple)})`, `Equity ${inr(series[i].equity)}`] });
  };
  const hi = tip ? Math.max(1, Math.min(series.length - 1, Math.round(((tip.x - P.l) / (W - P.l - P.r)) * (series.length - 1)))) : null;
  return (
    <div className="bt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Equity curve ending at ${inr(values.at(-1) ?? 0)}`}>
        {niceTicks(min, max).map((tick) => <g key={tick}><line className={tick === 0 ? "bt-zero" : "bt-gridline"} x1={P.l} x2={W - P.r} y1={y(tick)} y2={y(tick)} /><text className="bt-axis" x={P.l - 6} y={y(tick) + 3} textAnchor="end">{compact(tick)}</text></g>)}
        <path d={path} className="bt-line" />
        {hi !== null ? <g><line className="bt-crosshair" x1={x(hi)} x2={x(hi)} y1={P.t} y2={H - P.b} /><circle cx={x(hi)} cy={y(series[hi].equity)} r={4} className="bt-dot" /></g> : null}
        <text className="bt-axis" x={P.l} y={H - 6}>Trade 1</text><text className="bt-axis" x={W - P.r} y={H - 6} textAnchor="end">Trade {series.length - 1}</text>
        <rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} fill="transparent" onPointerMove={hover} onPointerLeave={() => setTip(null)} />
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}

function DrawdownChart({ points }: { points: BacktestResult["equity"] }) {
  const W = FULL; const H = 90; const P = { l: 52, r: 12, t: 6, b: 8 };
  const series = [{ drawdown: 0 }, ...points];
  const min = Math.min(-1, ...series.map((p) => p.drawdown));
  const x = (i: number) => P.l + (i / Math.max(1, series.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (v / min) * (H - P.t - P.b);
  const area = `M${x(0)},${y(0)}${series.map((p, i) => `L${x(i).toFixed(1)},${y(p.drawdown).toFixed(1)}`).join("")}L${x(series.length - 1)},${y(0)}Z`;
  return (
    <div className="bt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Maximum drawdown ${inr(min)}`}>
        <line className="bt-zero" x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} />
        <path d={area} className="bt-dd" />
        <text className="bt-axis" x={P.l - 6} y={y(min) + 3} textAnchor="end">{compact(min)}</text>
        <text className="bt-axis" x={P.l - 6} y={y(0) + 3} textAnchor="end">0</text>
      </svg>
    </div>
  );
}

function DailyBars({ days }: { days: BacktestResult["daily"] }) {
  const [tip, setTip] = useState<Tip>(null);
  const W = HALF; const H = 220; const P = { l: 52, r: 12, t: 12, b: 26 };
  const min = Math.min(0, ...days.map((d) => d.pnl)); const max = Math.max(0, ...days.map((d) => d.pnl));
  const span = max - min || 1;
  const y = (v: number) => P.t + (1 - (v - min) / span) * (H - P.t - P.b);
  const slot = (W - P.l - P.r) / Math.max(1, days.length);
  const barW = Math.max(3, Math.min(28, slot - 2));
  return (
    <div className="bt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily profit and loss">
        {niceTicks(min, max).map((tick) => <g key={tick}><line className={tick === 0 ? "bt-zero" : "bt-gridline"} x1={P.l} x2={W - P.r} y1={y(tick)} y2={y(tick)} /><text className="bt-axis" x={P.l - 6} y={y(tick) + 3} textAnchor="end">{compact(tick)}</text></g>)}
        {days.map((day, i) => {
          const cx = P.l + slot * i + slot / 2;
          const top = y(Math.max(0, day.pnl)); const height = Math.max(day.pnl === 0 ? 0 : 1.5, Math.abs(y(day.pnl) - y(0)));
          return <g key={day.day}>
            <rect className={day.pnl >= 0 ? "bt-bar-gain" : "bt-bar-loss"} x={cx - barW / 2} y={day.pnl >= 0 ? top : y(0)} width={barW} height={height} rx={2} />
            <rect x={P.l + slot * i} y={P.t} width={slot} height={H - P.t - P.b} fill="transparent" onPointerEnter={() => setTip({ x: cx, y: y(Math.max(0, day.pnl)) - 8, h: H, lines: [dayLabel(day.day), `${inr(day.pnl)} · ${day.trades} trade${day.trades === 1 ? "" : "s"}`] })} onPointerLeave={() => setTip(null)} />
            {days.length <= 12 || i % Math.ceil(days.length / 10) === 0 ? <text className="bt-axis" x={cx} y={H - 8} textAnchor="middle">{dayLabel(day.day)}</text> : null}
          </g>;
        })}
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}

function RHistogram({ buckets }: { buckets: BacktestResult["rDistribution"] }) {
  const [tip, setTip] = useState<Tip>(null);
  const W = HALF; const H = 220; const P = { l: 36, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const slot = (W - P.l - P.r) / buckets.length;
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b);
  return (
    <div className="bt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Distribution of trade results in R multiples">
        {niceTicks(0, max, 3).filter((tick) => Number.isInteger(tick)).map((tick) => <g key={tick}><line className={tick === 0 ? "bt-zero" : "bt-gridline"} x1={P.l} x2={W - P.r} y1={y(tick)} y2={y(tick)} /><text className="bt-axis" x={P.l - 6} y={y(tick) + 3} textAnchor="end">{tick}</text></g>)}
        {buckets.map((bucket, i) => {
          const cx = P.l + slot * i + slot / 2; const barW = Math.min(64, slot - 12);
          const negative = i < 2;
          return <g key={bucket.bucket}>
            <rect className={negative ? "bt-bar-loss" : "bt-bar-gain"} x={cx - barW / 2} y={y(bucket.count)} width={barW} height={Math.max(0, y(0) - y(bucket.count))} rx={2} />
            {bucket.count ? <text className="bt-value" x={cx} y={y(bucket.count) - 5} textAnchor="middle">{bucket.count}</text> : null}
            <text className="bt-axis" x={cx} y={H - 8} textAnchor="middle">{bucket.bucket}</text>
            <rect x={P.l + slot * i} y={P.t} width={slot} height={H - P.t - P.b} fill="transparent" onPointerEnter={() => setTip({ x: cx, y: y(bucket.count) - 8, h: H, lines: [bucket.bucket, `${bucket.count} trade${bucket.count === 1 ? "" : "s"}`] })} onPointerLeave={() => setTip(null)} />
          </g>;
        })}
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}
