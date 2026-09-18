import type { MarketCandle } from "../../../packages/domain-contracts/src/entities";
import { MarketRepository } from "./market-repository";
import type { Quote } from "./market-feed";

export class MarketDataService {
  constructor(private readonly repository = new MarketRepository()) {}
  snapshot(quotes: Quote[], candles: MarketCandle[]) { candles.forEach((candle) => this.repository.saveCandle(candle)); return { quotes, candles, updatedAt: new Date().toISOString() }; }
}