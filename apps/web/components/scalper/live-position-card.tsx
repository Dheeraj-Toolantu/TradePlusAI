"use client";

import { memo, useState } from "react";

/** A real-money position from /api/live-orders (OrderRecord with mode ALGO_LIVE). */
export type LivePositionView = {
  id: string; symbol: string; quantity: number; lotSize?: number; price: number; currentPrice?: number; pnl?: number; pnlPercent?: number;
  stopLoss?: number; initialStopLoss?: number; target?: number; brokerStopTrigger?: number; brokerStopOrderId?: string;
  trailResumeAbove?: number; reconcileWarning?: string; exitError?: string; createdAt: string; strategyName?: string;
  partialPrice?: number; partialQuantity?: number; partialDone?: boolean; partialMultiple?: number;
};

const money = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (value: number) => `${value >= 0 ? "+" : "−"}₹${money(Math.abs(value))}`;
const ist = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });

type Props = {
  order: LivePositionView;
  /** The trading PIN typed once in the panel (never stored). */
  pin: string;
  onModify: (changes: { stopLoss?: number; target?: number }) => Promise<string | null>;
  onExit: () => Promise<string | null>;
};

/**
 * One REAL-MONEY position on the scalper's right panel: live P&L, the stop-loss sitting at Groww,
 * the target, broker warnings, and PIN-protected Modify SL / target and Exit.
 */
export const LivePositionCard = memo(function LivePositionCard({ order, pin, onModify, onExit }: Props) {
  const [open, setOpen] = useState(false);
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ltp = order.currentPrice ?? order.price;
  const pnl = order.pnl ?? (ltp - order.price) * order.quantity;
  const atStop = order.stopLoss !== undefined ? (order.stopLoss - order.price) * order.quantity : null;
  const lots = order.lotSize ? Math.round(order.quantity / order.lotSize) : null;
  const needPin = pin.length < 6;

  const begin = () => { setStop(order.stopLoss !== undefined ? String(order.stopLoss) : ""); setTarget(order.target !== undefined ? String(order.target) : ""); setError(null); setOpen(true); };
  const run = async (work: () => Promise<string | null>) => { setBusy(true); const result = await work().catch(() => "Request failed"); setBusy(false); setError(result); return result; };
  const save = async () => {
    const changes: { stopLoss?: number; target?: number } = {};
    if (stop.trim() !== "" && Number(stop) !== order.stopLoss) changes.stopLoss = Number(stop);
    if (target.trim() !== "" && Number(target) !== order.target) changes.target = Number(target);
    if (!Object.keys(changes).length) { setOpen(false); return; }
    if (!window.confirm(`REAL MONEY: change ${order.symbol}${changes.stopLoss !== undefined ? ` stop-loss to ₹${changes.stopLoss} (moves the Groww SL order)` : ""}${changes.target !== undefined ? ` target to ₹${changes.target}` : ""}?`)) return;
    if (!(await run(() => onModify(changes)))) setOpen(false);
  };
  const exit = async () => {
    if (!window.confirm(`REAL MONEY: exit ${order.symbol} × ${order.quantity} at the market now?`)) return;
    await run(onExit);
  };

  return (
    <article className={`pos-card pos-live${pnl >= 0 ? " up" : " down"}`} aria-label={`Live ${order.symbol} position`}>
      <header className="pos-head">
        <span className="pos-side live">LIVE</span>
        <b className="pos-symbol" title={order.symbol}>{order.symbol}</b>
        <button type="button" className="pos-exit" disabled={busy || needPin} title={needPin ? "Enter your trading PIN above" : "Exit at the market on Groww"} onClick={() => void exit()}>Exit</button>
      </header>
      <div className="pos-meta">
        <span>{order.quantity} qty{lots ? ` · ${lots} lot${lots > 1 ? "s" : ""}` : ""}</span>
        <span>Groww MIS</span>
        <span>in {ist(order.createdAt)}</span>
        {order.strategyName ? <span>{order.strategyName.replace(/^Live · /, "")}</span> : null}
      </div>
      <div className="pos-pnl">
        <b>{signed(pnl)}</b>
        <span>{(order.pnlPercent ?? ((ltp - order.price) / order.price) * 100).toFixed(2)}%</span>
        <small>real money, unrealised, before charges</small>
      </div>
      <dl className="pos-grid">
        <div><dt>LTP</dt><dd>₹{money(ltp)}</dd></div>
        <div><dt>Avg entry</dt><dd>₹{money(order.price)}</dd></div>
        <div><dt>Stop-loss</dt><dd className="loss">₹{money(order.stopLoss)}{order.initialStopLoss !== undefined && order.initialStopLoss !== order.stopLoss ? <small> from {money(order.initialStopLoss)}</small> : null}</dd></div>
        <div><dt>Target</dt><dd className="gain">₹{money(order.target)}</dd></div>
        <div><dt>SL at Groww</dt><dd>{order.brokerStopOrderId ? `SL-M ₹${money(order.brokerStopTrigger)}` : <span className="loss">none</span>}</dd></div>
        {atStop !== null ? <div><dt>{atStop >= 0 ? "Locked if SL hits" : "Loss if SL hits"}</dt><dd className={atStop >= 0 ? "gain" : "loss"}>{signed(atStop)}</dd></div> : null}
      </dl>
      {order.partialPrice ? (
        <p className="pos-trail-mode">Partial booking: {order.partialQuantity
          ? order.partialDone ? <>booked at {order.partialMultiple ?? 1.5}x; the rest keeps running</> : <>sells <b>{order.partialQuantity} qty</b> at ₹{money(order.partialPrice)} ({order.partialMultiple ?? 1.5}x the fill), the rest runs</>
          : <>needs 2+ lots (a lot cannot be split)</>}</p>
      ) : null}
      {order.trailResumeAbove ? <p className="pos-trail-mode">Your stop holds until the premium beats ₹{money(order.trailResumeAbove)}, then the trail resumes.</p> : null}
      {order.reconcileWarning ? <p className="pos-modify-error">⚠ {order.reconcileWarning}</p> : null}
      {order.exitError ? <p className="pos-modify-error">{order.exitError}</p> : null}
      {open ? (
        <form className="pos-controls" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label>Stop-loss ₹<input type="number" inputMode="decimal" step="0.05" min="0" value={stop} onChange={(event) => setStop(event.target.value)} /></label>
          <label>Target ₹<input type="number" inputMode="decimal" step="0.05" min="0" value={target} onChange={(event) => setTarget(event.target.value)} /></label>
          <p className="pos-controls-hint">LTP ₹{money(ltp)}. The stop must be below and the target above it. A new stop moves the Groww SL-M order.</p>
          {error ? <p className="pos-modify-error" role="alert">{error}</p> : null}
          <div className="pos-controls-actions">
            <button type="submit" className="pos-modify" disabled={busy || needPin}>{busy ? "Sending…" : needPin ? "Enter PIN above" : "Save"}</button>
            <button type="button" className="pos-modify ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="pos-controls-bar">
          <button type="button" className="pos-modify" onClick={begin}>Modify SL / target</button>
          {error ? <span className="pos-modify-error" role="alert">{error}</span> : null}
        </div>
      )}
    </article>
  );
});
