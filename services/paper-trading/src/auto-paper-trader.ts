import { evaluateRisk } from "../../risk/src/risk-gate";
import type { BrokerQuote } from "../../../packages/broker-contracts/src/broker-adapter";
import type { PaperAccount, PaperOrder } from "./paper-repository";
import { PaperBrokerAdapter } from "./paper-broker-adapter";

type Candle = { open: number; high: number; low: number; close: number; volume: number; timestamp: string };
type PaperPosition = { symbol: string; side: "LONG" | "SHORT"; quantity: number; entry: number; stop: number; target: number; openedAt: string };
export type AutoPaperEvent = { type: "ENTRY" | "EXIT" | "BLOCKED" | "WAITING"; symbol: string; message: string; price: number; timestamp: string };

export type AutoPaperSettings = {
  riskPercent: number;
  minRiskReward: number;
  maxOpenPositions: number;
  maxTradesToday: number;
  lotSize: number;
  /** Ticks needed before the EMA20/VWAP trend read is meaningful. */
  minimumHistory: number;
  /** IST entry window and square-off, "HH:MM". */
  entryStartIst: string;
  entryEndIst: string;
  squareOffIst: string;
  /** Daily realised loss limit as a percentage of capital. */
  maxDailyLossPercent: number;
};

const DEFAULT_SETTINGS: AutoPaperSettings = { riskPercent: 1, minRiskReward: 2, maxOpenPositions: 2, maxTradesToday: 5, lotSize: 1, minimumHistory: 20, entryStartIst: "09:35", entryEndIst: "14:45", squareOffIst: "15:15", maxDailyLossPercent: 3 };

const istMinutes = (timestamp: string) => { const ist = new Date(Date.parse(timestamp) + 330 * 60_000); return ist.getUTCHours() * 60 + ist.getUTCMinutes(); };
const istDay = (timestamp: string) => new Date(Date.parse(timestamp) + 330 * 60_000).toISOString().slice(0, 10);
const clock = (value: string) => { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; };

/**
 * Tick-driven paper trader for the index quotes. Each tick becomes one bar built from the
 * previous tick's price to this tick's price (a quote's open/high/low are the DAY's values, so
 * they must never be used as the bar, or a stop above the morning low would trigger instantly).
 */
export class AutoPaperTrader {
  private readonly histories = new Map<string, Candle[]>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly events: AutoPaperEvent[] = [];
  private account: PaperAccount = { id: "auto-paper", capital: 100000, balance: 100000, realizedPnl: 0, orders: [] };
  private readonly paper = new PaperBrokerAdapter(this.account);
  private readonly settings: AutoPaperSettings;
  private tradeDay = "";
  private entriesToday = 0;
  private realizedToday = 0;

