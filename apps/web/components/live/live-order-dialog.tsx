"use client";

import { useEffect, useState } from "react";

type Check = { key: string; label: string; passed: boolean; detail: string };
type Preview = {
  ok: boolean; error?: string; token: string | null; expiresAt: string | null; ltp: number | null;
  ticket?: { symbol: string; lots: number; lotSize: number; quantity: number; limitPrice: number; stopLoss: number; target: number; exchange: string; expiry: string };
  checks: Check[]; maxLoss?: number; reward?: number; charges?: number; rewardRisk?: number; orderValue?: number;
};
export type LiveTicketDraft = { symbol: string; lots: number; stopLoss: number; target: number; source: string };

const inr = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export function LiveOrderDialog({ draft, onClose, onPlaced }: { draft: LiveTicketDraft; onClose: () => void; onPlaced: (message: string) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);

  const load = async () => {
    setBusy(true); setError(null); setPin(""); setAcknowledged(false);
    try {
      const response = await fetch("/api/live-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", ...draft }) });
      setPreview(await response.json());
    } catch { setError("Preview request failed"); }
    finally { setBusy(false); }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!preview?.expiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((new Date(preview.expiresAt!).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [preview?.expiresAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    if (!preview?.token) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/live-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", token: preview.token, pin }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) { setError(result.error ?? "Live order failed"); return; }
      onPlaced(`LIVE order filled: BUY ${result.order.quantity} × ${result.order.symbol} @ ₹${result.order.price}${result.partial ? " (partial fill)" : ""}. Exits are managed automatically.`);
      onClose();
    } catch { setError("Confirm request failed; check the Groww app before retrying."); }
    finally { setBusy(false); }
  };

  const ticket = preview?.ticket;
  const expired = Boolean(preview?.token) && secondsLeft === 0;
  return (
    <div className="live-dialog-backdrop" role="presentation" onClick={() => !busy && onClose()}>
      <div className="live-dialog" role="dialog" aria-modal="true" aria-labelledby="live-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <span className="live-dialog-badge">REAL MONEY · GROWW</span>
          <h2 id="live-dialog-title">Confirm live order</h2>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </header>
        {!preview && <p>Checking every live gate with a fresh Groww quote…</p>}
        {preview && ticket && (
          <>
            <div className="live-ticket">
              <b>BUY {ticket.lots} lot{ticket.lots > 1 ? "s" : ""} · {ticket.symbol}</b>
              <span>{ticket.quantity} qty · {ticket.exchange} · expiry {ticket.expiry} · intraday (MIS)</span>
              <dl>
                <div><dt>Limit price</dt><dd>{inr(ticket.limitPrice)}<small> LTP {inr(preview.ltp)}</small></dd></div>
                <div><dt>Stop-loss</dt><dd className="loss">{inr(ticket.stopLoss)}</dd></div>
                <div><dt>Target</dt><dd className="gain">{inr(ticket.target)}</dd></div>
                <div><dt>Order value</dt><dd>{inr(preview.orderValue)}</dd></div>
                <div><dt>Max loss incl. charges</dt><dd className="loss">{inr(preview.maxLoss)}</dd></div>
                <div><dt>Reward : risk</dt><dd>{preview.rewardRisk ?? "--"} : 1</dd></div>
              </dl>
            </div>
            <ul className="live-checks">
              {preview.checks.map((check) => <li key={check.key} className={check.passed ? "pass" : "fail"}><i aria-hidden="true">{check.passed ? "✓" : "✗"}</i><span>{check.label}<small>{check.detail}</small></span></li>)}
            </ul>
          </>
        )}
        {preview && !ticket && <p className="loss">{preview.error}</p>}
        {preview?.ok && preview.token && !expired && (
          <div className="live-confirm">
            <label className="live-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand this places a real order with my money, and I may lose up to {inr(preview.maxLoss)}.</label>
            <label>Trading PIN<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="Server PIN" /></label>
            <button type="button" className="live-confirm-button" disabled={busy || !acknowledged || pin.length < 6} onClick={confirm}>{busy ? "Sending to Groww…" : `Place live order (${secondsLeft}s)`}</button>
          </div>
        )}
        {(expired || (preview && !preview.ok)) && <button type="button" className="live-secondary" onClick={load} disabled={busy}>{expired ? "Quote expired: preview again" : "Re-check"}</button>}
        {error && <p className="loss live-error">{error}</p>}
        <p className="live-footnote">Stop-loss, target, trailing stop (breakeven at +1R, trail from +1.5R) and the 15:15 square-off are managed by this server. Keep it running while the position is open; Groww also squares off MIS positions automatically near the close.</p>
      </div>
    </div>
  );
}
