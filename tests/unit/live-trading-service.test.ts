import { beforeEach, describe, expect, it } from "vitest";
import type { BrokerOrderRequest } from "../../packages/broker-contracts/src/broker-adapter";
import type { GrowwInstrument } from "../../adapters/groww/src/groww-instruments";
import type { OrderRecord } from "../../apps/web/lib/firestore-orders";
import { LiveTradingService, estimateCharges, resetLiveMonitor, type LiveDeps } from "../../apps/web/lib/live/service";
import { resetLiveAutoArm } from "../../apps/web/lib/live/auto-arm";

const MONDAY_1030_IST = Date.parse("2026-09-28T05:00:00Z");
const ENABLED_ENV = { EXECUTION_MODE: "ALGO_LIVE", LIVE_EXECUTION_ENABLED: "true", LIVE_COMPLIANCE_APPROVED: "true", LIVE_TRADING_CONFIRMATION: "true", GROWW_ACCESS_TOKEN: "test-token", LIVE_TRADING_PIN: "482913", LIVE_CONFIRM_SECRET: "unit-test-secret-0123456789", LIVE_MAX_DAILY_LOSS: "5000", LIVE_MAX_LOTS_PER_ORDER: "2", LIVE_MAX_ORDER_VALUE: "50000" };
const instrument: GrowwInstrument = { exchange: "NSE", exchangeToken: "1", tradingSymbol: "NIFTY26SEP25100CE", growwSymbol: "NSE-NIFTY-25100-CE", instrumentType: "CE", segment: "FNO", underlyingSymbol: "NIFTY", expiryDate: "2026-09-30", strikePrice: 25100, lotSize: 65, tickSize: 0.05, freezeQuantity: 1755, isReserved: false, buyAllowed: true };

type Harness = { deps: LiveDeps; orders: BrokerOrderRequest[]; saved: Map<string, OrderRecord>; setLtp(value: number | null): void; setClock(ms: number): void; fillMode: "fill" | "none"; rejectStops: boolean; cancels: string[]; brokerPositions: Array<{ symbol: string; quantity: number; averagePrice: number }>; triggerStops(price: number): void; stopOrders(): BrokerOrderRequest[] };

