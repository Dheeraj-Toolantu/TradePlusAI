"use client";

import { memo } from "react";
import type { PositionView } from "../../../../services/paper-trading/src/smart-scalper";
import { nextTrailStep } from "../../../../services/paper-trading/src/scalper-trail";

const money = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const rupees = (value: number) => `${value >= 0 ? "+" : "−"}₹${money(Math.abs(value))}`;
const rr = (value: number | null) => (value === null || !Number.isFinite(value) ? "--" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}R`);
const clock = (ms: number) => { const total = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60; return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`; };
const ist = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" }) : "--");

export const STAGE_TEXT: Record<string, string> = { INITIAL: "Initial SL", BREAKEVEN: "Breakeven", LOCKED: "+0.5R locked", TRAILING: "Trailing" };
const EXIT_TEXT: Record<string, string> = {
  TARGET: "Target hit", SPOT_TARGET: "Index target hit", STOP_LOSS: "Stop loss hit", BREAKEVEN_STOP: "Breakeven stop", LOCKED_PROFIT_STOP: "Locked-profit stop",
  TRAILING_STOP: "Trailing stop", EMA9_LOST: "Momentum lost (9 EMA)", SPOT_LEVEL_BROKEN: "Index level broken", SCALP_TIME_STOP: "Time stop",
  MAX_LOSS_PER_TRADE: "Max loss per trade", SQUARE_OFF_15_15: "15:15 square-off", MANUAL: "Manual exit",
};

type Props = {
  position: PositionView;
  closed?: boolean;
  now: number;
  spot?: number | null;
  maxHoldMinutes: number;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onExit?: () => void;
};

/**
 * One position the way a trading terminal shows it: live P&L in rupees, percent and R; a price
 * ladder from the initial stop to the target with the entry, the current (trailing) stop and the
 * last price; the stop's stage and what moves it next; best and worst excursion; the index plan;
 * what confirmed the entry; and the clock (time in trade, time stop).
 */
