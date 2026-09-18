from dataclasses import dataclass

from .configuration import StrategyConfiguration
from .models import Blocker


@dataclass(frozen=True)
class ConfirmationScore:
    components: dict[str, int]
    total: int
    quality: str
    blockers: tuple[Blocker, ...] = ()


def score_confirmation(components: dict[str, int], config: StrategyConfiguration) -> ConfirmationScore:
    normalized = {name: max(0, min(100, value)) for name, value in components.items()}
    total = round(sum(normalized.get(name, 0) * weight / 100 for name, weight in config.confirmation_weights.items()))
    if total < 40:
        quality = "NO_TRADE"
    elif total < 60:
        quality = "WEAK"
    elif total < 75:
        quality = "POTENTIAL"
    elif total < 85:
        quality = "CONFIRMED"
    else:
        quality = "STRONG"
    blockers = () if total >= config.minimum_confidence else (Blocker("CONFIDENCE", "confidence below configured minimum", total, config.minimum_confidence),)
    return ConfirmationScore(normalized, total, quality, blockers)
