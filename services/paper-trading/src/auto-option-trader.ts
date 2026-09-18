import { getActiveOrdersFromFirestore, saveOrderToFirestore, type OrderRecord } from "../../../apps/web/lib/firestore-orders";

type Candle = { timestamp: string; open: number; high: number; low: number; close: number; volume: number };
type Contract = {
  symbol: string;
  contract: "CALL" | "PUT";
  expiry: string;
  strike: number;
  premium: number;
  bid: number;
  ask: number;
  openInterest: number;
  volume: number;
  iv: number;
  delta: number;
  score: number;
  riskReward: number;
  lotSize: number;
  tickSize: number;
  freezeQuantity: number;
};

type EngineInput = {
  symbol: string;
  spot: number;
  candles: Candle[];
  contracts: Contract[];
  settings?: AutoOptionTraderSettings;
};

export type AutoOptionTraderSettings = {
  maxTrades: number;
  minimumLoss: number;
  minimumProfit: number;
};

const normalizeSymbol = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

type AutoTradeSuggestion = {
  symbol: string;
  side: "BUY" | "SELL";
  contract: "CALL" | "PUT";
  strike: number;
  expiry: string;
  entry: number;
  stopLoss: number;
  target: number;
  quantity: number;
  score: number;
  riskReward: number;
  reason: string;
  timestamp: string;
};

export type AutoOptionTraderConfig = {
  maxTrades: number;
  minScore: number;
  minRiskReward: number;
  maxOpenPositions?: number;
  trailingActivationR?: number;
  trailingDistanceR?: number;
};

export class AutoOptionTrader {
  private readonly orders: OrderRecord[] = [];
  private readonly active = new Map<string, OrderRecord>();
  private readonly suggestionOrders = new Map<string, OrderRecord>();
  private readonly suggestions: AutoTradeSuggestion[] = [];
  private readonly config: Required<AutoOptionTraderConfig>;
  private tradedToday = 0;
  private tradeDate = new Date().toISOString().slice(0, 10);
  private lastDiagnostics: string[] = [];
  private activeOrdersHydrated = false;
  private tickQueue: Promise<void> = Promise.resolve();
  private lossExitConfirmations = new Map<string, { count: number; candleTimestamp: string }>();
  private readonly maxLossPerPosition = 2500;

  constructor(config: Partial<AutoOptionTraderConfig> = {}) {
    this.config = {
      maxTrades: config.maxTrades ?? 3,
      minScore: config.minScore ?? 75,
      minRiskReward: config.minRiskReward ?? 2,
      maxOpenPositions: config.maxOpenPositions ?? 3,
      trailingActivationR: config.trailingActivationR ?? 1,
      trailingDistanceR: config.trailingDistanceR ?? 0.75,
    };
  }

  async tick(input: EngineInput) {
    let release!: () => void;
    const previousTick = this.tickQueue;
    this.tickQueue = new Promise<void>((resolve) => { release = resolve; });
    await previousTick;
    try {
      return await this.tickInternal(input);
    } finally {
      release();
    }
  }