function harness(env: Record<string, string> = ENABLED_ENV): Harness {
  let clock = MONDAY_1030_IST;
  let ltp: number | null = 100;
  const orders: BrokerOrderRequest[] = [];
  const saved = new Map<string, OrderRecord>();
  const statuses = new Map<string, { request: BrokerOrderRequest; state: "OPEN" | "FILLED" | "CANCELLED"; fillPrice?: number }>();
  const h: Harness = {
    orders, saved, cancels: [], brokerPositions: [], fillMode: "fill", rejectStops: false,
    setLtp: (value) => { ltp = value; },
    setClock: (ms) => { clock = ms; },
    triggerStops: (price) => { for (const entry of statuses.values()) if (entry.request.orderType === "SL_M" && entry.state === "OPEN") Object.assign(entry, { state: "FILLED", fillPrice: price }); },
    stopOrders: () => orders.filter((order) => order.orderType === "SL_M"),
    deps: {
      broker: {
        healthCheck: async () => ({ ok: true, value: { connected: true, authenticated: true, permissions: [], checkedAt: "" } }),
        placeOrder: async (request) => {
          if (request.orderType === "SL_M" && h.rejectStops) return { ok: false, error: { code: "REJECTED", message: "stop rejected", retryable: false, safeStateImpact: "NONE" } } as never;
          orders.push(request);
          statuses.set(request.referenceId, { request, state: request.orderType === "SL_M" ? "OPEN" : h.fillMode === "fill" ? "FILLED" : "OPEN", fillPrice: request.price });
          return { ok: true, value: { brokerOrderId: `G-${request.referenceId}`, status: "OPEN", filledQuantity: 0, remainingQuantity: request.quantity } };
        },
        getOrderStatus: async (reference) => {
          const entry = statuses.get(reference)!;
          const status = entry.state === "FILLED" ? "EXECUTED" : entry.state === "CANCELLED" ? "CANCELLED" : entry.request.orderType === "SL_M" ? "TRIGGER_PENDING" : "OPEN";
          return { ok: true, value: { brokerOrderId: `G-${reference}`, status, filledQuantity: entry.state === "FILLED" ? entry.request.quantity : 0, remainingQuantity: entry.state === "FILLED" ? 0 : entry.request.quantity, averageFillPrice: entry.state === "FILLED" ? entry.fillPrice : undefined } };
        },
        cancelOrder: async (id) => {
          h.cancels.push(String(id));
          const entry = statuses.get(String(id).replace(/^G-/, ""));
          if (entry && entry.state === "OPEN") entry.state = "CANCELLED";
          return { ok: true, value: { brokerOrderId: String(id), status: "CANCELLED", filledQuantity: 0, remainingQuantity: 0 } };
        },
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
    expect(h.orders).toEqual([
      expect.objectContaining({ side: "BUY", orderType: "LIMIT", product: "MIS", segment: "FNO", quantity: 65, price: 100.5, symbol: instrument.tradingSymbol }),
      expect.objectContaining({ side: "SELL", orderType: "SL_M", product: "MIS", quantity: 65, triggerPrice: 80 }),
    ]);
    const stored = Array.from(h.saved.values()).find((order) => order.status === "OPEN");
    expect(stored).toMatchObject({ mode: "ALGO_LIVE", quantity: 65, price: 100.5, stopLoss: 80, target: 150 });
    const replay = await service.confirm(preview.token, "482913");
    expect(replay.ok).toBe(false);
    expect(h.orders).toHaveLength(2);
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
    expect(h.orders.at(-1)).toMatchObject({ side: "SELL", orderType: "LIMIT", product: "MIS", quantity: 65 });
    expect(h.cancels).toContain(`G-${h.stopOrders()[0].referenceId}`);
    expect(exited.realizedPnl).toBeCloseTo((exited.exitPrice! - 100.5) * 65 - estimateCharges(100.5, exited.exitPrice!, 65, "NSE"), 1);
  });

  it("moves the stop to breakeven after +1R, re-places the Groww stop, and books the broker stop fill", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.setLtp(122); // +1R (risk 20.5)
    await service.tick();
    const open = (await service.status()).positions[0];
    expect(open.stopLoss).toBeGreaterThan(100.5);
    expect(h.stopOrders().map((order) => order.triggerPrice)).toEqual([80, Math.floor(Number(open.stopLoss) / 0.05 + 1e-9) * 0.05].map((value) => Math.round(value * 100) / 100));
    const sellsBefore = h.orders.filter((order) => order.side === "SELL" && order.orderType === "LIMIT").length;
    h.triggerStops(101.2);
    h.setLtp(100.9);
    await service.tick();
    const exited = Array.from(h.saved.values()).find((order) => order.status === "EXITED")!;
    expect(exited.exitReason).toBe("BROKER_TRAILING_STOP");
    expect(exited.exitPrice).toBe(101.2);
    expect(h.orders.filter((order) => order.side === "SELL" && order.orderType === "LIMIT").length).toBe(sellsBefore);
  });

  it("closes the position immediately if Groww rejects the protective stop", async () => {
    const h = harness();
    h.rejectStops = true;
    const service = new LiveTradingService(h.deps);
    const result = await service.confirm((await service.preview(ticket)).token, "482913");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("closed immediately");
    expect(h.orders.at(-1)).toMatchObject({ side: "SELL", orderType: "LIMIT" });
    expect(Array.from(h.saved.values()).find((order) => order.status === "EXITED")?.exitReason).toBe("PROTECTIVE_STOP_FAILED");
  });

  it("cancels the Groww stop before an app exit and never sells twice if the stop already fired", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.triggerStops(79.5);
    const result = await service.exit(Array.from(h.saved.values())[0].id, "MANUAL_EXIT", "482913");
    expect(result.ok).toBe(true);
    expect(h.orders.filter((order) => order.side === "SELL" && order.orderType === "LIMIT")).toHaveLength(0);
    expect(Array.from(h.saved.values())[0]).toMatchObject({ status: "EXITED", exitReason: "BROKER_STOP", exitPrice: 79.5 });
  });

  it("app steps in only after the price stays through a stuck broker stop for 3 checks", async () => {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    await service.confirm((await service.preview(ticket)).token, "482913");
    h.setLtp(79);
    await service.tick();
    await service.tick();
    expect((await service.status()).positions).toHaveLength(1);
    await service.tick();
    const exited = Array.from(h.saved.values()).find((order) => order.status === "EXITED")!;
    expect(exited.exitReason).toBe("STOP_LOSS");
    expect(h.cancels.length).toBeGreaterThan(0);
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


describe("LiveTradingService automatic real-money orders", () => {
  beforeEach(() => { resetLiveMonitor(); resetLiveAutoArm(); });
  const AUTO_ENV = { ...ENABLED_ENV, LIVE_AUTO_EXECUTION_ENABLED: "true", LIVE_MAX_LOTS_PER_ORDER: "5", LIVE_MAX_ORDER_VALUE: "100000", LIVE_MAX_DAILY_LOSS: "20000" };
  const auto = (overrides = {}) => ({ symbol: instrument.tradingSymbol, lots: 3, stopLoss: 75, target: 200, strategy: "NIFTY_SNIPER" as const, setupId: "S1", source: "AUTO test", ...overrides });

  it("refuses without the server auto switch, without arming, or with the wrong PIN", async () => {
    const off = new LiveTradingService(harness().deps);
    expect((await off.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 1 })).error).toMatch(/LIVE_AUTO_EXECUTION_ENABLED/);
    const h = harness(AUTO_ENV);
    const service = new LiveTradingService(h.deps);
    expect((await service.autoPlace(auto())).error).toMatch(/not armed/);
    expect((await service.armAuto({ pin: "000000", strategy: "NIFTY_SNIPER", lots: 3 })).status).toBe(401);
    expect(h.orders).toHaveLength(0);
  });

  it("will not arm more lots than the server allows per order", async () => {
    const service = new LiveTradingService(harness(AUTO_ENV).deps);
    expect((await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 6 })).error).toMatch(/LIVE_MAX_LOTS_PER_ORDER \(5\)/);
    expect((await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 11 })).status).toBe(400);
  });

  it("buys EXACTLY the armed lots as an intraday MIS LIMIT, with stop and target from the fill and a Groww stop", async () => {
    const h = harness(AUTO_ENV);
    const service = new LiveTradingService(h.deps);
    expect((await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 3 })).ok).toBe(true);
    const result = await service.autoPlace(auto({ premiumMultiples: { stop: 0.75, target: 2 } }));
    expect(result.ok).toBe(true);
    const entry = h.orders[0];
    expect(entry).toMatchObject({ side: "BUY", orderType: "LIMIT", product: "MIS", segment: "FNO", quantity: 195 }); // 3 × 65
    if (!result.ok) throw new Error("not placed");
    expect(result.order).toMatchObject({ quantity: 195, price: 100.5, stopLoss: 75.35, target: 201, mode: "ALGO_LIVE", strategy: "LIVE_AUTO_NIFTY_SNIPER" });
    expect(h.stopOrders()[0]).toMatchObject({ side: "SELL", orderType: "SL_M", product: "MIS", quantity: 195, triggerPrice: 75.35 });
  });

  it("refuses (never resizes) when a limit cannot carry the armed lots, and only for the armed strategy and lots", async () => {
    const h = harness({ ...AUTO_ENV, LIVE_MAX_ORDER_VALUE: "15000" });
    const service = new LiveTradingService(h.deps);
    await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 3 });
    const refused = await service.autoPlace(auto());
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/at 3 lot\(s\).*Order value/);
    expect(h.orders).toHaveLength(0);
    expect((await service.autoPlace(auto({ lots: 2 }))).error).toMatch(/differ from the armed 3/);
    expect((await service.autoPlace(auto({ strategy: "VWAP_EMA_SCALP" }))).error).toMatch(/armed for NIFTY_SNIPER/);
  });

  it("sends a setup to Groww once, and stops after disarming or at the end of the day", async () => {
    const h = harness(AUTO_ENV);
    const service = new LiveTradingService(h.deps);
    await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 1 });
    expect((await service.autoPlace(auto({ lots: 1 }))).ok).toBe(true);
    await service.exit(Array.from((await service.status()).positions)[0].id, "TEST", undefined, false);
    expect((await service.autoPlace(auto({ lots: 1 }))).error).toMatch(/already sent/);
    service.disarmAuto();
    expect((await service.autoPlace(auto({ lots: 1, setupId: "S2" }))).error).toMatch(/not armed/);
    await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 1 });
    h.setClock(MONDAY_1030_IST + 24 * 3_600_000);
    expect((await service.status()).auto.armed).toBeNull();
  });
});