export const PositionCard = memo(function PositionCard({ position, closed = false, now, spot, maxHoldMinutes, selected, onSelect, onExit }: Props) {
  const qty = closed ? position.legs.reduce((sum, leg) => Math.max(sum, leg.quantity), 0) : position.quantity;
  const single = position.legs.length === 1;
  const ltp = closed ? position.exitValue ?? position.value : position.value;
  const pnl = closed ? position.realizedPnl ?? 0 : position.pnl;
  const risk = position.trail?.risk ?? position.initialRisk ?? null;
  const initialStop = risk !== null ? Math.round((position.entry - risk) * 100) / 100 : position.stop;
  const pct = position.entry > 0 ? ((ltp - position.entry) / position.entry) * 100 : 0;
  const rMultiple = risk && risk > 0 ? (ltp - position.entry) / risk : null;
  const best = Math.max(position.highWater, closed ? position.highWater : ltp);
  const worst = Math.min(position.lowWater ?? position.entry, closed ? position.lowWater ?? position.entry : ltp);
  const atStop = position.stop !== null ? (position.stop - position.entry) * qty : null;
  const atTarget = position.target !== null ? (position.target - position.entry) * qty : null;
  const stage = position.trail?.stage ?? (position.trailing ? "TRAILING" : "INITIAL");
  const next = !closed && position.trail ? nextTrailStep({ entry: position.entry, risk: position.trail.risk, costPerUnit: position.trail.costPerUnit, stage: position.trail.stage, highWater: best }) : null;
  const opened = Date.parse(position.openedAt);
  const ended = closed && position.exitAt ? Date.parse(position.exitAt) : now;
  const held = Number.isFinite(opened) ? ended - opened : 0;
  // The time stop: a scalp that has not reached +0.5R within the hold limit is closed.
  const timeLeft = !closed && position.kind === "SCALP" && risk ? maxHoldMinutes * 60_000 - held : null;
  const reachedHalfR = risk ? best - position.entry >= risk * 0.5 : false;

  // Ladder: from the lowest of (initial stop, worst, ltp) to the highest of (target, best, ltp).
  const marks = [initialStop, position.stop, position.entry, position.target, ltp, best, worst].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const span = hi - lo || 1;
  const at = (price: number) => `${((price - lo) / span) * 100}%`;
  const showLadder = single && position.stop !== null && position.target !== null;

  return (
    <article className={`pos-card${closed ? " closed" : ""}${pnl >= 0 ? " up" : " down"}`} aria-label={`${position.label} position`}>
      <header className="pos-head">
        {!closed && onSelect ? <input type="checkbox" checked={Boolean(selected)} onChange={(event) => onSelect(event.target.checked)} aria-label={`Select ${position.label}`} /> : null}
        <span className={`pos-side ${position.side === "CE" ? "ce" : "pe"}`}>{position.legs.length > 1 ? "SPREAD" : `BUY ${position.side}`}</span>
        <b className="pos-symbol" title={position.label}>{position.label}</b>
        {!closed && onExit ? <button type="button" className="pos-exit" title="Exit this position at market" onClick={onExit}>Exit</button> : null}
      </header>

      <div className="pos-meta">
        <span>{qty} qty</span>
        <span>{position.kind}{position.trail ? " · VWAP-EMA" : ""}</span>
        <span title={closed ? "Time in trade" : "Time in trade (live)"}>⏱ {clock(held)}</span>
        {timeLeft !== null && !reachedHalfR ? <span className={timeLeft < 120_000 ? "warn" : ""} title={`Closed at ${maxHoldMinutes} min unless the premium reaches +0.5R`}>time stop {timeLeft > 0 ? clock(timeLeft) : "due"}</span> : null}
        <span>in {ist(position.openedAt)}{closed && position.exitAt ? ` · out ${ist(position.exitAt)}` : ""}</span>
      </div>

      <div className="pos-pnl">
        <b>{rupees(pnl)}</b>
        <span>{pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%</span>
        <span>{rr(rMultiple)}</span>
        {closed ? <span className="pos-stage exit">{EXIT_TEXT[position.exitReason ?? ""] ?? position.exitReason ?? "Closed"}</span> : <span className={`pos-stage s-${stage.toLowerCase()}`} title="Where the stop is in the staged trail">{STAGE_TEXT[stage]}</span>}
        <small>{closed ? "realised" : "unrealised, before charges"}</small>
      </div>

      {showLadder ? (
        <div className="pos-ladder" role="img" aria-label={`Initial stop ${money(initialStop)}, stop ${money(position.stop)}, entry ${money(position.entry)}, ${closed ? "exit" : "last"} ${money(ltp)}, target ${money(position.target)}`}>
          <div className="pos-track">
            <i className="zone-risk" style={{ left: at(Math.min(position.stop!, position.entry)), width: `${(Math.abs(position.entry - position.stop!) / span) * 100}%` }} />
            <i className="zone-reward" style={{ left: at(position.entry), width: `${((position.target! - position.entry) / span) * 100}%` }} />
            {best > position.entry ? <i className="mfe" style={{ left: at(position.entry), width: `${((best - position.entry) / span) * 100}%` }} title={`Best ₹${money(best)}`} /> : null}
            {initialStop !== null && initialStop !== position.stop ? <em className="tick initial" style={{ left: at(initialStop) }} title={`Initial SL ₹${money(initialStop)}`} /> : null}
            <em className="tick stop" style={{ left: at(position.stop!) }} title={`SL ₹${money(position.stop)}`} />
            <em className="tick entry" style={{ left: at(position.entry) }} title={`Entry ₹${money(position.entry)}`} />
            <em className="tick target" style={{ left: at(position.target!) }} title={`Target ₹${money(position.target)}`} />
            <em className="ltp" style={{ left: at(ltp) }} title={`${closed ? "Exit" : "LTP"} ₹${money(ltp)}`} />
          </div>
          <div className="pos-ladder-labels">
            <span className="loss">SL {money(position.stop)}</span>
            <span>Entry {money(position.entry)}</span>
            <span className="gain">T {money(position.target)}</span>
          </div>
        </div>
      ) : null}

      <dl className="pos-grid">
        <div><dt>{closed ? "Exit" : "LTP"}</dt><dd>₹{money(ltp)}</dd></div>
        <div><dt>Avg entry</dt><dd>₹{money(position.entry)}</dd></div>
        <div><dt>{stage === "INITIAL" ? "Stop loss" : "Trailing SL"}</dt><dd className="loss">₹{money(position.stop)}{initialStop !== null && position.stop !== null && initialStop !== position.stop ? <small> from {money(initialStop)}</small> : null}</dd></div>
        <div><dt>Target</dt><dd className="gain">₹{money(position.target)}</dd></div>
        {!closed && atStop !== null ? <div><dt>{atStop >= 0 ? "Locked if SL hits" : "Loss if SL hits"}</dt><dd className={atStop >= 0 ? "gain" : "loss"}>{rupees(atStop)}</dd></div> : null}
        {!closed && atTarget !== null ? <div><dt>At target</dt><dd className="gain">{rupees(atTarget)}</dd></div> : null}
        <div><dt>Best (MFE)</dt><dd className="gain">{rupees((best - position.entry) * qty)}<small> {risk ? rr((best - position.entry) / risk) : ""}</small></dd></div>
        <div><dt>Worst (MAE)</dt><dd className="loss">{rupees((worst - position.entry) * qty)}<small> {risk ? rr((worst - position.entry) / risk) : ""}</small></dd></div>
        {risk ? <div><dt>Risk R / unit</dt><dd>₹{money(risk)}<small> · ₹{money(risk * qty, 0)} total</small></dd></div> : null}
        {position.spot ? <div className="wide"><dt>Index plan</dt><dd>{money(position.spot.entry, 1)}<small> SL {money(position.spot.stop, 1)} · T {money(position.spot.target, 1)}{spot ? ` · now ${money(spot, 1)}` : ""}</small></dd></div> : null}
      </dl>

      {next ? (
        <p className="pos-next">
          {next.trigger !== null ? <>Next: at ₹{money(next.trigger)} the SL moves to <b>₹{money(next.stopTo)}</b> ({next.label}).</> : <>SL {next.label}: <b>₹{money(next.stopTo)}</b> now (best ₹{money(best)}).</>}
        </p>
      ) : null}
      {position.signal ? (
        <p className="pos-signal">Entry confirmed by ADX(14) <b className={position.signal.adx > 20 ? "gain" : "warning"}>{position.signal.adx.toFixed(1)}</b> on the {position.signal.triggerTime ? ist(position.signal.triggerTime) : "trigger"} candle · +DI {position.signal.plusDi.toFixed(1)} / −DI {position.signal.minusDi.toFixed(1)}{position.signal.rising === null ? "" : position.signal.rising ? " · rising" : " · falling"}</p>
      ) : null}
      {position.fill ? <p className="pos-fill">Filled ₹{money(position.fill.actual)} (planned ₹{money(position.fill.planned)}, {position.fill.deviation >= 0 ? "+" : "−"}{money(Math.abs(position.fill.deviation))}) · {position.fill.riskReward}R at the fill · max loss ₹{money(position.fill.plannedLoss, 0)} planned / ₹{money(position.fill.stressedLoss, 0)} stressed</p> : null}
      {!single ? <p className="pos-fill">{position.legs.map((leg) => `${leg.side} ${leg.symbol} @ ₹${money(leg.entry)} (LTP ₹${money(leg.ltp)})`).join(" · ")}</p> : null}
    </article>
  );
});
