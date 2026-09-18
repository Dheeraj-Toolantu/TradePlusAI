from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Target:
    label: str
    price: float
    technical_reference: str
    r_multiple: float


def risk_reward(direction: Literal["LONG", "SHORT"], entry: float, stop: float, target: float) -> tuple[float, float, float] | None:
    risk = entry - stop if direction == "LONG" else stop - entry
    reward = target - entry if direction == "LONG" else entry - target
    if risk <= 0 or reward <= 0:
        return None
    return risk, reward, reward / risk
