import { beforeEach, describe, expect, it } from "vitest";
import type { BrokerOrderRequest } from "../../packages/broker-contracts/src/broker-adapter";
import type { GrowwInstrument } from "../../adapters/groww/src/groww-instruments";
import type { OrderRecord } from "../../apps/web/lib/firestore-orders";
import { LiveTradingService, estimateCharges, resetLiveMonitor, type LiveDeps } from "../../apps/web/lib/live/service";

const MONDAY_1030_IST = Date.parse("2026-09-28T05:00:00Z");
const ENABLED_ENV = { EXECUTION_MODE: "ALGO_LIVE", LIVE_EXECUTION_ENABLED: "true", LIVE_COMPLIANCE_APPROVED: "true", GROWW_ACCESS_TOKEN: "test-token", LIVE_TRADING_PIN: "482913", LIVE_CONFIRM_SECRET: "unit-test-secret-0123456789", LIVE_MAX_DAILY_LOSS: "5000", LIVE_MAX_LOTS_PER_ORDER: "2", LIVE_MAX_ORDER_VALUE: "50000" };
const instrument: GrowwInstrument = { exchange: "NSE", exchangeToken: "1", tradingSymbol: "NIFTY26SEP25100CE", growwSymbol: "NSE-NIFTY-25100-CE", instrumentType: "CE", segment: "FNO", underlyingSymbol: "NIFTY", expiryDate: "2026-09-30", strikePrice: 25100, lotSize: 65, tickSize: 0.05, freezeQuantity: 1755, isReserved: false, buyAllowed: true };

type Harness = { deps: LiveDeps; orders: BrokerOrderRequest[]; saved: Map<string, OrderRecord>; setLtp(value: number | null): void; setClock(ms: number): void; fillMode: "fill" | "none"; cancels: string[]; brokerPositions: Array<{ symbol: string; quantity: number; averagePrice: number }> };

function harness(env: Record<string, string> = ENABLED_ENV): Harness {
  let clock = MONDAY_1030_IST;
  let ltp: number | null = 100;
  const orders: BrokerOrderRequest[] = [];
  const saved = new Map<string, OrderRecord>();
  const statuses = new Map<string, { quantity: number; price: number }>();
  const h: Harness = {
    orders, saved, cancels: [], brokerPositions: [], fillMode: "fill",
    setLtp: (value) => { ltp = value; },
    setClock: (ms) => { clock = ms; },
    deps: {
      broker: {
        healthCheck: async () => ({ ok: true, value: { connected: true, authenticated: true, permissions: [], checkedAt: "" } }),
        placeOrder: async (request) => { orders.push(request); statuses.set(request.referenceId, { quantity: request.quantity, price: request.price ?? 0 }); return { ok: true, value: { brokerOrderId: `G-${request.referenceId}`, status: "OPEN", filledQuantity: 0, remainingQuantity: request.quantity } }; },
        getOrderStatus: async (reference) => {
          const order = statuses.get(reference)!;
          return h.fillMode === "fill"
            ? { ok: true, value: { brokerOrderId: `G-${reference}`, status: "EXECUTED", filledQuantity: order.quantity, remainingQuantity: 0, averageFillPrice: order.price } }
            : { ok: true, value: { brokerOrderId: `G-${reference}`, status: "OPEN", filledQuantity: 0, remainingQuantity: order.quantity } };
        },
        cancelOrder: async (id) => { h.cancels.push(String(id)); return { ok: true, value: { brokerOrderId: String(id), status: "CANCELLED", filledQuantity: 0, remainingQuantity: 0 } }; },
        getPositions: async () => ({ ok: true, value: h.brokerPositions }),
      },
      ltp: async () => ltp,
      instrument: async (symbol) => (symbol === instrument.tradingSymbol ? instrument : undefined),
      store: { save: async (order) => { saved.set(order.id, structuredClone(order)); }, listLive: async () => Array.from(saved.values()) },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      env,
    },
  };
  return h;
}

const ticket = { symbol: instrument.tradingSymbol, lots: 1, stopLoss: 80, target: 150 };

