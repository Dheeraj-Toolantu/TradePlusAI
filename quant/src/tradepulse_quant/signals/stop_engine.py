from .models import MarketStructure, PriceZone


def long_stop(entry: float, support: PriceZone, atr: float, buffer_multiplier: float) -> float:
    return min(entry, support.minimum - atr * buffer_multiplier)


def short_stop(entry: float, resistance: PriceZone, atr: float, buffer_multiplier: float) -> float:
    return max(entry, resistance.maximum + atr * buffer_multiplier)
