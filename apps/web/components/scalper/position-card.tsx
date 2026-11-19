"use client";

import { memo, useState } from "react";
import type { ModifyRequest, PositionView } from "../../../../services/paper-trading/src/smart-scalper";
import { nextSmartTrailStep, nextSniperTrailStep, nextTrailStep, type TrailMode } from "../../../../services/paper-trading/src/scalper-trail";

const money = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const rupees = (value: number) => `${value >= 0 ? "+" : "−"}₹${money(Math.abs(value))}`;
const rr = (value: number | null) => (value === null || !Number.isFinite(value) ? "--" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}R`);
const clock = (ms: number) => { const total = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60; return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`; };
const ist = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" }) : "--");

export const STAGE_TEXT: Record<string, string> = { INITIAL: "Initial SL", BREAKEVEN: "Breakeven", LOCKED: "+0.5R locked", TRAILING: "Trailing" };
const EXIT_TEXT: Record<string, string> = {
  TARGET: "Target hit", SPOT_TARGET: "Index target hit", STOP_LOSS: "Stop loss hit", BREAKEVEN_STOP: "Breakeven stop", LOCKED_PROFIT_STOP: "Locked-profit stop",
  TRAILING_STOP: "Trailing stop", EMA9_LOST: "Momentum lost (9 EMA)", SPOT_LEVEL_BROKEN: "Index level broken", SCALP_TIME_STOP: "Time stop",
  MAX_LOSS_PER_TRADE: "Max loss per trade", SQUARE_OFF_15_15: "15:15 square-off", MANUAL: "Manual exit", RUNNER_STOP: "Runner stop (ran past target)",
};
const STAGE_RANK = ["INITIAL", "BREAKEVEN", "LOCKED", "TRAILING"];
const MODE_TEXT: Record<TrailMode, string> = { SMART: "Smart auto trail", RULE: "Strategy rule", FIXED: "Fixed distance", OFF: "Off" };

type Props = {
  position: PositionView;
  closed?: boolean;
  now: number;
  spot?: number | null;
  maxHoldMinutes: number;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onExit?: () => void;
  /** Change the SL, target and trailing of this open position; resolves to an error text or null. */
  onModify?: (changes: ModifyRequest) => Promise<string | null>;
};

/**
 * The trader's controls on a taken trade: stop loss, target and the trailing mode, changeable at any
 * time. Only the fields the trader edits are sent, so a stop the trail moved meanwhile is not undone.
 */
