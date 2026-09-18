# Indicator Methodology

- EMA uses a simple moving average seed followed by the standard multiplier $2 / (period + 1)$.
- ATR uses Wilder true range, including prior-close gaps, followed by Wilder smoothing.
- VWAP is the volume-weighted typical price $(high + low + close) / 3$ for the supplied intraday session.
- ADX uses Wilder-smoothed true range and directional movement. It returns no value until two full periods are available.

All calculations use completed candles only. Callers must validate candle quality and session ownership before interpreting an indicator as trade evidence.