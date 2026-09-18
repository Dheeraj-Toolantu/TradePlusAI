from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal


@dataclass(frozen=True)
class Candle:
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass(frozen=True)
class MarketSnapshot:
    symbol: str
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    source_connected: bool
    last_update_age_seconds: float


@dataclass(frozen=True)
class OptionQuote:
    symbol: str
    expiry: str
    option_type: Literal["CE", "PE"]
    strike: Decimal
    bid: Decimal
    ask: Decimal
    last: Decimal
    volume: Decimal
    open_interest: Decimal
    timestamp: datetime
    source_connected: bool
    last_update_age_seconds: float

    @property
    def spread_pct(self) -> Decimal:
        midpoint = (self.bid + self.ask) / Decimal("2")
        return Decimal("0") if midpoint == 0 else ((self.ask - self.bid) / midpoint) * Decimal("100")


@dataclass(frozen=True)
class OptionChainSnapshot:
    symbol: str
    timestamp: datetime
    quotes: tuple[OptionQuote, ...] = ()


@dataclass(frozen=True)
class ContractMetadata:
    symbol: str
    expiry: str
    strike: Decimal
    option_type: Literal["CE", "PE"]
    lot_size: Decimal
    tick_size: Decimal
    freeze_quantity: Decimal
    active: bool = True


@dataclass(frozen=True)
class Signal:
    symbol: str
    side: Literal["BUY", "SELL", "NO_TRADE"]
    score: float
    reasons: tuple[str, ...] = ()
    regime: str = "UNKNOWN"
    vwap: Decimal | None = None
    orh: Decimal | None = None
    orl: Decimal | None = None
    confirmation: str | None = None


@dataclass(frozen=True)
class TradePlan:
    symbol: str
    side: Literal["BUY", "SELL"]
    entry: Decimal
    stop: Decimal
    target: Decimal
    quantity: int
    score: float
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class Position:
    symbol: str
    side: Literal["BUY", "SELL"] | None
    quantity: int = 0
    average_price: Decimal | None = None
    state: str = "FLAT"


@dataclass(frozen=True)
class OrderPlan:
    symbol: str
    side: Literal["BUY", "SELL"]
    quantity: int
    limit_price: Decimal
    client_ref: str
    order_type: str = "MARKETABLE_LIMIT"


@dataclass(frozen=True)
class OrderState:
    client_ref: str
    state: str = "NEW"
    filled_qty: int = 0
    average_fill_price: Decimal | None = None


@dataclass(frozen=True)
class RiskState:
    daily_pnl: Decimal = Decimal("0")
    daily_loss_limit_exceeded: bool = False
    consecutive_losses: int = 0
    trade_count: int = 0
    cooldown_end: datetime | None = None


@dataclass(frozen=True)
class TradeRecord:
    symbol: str
    side: Literal["BUY", "SELL"]
    entry_price: Decimal
    exit_price: Decimal | None = None
    pnl: Decimal | None = None
    score: float = 0.0
    regime: str = "UNKNOWN"
    auditor_note: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)