describe("LiveTradingService modify SL / target", () => {
  beforeEach(() => { resetLiveMonitor(); resetLiveAutoArm(); });
  async function opened() {
    const h = harness();
    const service = new LiveTradingService(h.deps);
    const preview = await service.preview(ticket);
    const confirmed = await service.confirm(preview.token, "482913");
    if (!confirmed.ok) throw new Error(confirmed.error);
    return { h, service, id: confirmed.order.id };
  }

  it("needs the PIN and keeps the stop below and the target above the live premium", async () => {
    const { h, service, id } = await opened();
    expect((await service.modify(id, { stopLoss: 90 }, "000000")).status).toBe(401);
    h.setLtp(105);
    expect((await service.modify(id, { stopLoss: 106 }, "482913")).error).toMatch(/below the live premium/);
    expect((await service.modify(id, { target: 104 }, "482913")).error).toMatch(/above the live premium/);
    expect((await service.modify("nope", { stopLoss: 90 }, "482913")).status).toBe(404);
  });

  it("moves the Groww stop-loss (old one cancelled first) and updates the target", async () => {
    const { h, service, id } = await opened();
    h.setLtp(110);
    const result = await service.modify(id, { stopLoss: 95, target: 170 }, "482913");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({ stopLoss: 95, target: 170, brokerStopTrigger: 95 });
    expect(h.stopOrders()).toHaveLength(2);
    expect(h.stopOrders()[1]).toMatchObject({ side: "SELL", orderType: "SL_M", triggerPrice: 95, quantity: 65 });
    expect(h.cancels.length).toBeGreaterThanOrEqual(1);
  });

  it("restores the previous Groww stop if the new one is refused", async () => {
    const { h, service, id } = await opened();
    h.setLtp(110);
    h.rejectStops = true;
    const result = await service.modify(id, { stopLoss: 95 }, "482913");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/NOT at Groww|restored/);
    h.rejectStops = false;
    const again = await service.modify(id, { stopLoss: 95 }, "482913");
    expect(again.ok).toBe(true);
  });

  it("holds a hand-moved stop until the premium makes a new best, then the trail resumes", async () => {
    const { h, service, id } = await opened();
    h.setLtp(140);
    await service.tick(); // +2R: trail raised the stop
    const trailed = (await service.status()).positions[0].stopLoss!;
    expect(trailed).toBeGreaterThan(100);
    h.setLtp(135);
    expect((await service.modify(id, { stopLoss: 98 }, "482913")).ok).toBe(true);
    await service.tick();
    expect((await service.status()).positions[0].stopLoss).toBe(98);
    h.setLtp(145); // a new best below the 150 target
    await service.tick();
    expect((await service.status()).positions[0].stopLoss).toBeGreaterThan(98);
  });
});

