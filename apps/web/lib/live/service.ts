import { randomBytes } from "node:crypto";
import type { BrokerAdapter } from "../../../../packages/broker-contracts/src/broker-adapter";
import type { GrowwInstrument } from "../../../../adapters/groww/src/groww-instruments";
import type { OrderRecord } from "../firestore-orders";
import { confirmSecret, istClock, pinMatches, readLiveConfig, type LiveConfig } from "./config";
import { consumeNonce, issueToken, verifyToken, type LiveTicket } from "./confirm-token";

// Real-money order lifecycle (manual confirmation per order, app-managed exits):
//   preview  -> every gate evaluated, signed single-use token for the exact ticket
//   confirm  -> PIN + token, gates re-checked on a fresh quote, MIS LIMIT entry, fill polled,
//               unfilled remainder cancelled, position registered with the exit monitor
//   monitor  -> every 2 s: stop, target, trailing (+1R breakeven, +1.5R trail), 15:15 square-off,
//               kill switch flatten; periodic broker reconciliation flags mismatches (never
//               silently closes a position it cannot see)
//   exit     -> SELL LIMIT with escalating price buffer, up to 3 attempts, partial fills tracked

export type LiveDeps = {
  broker: Pick<BrokerAdapter, "placeOrder" | "getOrderStatus" | "cancelOrder" | "getPositions" | "healthCheck">;
  ltp(symbol: string, exchange: "NSE" | "BSE"): Promise<number | null>;
  instrument(symbol: string): Promise<GrowwInstrument | undefined>;
  store: { save(order: OrderRecord): Promise<void>; listLive(): Promise<OrderRecord[]> };
  now(): number;
  sleep(ms: number): Promise<void>;
  env: NodeJS.ProcessEnv;
};

export type Check = { key: string; label: string; passed: boolean; detail: string };
export type PreviewInput = { symbol: string; lots: number; stopLoss: number; target: number; source?: string };

const FILLED = new Set(["EXECUTED", "COMPLETED", "COMPLETE", "FILLED"]);
const DEAD = new Set(["REJECTED", "CANCELLED", "CANCELED", "FAILED", "EXPIRED"]);
const ENTRY_FILL_TIMEOUT_MS = 8_000;
const EXIT_FILL_TIMEOUT_MS = 5_000;
const POLL_MS = 700;
const MONITOR_MS = 2_000;
const RECONCILE_EVERY_TICKS = 15;

