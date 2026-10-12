"use client";

import { memo } from "react";
import type { Contrarian, Participant, RetailDesk } from "../lib/index-sentiment";

const PARTICIPANTS: Array<{ key: "CLIENT" | "PRO" | "FII" | "DII"; label: string }> = [
  { key: "CLIENT", label: "Retail (Client)" },
  { key: "PRO", label: "Proprietary (Pro)" },
  { key: "FII", label: "FII" },
  { key: "DII", label: "DII" },
];
const BIAS_LABEL: Record<Contrarian["bias"], string> = {
  BEARISH: "Fade: bearish", LEAN_BEARISH: "Lean bearish", NONE: "No edge", LEAN_BULLISH: "Lean bullish", BULLISH: "Fade: bullish", NO_DATA: "No data",
};

const tone = (score: number | null | undefined) => (score === null || score === undefined ? "isa-muted" : score >= 12 ? "isa-up" : score <= -12 ? "isa-down" : "isa-flat");
const signed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`);
const biasTone = (bias: Contrarian["bias"]) => (bias.includes("BULLISH") ? "isa-up" : bias.includes("BEARISH") ? "isa-down" : "isa-muted");
const contracts = (value: number | undefined) => (value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toLocaleString("en-IN")}`);

function Meter({ score }: { score: number | null }) {
  const value = score === null ? null : Math.max(-100, Math.min(100, score));
  const width = value === null ? 0 : Math.abs(value) / 2;
  return (
    <div className="isa-bar rcd-meter" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-label="Retail crowd positioning">
      <span className="rcd-zone rcd-zone-short" /><span className="rcd-zone rcd-zone-long" />
      <span className="isa-bar-mid" />
      {value !== null ? <i className={value >= 0 ? "isa-fill-up" : "isa-fill-down"} style={{ width: `${width}%`, left: value >= 0 ? "50%" : `${50 - width}%` }} /> : null}
    </div>
  );
}

function ParticipantRow({ label, row }: { label: string; row: Participant }) {
  const long = row.futures_long_pct;
  return (
    <tr>
      <td><b>{label}</b></td>
      <td>
        {long === null ? "--" : <div className="isa-split"><i className="isa-fill-up" style={{ width: `${long}%` }} /><i className="isa-fill-down" style={{ width: `${100 - long}%` }} /></div>}
        <small>{long === null ? "" : `${long.toFixed(0)}% long · ${row.futures_long.toLocaleString("en-IN")} L / ${row.futures_short.toLocaleString("en-IN")} S`}</small>
      </td>
      <td className={tone(row.options_net)}>{signed(row.options_net)}</td>
      <td>{row.call_put_long_ratio !== undefined ? row.call_put_long_ratio.toFixed(2) : row.put_long ? (row.call_long / row.put_long).toFixed(2) : "--"}</td>
      <td>{row.futures_long_change === undefined ? "--" : <><span className={tone(row.futures_long_change)}>{contracts(row.futures_long_change)} L</span> / <span className={tone(-(row.futures_short_change ?? 0))}>{contracts(row.futures_short_change)} S</span></>}</td>
    </tr>
  );
}

export const RetailCrowdDesk = memo(function RetailCrowdDesk({ desk }: { desk: RetailDesk }) {
  return (
    <section className="isa-panel rcd">
      <div className="rcd-head">
        <div>
          <h3>Retail crowd &amp; contrarian desk</h3>
          <p className="isa-muted">Where retail traders are positioned, how stretched they are, and what the other side of that crowd implies. Contrarian calls appear only at extremes.</p>
        </div>
        <small className="isa-muted">Positioning: NSE participant OI {desk.participants_date ? `as of ${desk.participants_date}` : `unavailable${desk.participants_error ? ` (${desk.participants_error})` : ""}`} · MMI {desk.mmi_value ?? "--"}</small>
      </div>

      <div className="rcd-cards">
        {desk.indices.map((reading) => (
          <div className="rcd-card" key={reading.id}>
            <div className="rcd-card-head"><b>{reading.name}</b><span className={`rcd-chip ${biasTone(reading.contrarian.bias)}`}>{BIAS_LABEL[reading.contrarian.bias]}</span></div>
            <div className="rcd-score"><strong className={tone(reading.crowd_score)}>{signed(reading.crowd_score)}</strong><em>{reading.crowd.replaceAll("_", " ").toLowerCase()}</em></div>
            <Meter score={reading.crowd_score} />
            <small className="rcd-scale"><span>All-in short</span><span>Balanced</span><span>All-in long</span></small>
            {reading.contrarian.strength ? <div className="rcd-strength"><small>Contrarian strength {reading.contrarian.strength}/100</small><div><i className={biasTone(reading.contrarian.bias) === "isa-up" ? "isa-fill-up" : "isa-fill-down"} style={{ width: `${reading.contrarian.strength}%` }} /></div></div> : null}
            <p>{reading.contrarian.action}</p>
            <small className="isa-muted">Forum mood {signed(reading.forum_mood)} · {reading.posts} posts{reading.bullish_pct !== null ? ` (${reading.bullish_pct.toFixed(0)}% bullish)` : ""} · index sentiment {signed(reading.index_sentiment)} · {reading.inputs}/4 inputs</small>
          </div>
        ))}
      </div>

      {desk.notes.length ? <ul className="isa-notes rcd-notes">{desk.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}

      <div className="isa-grid rcd-grid">
        <div>
          <h4>Who holds what: index derivatives</h4>
          {desk.participants ? (
            <div className="isa-table-wrap">
              <table className="isa-table">
                <thead><tr><th>Participant</th><th>Index futures long vs short</th><th>Options net</th><th>Call/put buys</th><th>Futures change</th></tr></thead>
                <tbody>{PARTICIPANTS.map(({ key, label }) => (desk.participants?.[key] ? <ParticipantRow key={key} label={label} row={desk.participants[key]!} /> : null))}</tbody>
              </table>
            </div>
          ) : <p className="isa-muted">NSE participant-wise open interest could not be loaded; crowd scores use forum mood and the Market Mood Index only.</p>}
          <small className="isa-muted">Options net: +100 = all bullish exposure (call buys + put writes), −100 = all bearish. Futures change vs the previous session, in contracts.</small>
        </div>
        <div>
          <h4>Crowded stocks</h4>
          {desk.crowded_stocks.length ? (
            <ul className="rcd-stocks">
              {desk.crowded_stocks.map((stock) => (
                <li key={stock.symbol} className={stock.divergence ? "rcd-diverge" : ""}>
                  <div><b>{stock.symbol}</b>{stock.divergence ? <span className="rcd-chip isa-flat">Crowd vs footprint</span> : null}<small>{stock.posts} posts · retail {signed(stock.retail_mood)} · institutions {signed(stock.institutional_footprint)}{stock.delivery_pct !== null ? ` · delivery ${stock.delivery_pct.toFixed(0)}%` : ""}</small></div>
                  <p>{stock.read}</p>
                </li>
              ))}
            </ul>
          ) : <p className="isa-muted">No stock is both heavily discussed and strongly one-sided right now.</p>}
        </div>
      </div>
      <p className="isa-muted rcd-method">{desk.method}</p>
    </section>
  );
});