  private async tickInternal(input: EngineInput) {
    const settings = this.settingsFor(input.settings);
    await this.hydrateActiveOrders();
    const currentDate = new Date().toISOString().slice(0, 10);
    if (currentDate !== this.tradeDate) {
      this.tradeDate = currentDate;
      this.tradedToday = 0;
    }
    const timestamp = new Date().toISOString();
    await this.updateExits(input, timestamp, settings);
    const limitHit = this.tradedToday >= settings.maxTrades;
    const trend = this.detectTrend(input.candles);
    this.lastDiagnostics = input.contracts.slice(0, 20).map((contract) => {
      const failures: string[] = [];
      if (contract.score < this.config.minScore) failures.push(`score ${contract.score}<${this.config.minScore}`);
      if (contract.riskReward < this.config.minRiskReward) failures.push(`RR ${contract.riskReward}<${this.config.minRiskReward}`);
      if (contract.lotSize <= 0) failures.push("missing lot size");
      if (!((contract.contract === "CALL" && trend === "BULLISH") || (contract.contract === "PUT" && trend === "BEARISH"))) failures.push(`trend ${trend} does not confirm ${contract.contract}`);
      if (!this.contractIsNearAtm(contract, input.spot)) failures.push(`delta/ATM filter failed (strike ${contract.strike}, delta ${contract.delta})`);
      return `${contract.contract} ${contract.symbol}: ${failures.length ? failures.join("; ") : "eligible"}`;
    });
    const eligible = input.contracts
      .filter((contract) => contract.score >= this.config.minScore)
      .filter((contract) => contract.riskReward >= this.config.minRiskReward)
      .filter((contract) => contract.lotSize > 0)
      .filter((contract) => this.active.size < settings.maxTrades || this.active.has(normalizeSymbol(contract.symbol)))
      .filter((contract) => limitHit || !this.active.has(normalizeSymbol(contract.symbol)))
      .map((contract) => this.buildSuggestion(input.symbol, input.spot, input.candles, contract, timestamp))
      .filter((suggestion): suggestion is AutoTradeSuggestion => suggestion !== null);

    if (eligible.length === 0) {
      return {
        mode: "PAPER",
        limitHit,
        tradesTaken: this.tradedToday,
        orders: [...this.orders],
        suggestions: [...this.suggestions],
        diagnostics: this.lastDiagnostics,
        summary: `No eligible auto-trade for ${input.symbol} yet. ${this.lastDiagnostics[0] ?? "Market confirmation is still forming."}`,
      };
    }

    const winner = eligible.sort((a, b) => b.score - a.score)[0];
    if (limitHit) {
      this.suggestions.push(winner);
      const suggestionKey = `${this.tradeDate}:${winner.symbol}`;
      const suggestionOrder = this.orderFromSuggestion(winner, timestamp, suggestionKey);
      const previousSuggestion = this.suggestionOrders.get(suggestionKey);
      if (previousSuggestion) Object.assign(previousSuggestion, suggestionOrder, { id: previousSuggestion.id, status: "SIMULATED" });
      else {
        this.suggestionOrders.set(suggestionKey, suggestionOrder);
        this.orders.push(suggestionOrder);
      }
      void saveOrderToFirestore(previousSuggestion ?? suggestionOrder);
      return {
        mode: "PAPER",
        limitHit: true,
        tradesTaken: this.tradedToday,
        orders: [...this.orders],
        suggestions: [...this.suggestions],
        diagnostics: this.lastDiagnostics,
        summary: `Auto trade cap reached. ${winner.symbol} suggested only.`,
      };
    }

    const quantity = winner.quantity;
    const orderKey = `${this.tradeDate}:${normalizeSymbol(winner.symbol)}`;
    const existingOrder = this.orders.find((candidate) => candidate.id === `auto-${orderKey}`);
    if (existingOrder && ["OPEN", "FILLED"].includes(existingOrder.status)) {
      return {
        mode: "PAPER",
        limitHit: this.tradedToday >= settings.maxTrades,
        tradesTaken: this.tradedToday,
        orders: [...this.orders],
        suggestions: [...this.suggestions],
        diagnostics: this.lastDiagnostics,
        summary: `Duplicate entry blocked for ${winner.symbol}; existing trade remains active.`,
      };
    }

    const initialRisk = Math.max(winner.entry - winner.stopLoss, 0.01);
    const order: OrderRecord = {
      id: `auto-${orderKey}`,
      strategy: "AUTO_OPTION_ENGINE",
      strategyName: "Auto Option Engine",
      symbol: winner.symbol,
      growwSymbol: winner.symbol,
      expiry: winner.expiry,
      side: "BUY",
      quantity,
      lotSize: winner.quantity,
      price: winner.entry,
      target: winner.target,
      stopLoss: winner.stopLoss,
      minimumLossExitPrice: winner.stopLoss,
      maxProfitToTrail: Math.max(winner.entry + initialRisk * this.config.trailingActivationR, winner.entry + Math.max(winner.target - winner.entry, 0) * 0.5),
      highWaterMark: winner.entry,
      trailingStop: winner.stopLoss,
      trailingDistance: Math.round((winner.entry - winner.stopLoss) * this.config.trailingDistanceR * 100) / 100,
      status: "OPEN",
      mode: "PAPER",
      source: "Auto option engine",
      createdAt: timestamp,
    };

    this.orders.push(order);
    this.active.set(normalizeSymbol(winner.symbol), order);
    this.tradedToday += 1;
    this.suggestions.push(winner);
    void saveOrderToFirestore(order);

    return {
      mode: "PAPER",
      limitHit: this.tradedToday >= settings.maxTrades,
      tradesTaken: this.tradedToday,
      orders: [...this.orders],
      suggestions: [...this.suggestions],
      diagnostics: this.lastDiagnostics,
      summary: `Auto trade placed: ${winner.symbol} ${winner.contract} at ${winner.entry}.`,
    };
  }