const round2 = (value: number) => Math.round(value * 100) / 100;
const tickUp = (value: number, tick: number) => round2(Math.ceil(value / tick - 1e-9) * tick);
const tickDown = (value: number, tick: number) => round2(Math.max(tick, Math.floor(value / tick + 1e-9) * tick));
const isOpen = (order: OrderRecord) => order.status === "OPEN" || order.status === "FILLED";
const referenceId = () => `TP${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 20);

/** Round-trip charges for an intraday option buy (brokerage, STT, exchange, GST, SEBI, stamp). */
export function estimateCharges(entry: number, exit: number, quantity: number, exchange: "NSE" | "BSE"): number {
  const buyValue = entry * quantity;
  const sellValue = exit * quantity;
  const brokerage = 40;
  const stt = sellValue * 0.001;
  const transaction = (buyValue + sellValue) * (exchange === "BSE" ? 0.000325 : 0.000353);
  const sebi = (buyValue + sellValue) * 10 / 1e7;
  const stamp = buyValue * 0.00003;
  const gst = (brokerage + transaction + sebi) * 0.18;
  return round2(brokerage + stt + transaction + sebi + stamp + gst);
}

export type DailyState = { date: string; tradesToday: number; realizedPnl: number; openPositions: OrderRecord[]; openRisk: number };

export function dailyState(orders: OrderRecord[], nowMs: number): DailyState {
  const today = istClock(nowMs).date;
  const live = orders.filter((order) => order.mode === "ALGO_LIVE");
  const todays = live.filter((order) => istClock(new Date(order.createdAt).getTime()).date === today && order.quantity > 0);
  const openPositions = live.filter(isOpen);
  return {
    date: today,
    tradesToday: todays.filter((order) => order.status !== "CANCELLED").length,
    realizedPnl: round2(todays.reduce((sum, order) => sum + (order.status === "EXITED" ? Number(order.realizedPnl ?? 0) : 0), 0)),
    openPositions,
    openRisk: round2(openPositions.reduce((sum, order) => sum + Math.max(order.price - Number(order.stopLoss ?? 0), 0) * order.quantity, 0)),
  };
}

export function evaluateTicket(ticket: LiveTicket, instrument: GrowwInstrument | undefined, ltp: number | null, state: DailyState, config: LiveConfig, nowMs: number, brokerHealthy: boolean): { checks: Check[]; maxLoss: number; reward: number; charges: number; rewardRisk: number; orderValue: number } {
  const clock = istClock(nowMs);
  const charges = estimateCharges(ticket.limitPrice, ticket.stopLoss, ticket.quantity, ticket.exchange);
  const maxLoss = round2((ticket.limitPrice - ticket.stopLoss) * ticket.quantity + charges);
  const reward = round2((ticket.target - ticket.limitPrice) * ticket.quantity - estimateCharges(ticket.limitPrice, ticket.target, ticket.quantity, ticket.exchange));
  const rewardRisk = maxLoss > 0 ? round2(reward / maxLoss) : 0;
  const orderValue = round2(ticket.limitPrice * ticket.quantity);
  const lossUsed = Math.max(-state.realizedPnl, 0) + state.openRisk;
  const { limits } = config;
  const checks: Check[] = [
    { key: "enabled", label: "Live trading enabled on the server", passed: config.enabled, detail: config.enabled ? "All server switches are on" : config.disabledReasons.join("; ") },
    { key: "broker", label: "Groww connected and authenticated", passed: brokerHealthy, detail: brokerHealthy ? "Health check passed" : "Groww health check failed" },
    { key: "session", label: "Inside the live entry window", passed: clock.weekday >= 1 && clock.weekday <= 5 && clock.minute >= config.entryWindow.start && clock.minute < config.entryWindow.end, detail: `IST ${String(Math.floor(clock.minute / 60)).padStart(2, "0")}:${String(clock.minute % 60).padStart(2, "0")}` },
    { key: "contract", label: "Contract exists in the Groww contract master and is tradable", passed: Boolean(instrument && instrument.segment === "FNO" && instrument.tradingSymbol === ticket.symbol && instrument.isReserved !== true && instrument.buyAllowed !== false), detail: instrument ? `${instrument.tradingSymbol} · lot ${instrument.lotSize} · freeze ${instrument.freezeQuantity}` : "Not found" },
    { key: "quote", label: "Live option quote available", passed: ltp !== null && ltp > 0, detail: ltp ? `LTP ₹${ltp}` : "No live quote" },
    { key: "lots", label: `Lots within limit (max ${limits.maxLotsPerOrder})`, passed: Number.isInteger(ticket.lots) && ticket.lots >= 1 && ticket.lots <= limits.maxLotsPerOrder, detail: `${ticket.lots} lot(s) = ${ticket.quantity} qty` },
    { key: "freeze", label: "Quantity below exchange freeze limit", passed: !instrument?.freezeQuantity || ticket.quantity <= Number(instrument.freezeQuantity), detail: `freeze ${instrument?.freezeQuantity ?? "--"}` },
    { key: "value", label: `Order value within ₹${limits.maxOrderValue.toLocaleString("en-IN")}`, passed: orderValue <= limits.maxOrderValue, detail: `₹${orderValue.toLocaleString("en-IN")}` },
    { key: "structure", label: "Stop below entry and target above entry", passed: ticket.stopLoss > 0 && ticket.stopLoss < ticket.limitPrice && ticket.target > ticket.limitPrice, detail: `SL ₹${ticket.stopLoss} · entry ≤ ₹${ticket.limitPrice} · target ₹${ticket.target}` },
    { key: "rr", label: `Reward at least ${limits.minRewardRisk}× risk after charges`, passed: rewardRisk >= limits.minRewardRisk, detail: `${rewardRisk}:1` },
    { key: "daily_loss", label: `Daily loss budget (₹${limits.maxDailyLoss.toLocaleString("en-IN")}) not exceeded`, passed: lossUsed + maxLoss <= limits.maxDailyLoss, detail: `used ₹${round2(lossUsed)} + this trade ₹${maxLoss}` },
    { key: "trades", label: `Fewer than ${limits.maxTradesPerDay} live trades today`, passed: state.tradesToday < limits.maxTradesPerDay, detail: `${state.tradesToday} taken` },
    { key: "open", label: `Fewer than ${limits.maxOpenPositions} open live position(s)`, passed: state.openPositions.length < limits.maxOpenPositions, detail: `${state.openPositions.length} open` },
    { key: "duplicate", label: "No open live position in this contract", passed: !state.openPositions.some((order) => order.symbol === ticket.symbol), detail: ticket.symbol },
  ];
  return { checks, maxLoss, reward, charges, rewardRisk, orderValue };
}

type MonitorState = { timer: ReturnType<typeof setInterval> | null; ticks: number; lastTickAt: string | null; lastError: string | null; exiting: Set<string>; positions: Map<string, OrderRecord>; hydrated: boolean; busy: boolean };
const monitorGlobal = globalThis as typeof globalThis & { __tradepulseLiveMonitor?: MonitorState };
const stopBreaches = new Map<string, number>();
const monitor = (monitorGlobal.__tradepulseLiveMonitor ??= { timer: null, ticks: 0, lastTickAt: null, lastError: null, exiting: new Set(), positions: new Map(), hydrated: false, busy: false });

export class LiveTradingService {
  constructor(private readonly deps: LiveDeps) {}

  private config() { return readLiveConfig(this.deps.env); }

  private async state(): Promise<DailyState> {
    const orders = await this.deps.store.listLive();
    const merged = new Map(orders.map((order) => [order.id, order]));
    for (const order of monitor.positions.values()) merged.set(order.id, order);
    return dailyState(Array.from(merged.values()), this.deps.now());
  }

  private async healthy(): Promise<boolean> {
    const health = await this.deps.broker.healthCheck().catch(() => null);
    return Boolean(health && "value" in health && health.value.connected && health.value.authenticated);
  }

  private async buildTicket(input: PreviewInput, limitPrice?: number): Promise<{ ticket: LiveTicket | null; instrument?: GrowwInstrument; ltp: number | null; error?: string }> {
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    const lots = Number(input.lots);
    const stopLoss = round2(Number(input.stopLoss));
    const target = round2(Number(input.target));
    if (!/^[A-Z0-9]{6,40}$/.test(symbol)) return { ticket: null, ltp: null, error: "Invalid option trading symbol" };
    if (!Number.isFinite(stopLoss) || !Number.isFinite(target)) return { ticket: null, ltp: null, error: "Stop-loss and target premiums are required" };
    const instrument = await this.deps.instrument(symbol);
    if (!instrument) return { ticket: null, ltp: null, error: "Contract not found in the Groww contract master" };
    const exchange = instrument.exchange === "BSE" ? "BSE" : "NSE";
    const ltp = await this.deps.ltp(symbol, exchange).catch(() => null);
    const tick = Number(instrument.tickSize) > 0 ? Number(instrument.tickSize) : 0.05;
    const lotSize = Number(instrument.lotSize);
    const buffer = this.config().limitBufferPct / 100;
    const ticket: LiveTicket = {
      symbol, exchange, side: "BUY", lots, lotSize, quantity: lots * lotSize,
      limitPrice: limitPrice ?? (ltp ? tickUp(ltp * (1 + buffer), tick) : 0),
      stopLoss, target, tickSize: tick,
      underlying: String(instrument.underlyingSymbol ?? ""), expiry: String(instrument.expiryDate ?? ""),
      optionType: instrument.instrumentType === "PE" ? "PE" : "CE", strike: Number(instrument.strikePrice ?? 0),
      source: String(input.source ?? "MANUAL").slice(0, 40),
    };
    return { ticket, instrument, ltp };
  }

  async preview(input: PreviewInput) {
    const config = this.config();
    const built = await this.buildTicket(input);
    if (!built.ticket) return { ok: false as const, error: built.error ?? "Invalid ticket", checks: [] as Check[] };
    const [state, brokerHealthy] = await Promise.all([this.state(), this.healthy()]);
    const evaluation = evaluateTicket(built.ticket, built.instrument, built.ltp, state, config, this.deps.now(), brokerHealthy);
    const allPassed = evaluation.checks.every((check) => check.passed);
    const token = allPassed ? issueToken(built.ticket, confirmSecret(this.deps.env), config.confirmTtlSeconds, this.deps.now()) : null;
    return { ok: allPassed, ticket: built.ticket, ltp: built.ltp, ...evaluation, token: token?.token ?? null, expiresAt: token?.expiresAt ?? null, error: allPassed ? undefined : "One or more live checks failed" };
  }

  async confirm(token: unknown, pin: unknown) {
    if (!pinMatches(pin, this.deps.env)) return { ok: false as const, status: 401, error: "Incorrect trading PIN" };
    const verified = verifyToken(token, confirmSecret(this.deps.env), this.deps.now());
    if ("error" in verified) return { ok: false as const, status: 409, error: verified.error };
    const ticket = verified.ticket;
    const config = this.config();
    // Re-check everything on a fresh quote; the user's confirmed limit price is kept.
    const fresh = await this.buildTicket({ symbol: ticket.symbol, lots: ticket.lots, stopLoss: ticket.stopLoss, target: ticket.target, source: ticket.source }, ticket.limitPrice);
    if (!fresh.ticket || fresh.ticket.quantity !== ticket.quantity) return { ok: false as const, status: 409, error: "Contract metadata changed; preview again" };
    if (fresh.ltp && Math.abs(fresh.ltp - ticket.limitPrice) / ticket.limitPrice > 0.02) return { ok: false as const, status: 409, error: `Price moved to ₹${fresh.ltp} (more than 2% from your ₹${ticket.limitPrice} limit); preview again` };
    const [state, brokerHealthy] = await Promise.all([this.state(), this.healthy()]);
    const evaluation = evaluateTicket(ticket, fresh.instrument, fresh.ltp, state, config, this.deps.now(), brokerHealthy);
    const failed = evaluation.checks.filter((check) => !check.passed);
    if (failed.length) return { ok: false as const, status: 403, error: `Live checks failed: ${failed.map((check) => check.label).join("; ")}`, checks: evaluation.checks };
    if (!consumeNonce(verified.nonce, this.deps.now())) return { ok: false as const, status: 409, error: "This confirmation was already used" };

    const reference = referenceId();
    const placed = await this.deps.broker.placeOrder({ referenceId: reference, symbol: ticket.symbol, quantity: ticket.quantity, side: "BUY", orderType: "LIMIT", price: ticket.limitPrice, exchange: ticket.exchange, segment: "FNO", product: "MIS" });
    const createdAt = new Date(this.deps.now()).toISOString();
    const base: OrderRecord = {
      id: `live-${reference}`, symbol: ticket.symbol, growwSymbol: ticket.symbol, expiry: ticket.expiry, strike: ticket.strike, underlying: ticket.underlying, exchange: ticket.exchange,
      strategy: "LIVE_CONFIRMED", strategyName: `Live · ${ticket.source}`, side: "BUY", quantity: 0, lotSize: ticket.lotSize, price: ticket.limitPrice,
      target: ticket.target, stopLoss: ticket.stopLoss, initialStopLoss: ticket.stopLoss, status: "CANCELLED", mode: "ALGO_LIVE", source: "Groww live (manual confirmation)", referenceId: reference, createdAt,
    };
    if ("error" in placed) {
      await this.deps.store.save({ ...base, exitReason: "ORDER_REJECTED", exitError: placed.error.message });
      return { ok: false as const, status: 502, error: `Groww rejected the order: ${placed.error.message}` };
    }
    const fill = await this.awaitFill(reference, placed.value.brokerOrderId, ticket.quantity, ENTRY_FILL_TIMEOUT_MS);
    if (fill.filled <= 0) {
      await this.deps.store.save({ ...base, brokerOrderId: placed.value.brokerOrderId, exitReason: "NOT_FILLED", exitError: fill.note });
      return { ok: false as const, status: 408, error: `Entry not filled within ${ENTRY_FILL_TIMEOUT_MS / 1000}s at ₹${ticket.limitPrice}; the order was cancelled. ${fill.note}`.trim() };
    }
    const entry = fill.averagePrice ?? ticket.limitPrice;
    const order: OrderRecord = { ...base, brokerOrderId: placed.value.brokerOrderId, status: "OPEN", quantity: fill.filled, price: entry, highWaterMark: entry, currentPrice: entry, pnl: 0, pnlPercent: 0, quoteSource: "Groww live fill" };
    monitor.positions.set(order.id, order);
    this.ensureMonitor();
    const stop = await this.placeProtectiveStop(order, ticket.stopLoss);
    if (!stop.ok) {
      await this.deps.store.save(order);
      const closed = await this.exit(order.id, "PROTECTIVE_STOP_FAILED", undefined, false);
      return { ok: false as const, status: 502, error: `Entry filled but Groww rejected the protective stop (${stop.error}); the position was ${closed.ok ? "closed immediately" : "NOT closed: exit it in the Groww app now"}.`, order };
    }
    await this.deps.store.save(order);
    return { ok: true as const, status: 200, order, partial: fill.filled < ticket.quantity };
  }

  private async awaitFill(reference: string, brokerOrderId: string, quantity: number, timeoutMs: number) {
    const deadline = this.deps.now() + timeoutMs;
    let filled = 0;
    let averagePrice: number | undefined;
    let note = "";
    while (this.deps.now() < deadline) {
      await this.deps.sleep(POLL_MS);
      const status = await this.deps.broker.getOrderStatus(reference);
      if ("error" in status) { note = status.error.message; continue; }
      filled = status.value.filledQuantity;
      averagePrice = status.value.averageFillPrice ?? averagePrice;
      const state = status.value.status.toUpperCase();
      if (FILLED.has(state) || filled >= quantity) return { filled: Math.min(filled, quantity), averagePrice, note };
      if (DEAD.has(state)) return { filled, averagePrice, note: `Order ${state.toLowerCase()}` };
    }
    await this.deps.broker.cancelOrder(brokerOrderId);
    const final = await this.deps.broker.getOrderStatus(reference);
    if ("value" in final) { filled = final.value.filledQuantity; averagePrice = final.value.averageFillPrice ?? averagePrice; }
    return { filled: Math.min(filled, quantity), averagePrice, note: note || "Unfilled remainder cancelled" };
  }

  // ---- broker-side protective stop (SL-M at Groww) ---------------------------------------
  // The stop lives at the broker so the position stays protected if this server stops. The app
  // still owns targets, trailing (it moves the broker stop), square-off and kill-switch exits.

  private async placeProtectiveStop(order: OrderRecord, trigger: number): Promise<{ ok: boolean; error?: string }> {
    const instrument = await this.deps.instrument(order.symbol);
    const tick = Number(instrument?.tickSize) > 0 ? Number(instrument?.tickSize) : 0.05;
    const reference = referenceId();
    const placed = await this.deps.broker.placeOrder({ referenceId: reference, symbol: order.symbol, quantity: order.quantity, side: "SELL", orderType: "SL_M", triggerPrice: tickDown(trigger, tick), exchange: order.exchange === "BSE" ? "BSE" : "NSE", segment: "FNO", product: "MIS" });
    if ("error" in placed) return { ok: false, error: placed.error.message };
    Object.assign(order, { brokerStopOrderId: placed.value.brokerOrderId, stopReferenceId: reference, brokerStopTrigger: tickDown(trigger, tick) });
    return { ok: true };
  }

  /** Status of the broker stop: filled (position closed at the broker), dead (cancelled/rejected) or pending. */
  private async stopState(order: OrderRecord): Promise<{ filled: number; averagePrice?: number; state: "FILLED" | "DEAD" | "PENDING" | "UNKNOWN" }> {
    if (!order.stopReferenceId) return { filled: 0, state: "UNKNOWN" };
    const status = await this.deps.broker.getOrderStatus(order.stopReferenceId);
    if ("error" in status) return { filled: 0, state: "UNKNOWN" };
    const value = status.value.status.toUpperCase();
    const filled = status.value.filledQuantity;
    if (FILLED.has(value) || filled >= order.quantity) return { filled: Math.min(filled, order.quantity), averagePrice: status.value.averageFillPrice, state: "FILLED" };
    if (DEAD.has(value)) return { filled, averagePrice: status.value.averageFillPrice, state: "DEAD" };
    return { filled, averagePrice: status.value.averageFillPrice, state: "PENDING" };
  }

  /** Cancel the broker stop before an app exit. Never lets the app sell while the stop may still fire. */
  private async releaseStop(order: OrderRecord): Promise<{ status: "RELEASED" } | { status: "ALREADY_EXITED"; filled: number; averagePrice?: number } | { status: "BLOCKED"; error: string }> {
    if (!order.brokerStopOrderId) return { status: "RELEASED" };
    await this.deps.broker.cancelOrder(order.brokerStopOrderId);
    const state = await this.stopState(order);
    if (state.state === "FILLED") return { status: "ALREADY_EXITED", filled: state.filled, averagePrice: state.averagePrice };
    if (state.state === "DEAD") {
      if (state.filled > 0) return { status: "ALREADY_EXITED", filled: state.filled, averagePrice: state.averagePrice };
      Object.assign(order, { brokerStopOrderId: undefined, stopReferenceId: undefined });
      return { status: "RELEASED" };
    }
    return { status: "BLOCKED", error: "Could not confirm the Groww stop-loss was cancelled; exit aborted to avoid selling twice. Check the Groww app." };
  }

  private async closeFromBrokerStop(order: OrderRecord, averagePrice: number | undefined, reason: string) {
    const exitPrice = round2(averagePrice ?? Number(order.brokerStopTrigger ?? order.stopLoss));
    const exchange = order.exchange === "BSE" ? "BSE" : "NSE";
    const charges = estimateCharges(order.price, exitPrice, order.quantity, exchange);
    Object.assign(order, { status: "EXITED", exitPrice, exitAt: new Date(this.deps.now()).toISOString(), exitReason: reason, charges, realizedPnl: round2((exitPrice - order.price) * order.quantity - charges), realizedPnlPercent: round2((exitPrice - order.price) / order.price * 100) });
    await this.deps.store.save(order);
    monitor.positions.delete(order.id);
  }

  private async moveBrokerStop(order: OrderRecord, trigger: number) {
    const released = await this.releaseStop(order);
    if (released.status === "ALREADY_EXITED") { await this.closeFromBrokerStop(order, released.averagePrice, "BROKER_STOP"); return; }
    if (released.status === "BLOCKED") { order.exitError = released.error; return; }
    const placed = await this.placeProtectiveStop(order, trigger);
    order.exitError = placed.ok ? undefined : `Trailing stop could not be re-placed at Groww (${placed.error}); the app will exit on its own stop.`;
  }

  async exit(orderId: string, reason: string, pin?: unknown, requirePin = true) {
    if (requirePin && !pinMatches(pin, this.deps.env)) return { ok: false as const, status: 401, error: "Incorrect trading PIN" };
    await this.hydrate();
    const order = monitor.positions.get(orderId);
    if (!order || !isOpen(order)) return { ok: false as const, status: 404, error: "No open live position with that id" };
    if (monitor.exiting.has(orderId)) return { ok: false as const, status: 409, error: "Exit already in progress" };
    monitor.exiting.add(orderId);
    try {
      const released = await this.releaseStop(order);
      if (released.status === "ALREADY_EXITED") { await this.closeFromBrokerStop(order, released.averagePrice, "BROKER_STOP"); return { ok: true as const, status: 200, order }; }
      if (released.status === "BLOCKED") { order.exitError = released.error; await this.deps.store.save(order); return { ok: false as const, status: 502, error: released.error }; }
      const exchange = order.exchange === "BSE" ? "BSE" : "NSE";
      const instrument = await this.deps.instrument(order.symbol);
      const tick = Number(instrument?.tickSize) > 0 ? Number(instrument?.tickSize) : 0.05;
      let remaining = order.quantity;
      let proceeds = 0;
      let lastError = "";
      for (let attempt = 1; attempt <= 3 && remaining > 0; attempt += 1) {
        const ltp = await this.deps.ltp(order.symbol, exchange).catch(() => null);
        if (!ltp) { lastError = "No live quote for the exit"; await this.deps.sleep(POLL_MS); continue; }
        const price = tickDown(ltp * (1 - (this.config().limitBufferPct * attempt) / 100), tick);
        const reference = referenceId();
        const placed = await this.deps.broker.placeOrder({ referenceId: reference, symbol: order.symbol, quantity: remaining, side: "SELL", orderType: "LIMIT", price, exchange, segment: "FNO", product: "MIS" });
        if ("error" in placed) { lastError = placed.error.message; continue; }
        const fill = await this.awaitFill(reference, placed.value.brokerOrderId, remaining, EXIT_FILL_TIMEOUT_MS);
        proceeds += fill.filled * (fill.averagePrice ?? price);
        remaining -= fill.filled;
        if (fill.filled === 0) lastError = fill.note;
      }
      const exitedQuantity = order.quantity - remaining;
      if (remaining > 0) {
        order.quantity = remaining;
        const reprotected = await this.placeProtectiveStop(order, Number(order.stopLoss));
        Object.assign(order, { exitError: `Exit incomplete: ${remaining} qty still open${reprotected.ok ? " (Groww stop-loss re-placed)" : " and UNPROTECTED"}. ${lastError}`.trim(), updatedAt: new Date(this.deps.now()).toISOString() });
        await this.deps.store.save(order);
        return { ok: false as const, status: 502, error: order.exitError, exitedQuantity };
      }
      const exitPrice = round2(proceeds / exitedQuantity);
      const charges = estimateCharges(order.price, exitPrice, exitedQuantity, exchange);
      const realized = round2((exitPrice - order.price) * exitedQuantity - charges);
      Object.assign(order, { status: "EXITED", exitPrice, exitAt: new Date(this.deps.now()).toISOString(), exitReason: reason, charges, realizedPnl: realized, realizedPnlPercent: round2((exitPrice - order.price) / order.price * 100), exitError: undefined });
      await this.deps.store.save(order);
      monitor.positions.delete(orderId);
      return { ok: true as const, status: 200, order };
    } finally {
      monitor.exiting.delete(orderId);
    }
  }

  /** Operator action after a reconcile mismatch (e.g. position closed in the Groww app). */
  async markClosed(orderId: string, exitPrice: number, pin: unknown) {
    if (!pinMatches(pin, this.deps.env)) return { ok: false as const, status: 401, error: "Incorrect trading PIN" };
    await this.hydrate();
    const order = monitor.positions.get(orderId);
    if (!order) return { ok: false as const, status: 404, error: "No open live position with that id" };
    const price = Number(exitPrice);
    if (!(price > 0)) return { ok: false as const, status: 400, error: "Exit price is required" };
    Object.assign(order, { status: "EXITED", exitPrice: price, exitAt: new Date(this.deps.now()).toISOString(), exitReason: "CLOSED_AT_BROKER", realizedPnl: round2((price - order.price) * order.quantity) });
    await this.deps.store.save(order);
    monitor.positions.delete(orderId);
    return { ok: true as const, status: 200, order };
  }

  async hydrate() {
    if (monitor.hydrated) return;
    monitor.hydrated = true;
    for (const order of await this.deps.store.listLive()) if (isOpen(order) && order.quantity > 0) monitor.positions.set(order.id, order);
    if (monitor.positions.size) this.ensureMonitor();
  }

  ensureMonitor() {
    if (monitor.timer) return;
    monitor.timer = setInterval(() => { void this.tick(); }, MONITOR_MS);
    monitor.timer.unref?.();
  }

  /** One monitor pass. Public for tests; the interval calls it every 2 seconds. */
  async tick() {
    if (monitor.busy) return;
    monitor.busy = true;
    try {
      monitor.ticks += 1;
      monitor.lastTickAt = new Date(this.deps.now()).toISOString();
      const config = this.config();
      const clock = istClock(this.deps.now());
      for (const order of Array.from(monitor.positions.values())) {
        if (!isOpen(order) || monitor.exiting.has(order.id)) continue;
        const ltp = await this.deps.ltp(order.symbol, order.exchange === "BSE" ? "BSE" : "NSE").catch(() => null);
        if (!ltp) continue;
        const entry = order.price;
        const initialStop = Number(order.initialStopLoss ?? order.stopLoss);
        const risk = Math.max(entry - initialStop, 0.05);
        const highWater = Math.max(Number(order.highWaterMark ?? entry), ltp);
        let stop = Number(order.stopLoss);
        const breakeven = entry + estimateCharges(entry, entry, order.quantity, order.exchange === "BSE" ? "BSE" : "NSE") / order.quantity;
        if (highWater >= entry + risk) stop = Math.max(stop, round2(breakeven));
        if (highWater >= entry + 1.5 * risk) stop = Math.max(stop, round2(highWater - risk));
        if (order.brokerStopOrderId) {
          const state = await this.stopState(order);
          if (state.state === "FILLED") { await this.closeFromBrokerStop(order, state.averagePrice, stop > initialStop ? "BROKER_TRAILING_STOP" : "BROKER_STOP"); continue; }
          if (state.state === "DEAD") { Object.assign(order, { brokerStopOrderId: undefined, stopReferenceId: undefined }); await this.placeProtectiveStop(order, Math.max(stop, Number(order.stopLoss))); }
        }
        const changed = stop !== Number(order.stopLoss) || highWater !== Number(order.highWaterMark);
        Object.assign(order, { currentPrice: ltp, pnl: round2((ltp - entry) * order.quantity), pnlPercent: round2((ltp - entry) / entry * 100), highWaterMark: highWater, stopLoss: stop, trailingStop: stop, quoteSource: "Groww live quote" });
        if (stop > initialStop && !order.trailingActivatedAt) order.trailingActivatedAt = new Date(this.deps.now()).toISOString();
        if (order.brokerStopOrderId && stop > Number(order.brokerStopTrigger ?? 0) + 0.049) await this.moveBrokerStop(order, stop);
        if (!monitor.positions.has(order.id)) continue;
        if (changed) await this.deps.store.save(order);
        // With a live broker stop, Groww executes the stop itself; the app only steps in if the
        // price has stayed through the stop for 3 checks (stop order stuck or rejected).
        const breach = ltp <= stop ? (stopBreaches.get(order.id) ?? 0) + 1 : 0;
        stopBreaches.set(order.id, breach);
        const stopHit = order.brokerStopOrderId ? breach >= 3 : breach >= 1;
        const reason = config.killSwitch ? "KILL_SWITCH" : clock.minute >= config.squareOffMinute ? "SQUARE_OFF_1515" : ltp >= Number(order.target) ? "TARGET" : stopHit ? (stop > initialStop ? "TRAILING_STOP" : "STOP_LOSS") : null;
        if (reason) await this.exit(order.id, reason, undefined, false);
      }
      if (monitor.ticks % RECONCILE_EVERY_TICKS === 0 && monitor.positions.size) await this.reconcile();
      monitor.lastError = null;
    } catch (error) {
      monitor.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      monitor.busy = false;
      if (!monitor.positions.size && monitor.timer) { clearInterval(monitor.timer); monitor.timer = null; }
    }
  }

  async reconcile() {
    const positions = await this.deps.broker.getPositions();
    if ("error" in positions) return;
    for (const order of monitor.positions.values()) {
      const broker = positions.value.find((position) => position.symbol === order.symbol);
      const brokerQuantity = broker?.quantity ?? 0;
      const warning = brokerQuantity === order.quantity ? undefined : `Groww shows ${brokerQuantity} qty, app tracks ${order.quantity}. Check the Groww app; use "Mark closed" if you exited there.`;
      if (warning !== order.reconcileWarning) { order.reconcileWarning = warning; await this.deps.store.save(order); }
    }
  }

  async status() {
    await this.hydrate();
    const config = this.config();
    const state = await this.state();
    return {
      enabled: config.enabled,
      disabledReasons: config.disabledReasons,
      limits: config.limits,
      entryWindow: config.entryWindow,
      squareOffMinute: config.squareOffMinute,
      today: { date: state.date, tradesToday: state.tradesToday, realizedPnl: state.realizedPnl, openRisk: state.openRisk, lossBudgetLeft: round2(config.limits.maxDailyLoss - Math.max(-state.realizedPnl, 0) - state.openRisk) },
      positions: Array.from(monitor.positions.values()),
      monitor: { running: Boolean(monitor.timer), lastTickAt: monitor.lastTickAt, lastError: monitor.lastError },
    };
  }
}

/** Test hook. */
export function resetLiveMonitor() {
  if (monitor.timer) clearInterval(monitor.timer);
  Object.assign(monitor, { timer: null, ticks: 0, lastTickAt: null, lastError: null, exiting: new Set(), positions: new Map(), hydrated: false, busy: false });
}
