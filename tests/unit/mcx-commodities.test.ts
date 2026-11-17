import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowwInstrumentCatalog, type GrowwInstrument } from "../../adapters/groww/src/groww-instruments";
import { contractBySymbol, derivativesIn, nearestFuture, nearestOptionExpiry } from "../../apps/web/lib/underlying-catalog";
import { entryOpen, isCommodity, sessionFor } from "../../apps/web/lib/underlyings";
import { SmartScalper, valueOption, type PositionView, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { ensureVwapAutoTrader, resetVwapAutoTrader, setVwapAutoTrader, vwapAutoTraderStatus, vwapAutoTraderTick, type AutoTraderConfig, type AutoTraderDeps } from "../../apps/web/lib/vwap-auto-trader";

// Catalog rows shaped like Groww's instrument CSV. The MCX segment name and symbol format are
// deliberately arbitrary here: the code must take them from the rows, not assume them.
const row = (r: Partial<GrowwInstrument> & { tradingSymbol: string }): GrowwInstrument => ({ exchange: "MCX", exchangeToken: r.tradingSymbol, growwSymbol: `G-${r.tradingSymbol}`, segment: "COMMODITY", ...r });
const catalog = new GrowwInstrumentCatalog([
  row({ tradingSymbol: "CRUDEOIL25DECFUT", underlyingSymbol: "CRUDEOIL", instrumentType: "FUT", expiryDate: "2026-12-18", lotSize: 100 }),
  row({ tradingSymbol: "CRUDEOIL25NOVFUT", underlyingSymbol: "CRUDEOIL", instrumentType: "FUT", expiryDate: "2026-11-19", lotSize: 100 }),
  row({ tradingSymbol: "CRUDEOIL25NOV5500CE", underlyingSymbol: "CRUDEOIL", instrumentType: "CE", expiryDate: "2026-11-17", strikePrice: 5500, lotSize: 100 }),
  row({ tradingSymbol: "CRUDEOIL25DEC5500CE", underlyingSymbol: "CRUDEOIL", instrumentType: "CE", expiryDate: "2026-12-16", strikePrice: 5500, lotSize: 100 }),
  row({ tradingSymbol: "CRUDEOILM25NOV5500CE", underlyingSymbol: "CRUDEOILM", instrumentType: "CE", expiryDate: "2026-11-17", strikePrice: 5500, lotSize: 10 }),
  row({ tradingSymbol: "GOLDM25DEC130000CE", underlyingSymbol: "GOLDM", instrumentType: "CE", expiryDate: "2026-11-25", strikePrice: 130000, lotSize: 10 }),
  { exchange: "NSE", exchangeToken: "n1", tradingSymbol: "NIFTY25N2524000CE", growwSymbol: "G-N1", segment: "FNO", underlyingSymbol: "NIFTY", instrumentType: "CE", expiryDate: "2026-11-25", strikePrice: 24000, lotSize: 65 },
]);

describe("MCX contracts come from the Groww catalog", () => {
  it("resolves exchange, segment, options and futures for crude oil without picking up the mini contract", () => {
    const d = derivativesIn(catalog, "CRUDEOIL");
    expect(d).toMatchObject({ exchange: "MCX", segment: "COMMODITY" });
    expect(d.options.map((item) => item.tradingSymbol).sort()).toEqual(["CRUDEOIL25DEC5500CE", "CRUDEOIL25NOV5500CE"]);
    expect(nearestOptionExpiry(d, "2026-11-17")).toBe("2026-11-17");
    // The tape is the nearest future that has not expired today.
    expect(nearestFuture(d, "2026-11-17")?.tradingSymbol).toBe("CRUDEOIL25NOVFUT");
    expect(nearestFuture(d, "2026-11-19")?.tradingSymbol).toBe("CRUDEOIL25DECFUT");
  });

  it("says plainly when the account's catalog lists no contracts, instead of guessing (GOLDM is not GOLD)", () => {
    expect(() => derivativesIn(catalog, "GOLD")).toThrow(/no MCX GOLD contracts/);
  });

  it("finds an option leg on any exchange, and index underlyings keep their NSE rules", () => {
    expect(contractBySymbol(catalog, "CRUDEOIL25NOV5500CE")).toMatchObject({ exchange: "MCX", segment: "COMMODITY" });
    expect(derivativesIn(catalog, "NIFTY")).toMatchObject({ exchange: "NSE", segment: "FNO" });
  });

  it("knows each market's session", () => {
    expect(isCommodity("GOLD")).toBe(true);
    expect(isCommodity("NIFTY")).toBe(false);
    const evening = new Date("2026-11-17T20:30:00+05:30").getTime();
    expect(entryOpen("CRUDEOIL", evening)).toBe(true);
    expect(entryOpen("NIFTY", evening)).toBe(false);
    expect(entryOpen("CRUDEOIL", new Date("2026-11-17T22:50:00+05:30").getTime())).toBe(false);
    expect(sessionFor("GOLD").squareOff).toBe(23 * 60);
  });
});

const crude = (premium = 120): ScalperContract => ({ symbol: "CRUDEOIL25NOV5500CE", contract: "CALL", expiry: "2026-11-17", strike: 5500, premium, bid: premium - 0.5, ask: premium + 0.5, openInterest: 1, volume: 1, iv: 35, delta: 0.5, theta: -20, lotSize: 100, tickSize: 0.1 });
const plan = (item: ScalperContract): ScalperPlan => ({
  kind: "SCALP", side: "CE", legs: [{ symbol: item.symbol, contract: "CALL", strike: item.strike, side: "BUY", price: item.ask, valuation: valueOption(item, 5500) }],
  lots: 1, quantity: 100, entry: item.ask, stop: item.ask - 6, target: item.ask + 12, riskPerLot: 600, rewardPerLot: 1200, riskReward: 2,
  spot: { entry: 5500, stop: 5480, target: 5540 }, reason: "VWAP-EMA on crude", trail: { rule: "VWAP_EMA", costPerUnit: 0.3 },
});

describe("Smart Scalper sessions per underlying", () => {
  it("takes a crude oil trade in the evening and squares it off at 23:00, not 15:15", async () => {
    let now = new Date("2026-11-17T22:40:00+05:30"); // inside the 22:45 entry cutoff
    const book = new SmartScalper({ now: () => now, hydrate: false });
    const placed = await book.place("CRUDEOIL", plan(crude()), [crude()], { setupId: "c1", settings: { maxLossPerTrade: 5000 } });
    expect(placed.placed).toBe(true);
    now = new Date("2026-11-17T22:45:00+05:30"); // still open: past 15:15, before 23:00 (and inside the 12-min scalp time stop)
    const early = (await book.manage({ symbol: "CRUDEOIL", spot: 5505, bars: [], contracts: [crude(121)] })).exited;
    expect(early.map((item) => item.exitReason)).toEqual([]);
    now = new Date("2026-11-17T23:00:00+05:30");
    expect((await book.manage({ symbol: "CRUDEOIL", spot: 5505, bars: [], contracts: [crude(121)] })).exited[0]).toMatchObject({ exitReason: "SQUARE_OFF_23_00" });
  });

  it("refuses an index entry after its 15:15 square-off while a commodity is still open for entries", async () => {
    const now = new Date("2026-11-17T16:00:00+05:30");
    const book = new SmartScalper({ now: () => now, hydrate: false });
    const nifty = { ...crude(), symbol: "NIFTY25N2524000CE", strike: 24000, lotSize: 65 };
    const refused = await book.place("NIFTY", { ...plan(nifty), quantity: 65 }, [nifty], { setupId: "n1" });
    expect(refused).toMatchObject({ placed: false });
    expect(refused.error).toMatch(/NIFTY are open 09:15-15:15/);
    expect((await book.place("CRUDEOIL", plan(crude()), [crude()], { setupId: "c2", settings: { maxLossPerTrade: 5000 } })).placed).toBe(true);
  });
});

describe("auto-trader keeps each underlying inside its own session", () => {
  afterEach(() => resetVwapAutoTrader());

  it("in the evening it runs crude oil and gold and skips NIFTY", async () => {
    let saved: AutoTraderConfig | null = null;
    const place = vi.fn(async () => ({ status: 403, body: { placed: false, error: "V5 no-trade gate: the scalp is not confirmed on the server.", reasons: ["RETEST_NOT_CONFIRMED"] } as Record<string, unknown> }));
    const deps: AutoTraderDeps = { place, openTrade: async () => null as PositionView | null, now: () => new Date("2026-11-17T20:30:00+05:30").getTime(), load: async () => saved, save: async (config) => { saved = structuredClone(config); } };
    ensureVwapAutoTrader("http://test", deps);
    for (const index of ["NIFTY", "CRUDEOIL", "GOLD"]) await setVwapAutoTrader({ index, enabled: true });
    await vwapAutoTraderTick();
    expect(place.mock.calls.map((call) => (call as unknown as [{ underlying: string }])[0].underlying)).toEqual(["CRUDEOIL", "GOLD"]);
    expect(vwapAutoTraderStatus().lastByIndex.NIFTY.text).toMatch(/09:15-15:15 IST/);
  });

  it("the NIFTY Sniper stays NIFTY only", async () => {
    ensureVwapAutoTrader("http://test", { place: vi.fn(), openTrade: async () => null, now: () => Date.now(), load: async () => null, save: async () => undefined });
    await expect(setVwapAutoTrader({ index: "CRUDEOIL", enabled: true, strategy: "NIFTY_SNIPER" })).rejects.toThrow(/NIFTY only/);
  });
});
