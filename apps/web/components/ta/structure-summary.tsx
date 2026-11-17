"use client";

import { memo } from "react";
import type { Bar, SmcStructure } from "../../lib/smc-structure";

const money = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const clock = (epochS: number | undefined) => (epochS === undefined ? "--" : new Date(epochS * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }));
const word = (dir: "bull" | "bear") => (dir === "bull" ? "bullish" : "bearish");

type Row = { index: number; tag: string; tone: "bull" | "bear" | "warn" | "idm"; text: string };

/** Plain-language read of the structure the chart draws, newest first. */
function StructureSummaryView({ structure, bars, timeframe, swingLength }: { structure: SmcStructure | null; bars: Bar[]; timeframe: string; swingLength: number }) {
  if (!structure) return <article className="ta-panel ta-smc-summary"><span className="ta-kicker">MARKET STRUCTURE · {timeframe}</span><p className="ta-muted">Not enough candles to confirm swings yet.</p></article>;
  const at = (index: number) => clock(bars[index]?.time);
  const highs = structure.swings.filter((s) => s.kind === "HIGH");
  const lows = structure.swings.filter((s) => s.kind === "LOW");
  const lastHigh = highs.at(-1); const lastLow = lows.at(-1);
  const rows: Row[] = [
    ...structure.events.map((e): Row => ({ index: e.index, tag: e.kind, tone: e.kind === "MSS" ? "warn" : e.dir,
      text: `${word(e.dir)} close through ${money(e.price)}${e.kind === "BOS" ? " with the trend" : e.kind === "MSS" ? " (the protected swing, on a displacement candle)" : " against the trend (early warning)"}` })),
    ...structure.liquidityEvents.map((e): Row => ({ index: e.reclaimIndex, tag: e.kind === "SWEEP" ? "Sweep" : "Grab", tone: "warn",
      text: `${e.side === "BSL" ? "buy-side liquidity above" : "sell-side liquidity below"} ${e.levels.length > 1 ? `${e.levels.length} levels (${e.levels.map(money).join(" / ")})` : money(e.price)} taken to ${money(e.extreme)}, ${e.kind === "SWEEP" ? "wick rejected on the same candle" : `closed through, reclaimed ${e.reclaimIndex - e.index} candle(s) later`}` })),
    ...structure.inducements.filter((i) => i.takenIndex !== null).map((i): Row => ({ index: i.takenIndex!, tag: "IDM", tone: "idm", text: `inducement ${i.dir === "bull" ? "low" : "high"} ${money(i.price)} taken` })),
  ].sort((a, b) => b.index - a.index).slice(0, 10);
  const pd = structure.premiumDiscount;
  const openIdm = structure.inducements.filter((i) => i.takenIndex === null).at(-1);
  return (
    <article className="ta-panel ta-smc-summary" aria-label="Market structure">
      <span className="ta-kicker">MARKET STRUCTURE · {timeframe}</span>
      <h2 className={structure.trend === "bull" ? "ta-up" : structure.trend === "bear" ? "ta-down" : undefined}>{structure.trend ? `${word(structure.trend).toUpperCase()} STRUCTURE` : "NO STRUCTURE YET"}</h2>
      <div className="ta-smc-facts">
        <span>Last swing high <b>{lastHigh ? `${lastHigh.label} ${money(lastHigh.price)}` : "--"}</b><small>{lastHigh ? `confirmed ${at(lastHigh.confirmedIndex)}` : ""}</small></span>
        <span>Last swing low <b>{lastLow ? `${lastLow.label} ${money(lastLow.price)}` : "--"}</b><small>{lastLow ? `confirmed ${at(lastLow.confirmedIndex)}` : ""}</small></span>
        <span>Protected {structure.protectedLevel ? (structure.protectedLevel.dir === "bull" ? "low" : "high") : "level"} <b>{structure.protectedLevel ? money(structure.protectedLevel.price) : "--"}</b><small>a close through it is an MSS</small></span>
        <span>Inducement <b>{openIdm ? `${money(openIdm.price)} untaken` : "none open"}</b><small>{openIdm ? "liquidity price often takes before continuing" : ""}</small></span>
        <span>Price zone <b>{pd ? pd.zone.toLowerCase() : "--"}</b><small>{pd ? `EQ ${money(pd.equilibrium)} of ${money(pd.low)}–${money(pd.high)}` : ""}</small></span>
      </div>
      <ul className="ta-smc-events">
        {rows.length ? rows.map((row, k) => <li key={`${row.tag}-${row.index}-${k}`}><em className={`ta-smc-tag ta-smc-${row.tone}`}>{row.tag}</em><span>{row.text}</span><small>{at(row.index)}</small></li>) : <li className="ta-muted">No structure events on this timeframe yet.</li>}
      </ul>
      <p className="ta-muted">Rules: a swing is confirmed {swingLength} candles after the pivot; BOS/CHoCH/MSS need a candle close; a sweep is a wick through that closes back; a grab closes through and is reclaimed within 3 candles. Structure describes what happened; it is not a prediction.</p>
    </article>
  );
}

export const StructureSummary = memo(StructureSummaryView);
