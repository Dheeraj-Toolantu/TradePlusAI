"use client";

type Signal = "BULLISH" | "BEARISH" | "NEUTRAL";
type Entry = { direction: "LONG" | "SHORT"; zone_low: number; zone_high: number; entry_price: number; time: string; today: boolean; confidence: number; status: "DEFENDED" | "UNTESTED"; pnl_points: number; in_profit: boolean; evidence: string[] };
type Writer = { side: "CE" | "PE"; role: string; strike: number; oi: number; oi_change_5m: number | null; premium: number; breakeven: number; state: "SAFE" | "UNDER_PRESSURE" | "LOSING" };
type Driver = { name: string; effect_pct: number; detail: string };
type GapOdds = {
  direction: "BULLISH" | "BEARISH"; top: number; bottom: number; mid: number; time: string; partially_filled: boolean; move_needed: "UP" | "DOWN";
  distance_points: number; distance_atr: number; probability: number; base_rate: number; base_bucket: string; drivers: Driver[]; trade_idea: string | null;
};
type MacroDriver = { id: string; name: string; price: number | null; change_pct: number; effect: "TAILWIND" | "HEADWIND" | "NEUTRAL"; why: string };
export type OperatorFootprint = {
  available: boolean; reason?: string; stance: "ACCUMULATING" | "DISTRIBUTING" | "TWO_SIDED"; stance_score: number; headline: string;
  entries: Entry[]; writers: Writer[]; writer_comfort_zone: { low: number; high: number } | null; pressure: number;
  context: Array<{ name: string; value: number; weight: number; signal: Signal; detail: string }>;
  macro: { score: number; label: string; drivers: MacroDriver[]; notes: string[]; coverage: string } | null;
  fvg_fill: { gaps: GapOdds[]; most_likely: GapOdds | null; base_rates: { sessions: number; gaps: number } | null; reach_points?: number; reach_basis?: string; minutes_left?: number };
  method: string;
};

const fmt = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 }));
const signed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${fmt(value, digits)}`);
const compact = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)} K`;
  return `${sign}${abs.toFixed(0)}`;
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const tone = (signal: string | null | undefined) => (signal === "BULLISH" || signal === "LONG" || signal === "ACCUMULATING" || signal === "TAILWIND" ? "gain" : signal === "BEARISH" || signal === "SHORT" || signal === "DISTRIBUTING" || signal === "HEADWIND" ? "loss" : "warning");
const oddsTone = (probability: number) => (probability >= 60 ? "gain" : probability >= 35 ? "warning" : "loss");