describe("LiveTradingService", () => {
  beforeEach(() => resetLiveMonitor());

  it("is disabled by default and never issues a token", async () => {
    const h = harness({});
    const preview = await new LiveTradingService(h.deps).preview(ticket);
    expect(preview.ok).toBe(false);
    expect(preview.token).toBeNull();
    expect(preview.checks.find((check) => check.key === "enabled")?.passed).toBe(false);
    expect(h.orders).toHaveLength(0);
  });

  it("previews with a marketable limit and a signed token when every gate passes", async () => {
    const preview = await new LiveTradingService(harness().deps).preview(ticket);
    expect(preview.checks.filter((check) => !check.passed)).toEqual([]);
    expect(preview.ok).toBe(true);
    expect(preview.ticket?.limitPrice).toBe(100.5);
    expect(preview.ticket?.quantity).toBe(65);
    expect(preview.token).toBeTruthy();
  });

  it("rejects a wrong PIN without touching the broker", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    const preview = await service.preview(ticket);
    const result = await service.confirm(preview.token, "000000");
    expect(result.status).toBe(401);
    expect(h.orders).toHaveLength(0);
  });

  it("places an intraday LIMIT order on confirm, records the fill, and blocks token replay", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    const preview = await service.preview(ticket);
    const result = await service.confirm(preview.token, "482913");
    expect(result.ok).toBe(true);
    expect(h.orders).toEqual([expect.objectContaining({ side: "BUY", orderType: "LIMIT", product: "MIS", segment: "FNO", quantity: 65, price: 100.5, symbol: instrument.tradingSymbol })]);
    const stored = Array.from(h.saved.values()).find((order) => order.status === "OPEN");
    expect(stored).toMatchObject({ mode: "ALGO_LIVE", quantity: 65, price: 100.5, stopLoss: 80, target: 150 });
    const replay = await service.confirm(preview.token, "482913");
    expect(replay.ok).toBe(false);
    expect(h.orders).toHaveLength(1);
  });

  it("rejects a tampered token", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    const preview = await service.preview(ticket);
    const [payload, signature] = String(preview.token).split(".");
    const envelope = JSON.parse(Buffer.from(payload, "base64url").toString());
    envelope.ticket.lots = 2;
    envelope.ticket.quantity = 130;
    const forged = `${Buffer.from(JSON.stringify(envelope)).toString("base64url")}.${signature}`;
    const result = await service.confirm(forged, "482913");
    expect(result.ok).toBe(false);
    expect(h.orders).toHaveLength(0);
  });

  it("enforces reward:risk, lot and daily-loss limits", async () => {
    const service = new LiveTradingService(harness().deps);
    const poorRr = await service.preview({ ...ticket, target: 110 });
    expect(poorRr.checks.find((check) => check.key === "rr")?.passed).toBe(false);
    const tooManyLots = await service.preview({ ...ticket, lots: 3 });
    expect(tooManyLots.checks.find((check) => check.key === "lots")?.passed).toBe(false);
    const hugeRisk = await service.preview({ ...ticket, stopLoss: 5, target: 400 });
    expect(hugeRisk.checks.find((check) => check.key === "daily_loss")?.passed).toBe(false);
  });

  it("blocks entries outside the live window", async () => {
    const h = harness();
    h.setClock(Date.parse("2026-09-28T09:45:00Z")); // 15:15 IST
    const preview = await new LiveTradingService(h.deps).preview(ticket);
    expect(preview.checks.find((check) => check.key === "session")?.passed).toBe(false);
  });

  it("refuses to confirm when the price moved more than 2% after the preview", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    const preview = await service.preview(ticket);
    h.setLtp(104);
    const result = await service.confirm(preview.token, "482913");
    expect(result.status).toBe(409);
    expect(h.orders).toHaveLength(0);
  });

  it("cancels an entry that does not fill and records no position", async () => {
    const h = harness();
    h.fillMode = "none";
    const service = new LiveTradingService(h.deps);
    const preview = await service.preview(ticket);
    const result = await service.confirm(preview.token, "482913");
    expect(result.ok).toBe(false);
    expect(h.cancels).toHaveLength(1);
    expect(Array.from(h.saved.values()).every((order) => order.status === "CANCELLED")).toBe(true);
    expect((await service.status()).positions).toHaveLength(0);
  });

  it("exits at target from the monitor and books realized P&L after charges", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.setLtp(151);
    await service.tick();
    const exited = Array.from(h.saved.values()).find((order) => order.status === "EXITED")!;
    expect(exited.exitReason).toBe("TARGET");
    expect(h.orders.at(-1)).toMatchObject({ side: "SELL", product: "MIS", quantity: 65 });
    expect(exited.realizedPnl).toBeCloseTo((exited.exitPrice! - 100.5) * 65 - estimateCharges(100.5, exited.exitPrice!, 65, "NSE"), 1);
  });

  it("moves the stop to breakeven after +1R and exits on the trailing stop", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.setLtp(122); // +1R (risk 20.5)
    await service.tick();
    const open = (await service.status()).positions[0];
    expect(open.stopLoss).toBeGreaterThan(100.5);
    h.setLtp(100.6);
    await service.tick();
    const exited = Array.from(h.saved.values()).find((order) => order.status === "EXITED")!;
    expect(exited.exitReason).toBe("TRAILING_STOP");
  });

  it("squares off at 15:15 IST", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.setClock(Date.parse("2026-09-28T09:45:30Z"));
    await service.tick();
    expect(Array.from(h.saved.values()).find((order) => order.status === "EXITED")?.exitReason).toBe("SQUARE_OFF_1515");
  });

  it("flags a broker mismatch instead of silently closing the position", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.brokerPositions = [];
    await service.reconcile();
    const [position] = (await service.status()).positions;
    expect(position.status).toBe("OPEN");
    expect(position.reconcileWarning).toContain("Groww shows 0 qty");
  });
});