describe("LiveTradingService partial booking at 1.5x", () => {
  beforeEach(() => { resetLiveMonitor(); resetLiveAutoArm(); });
  const AUTO_ENV = { ...ENABLED_ENV, LIVE_AUTO_EXECUTION_ENABLED: "true", LIVE_MAX_LOTS_PER_ORDER: "5", LIVE_MAX_ORDER_VALUE: "100000", LIVE_MAX_DAILY_LOSS: "20000" };
  async function opened(lots: number) {
    const h = harness(AUTO_ENV);
    const service = new LiveTradingService(h.deps);
    await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots });
    const result = await service.autoPlace({ symbol: instrument.tradingSymbol, lots, stopLoss: 75, target: 200, strategy: "NIFTY_SNIPER", setupId: `P${lots}`, premiumMultiples: { stop: 0.75, target: 2 }, partialMultiple: 1.5 });
    if (!result.ok) throw new Error(result.error);
    return { h, service, order: result.order };
  }

  it("plans half the lots at 1.5x the fill", async () => {
    const { order } = await opened(3);
    expect(order).toMatchObject({ quantity: 195, partialPrice: 150.75, partialQuantity: 65, partialDone: false }); // 1.5 × 100.5; 3 lots → book 1
  });

  it("sells the partial lots on Groww, records the slice, and re-places the Groww stop for the rest", async () => {
    const { h, service, order } = await opened(4);
    h.setLtp(151);
    await service.tick();
    const sells = h.orders.filter((item) => item.side === "SELL" && item.orderType === "LIMIT");
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ quantity: 130, product: "MIS" }); // 2 of 4 lots
    const slice = h.saved.get(`${order.id}-PARTIAL`)!;
    expect(slice).toMatchObject({ status: "EXITED", quantity: 130, exitReason: "PARTIAL_1_5X" });
    expect(slice.realizedPnl).toBeGreaterThan(0);
    const open = (await service.status()).positions[0];
    expect(open).toMatchObject({ quantity: 130, partialDone: true });
    expect(h.stopOrders().at(-1)).toMatchObject({ side: "SELL", orderType: "SL_M", quantity: 130 }); // new stop covers the rest only
    // Booked once, and the slice is not counted as a new trade.
    await service.tick();
    expect(h.orders.filter((item) => item.side === "SELL" && item.orderType === "LIMIT")).toHaveLength(1);
    expect((await service.status()).today.tradesToday).toBe(1);
  });

  it("does not split a single lot", async () => {
    const { h, service, order } = await opened(1);
    expect(order.partialQuantity).toBe(0);
    h.setLtp(151);
    await service.tick();
    expect(h.orders.filter((item) => item.side === "SELL" && item.orderType === "LIMIT")).toHaveLength(0);
    expect((await service.status()).positions[0].quantity).toBe(65);
  });

  it("closes instead of booking when the Groww stop already executed", async () => {
    const { h, service } = await opened(2);
    h.triggerStops(80);
    h.setLtp(151);
    await service.tick();
    expect((await service.status()).positions).toHaveLength(0);
    expect(h.orders.filter((item) => item.side === "SELL" && item.orderType === "LIMIT")).toHaveLength(0);
  });
});

