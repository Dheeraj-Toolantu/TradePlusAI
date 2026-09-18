import type { Instrument, MarketCandle, OptionSnapshot } from "../../../packages/domain-contracts/src/entities";

export class MarketRepository {
  private readonly instruments = new Map<string, Instrument>();
  private readonly candles: MarketCandle[] = [];
  private readonly options: OptionSnapshot[] = [];

  saveInstrument(instrument: Instrument) { this.instruments.set(instrument.id, instrument); return instrument; }
  saveCandle(candle: MarketCandle) { this.candles.push(candle); return candle; }
  saveOptionSnapshot(snapshot: OptionSnapshot) { this.options.push(snapshot); return snapshot; }
  getInstrument(id: string) { return this.instruments.get(id); }
  getCandles(instrumentId: string, timeframe: string) { return this.candles.filter((candle) => candle.instrumentId === instrumentId && candle.timeframe === timeframe); }
  getOptions(instrumentId: string) { return this.options.filter((snapshot) => snapshot.instrumentId === instrumentId); }
}