  constructor(settings: Partial<AutoPaperSettings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  async tick(quotes: BrokerQuote[], timestamp = new Date().toISOString()) {
    this.rollDay(timestamp);
    for (const quote of quotes.filter((item) => ["NIFTY", "BANKNIFTY", "SENSEX"].includes(item.symbol) && item.price > 0)) {
      const history = this.histories.get(quote.symbol) ?? [];
      const previousClose = history.at(-1)?.close ?? quote.price;
      const candle: Candle = { open: previousClose, high: Math.max(previousClose, quote.price), low: Math.min(previousClose, quote.price), close: quote.price, volume: quote.volume || 0, timestamp };
      const updated = [...history, candle].slice(-50);
      this.histories.set(quote.symbol, updated);
      const position = this.positions.get(quote.symbol);
      if (position) await this.manage(position, quote.price, timestamp);
      else await this.tryEntry(quote, updated, timestamp);
    }
    return this.status();
  }

  status() { return { mode: "PAPER", account: { balance: this.account.balance, realizedPnl: this.account.realizedPnl, orders: this.account.orders.length }, today: { entries: this.entriesToday, realizedPnl: Math.round(this.realizedToday * 100) / 100 }, positions: [...this.positions.values()], histories: [...this.histories.entries()].map(([symbol, candles]) => ({ symbol, candles: candles.length })), events: this.events.slice(-20), updatedAt: new Date().toISOString() }; }

  reset() {
    this.histories.clear();
    this.positions.clear();
    this.events.length = 0;
    this.account = { id: "auto-paper", capital: 100000, balance: 100000, realizedPnl: 0, orders: [] };
    this.entriesToday = 0;
    this.realizedToday = 0;
    return this.status();
  }

  private rollDay(timestamp: string) {
    const day = istDay(timestamp);
    if (day === this.tradeDay) return;
    this.tradeDay = day;
    this.entriesToday = 0;
    this.realizedToday = 0;
  }

  private async manage(position: PaperPosition, price: number, timestamp: string) {
    const long = position.side === "LONG";
    // A resting target fills at the target; a touched stop is a market order and fills at the
    // traded price, which can be worse than the stop when price gaps through it.
    if (long ? price >= position.target : price <= position.target) return this.exit(position, position.target, timestamp, "Target");
    if (long ? price <= position.stop : price >= position.stop) return this.exit(position, price, timestamp, "Stop");
    if (istMinutes(timestamp) >= clock(this.settings.squareOffIst)) return this.exit(position, price, timestamp, `${this.settings.squareOffIst} square-off`);
    return undefined;
  }

  private async tryEntry(quote: BrokerQuote, history: Candle[], timestamp: string) {
    const minutes = istMinutes(timestamp);
    if (minutes < clock(this.settings.entryStartIst) || minutes >= clock(this.settings.entryEndIst)) return this.record({ type: "WAITING", symbol: quote.symbol, message: `Outside the ${this.settings.entryStartIst}-${this.settings.entryEndIst} IST entry window`, price: quote.price, timestamp });
    if (history.length < this.settings.minimumHistory) return this.record({ type: "WAITING", symbol: quote.symbol, message: `Collecting candles (${history.length}/${this.settings.minimumHistory})`, price: quote.price, timestamp });
    const previous = history.at(-2)!;
    const current = history.at(-1)!;
    const closes = history.map((candle) => candle.close);
    const fast = this.ema(closes, 9);
    const slow = this.ema(closes, 20);
    const bullishCandle = current.close > current.open && current.close >= previous.open && current.open <= previous.close;
    const bearishCandle = current.close < current.open && current.open >= previous.close && current.close <= previous.open;
    const bullishTrend = fast > slow && current.close > this.vwap(history);
    const bearishTrend = fast < slow && current.close < this.vwap(history);
    const recent = history.slice(-14);
    const atr = recent.reduce((sum, candle) => sum + candle.high - candle.low, 0) / recent.length;
    const breakoutStep = Math.max(0.8, atr * 0.3);
    const strongBullBreak = bullishCandle && current.close >= previous.close + breakoutStep && current.high >= previous.high + breakoutStep;
    const strongBearBreak = bearishCandle && current.close <= previous.close - breakoutStep && current.low <= previous.low - breakoutStep;
    const side = bullishTrend && strongBullBreak ? "LONG" : bearishTrend && strongBearBreak ? "SHORT" : undefined;
    if (!side) return this.record({ type: "WAITING", symbol: quote.symbol, message: "Trend and candlestick confirmation not aligned", price: quote.price, timestamp });
    const riskDistance = Math.max(atr * 0.75, quote.price * 0.002);
    const stop = side === "LONG" ? quote.price - riskDistance : quote.price + riskDistance;
    const target = side === "LONG" ? quote.price + riskDistance * this.settings.minRiskReward : quote.price - riskDistance * this.settings.minRiskReward;
    const risk = evaluateRisk({ signalId: `auto-${quote.symbol}`, mode: "PAPER", capital: this.account.balance, riskPercent: this.settings.riskPercent, entry: quote.price, stop, target, candidateQuantity: 100, lotSize: this.settings.lotSize, dailyLoss: Math.max(0, -this.realizedToday), maxDailyLoss: this.account.capital * this.settings.maxDailyLossPercent / 100, openPositions: this.positions.size, maxOpenPositions: this.settings.maxOpenPositions, tradesToday: this.entriesToday, maxTradesToday: this.settings.maxTradesToday, minRiskReward: this.settings.minRiskReward, marketFreshness: "FRESH", killSwitch: false });
    if (risk.decision !== "ALLOW" || !risk.normalizedQuantity) return this.record({ type: "BLOCKED", symbol: quote.symbol, message: risk.checks.filter((check) => !check.result).map((check) => check.reason).join(" "), price: quote.price, timestamp });
    const orderSide = side === "LONG" ? "BUY" : "SELL";
    await this.paper.placeOrder({ referenceId: `AUTO-${quote.symbol}-${Date.now()}`, symbol: quote.symbol, quantity: risk.normalizedQuantity, side: orderSide, orderType: "MARKET", price: quote.price });
    const order: PaperOrder = { id: crypto.randomUUID(), symbol: quote.symbol, side: orderSide, quantity: risk.normalizedQuantity, price: quote.price, status: "FILLED" };
    this.account = { ...this.account, orders: [...this.account.orders, order] };
    this.positions.set(quote.symbol, { symbol: quote.symbol, side, quantity: risk.normalizedQuantity, entry: quote.price, stop, target, openedAt: timestamp });
    this.entriesToday += 1;
    this.record({ type: "ENTRY", symbol: quote.symbol, message: `${side} entry; trend and candle confirmed; RR ${risk.riskReward?.toFixed(2)}`, price: quote.price, timestamp });
  }

  private async exit(position: PaperPosition, price: number, timestamp: string, reason: string) {
    const pnl = position.side === "LONG" ? (price - position.entry) * position.quantity : (position.entry - price) * position.quantity;
    const side = position.side === "LONG" ? "SELL" : "BUY";
    await this.paper.placeOrder({ referenceId: `AUTO-EXIT-${position.symbol}-${Date.now()}`, symbol: position.symbol, quantity: position.quantity, side, orderType: "MARKET", price });
    this.account = { ...this.account, balance: this.account.balance + pnl, realizedPnl: this.account.realizedPnl + pnl, orders: [...this.account.orders, { id: crypto.randomUUID(), symbol: position.symbol, side, quantity: position.quantity, price, status: "FILLED" }] };
    this.realizedToday += pnl;
    this.positions.delete(position.symbol);
    this.record({ type: "EXIT", symbol: position.symbol, message: `${reason} exit; PnL ${pnl.toFixed(2)}`, price, timestamp });
  }

  private record(event: AutoPaperEvent) { this.events.push(event); if (this.events.length > 100) this.events.shift(); }
  private ema(values: number[], period: number) { const multiplier = 2 / (period + 1); return values.slice(1).reduce((result, value) => (value - result) * multiplier + result, values[0]); }
  private vwap(candles: Candle[]) { const volume = candles.reduce((sum, candle) => sum + candle.volume, 0); return volume ? candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0) / volume : candles.at(-1)!.close; }
}
