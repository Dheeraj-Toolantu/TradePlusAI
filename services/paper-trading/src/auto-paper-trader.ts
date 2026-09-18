import { evaluateRisk } from "../../risk/src/risk-gate";
import type { BrokerQuote } from "../../../packages/broker-contracts/src/broker-adapter";
import type { PaperAccount, PaperOrder } from "./paper-repository";
import { PaperBrokerAdapter } from "./paper-broker-adapter";

type Candle = { open: number; high: number; low: number; close: number; volume: number; timestamp: string };
type PaperPosition = { symbol: string; side: "LONG" | "SHORT"; quantity: number; entry: number; stop: number; target: number; openedAt: string };
export type AutoPaperEvent = { type: "ENTRY" | "EXIT" | "BLOCKED" | "WAITING"; symbol: string; message: string; price: number; timestamp: string };

export class AutoPaperTrader {
  private readonly histories = new Map<string, Candle[]>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly events: AutoPaperEvent[] = [];
  private account: PaperAccount = { id: "auto-paper", capital: 100000, balance: 100000, realizedPnl: 0, orders: [] };
  private readonly paper = new PaperBrokerAdapter(this.account);

  constructor(private readonly settings = { riskPercent: 1, minRiskReward: 2, maxOpenPositions: 2, maxTradesToday: 5, lotSize: 1, minimumHistory: 3 }) {}

  async tick(quotes: BrokerQuote[], timestamp = new Date().toISOString()) {
    for (const quote of quotes.filter((item) => ["NIFTY", "BANKNIFTY", "SENSEX"].includes(item.symbol) && item.price > 0)) {
      const candle = { open: quote.open || quote.price, high: Math.max(quote.high || quote.price, quote.price), low: Math.min(quote.low || quote.price, quote.price), close: quote.price, volume: quote.volume || 0, timestamp };
      const history = [...(this.histories.get(quote.symbol) ?? []), candle].slice(-50);
      this.histories.set(quote.symbol, history);
      const position = this.positions.get(quote.symbol);
      if (position && ((position.side === "LONG" && (candle.low <= position.stop || candle.high >= position.target)) || (position.side === "SHORT" && (candle.high >= position.stop || candle.low <= position.target)))) await this.exit(position, quote.price, timestamp);
      else if (!position) await this.tryEntry(quote, history, timestamp);
    }
    return this.status();
  }

  status() { return { mode: "PAPER", account: { balance: this.account.balance, realizedPnl: this.account.realizedPnl, orders: this.account.orders.length }, positions: [...this.positions.values()], histories: [...this.histories.entries()].map(([symbol, candles]) => ({ symbol, candles: candles.length })), events: this.events.slice(-20), updatedAt: new Date().toISOString() }; }

  reset() {
    this.histories.clear();
    this.positions.clear();
    this.events.length = 0;
    this.account = { id: "auto-paper", capital: 100000, balance: 100000, realizedPnl: 0, orders: [] };
    return this.status();
  }

  private async tryEntry(quote: BrokerQuote, history: Candle[], timestamp: string) {
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
    const atr = history.slice(-14).reduce((sum, candle) => sum + candle.high - candle.low, 0) / 14;
    const breakoutStep = Math.max(0.8, atr * 0.3);
    const earlyWarmup = history.length <= 3 && current.close >= previous.close && current.close > history[0].close;
    const strongBullBreak = bullishCandle && history.length > 3 && current.close >= previous.close + breakoutStep && current.high >= previous.high + breakoutStep;
    const strongBearBreak = bearishCandle && history.length > 3 && current.close <= previous.close - breakoutStep && current.low <= previous.low - breakoutStep;
    const confirmedSide = (bullishTrend && strongBullBreak) || earlyWarmup ? "LONG" : (bearishTrend && strongBearBreak) ? "SHORT" : undefined;
    const side = confirmedSide;
    if (!side) return this.record({ type: "WAITING", symbol: quote.symbol, message: "Trend and candlestick confirmation not aligned", price: quote.price, timestamp });
    const riskDistance = Math.max(atr * 0.75, quote.price * 0.002);
    const stop = side === "LONG" ? quote.price - riskDistance : quote.price + riskDistance;
    const target = side === "LONG" ? quote.price + riskDistance * this.settings.minRiskReward : quote.price - riskDistance * this.settings.minRiskReward;
    const risk = evaluateRisk({ signalId: `auto-${quote.symbol}`, mode: "PAPER", capital: this.account.balance, riskPercent: this.settings.riskPercent, entry: quote.price, stop, target, candidateQuantity: 100, lotSize: this.settings.lotSize, dailyLoss: Math.max(0, -this.account.realizedPnl), maxDailyLoss: this.account.capital * 0.03, openPositions: this.positions.size, maxOpenPositions: this.settings.maxOpenPositions, tradesToday: this.account.orders.length, maxTradesToday: this.settings.maxTradesToday, minRiskReward: this.settings.minRiskReward, marketFreshness: "FRESH", killSwitch: false });
    if (risk.decision !== "ALLOW" || !risk.normalizedQuantity) return this.record({ type: "BLOCKED", symbol: quote.symbol, message: risk.checks.filter((check) => !check.result).map((check) => check.reason).join(" "), price: quote.price, timestamp });
    const orderSide = side === "LONG" ? "BUY" : "SELL";
    await this.paper.placeOrder({ referenceId: `AUTO-${quote.symbol}-${Date.now()}`, symbol: quote.symbol, quantity: risk.normalizedQuantity, side: orderSide, orderType: "MARKET", price: quote.price });
    this.account = { ...this.account, orders: [...this.account.orders, { id: crypto.randomUUID(), symbol: quote.symbol, side: orderSide, quantity: risk.normalizedQuantity, price: quote.price, status: "FILLED" }] };
    this.positions.set(quote.symbol, { symbol: quote.symbol, side, quantity: risk.normalizedQuantity, entry: quote.price, stop, target, openedAt: timestamp });
    this.record({ type: "ENTRY", symbol: quote.symbol, message: `${side} entry${confirmedSide ? "; trend and candle confirmed" : "; momentum paper signal"}; RR ${risk.riskReward?.toFixed(2)}`, price: quote.price, timestamp });
  }

  private async exit(position: PaperPosition, price: number, timestamp: string) { const pnl = position.side === "LONG" ? (price - position.entry) * position.quantity : (position.entry - price) * position.quantity; const side = position.side === "LONG" ? "SELL" : "BUY"; await this.paper.placeOrder({ referenceId: `AUTO-EXIT-${position.symbol}-${Date.now()}`, symbol: position.symbol, quantity: position.quantity, side, orderType: "MARKET", price }); this.account = { ...this.account, balance: this.account.balance + pnl, realizedPnl: this.account.realizedPnl + pnl, orders: [...this.account.orders, { id: crypto.randomUUID(), symbol: position.symbol, side, quantity: position.quantity, price, status: "FILLED" }] }; this.positions.delete(position.symbol); this.record({ type: "EXIT", symbol: position.symbol, message: `${pnl >= 0 ? "Target" : "Stop"} exit; PnL ${pnl.toFixed(2)}`, price, timestamp }); }
  private record(event: AutoPaperEvent) { this.events.push(event); if (this.events.length > 100) this.events.shift(); }
  private ema(values: number[], period: number) { const multiplier = 2 / (period + 1); return values.slice(1).reduce((result, value) => (value - result) * multiplier + result, values[0]); }
  private vwap(candles: Candle[]) { const volume = candles.reduce((sum, candle) => sum + candle.volume, 0); return volume ? candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0) / volume : candles.at(-1)!.close; }
}