  private orderFromSuggestion(suggestion: AutoTradeSuggestion, timestamp: string, suggestionKey: string): OrderRecord {
    return {
      id: `suggestion-${suggestionKey.replaceAll(/[^a-zA-Z0-9:-]/g, "-")}`,
      strategy: "AUTO_OPTION_ENGINE",
      strategyName: "Auto Option Engine",
      symbol: suggestion.symbol,
      growwSymbol: suggestion.symbol,
      expiry: suggestion.expiry,
      side: "BUY",
      quantity: suggestion.quantity,
      lotSize: suggestion.quantity,
      price: suggestion.entry,
      target: suggestion.target,
      stopLoss: suggestion.stopLoss,
      status: "SIMULATED",
      mode: "PAPER",
      source: "Auto option engine · suggestion only (trade cap reached)",
      createdAt: timestamp,
    };
  }

  private async updateExits(input: EngineInput, timestamp: string, settings: AutoOptionTraderSettings) {
    for (const [symbol, order] of this.active) {
      const contract = input.contracts.find((item) => normalizeSymbol(item.symbol) === symbol);
      if (!contract) continue;
      const entry = Number(order.price);
      const currentStop = Number(order.stopLoss);
      const storedTrailDistance = Number(order.trailingDistance);
      const initialRisk = storedTrailDistance > 0 && this.config.trailingDistanceR > 0
        ? storedTrailDistance / this.config.trailingDistanceR
        : entry - currentStop;
      const initialStop = entry - initialRisk;
      const highWaterMark = Math.max(Number(order.highWaterMark ?? entry), contract.premium);
      const minimumProfitPrice = entry + settings.minimumProfit / Math.max(order.quantity, 1);
      const activationPrice = Math.max(entry + initialRisk * this.config.trailingActivationR, minimumProfitPrice);
      const trailDistance = Number(order.trailingDistance ?? initialRisk * this.config.trailingDistanceR);
      const trailingStop = highWaterMark >= activationPrice
        ? Math.max(initialStop, highWaterMark - trailDistance)
        : initialStop;
      const stopMoved = trailingStop > currentStop;
      order.currentPrice = contract.premium;
      order.pnl = Math.round((contract.premium - entry) * order.quantity * 100) / 100;
      order.pnlPercent = entry ? Math.round((contract.premium - entry) / entry * 10000) / 100 : 0;
      order.quoteSource = "Groww real-time F&O quote";
      if (stopMoved || highWaterMark > Number(order.highWaterMark ?? entry)) {
        order.highWaterMark = highWaterMark;
        order.maxProfitToTrail = Math.max(Number(order.maxProfitToTrail ?? entry), highWaterMark);
        order.trailingDistance = trailDistance;
        order.trailingStop = trailingStop;
        order.stopLoss = trailingStop;
        if (highWaterMark >= activationPrice && !order.trailingActivatedAt) order.trailingActivatedAt = timestamp;
      }
      if (Number.isFinite(initialStop) && (!Number.isFinite(Number(order.minimumLossExitPrice)) || Number(order.minimumLossExitPrice) > initialStop)) {
        order.minimumLossExitPrice = initialStop;
      }
      void saveOrderToFirestore(order);
      const pnl = (contract.premium - entry) * order.quantity;
      const lossExitConfirmed = this.confirmLossExit(order, contract, input.candles);
      const hitTarget = contract.premium >= Number(order.target);
      const hitStop = contract.premium <= trailingStop;
      const hitLossProtection = pnl <= -settings.minimumLoss;
      if (!hitTarget && !hitStop && !hitLossProtection) continue;
      const updates: Partial<OrderRecord> = {
        status: "EXITED",
        exitPrice: contract.premium,
        exitAt: timestamp,
        exitReason: hitTarget ? "AUTO_TARGET" : hitLossProtection ? (lossExitConfirmed ? "AUTO_MAX_LOSS_CONFIRMED_REVERSAL" : "AUTO_MAX_LOSS") : stopMoved || order.trailingActivatedAt ? "AUTO_TRAILING_STOP" : "AUTO_STOP_LOSS",
        realizedPnl: Math.round(pnl * 100) / 100,
      };
      Object.assign(order, updates);
      this.active.delete(symbol);
      this.lossExitConfirmations.delete(symbol);
      void saveOrderToFirestore({ ...order, ...updates });
    }
  }