function RiskControls({ position, onModify }: { position: PositionView; onModify: (changes: ModifyRequest) => Promise<string | null> }) {
  const controls = position.controls;
  const initial = () => ({
    stop: position.stop === null ? "" : String(position.stop), target: position.target === null ? "" : String(position.target),
    mode: (controls?.mode ?? (position.kind === "MANUAL" ? "OFF" : "RULE")) as TrailMode, points: controls?.points ? String(controls.points) : "", run: Boolean(controls?.runPastTarget),
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial);
  const [start, setStart] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const modes: TrailMode[] = position.kind === "MANUAL" ? ["SMART", "FIXED", "OFF"] : ["SMART", "RULE", "FIXED", "OFF"];
  const begin = () => { const next = initial(); setForm(next); setStart(next); setError(null); setOpen(true); };
  const send = async (changes: ModifyRequest) => {
    setSaving(true);
    const result = await onModify(changes).catch(() => "Modify request failed");
    setSaving(false);
    setError(result);
    if (!result) setOpen(false);
  };
  const save = () => {
    const changes: ModifyRequest = {};
    const level = (text: string) => (text.trim() === "" ? null : Number(text));
    if (form.stop !== start.stop) changes.stop = level(form.stop);
    if (form.target !== start.target) changes.target = level(form.target);
    if (form.mode !== start.mode) changes.trailMode = form.mode;
    if (form.points !== start.points || (form.mode === "FIXED" && form.mode !== start.mode)) changes.trailPoints = level(form.points);
    if (form.run !== start.run) changes.runPastTarget = form.run;
    if (!Object.keys(changes).length) { setOpen(false); return; }
    void send(changes);
  };
  const breakeven = Math.ceil((position.entry + 0.05) * 20) / 20;
  if (!open) {
    return (
      <div className="pos-controls-bar">
        <button type="button" className="pos-modify" onClick={begin} title="Change the stop loss, target or trailing stop of this trade">Modify SL / target / trail</button>
        {position.value > breakeven ? <button type="button" className="pos-modify ghost" disabled={saving} title={`Move the stop loss to ₹${money(breakeven)} (entry + one tick): this trade can no longer lose on the premium`} onClick={() => void send({ stop: breakeven })}>SL to cost</button> : null}
        {error ? <span className="pos-modify-error" role="alert">{error}</span> : null}
      </div>
    );
  }
  return (
    <form className="pos-controls" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label>Stop loss ₹<input type="number" inputMode="decimal" step="0.05" min="0" value={form.stop} placeholder="none" onChange={(event) => setForm({ ...form, stop: event.target.value })} /></label>
      <label>Target ₹<input type="number" inputMode="decimal" step="0.05" min="0" value={form.target} placeholder="none" onChange={(event) => setForm({ ...form, target: event.target.value })} /></label>
      <label>Trailing SL<select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value as TrailMode })}>
        {modes.map((mode) => <option key={mode} value={mode}>{mode === "RULE" && position.trail ? `Strategy rule (${position.trail.rule === "SNIPER" ? "NIFTY Sniper" : "VWAP-EMA"})` : MODE_TEXT[mode]}</option>)}
      </select></label>
      {form.mode === "FIXED" ? <label>Trail by ₹<input type="number" inputMode="decimal" step="0.05" min="0.05" value={form.points} placeholder="e.g. 5" onChange={(event) => setForm({ ...form, points: event.target.value })} /></label> : null}
      {form.mode === "SMART" ? <label className="pos-check"><input type="checkbox" checked={form.run} onChange={(event) => setForm({ ...form, run: event.target.checked })} />Run past target (lock 80%, extend target)</label> : null}
      <p className="pos-controls-hint">LTP ₹{money(position.value)}. SL must be below and target above it; leave blank for none. A stop you move stays put until the premium makes a new high, then the trail takes over again.</p>
      {error ? <p className="pos-modify-error" role="alert">{error}</p> : null}
      <div className="pos-controls-actions">
        <button type="submit" className="pos-modify" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" className="pos-modify ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * One position the way a trading terminal shows it: live P&L in rupees, percent and R; a price
 * ladder from the initial stop to the target with the entry, the current (trailing) stop and the
 * last price; the stop's stage and what moves it next; best and worst excursion; the index plan;
 * what confirmed the entry; and the clock (time in trade, time stop).
 */
