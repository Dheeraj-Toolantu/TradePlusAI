from dataclasses import dataclass
from typing import Literal

from .configuration import StrategyConfiguration
from .confirmation import ConfirmationScore
from .target_engine import Target, risk_reward


@dataclass(frozen=True)
class TradeSetup:
    direction: Literal["LONG", "SHORT"] | None
    status: str
    entry_min: float | None
    entry_max: float | None
    stop_loss: float | None
    targets: tuple[Target, ...]
    risk_rewards: tuple[float, ...]
    confidence: int
    reasons: tuple[str, ...]
    risks: tuple[str, ...]
    invalidation: str


def build_setup(direction: Literal["LONG", "SHORT"], entry_min: float, entry_max: float, stop: float, targets: tuple[Target, ...], score: ConfirmationScore, config: StrategyConfiguration) -> TradeSetup:
    entry = (entry_min + entry_max) / 2
    ratios = tuple(result[2] for target in targets if (result := risk_reward(direction, entry, stop, target.price)) is not None)
    blockers = [blocker.reason for blocker in score.blockers]
    if not ratios or min(ratios) < config.minimum_rr:
        blockers.append("no technical target meets minimum risk/reward")
    if blockers:
        return TradeSetup(None, "WAIT_FOR_CONFIRMATION", None, None, None, (), ratios, score.total, tuple(score.components), tuple(blockers), "confirmation or risk/reward requirements not met")
    return TradeSetup(direction, "CONFIRMED", entry_min, entry_max, stop, targets, ratios, score.total, tuple(score.components), (), f"close beyond {entry_max:g} invalidates setup")