  private settingsFor(settings?: AutoOptionTraderSettings): AutoOptionTraderSettings {
    return {
      maxTrades: Math.max(1, Math.min(10, Math.floor(Number(settings?.maxTrades) || this.config.maxTrades))),
      minimumLoss: Math.max(0, Number(settings?.minimumLoss) || this.maxLossPerPosition),
      minimumProfit: Math.max(0, Number(settings?.minimumProfit) || 0),
    };
  }

  private confirmLossExit(order: OrderRecord, contract: Contract, candles: Candle[]) {
    const symbol = normalizeSymbol(order.symbol);
    if (candles.length < 15) {
      this.lossExitConfirmations.delete(symbol);
      return false;
    }
    const recent = candles.slice(-15);
    const closes = recent.map((candle) => candle.close);
    const fast = this.ema(closes, Math.min(9, closes.length));
    const slow = this.ema(closes, Math.min(20, closes.length));
    const totalVolume = recent.reduce((sum, candle) => sum + candle.volume, 0);
    const averageVolume = totalVolume / recent.length;
    const latest = recent.at(-1)!;
    const previous = recent.at(-2)!;
    const vwap = totalVolume > 0 ? recent.reduce((sum, candle) => sum + candle.close * candle.volume, 0) / totalVolume : closes.reduce((sum, close) => sum + close, 0) / closes.length;
    const isCall = /CE$/.test(symbol) || contract.contract === "CALL";
    const oppositeTrend = isCall ? fast < slow && latest.close < vwap : fast > slow && latest.close > vwap;
    const candleReversal = isCall
      ? latest.close < latest.open && latest.close < previous.close && latest.high <= previous.high
      : latest.close > latest.open && latest.close > previous.close && latest.low >= previous.low;
    const volumeConfirmed = averageVolume <= 0 || latest.volume >= averageVolume * 1.2;
    const deltaConfirmed = Math.abs(contract.delta) >= 0.35;
    const chainConfirmed = contract.score >= this.config.minScore && contract.riskReward >= this.config.minRiskReward;
    const confirmations = [oppositeTrend, candleReversal, volumeConfirmed, deltaConfirmed, chainConfirmed].filter(Boolean).length;
    const prior = this.lossExitConfirmations.get(symbol);
    if (confirmations < 4) {
      this.lossExitConfirmations.delete(symbol);
      return false;
    }
    if (prior?.candleTimestamp === latest.timestamp) return prior.count >= 2;
    const next = (prior?.count ?? 0) + 1;
    this.lossExitConfirmations.set(symbol, { count: next, candleTimestamp: latest.timestamp });
    return next >= 2;
  }

