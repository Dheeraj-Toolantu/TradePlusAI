from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from .configuration import StrategyConfiguration

IST = timezone(timedelta(hours=5, minutes=30))


def normalize_to_ist(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=IST)
    return value.astimezone(IST)


def _window(config: StrategyConfiguration, name: str) -> time:
    minutes = config.trading_windows[name]
    return time(minutes // 60, minutes % 60)


def current_session_window(value: datetime, config: StrategyConfiguration | None = None) -> str:
    cfg = config or StrategyConfiguration()
    current = normalize_to_ist(value).time()
    if current < _window(cfg, "market_open"):
        return "PRE_OPEN"
    if current < _window(cfg, "or_complete"):
        return "OPENING_RANGE"
    if current < _window(cfg, "entry_start"):
        return "POST_OR_PRE_ENTRY"
    if current < _window(cfg, "entry_end"):
        return "ENTRY_WINDOW"
    if current < _window(cfg, "mandatory_square_off"):
        return "CLOSE_TO_SQUARE_OFF"
    return "MANDATORY_SQUARE_OFF"


def is_entry_permitted(value: datetime, config: StrategyConfiguration | None = None) -> bool:
    cfg = config or StrategyConfiguration()
    current = normalize_to_ist(value).time()
    return _window(cfg, "entry_start") <= current < _window(cfg, "entry_end")


def is_session_active(value: datetime, config: StrategyConfiguration | None = None) -> bool:
    cfg = config or StrategyConfiguration()
    current = normalize_to_ist(value).time()
    return _window(cfg, "market_open") <= current < _window(cfg, "mandatory_square_off")


def validate_session_boundaries(value: datetime, config: StrategyConfiguration | None = None) -> tuple[bool, str]:
    phase = current_session_window(value, config)
    return phase not in {"PRE_OPEN", "CLOSE_TO_SQUARE_OFF", "MANDATORY_SQUARE_OFF"}, phase


def session_start_for(value: datetime) -> datetime:
    return datetime.combine(normalize_to_ist(value).date(), _window(StrategyConfiguration(), "market_open"), tzinfo=IST)


def session_end_for(value: datetime) -> datetime:
    return datetime.combine(normalize_to_ist(value).date(), _window(StrategyConfiguration(), "mandatory_square_off"), tzinfo=IST)
