from dataclasses import dataclass, field
from typing import Literal

AnalysisStatus = Literal["VALID", "INSUFFICIENT_DATA", "INVALID", "STALE", "DISCONTINUOUS"]
TradeDecision = Literal["NO_TRADE", "WAIT_FOR_CONFIRMATION", "WAIT_FOR_BREAKOUT", "INVALIDATED", "CONFIRMED"]


@dataclass(frozen=True)
class Blocker:
    code: str
    reason: str
    observed: object | None = None
    threshold: object | None = None


@dataclass(frozen=True)
class Evidence:
    kind: str
    label: str
    value: object | None = None
    source: str | None = None


@dataclass(frozen=True)
class AnalysisQuality:
    status: AnalysisStatus
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class IndicatorSet:
    ema9: float | None = None
    ema20: float | None = None
    ema50: float | None = None
    ema200: float | None = None
    rsi: float | None = None
    macd: tuple[float, float, float] | None = None
    adx: float | None = None
    vwap: float | None = None
    atr: float | None = None
    volume_sma: float | None = None
    relative_volume: float | None = None
    status: AnalysisStatus = "VALID"
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class SwingPoint:
    index: int
    price: float
    kind: Literal["HIGH", "LOW"]
    strength: int


@dataclass(frozen=True)
class StructureRelationship:
    kind: Literal["HH", "HL", "LH", "LL"]
    previous_index: int
    current_index: int


@dataclass(frozen=True)
class MarketStructure:
    swing_highs: tuple[SwingPoint, ...]
    swing_lows: tuple[SwingPoint, ...]
    relationships: tuple[StructureRelationship, ...]
    regime: str
    status: AnalysisStatus = "VALID"
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class PriceZone:
    kind: Literal["SUPPORT", "RESISTANCE"]
    minimum: float
    maximum: float
    sources: tuple[str, ...] = ()
    touch_count: int = 1


@dataclass(frozen=True)
class AnalysisSnapshot:
    quality: AnalysisQuality
    indicators: IndicatorSet | None
    structure: MarketStructure | None
    zones: tuple[PriceZone, ...] = ()
    evidence: tuple[Evidence, ...] = ()
    blockers: tuple[Blocker, ...] = ()
