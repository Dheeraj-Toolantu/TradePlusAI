from dataclasses import dataclass, field
import json
from hashlib import sha256


@dataclass(frozen=True)
class StrategyConfiguration:
    version: str = "ai-chart-v1"
    minimum_rr: float = 2.0
    minimum_confidence: int = 75
    atr_period: int = 14
    atr_buffer_multiplier: float = 0.5
    volume_period: int = 20
    require_volume_confirmation: bool = True
    require_support_confirmation: bool = True
    require_mtf_confirmation: bool = True
    trend_timeframe: str = "15m"
    setup_timeframe: str = "5m"
    entry_timeframe: str = "1m"
    confirmation_weights: dict[str, int] = field(default_factory=lambda: {
        "candlestick": 20,
        "market_structure": 20,
        "trend": 15,
        "support_resistance": 15,
        "volume": 10,
        "momentum": 10,
        "chart_pattern": 5,
        "multi_timeframe": 5,
    })

    def __post_init__(self) -> None:
        if self.minimum_rr <= 0 or self.minimum_confidence < 0 or self.minimum_confidence > 100:
            raise ValueError("minimum risk/reward and confidence must be positive and bounded")
        if self.atr_period <= 0 or self.volume_period <= 0 or self.atr_buffer_multiplier <= 0:
            raise ValueError("indicator periods and ATR buffer must be positive")
        if sum(self.confirmation_weights.values()) != 100:
            raise ValueError("confirmation weights must total 100")

    def reproducibility_key(self) -> str:
        payload = json.dumps(self.__dict__, sort_keys=True, separators=(",", ":"), default=list)
        return sha256(payload.encode("utf-8")).hexdigest()
