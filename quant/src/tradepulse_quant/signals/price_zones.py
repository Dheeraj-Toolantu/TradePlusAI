from .models import MarketStructure, PriceZone
from .ohlcv import OHLCVSeries


def _merge(values: list[float], proximity: float, kind: str, source: str) -> list[PriceZone]:
    if not values:
        return []
    values.sort()
    zones: list[list[float]] = [[values[0]]]
    for value in values[1:]:
        if value - zones[-1][-1] <= proximity:
            zones[-1].append(value)
        else:
            zones.append([value])
    return [PriceZone(kind, min(zone), max(zone), (source,), len(zone)) for zone in zones]


def detect_price_zones(series: OHLCVSeries, structure: MarketStructure, proximity: float | None = None) -> tuple[PriceZone, ...]:
    if not series.candles:
        return ()
    current = series.candles[-1].close
    distance = proximity if proximity is not None else max(current * 0.001, 0.01)
    supports = [swing.price for swing in structure.swing_lows if swing.price <= current]
    resistances = [swing.price for swing in structure.swing_highs if swing.price >= current]
    return tuple(_merge(supports, distance, "SUPPORT", "SWING") + _merge(resistances, distance, "RESISTANCE", "SWING"))