  private async hydrateActiveOrders() {
    if (this.activeOrdersHydrated) return;
    this.activeOrdersHydrated = true;
    const persisted = await getActiveOrdersFromFirestore();
    for (const order of persisted) {
      if (order.strategy !== "AUTO_OPTION_ENGINE" || !["OPEN", "FILLED"].includes(order.status)) continue;
      const symbol = normalizeSymbol(order.symbol);
      if (this.active.has(symbol)) continue;
      const entry = Number(order.price);
      const stop = Number(order.stopLoss);
      if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= stop) continue;
      const risk = entry - stop;
      order.highWaterMark = Number(order.highWaterMark ?? entry);
      order.trailingStop = Number(order.trailingStop ?? stop);
      order.trailingDistance = Number(order.trailingDistance ?? risk * this.config.trailingDistanceR);
      this.active.set(symbol, order);
      if (!this.orders.some((current) => current.id === order.id)) this.orders.push(order);
    }
  }

  private buildSuggestion(symbol: string, spot: number, candles: Candle[], contract: Contract, timestamp: string): AutoTradeSuggestion | null {
    const price = contract.premium;
    const trend = this.detectTrend(candles);
    const contractMatchesTrend = (contract.contract === "CALL" && trend === "BULLISH") || (contract.contract === "PUT" && trend === "BEARISH");
    if (!contractMatchesTrend || !this.contractIsNearAtm(contract, spot)) return null;

    const stopLoss = contract.contract === "CALL" ? Math.max(price * 0.82, 0.05) : Math.max(price * 0.82, 0.05);
    const target = price + Math.max(contract.premium * 0.9, 5);
    const quantity = Math.max(Math.round(contract.lotSize || 65), 1);

    return {
      symbol: contract.symbol,
      side: contract.contract === "CALL" ? "BUY" : "BUY",
      contract: contract.contract,
      strike: contract.strike,
      expiry: contract.expiry,
      entry: price,
      stopLoss,
      target,
      quantity,
      score: contract.score,
      riskReward: contract.riskReward,
      reason: `${contract.contract} confirmed by score ${contract.score} and risk-reward ${contract.riskReward}.`,
      timestamp,
    };
  }

  private contractIsNearAtm(contract: Contract, spot: number) {
    const distance = Math.abs(contract.strike - spot);
    const normalizedDistance = distance / Math.max(spot, 1);
    return Math.abs(contract.delta) > 0.35 && normalizedDistance < 0.012;
  }

  private detectTrend(candles: Candle[]) {
    if (candles.length < 3) return "UNKNOWN";
    const closes = candles.map((candle) => candle.close);
    const fast = this.ema(closes, Math.max(2, Math.min(9, closes.length - 1)));
    const slow = this.ema(closes, Math.min(20, closes.length));
    const volume = candles.reduce((sum, candle) => sum + candle.volume, 0);
    const vwap = volume > 0 ? candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0) / volume : closes.at(-1)!;
    const last = candles.at(-1)!;
    const previous = candles.at(-2)!;
    const bullishVotes = [fast > slow, last.close > vwap, last.close > previous.close].filter(Boolean).length;
    const bearishVotes = [fast < slow, last.close < vwap, last.close < previous.close].filter(Boolean).length;
    if (bullishVotes >= 2 && last.close >= last.open) return "BULLISH";
    if (bearishVotes >= 2 && last.close <= last.open) return "BEARISH";
    if (bullishVotes >= 2 && bearishVotes === 0) return "BULLISH";
    if (bearishVotes >= 2 && bullishVotes === 0) return "BEARISH";
    return "UNKNOWN";
  }

  private ema(values: number[], period: number) {
    const multiplier = 2 / (period + 1);
    return values.slice(1).reduce((result, value) => (value - result) * multiplier + result, values[0]);
  }
}