export const PositionCard = memo(function PositionCard({ position, closed = false, now, spot, maxHoldMinutes, selected, onSelect, onExit, onModify }: Props) {
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
  const controls = position.controls;
  const mode: TrailMode = controls?.mode ?? (position.kind === "MANUAL" ? "OFF" : "RULE");
  const ruleStage = position.trail?.stage ?? (position.trailing ? "TRAILING" : "INITIAL");
  const stage = controls && mode !== "RULE" && STAGE_RANK.indexOf(controls.stage) > STAGE_RANK.indexOf(ruleStage) ? controls.stage : ruleStage;
  const ruleNext = position.trail
    ? position.trail.rule === "SNIPER"
      ? nextSniperTrailStep({ entry: position.entry, costPerUnit: position.trail.costPerUnit, stage: position.trail.stage, highWater: best })
      : nextTrailStep({ entry: position.entry, risk: position.trail.risk, costPerUnit: position.trail.costPerUnit, stage: position.trail.stage, highWater: best })
    : null;
  const smartNext = controls && mode === "SMART" ? nextSmartTrailStep({ entry: position.entry, risk: controls.risk, costPerUnit: position.trail?.costPerUnit ?? 0, stage: controls.stage, highWater: best }) : null;
  // Smart mode keeps the strategy rule too: show whichever step would put the stop higher.
  const next = closed || mode === "OFF" || mode === "FIXED" ? null : mode === "SMART" && smartNext && (!ruleNext || smartNext.stopTo >= ruleNext.stopTo) ? smartNext : ruleNext;
  const resumeAbove = controls?.resumeAbove ?? null;
  const opened = Date.parse(position.openedAt);
  const ended = closed && position.exitAt ? Date.parse(position.exitAt) : now;
  const held = Number.isFinite(opened) ? ended - opened : 0;
  // The time stop: a scalp that has not reached +0.5R within the hold limit is closed.
  // NIFTY Sniper: its own 90-minute stop for a trade that has not reached 1.25x.
  const sniper = position.trail?.rule === "SNIPER";
  const timeLeft = !closed && position.kind === "SCALP" && risk ? (sniper ? 90 : maxHoldMinutes) * 60_000 - held : null;
  const reachedHalfR = sniper ? best >= position.entry * 1.25 : risk ? best - position.entry >= risk * 0.5 : false;

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
        <span>{position.kind}{position.trail ? (position.trail.rule === "SNIPER" ? " · NIFTY Sniper" : " · VWAP-EMA") : ""}</span>
        <span title={closed ? "Time in trade" : "Time in trade (live)"}>⏱ {clock(held)}</span>
        {timeLeft !== null && !reachedHalfR ? <span className={timeLeft < 120_000 ? "warn" : ""} title={sniper ? "Closed at 90 min unless the premium reaches 1.25x" : `Closed at ${maxHoldMinutes} min unless the premium reaches +0.5R`}>time stop {timeLeft > 0 ? clock(timeLeft) : "due"}</span> : null}
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
      {!closed && controls ? (
        <p className="pos-trail-mode">
          Trailing: <b>{MODE_TEXT[mode]}</b>
          {mode === "SMART" ? (controls.runPastTarget ? ` · runs past target${controls.targetRuns ? ` (target moved out ${controls.targetRuns}×)` : ""}` : " · closes at target") : null}
          {mode === "FIXED" && controls.points ? <> · ₹{money(controls.points)} under the best premium: SL <b>₹{money(Math.max(position.stop ?? 0, best - controls.points))}</b></> : null}
          {mode === "OFF" ? " · the SL moves only when you move it" : null}
          {resumeAbove !== null && mode !== "OFF" ? <> · your SL holds until the premium beats ₹{money(resumeAbove)}</> : null}
        </p>
      ) : null}
      {!closed && onModify ? <RiskControls key={position.id} position={position} onModify={onModify} /> : null}
      {position.signal ? (
        <p className="pos-signal">Entry confirmed by ADX(14) <b className={position.signal.adx > 20 ? "gain" : "warning"}>{position.signal.adx.toFixed(1)}</b> on the {position.signal.triggerTime ? ist(position.signal.triggerTime) : "trigger"} candle · +DI {position.signal.plusDi.toFixed(1)} / −DI {position.signal.minusDi.toFixed(1)}{position.signal.rising === null ? "" : position.signal.rising ? " · rising" : " · falling"}</p>
      ) : null}
      {position.fill ? <p className="pos-fill">Filled ₹{money(position.fill.actual)} (planned ₹{money(position.fill.planned)}, {position.fill.deviation >= 0 ? "+" : "−"}{money(Math.abs(position.fill.deviation))}) · {position.fill.riskReward}R at the fill · max loss ₹{money(position.fill.plannedLoss, 0)} planned / ₹{money(position.fill.stressedLoss, 0)} stressed</p> : null}
      {!single ? <p className="pos-fill">{position.legs.map((leg) => `${leg.side} ${leg.symbol} @ ₹${money(leg.entry)} (LTP ₹${money(leg.ltp)})`).join(" · ")}</p> : null}
    </article>
  );
});
