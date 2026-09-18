from dataclasses import dataclass
from typing import Literal

from .market_structure import detect_structure
from .ohlcv import OHLCVSeries


@dataclass(frozen=True)
class ChartPattern:
    name: str
    direction: Literal["BULLISH", "BEARISH", "NEUTRAL"]
    confidence: int
    start_index: int
    end_index: int
    invalidation: str


def detect_chart_patterns(series: OHLCVSeries) -> tuple[ChartPattern, ...]:
    if series.quality.status != "VALID" or len(series.candles) < 8:
        return ()
    structure = detect_structure(series)
    if not structure.relationships:
        return ()
    recent = structure.relationships[-4:]
    kinds = {relationship.kind for relationship in recent}
    latest = len(series.candles) - 1
    if {"HH", "HL"}.issubset(kinds):
        return (ChartPattern("Ascending Structure", "BULLISH", 60, recent[0].current_index, latest, "close below latest swing low"),)
    if {"LH", "LL"}.issubset(kinds):
        return (ChartPattern("Descending Structure", "BEARISH", 60, recent[0].current_index, latest, "close above latest swing high"),)
    return ()
