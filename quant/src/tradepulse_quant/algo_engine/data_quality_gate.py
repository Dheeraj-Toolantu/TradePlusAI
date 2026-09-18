from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from math import isfinite
from typing import Iterable

from .configuration import StrategyConfiguration
from .models import Candle, MarketSnapshot, OptionQuote


class DataQualityGate:
    def __init__(self, config: StrategyConfiguration | None = None) -> None:
        self.config = config or StrategyConfiguration()

    def validate_market_snapshot(self, snapshot: MarketSnapshot, *, now: datetime | None = None, requires_full_sync_on_reconnect: bool = False) -> tuple[bool, list[str]]:
        reasons: list[str] = []
        reference = now or datetime.now(snapshot.timestamp.tzinfo)
        if (reference - snapshot.timestamp).total_seconds() > self.config.max_data_age_seconds or snapshot.last_update_age_seconds > self.config.max_data_age_seconds:
            reasons.append("DATA_STALE")
        if not snapshot.source_connected:
            reasons.append("RECONNECT_SYNC_REQUIRED" if requires_full_sync_on_reconnect else "FEED_DISCONNECTED")
        fields = (snapshot.open, snapshot.high, snapshot.low, snapshot.close, snapshot.volume)
        if not all(isfinite(float(value)) for value in fields):
            reasons.append("INVALID_OHLC")
        if snapshot.high < snapshot.low or snapshot.high <= 0 or snapshot.low <= 0:
            reasons.append("INVALID_MARKET")
        if snapshot.high < max(snapshot.open, snapshot.close) or snapshot.low > min(snapshot.open, snapshot.close):
            reasons.append("INVALID_OHLC")
        return not reasons, reasons

    def validate_option_quote(self, quote: OptionQuote, *, now: datetime | None = None, market_timestamp: datetime | None = None) -> tuple[bool, list[str]]:
        reasons: list[str] = []
        reference = now or datetime.now(quote.timestamp.tzinfo)
        if (reference - quote.timestamp).total_seconds() > self.config.option_quote_stale_seconds or quote.last_update_age_seconds > self.config.option_quote_stale_seconds:
            reasons.append("OPTION_QUOTE_STALE")
        if market_timestamp is not None and abs((quote.timestamp - market_timestamp).total_seconds()) > self.config.max_timestamp_mismatch_seconds:
            reasons.append("TIMESTAMP_MISMATCH")
        if not quote.source_connected:
            reasons.append("RECONNECT_SYNC_REQUIRED")
        if quote.bid <= 0 or quote.ask <= 0 or quote.last <= 0 or quote.ask < quote.bid:
            reasons.append("INVALID_MARKET")
        if quote.ask - quote.bid > quote.ask * Decimal("0.10"):
            reasons.append("ABNORMAL_SPREAD")
        return not reasons, reasons

    def validate_candles(self, symbol: str, candles: Iterable[Candle], *, now: datetime | None = None) -> tuple[bool, list[str]]:
        values = list(candles)
        reasons: list[str] = []
        if not values:
            return False, ["MISSING_FIELD"]
        previous: datetime | None = None
        seen: set[datetime] = set()
        for candle in values:
            if candle.timestamp in seen:
                reasons.append("DUPLICATE_TIMESTAMP")
            seen.add(candle.timestamp)
            if previous is not None and candle.timestamp <= previous:
                reasons.append("OUT_OF_ORDER_CANDLES")
            previous = candle.timestamp
            fields = (candle.open, candle.high, candle.low, candle.close, candle.volume)
            if not all(isfinite(float(value)) for value in fields) or candle.high < max(candle.open, candle.close) or candle.low > min(candle.open, candle.close):
                reasons.append("INVALID_OHLC")
            if candle.high < candle.low:
                reasons.append("INVALID_OHLC")
            if candle.volume < 0:
                reasons.append("MISSING_FIELD")
        return not reasons, reasons