describe("LiveTradingService NIFTY Sniper staged trail", () => {
  beforeEach(() => { resetLiveMonitor(); resetLiveAutoArm(); });
  const AUTO_ENV = { ...ENABLED_ENV, LIVE_AUTO_EXECUTION_ENABLED: "true", LIVE_MAX_LOTS_PER_ORDER: "5", LIVE_MAX_ORDER_VALUE: "100000", LIVE_MAX_DAILY_LOSS: "20000" };
  async function opened() {
    const h = harness(AUTO_ENV);
    const service = new LiveTradingService(h.deps);
    await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 1 });
    const result = await service.autoPlace({ symbol: instrument.tradingSymbol, lots: 1, stopLoss: 75, target: 200, strategy: "NIFTY_SNIPER", setupId: "T1", premiumMultiples: { stop: 0.75, target: 2 }, trailRule: "SNIPER" });
    if (!result.ok) throw new Error(result.error);
    return { h, service, order: result.order };
  }
  const position = async (service: LiveTradingService) => (await service.status()).positions[0];

  it("steps the stop at 1.25x, 1.5x and 1.75x the fill and moves the Groww stop each time", async () => {
    const { h, service, order } = await opened();
    expect(order).toMatchObject({ trailRule: "SNIPER", trailStage: "INITIAL", price: 100.5 });
    h.setLtp(124); await service.tick();
    expect((await position(service)).trailStage).toBe("INITIAL"); // below 1.25x
    h.setLtp(126); await service.tick(); // 1.25x = 125.6
    let open = await position(service);
    expect(open.trailStage).toBe("BREAKEVEN");
    expect(open.stopLoss).toBeGreaterThan(100.5);
    expect(h.stopOrders().at(-1)!.triggerPrice).toBe(open.stopLoss);
    h.setLtp(151); await service.tick(); // 1.5x = 150.75 → lock 1.2x
    open = await position(service);
    expect(open).toMatchObject({ trailStage: "LOCKED", stopLoss: 120.6 });
    h.setLtp(180); await service.tick(); // 1.75x+ → trail 0.2 × 100.5 under the best
    open = await position(service);
    expect(open.trailStage).toBe("TRAILING");
    expect(open.stopLoss).toBe(159.9);
    expect(h.stopOrders().at(-1)!.triggerPrice).toBe(159.9);
  });

  it("closes at 2x with the sniper exit reason", async () => {
    const { h, service, order } = await opened();
    h.setLtp(202); await service.tick();
    expect(h.saved.get(order.id)).toMatchObject({ status: "EXITED", exitReason: "TARGET_2X" });
  });
});