export function OperatorFootprintPanel({ data }: { data: OperatorFootprint | undefined }) {
  if (!data) return null;
  if (!data.available) return <article className="mi-card"><div className="algo-empty">{data.reason ?? "Operator footprint unavailable"}</div></article>;
  const fills = data.fvg_fill;
  const best = fills.most_likely;
  return (
    <article className="mi-card mi-operator">
      <div className="algo-panel-head">
        <div>
          <span className="algo-kicker">SMART MONEY · OPERATOR FOOTPRINT & FVG FILL ODDS</span>
          <h2 className={tone(data.stance)}>Operators: {data.stance.replace("_", "-").toLowerCase()}</h2>
        </div>
        <span>pressure {signed(data.pressure * 100, 0)}</span>
      </div>
      <p className="mi-instruction">{data.headline}</p>

      {best && (
        <div className={`mi-best-gap mi-${best.direction.toLowerCase()}`}>
          <small>Most likely gap to fill today</small>
          <b className={tone(best.direction)}>{best.direction === "BULLISH" ? "▲" : "▼"} {fmt(best.bottom)} – {fmt(best.top)}</b>
          <span className={oddsTone(best.probability)}>{fmt(best.probability, 0)}% chance to reach midpoint {fmt(best.mid)}</span>
          <em>Needs a {fmt(best.distance_points, 0)} pt move {best.move_needed.toLowerCase()} ({fmt(best.distance_atr, 1)} ATR){best.trade_idea ? ` · ${best.trade_idea}` : ""}</em>
        </div>
      )}

      <div className="mi-zones">
        <div>
          <b>Where operators entered</b>
          {data.entries.length ? data.entries.map((entry) => (
            <details key={`${entry.time}-${entry.zone_low}`} className="mi-op-entry">
              <summary>
                <span className={tone(entry.direction)}>{entry.direction === "LONG" ? "▲ Long" : "▼ Short"} {fmt(entry.zone_low)} – {fmt(entry.zone_high)}</span>
                <span className="mi-op-meta">{clock(entry.time)}{entry.today ? "" : " (prev. day)"} · {entry.status.toLowerCase()} · <b>{entry.confidence}%</b> · <i className={entry.in_profit ? "gain" : "loss"}>{signed(entry.pnl_points, 0)} pts</i></span>
              </summary>
              <ul>{entry.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
            </details>
          )) : <span>No high-confidence institutional footprint in the last two sessions</span>}
        </div>

        <div>
          <b>Option-writer camps (where they get hurt)</b>
          {data.writers.length ? data.writers.map((writer) => (
            <span key={`${writer.side}-${writer.strike}`} className={writer.side === "PE" ? "gain" : "loss"}>
              {writer.side === "PE" ? "Put" : "Call"} writers {fmt(writer.strike, 0)} · OI {compact(writer.oi)}{writer.oi_change_5m ? ` (${writer.oi_change_5m > 0 ? "+" : ""}${compact(writer.oi_change_5m)} in 5m)` : ""} · breakeven {fmt(writer.breakeven)}
              {writer.state !== "SAFE" && <b className="warning"> {writer.state.replace("_", " ").toLowerCase()}</b>}
            </span>
          )) : <span>Option chain unavailable</span>}
          {data.writer_comfort_zone && <span>Writers' comfort zone: <b>{fmt(data.writer_comfort_zone.low)} – {fmt(data.writer_comfort_zone.high)}</b></span>}
        </div>
      </div>

      <div className="mi-table-wrap">
        <table className="mi-fvg-odds">
          <thead><tr><th>Fair value gap</th><th>Move needed</th><th>Fill odds</th><th>Base rate</th><th>Biggest drivers</th></tr></thead>
          <tbody>
            {fills.gaps.map((gap) => (
              <tr key={`${gap.time}-${gap.bottom}`}>
                <th className={tone(gap.direction)}>{gap.direction === "BULLISH" ? "▲" : "▼"} {fmt(gap.bottom)} – {fmt(gap.top)}{gap.partially_filled ? <small> partly filled</small> : null}</th>
                <td>{gap.move_needed === "UP" ? "↑" : "↓"} {fmt(gap.distance_points, 0)} pts <small>({fmt(gap.distance_atr, 1)} ATR)</small></td>
                <td className={oddsTone(gap.probability)}><span className="mi-odds-bar"><i style={{ width: `${gap.probability}%` }} /></span>{fmt(gap.probability, 0)}%</td>
                <td><small>{fmt(gap.base_rate, 0)}% at {gap.base_bucket}</small></td>
                <td>{gap.drivers.slice(0, 3).map((driver) => <small key={driver.name} title={driver.detail} className={driver.effect_pct >= 0 ? "gain" : "loss"}>{driver.name} {signed(driver.effect_pct, 0)}%</small>)}</td>
              </tr>
            ))}
            {!fills.gaps.length && <tr><td colSpan={5}>No unfilled fair value gaps</td></tr>}
          </tbody>
        </table>
      </div>
      {fills.reach_points !== undefined && (
        <p className="mi-note">Reach left today ≈ ±{fmt(fills.reach_points, 0)} pts ({fills.reach_basis}, {fills.minutes_left} min). Base rates learnt from {fills.base_rates?.gaps ?? 0} gaps over {fills.base_rates?.sessions ?? 0} completed session(s), shrunk towards a conservative prior.</p>
      )}

      <div className="mi-zones">
        <div>
          <b>What drives the pressure</b>
          {data.context.map((part) => <span key={part.name} className={tone(part.signal)}>{part.name}: {part.detail}</span>)}
        </div>
        <div>
          <b>Crude, dollar, rupee & global markets {data.macro ? <small className={tone(data.macro.label.includes("TAILWIND") ? "TAILWIND" : data.macro.label.includes("HEADWIND") ? "HEADWIND" : "")}>{signed(data.macro.score, 0)} · {data.macro.label.replace("_", " ").toLowerCase()}</small> : null}</b>
          {data.macro ? (
            <>
              {data.macro.drivers.slice(0, 6).map((driver) => <span key={driver.id} className={tone(driver.effect)} title={driver.why}>{driver.name} {fmt(driver.price)} ({signed(driver.change_pct, 2)}%)</span>)}
              {data.macro.notes.map((note) => <small key={note} className="warning">{note}</small>)}
            </>
          ) : <span>Global quotes loading or unavailable; odds use Indian data only</span>}
        </div>
      </div>
      <details className="mi-learn">
        <summary>What is this?</summary>
        <p>Operators (institutions, prop desks, big option writers) cannot hide their size. Their entries show up as a violent candle leg from a small base, often right after a stop hunt, that breaks structure and leaves a fair value gap, while option writers build a wall at the same price. The confidence % counts how many of those footprints line up. Writers' breakeven is where their positions start losing money; they usually defend it.</p>
        <p>Fill odds = the chance price trades back to the gap's midpoint before today's close. It starts from how often similar gaps (same distance in ATR) filled in this index's own recent candles, then moves up or down for market pressure (verdict, option writers, structure, news/forum sentiment, crude/dollar/rupee/global futures), OI walls in the path, max pain, premium/discount, liquidity beyond the gap and how far India VIX says price can still travel today. Each driver's effect is shown so you can disagree with it.</p>
        <p>{data.method}</p>
      </details>
    </article>
  );
}
