from dataclasses import dataclass
from typing import Literal

from .ohlcv import OHLCVSeries


@dataclass(frozen=True)
class EntryZone:
    minimum: float
    maximum: float
    method: Literal["BREAKOUT", "PULLBACK", "REVERSAL"]
    trigger: str


def breakout_entry(series: OHLCVSeries, level: float, volume_confirmed: bool) -> EntryZone | None:
    if not series.candles or series.candles[-1].close <= level or not volume_confirmed:
        return None
    close = series.candles[-1].close
    return EntryZone(level, close, "BREAKOUT", f"close above {level:g} with volume confirmation")