describe("LiveTradingService money (₹ P&L) stop and trail", () => {
  beforeEach(() => { resetLiveMonitor(); resetLiveAutoArm(); });
  const AUTO_ENV = { ...ENABLED_ENV, LIVE_AUTO_EXECUTION_ENABLED: "true", LIVE_MAX_LOTS_PER_ORDER: "5", LIVE_MAX_ORDER_VALUE: "100000", LIVE_MAX_DAILY_LOSS: "20000" };
  const money = { stopLoss: 500, trigger: 500, firstStop: -200, step: 200, target: 1500 };
  async function opened() {
    const h = harness(AUTO_ENV);
    const service = new LiveTradingService(h.deps);
    await service.armAuto({ pin: "482913", strategy: "NIFTY_SNIPER", lots: 1 });
    const result = await service.autoPlace({ symbol: instrument.tradingSymbol, lots: 1, stopLoss: 75, target: 200, strategy: "NIFTY_SNIPER", setupId: "M1", premiumMultiples: { stop: 0.75, target: 2 }, trailRule: "SNIPER", partialMultiple: 1.5, moneyTrail: money });
    if (!result.ok) throw new Error(result.error);
    return { h, service, order: result.order };
  }

  it("sets the ₹ stop and target from the fill, with the Groww stop at the ₹ stop, replacing the sniper trail and partial", async () => {
    const { h, order } = await opened();
    // 65 qty filled at 100.5: −₹500 → 92.81 → 92.85; +₹1500 → 123.58 → 123.60.
    expect(order).toMatchObject({ stopLoss: 92.85, target: 123.6, moneyTrail: money });
    expect(order.trailRule).toBeUndefined();
    expect(order.partialPrice).toBeUndefined();
    expect(h.stopOrders()[0]).toMatchObject({ triggerPrice: 92.85, quantity: 65 });
  });

  it("trails the Groww stop in ₹ steps and exits at the ₹ target", async () => {
    const { h, service, order } = await opened();
    h.setLtp(108.2); await service.tick(); // +₹500.5 → SL −₹200
    expect((await service.status()).positions[0]).toMatchObject({ stopLoss: 97.45, trailStage: "TRAILING" });
    h.setLtp(111.6); await service.tick(); // +₹721.5 → SL ₹0
    expect((await service.status()).positions[0].stopLoss).toBe(100.5);
    expect(h.stopOrders().at(-1)!.triggerPrice).toBe(100.5);
    h.setLtp(124); await service.tick();
    expect(h.saved.get(order.id)).toMatchObject({ status: "EXITED", exitReason: "MONEY_TARGET" });
  });
});
