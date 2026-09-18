import { describe, expect, it } from "vitest";
import { AutoOptionTrader } from "../../services/paper-trading/src/auto-option-trader";

describe("AutoOptionTrader", () => {
  it("does not create duplicate trades when identical scans overlap", async () => {
    const trader = new AutoOptionTrader({ maxTrades: 10, minScore: 75, minRiskReward: 2 });
    const input = {
      symbol: "NIFTY",
      spot: 23150,
      candles: [
        { timestamp: "2099-09-15T09:00:00+05:30", open: 23120, high: 23135, low: 23110, close: 23125, volume: 1000 },
        { timestamp: "2099-09-15T09:05:00+05:30", open: 23125, high: 23145, low: 23120, close: 23140, volume: 1200 },
        { timestamp: "2099-09-15T09:10:00+05:30", open: 23140, high: 23170, low: 23135, close: 23165, volume: 1500 },
      ],
      contracts: [{ symbol: "NIFTY20990923300DUPCE", contract: "CALL" as const, strike: 23300, premium: 52, bid: 50.5, ask: 53.5, openInterest: 450000, volume: 4500000, iv: 28, delta: 0.52, score: 91, riskReward: 2.4, expiry: "2099-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 }],
    };

    const [first, second] = await Promise.all([trader.tick(input), trader.tick(input)]);

    const targetSymbol = input.contracts[0].symbol;
    expect(first.orders.filter((order) => order.status === "OPEN" && order.symbol === targetSymbol)).toHaveLength(1);
    expect(second.orders.filter((order) => order.status === "OPEN" && order.symbol === targetSymbol)).toHaveLength(1);
    expect(new Set(second.orders.map((order) => order.id)).size).toBe(second.orders.length);
  });

  it("selects a confirmed bullish call or bearish put and stores the order in the order log", async () => {
    const trader = new AutoOptionTrader({ maxTrades: 3, minScore: 75, minRiskReward: 2 });

    const status = await trader.tick({
      symbol: "NIFTY",
      spot: 23150,
      candles: [
        { timestamp: "2026-09-15T09:00:00+05:30", open: 23120, high: 23135, low: 23110, close: 23125, volume: 1000 },
        { timestamp: "2026-09-15T09:05:00+05:30", open: 23125, high: 23145, low: 23120, close: 23140, volume: 1200 },
        { timestamp: "2026-09-15T09:10:00+05:30", open: 23140, high: 23170, low: 23135, close: 23165, volume: 1500 },
      ],
      contracts: [
        { symbol: "NIFTY2691523300CE", contract: "CALL", strike: 23300, premium: 52, bid: 50.5, ask: 53.5, openInterest: 450000, volume: 4500000, iv: 28, delta: 0.52, score: 91, riskReward: 2.4, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 },
        { symbol: "NIFTY2691523300PE", contract: "PUT", strike: 23300, premium: 40, bid: 39, ask: 41, openInterest: 300000, volume: 3200000, iv: 27, delta: -0.45, score: 84, riskReward: 2.1, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 },
      ],
    });

    expect(status.orders.length).toBeGreaterThan(0);
    expect(status.tradesTaken).toBe(1);
    expect(status.limitHit).toBe(false);
    expect(status.suggestions.length).toBeGreaterThan(0);
  });

  it("stops taking fresh trades after the max trade limit and only returns suggestions", async () => {
    const trader = new AutoOptionTrader({ maxTrades: 1, minScore: 70, minRiskReward: 2 });

    const input = {
      symbol: "NIFTY",
      spot: 23200,
      candles: [
        { timestamp: "2026-09-15T09:00:00+05:30", open: 23170, high: 23210, low: 23170, close: 23190, volume: 1000 },
        { timestamp: "2026-09-15T09:05:00+05:30", open: 23190, high: 23220, low: 23185, close: 23205, volume: 1300 },
        { timestamp: "2026-09-15T09:10:00+05:30", open: 23205, high: 23255, low: 23200, close: 23230, volume: 1400 },
      ],
      contracts: [
        { symbol: "NIFTY2691523250CE", contract: "CALL", strike: 23250, premium: 72, bid: 70, ask: 74, openInterest: 500000, volume: 5000000, iv: 30, delta: 0.62, score: 90, riskReward: 2.5, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 },
      ],
    };

    await trader.tick(input);
    const status = await trader.tick({ ...input, contracts: input.contracts.map((contract) => ({ ...contract, premium: contract.premium + 1 })) });
    const repeated = await trader.tick({ ...input, contracts: input.contracts.map((contract) => ({ ...contract, premium: contract.premium + 2 })) });

    expect(status.tradesTaken).toBe(1);
    expect(status.limitHit).toBe(true);
    expect(status.suggestions.length).toBeGreaterThan(0);
    expect(status.orders.length).toBe(2);
    expect(repeated.orders.length).toBe(2);
    expect(status.orders.some((order) => order.status === "OPEN")).toBe(true);
    expect(status.orders.some((order) => order.status === "SIMULATED")).toBe(true);
  });

  it("selects a PUT when the confirmed market trend is bearish", async () => {
    const trader = new AutoOptionTrader({ minScore: 70, minRiskReward: 2 });
    const status = await trader.tick({
      symbol: "NIFTY",
      spot: 23200,
      candles: [
        { timestamp: "2026-09-15T09:00:00+05:30", open: 23240, high: 23250, low: 23220, close: 23235, volume: 1000 },
        { timestamp: "2026-09-15T09:05:00+05:30", open: 23235, high: 23240, low: 23200, close: 23210, volume: 1300 },
        { timestamp: "2026-09-15T09:10:00+05:30", open: 23210, high: 23215, low: 23160, close: 23175, volume: 1500 },
      ],
      contracts: [{ symbol: "NIFTY2691523200PE", contract: "PUT", strike: 23200, premium: 68, bid: 67, ask: 69, openInterest: 500000, volume: 5000000, iv: 30, delta: -0.62, score: 92, riskReward: 2.4, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 }],
    });

    expect(status.orders[0]?.symbol).toContain("PE");
    expect(status.suggestions[0]?.contract).toBe("PUT");
  });

  it("activates and ratchets a trailing stop, then exits on a premium pullback", async () => {
    const trader = new AutoOptionTrader({ trailingActivationR: 1, trailingDistanceR: 0.75 });
    const input = {
      symbol: "NIFTY",
      spot: 23150,
      candles: [
        { timestamp: "2026-09-15T09:00:00+05:30", open: 23120, high: 23135, low: 23110, close: 23125, volume: 1000 },
        { timestamp: "2026-09-15T09:05:00+05:30", open: 23125, high: 23145, low: 23120, close: 23140, volume: 1200 },
        { timestamp: "2026-09-15T09:10:00+05:30", open: 23140, high: 23170, low: 23135, close: 23165, volume: 1500 },
      ],
      contracts: [{ symbol: "NIFTY2691523300CE", contract: "CALL" as const, strike: 23300, premium: 52, bid: 50.5, ask: 53.5, openInterest: 450000, volume: 4500000, iv: 28, delta: 0.52, score: 91, riskReward: 2.4, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 }],
    };
    const entry = await trader.tick(input);
    const initialStop = entry.orders[0].stopLoss;
    const advanced = await trader.tick({ ...input, contracts: [{ ...input.contracts[0], premium: 70 }] });

    expect(advanced.orders[0].highWaterMark).toBe(70);
    expect(advanced.orders[0].stopLoss).toBeGreaterThan(initialStop);
    expect(advanced.orders[0].trailingActivatedAt).toBeTruthy();

    const exited = await trader.tick({ ...input, contracts: [{ ...input.contracts[0], premium: Number(advanced.orders[0].stopLoss) - 0.1 }] });
    expect(exited.orders[0].status).toBe("EXITED");
    expect(exited.orders[0].exitReason).toBe("AUTO_TRAILING_STOP");
  });

  it("exits immediately when the option premium reaches the target", async () => {
    const trader = new AutoOptionTrader();
    const input = {
      symbol: "NIFTY",
      spot: 23150,
      candles: [
        { timestamp: "2026-09-15T09:00:00+05:30", open: 23120, high: 23135, low: 23110, close: 23125, volume: 1000 },
        { timestamp: "2026-09-15T09:05:00+05:30", open: 23125, high: 23145, low: 23120, close: 23140, volume: 1200 },
        { timestamp: "2026-09-15T09:10:00+05:30", open: 23140, high: 23170, low: 23135, close: 23165, volume: 1500 },
      ],
      contracts: [{ symbol: "NIFTY2691523300CE", contract: "CALL" as const, strike: 23300, premium: 52, bid: 50.5, ask: 53.5, openInterest: 450000, volume: 4500000, iv: 28, delta: 0.52, score: 91, riskReward: 2.4, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 }],
    };
    const entry = await trader.tick(input);
    const target = Number(entry.orders[0].target);
    const exited = await trader.tick({ ...input, contracts: [{ ...input.contracts[0], premium: target }] });

    expect(exited.orders[0].status).toBe("EXITED");
    expect(exited.orders[0].exitReason).toBe("AUTO_TARGET");
    expect(exited.orders[0].exitPrice).toBe(target);
  });

  it("exits at the configured minimum loss even when reversal confirmation is still forming", async () => {
    const trader = new AutoOptionTrader({ minScore: 70, minRiskReward: 2 });
    const baseCandles = Array.from({ length: 13 }, (_, index) => ({ timestamp: `2026-09-15T09:${String(index).padStart(2, "0")}:00+05:30`, open: 23180 - index, high: 23190 - index, low: 23170 - index, close: 23180 - index, volume: 1000 }));
    const bullishCandles = [...baseCandles, { timestamp: "2026-09-15T10:05:00+05:30", open: 23168, high: 23175, low: 23160, close: 23170, volume: 1000 }, { timestamp: "2026-09-15T10:10:00+05:30", open: 23170, high: 23172, low: 23145, close: 23150, volume: 1500 }];
    const entryInput = {
      symbol: "NIFTY",
      spot: 23150,
      candles: [
        { timestamp: "2026-09-15T09:00:00+05:30", open: 23120, high: 23135, low: 23110, close: 23125, volume: 1000 },
        { timestamp: "2026-09-15T09:05:00+05:30", open: 23125, high: 23145, low: 23120, close: 23140, volume: 1200 },
        { timestamp: "2026-09-15T09:10:00+05:30", open: 23140, high: 23170, low: 23135, close: 23165, volume: 1500 },
      ],
      contracts: [{ symbol: "NIFTY2691523300CE", contract: "CALL" as const, strike: 23300, premium: 52, bid: 50, ask: 53, openInterest: 450000, volume: 4500000, iv: 28, delta: 0.52, score: 91, riskReward: 2.4, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 }],
    };
    const entry = await trader.tick(entryInput);
    entry.orders[0].stopLoss = 1;
    entry.orders[0].trailingDistance = 0;
    const losingInput = { ...entryInput, candles: bullishCandles, contracts: entryInput.contracts.map((contract) => ({ ...contract, premium: 10 })) };
    const exited = await trader.tick({ ...losingInput, settings: { maxTrades: 3, minimumLoss: 250, minimumProfit: 0 } });
    expect(exited.orders[0].status).toBe("EXITED");
    expect(exited.orders[0].exitReason).toBe("AUTO_MAX_LOSS");
    expect(exited.orders[0].realizedPnl).toBe(Math.round((10 - Number(entry.orders[0].price)) * entry.orders[0].quantity * 100) / 100);
  });
});
