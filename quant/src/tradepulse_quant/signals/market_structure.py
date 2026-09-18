from .models import MarketStructure, StructureRelationship, SwingPoint
from .ohlcv import OHLCVSeries


def detect_structure(series: OHLCVSeries, lookback: int = 2) -> MarketStructure:
    if series.quality.status != "VALID" or len(series.candles) < lookback * 2 + 3:
        return MarketStructure((), (), (), "SIDEWAYS", series.quality.status, series.quality.reasons)
    highs: list[SwingPoint] = []
    lows: list[SwingPoint] = []
    candles = series.candles
    for index in range(lookback, len(candles) - lookback):
        window = candles[index - lookback:index + lookback + 1]
        if candles[index].high == max(item.high for item in window):
            highs.append(SwingPoint(index, candles[index].high, "HIGH", lookback))
        if candles[index].low == min(item.low for item in window):
            lows.append(SwingPoint(index, candles[index].low, "LOW", lookback))
    relationships: list[StructureRelationship] = []
    for previous, current in zip(highs, highs[1:]):
        relationships.append(StructureRelationship("HH" if current.price > previous.price else "LH", previous.index, current.index))
    for previous, current in zip(lows, lows[1:]):
        relationships.append(StructureRelationship("HL" if current.price > previous.price else "LL", previous.index, current.index))
    recent = {relationship.kind for relationship in relationships[-4:]}
    bullish = "HH" in recent and "HL" in recent
    bearish = "LH" in recent and "LL" in recent
    if bullish and len(recent) == 2:
        regime = "STRONG_UPTREND"
    elif bullish:
        regime = "UPTREND"
    elif bearish and len(recent) == 2:
        regime = "STRONG_DOWNTREND"
    elif bearish:
        regime = "DOWNTREND"
    elif "HH" in recent or "HL" in recent:
        regime = "BULLISH_REVERSAL"
    elif "LH" in recent or "LL" in recent:
        regime = "BEARISH_REVERSAL"
    else:
        regime = "SIDEWAYS"
    return MarketStructure(tuple(highs), tuple(lows), tuple(relationships), regime)
