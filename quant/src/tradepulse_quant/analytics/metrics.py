from statistics import mean, median, pstdev


def summarize_returns(returns: list[float], r_multiples: list[float] | None = None, costs: float = 0.0, slippage: float = 0.0, exposure: float = 0.0) -> dict[str, float]:
    if not returns:
        return {"win_rate": 0.0, "expectancy": 0.0, "sharpe": 0.0, "max_drawdown": 0.0, "profit_factor": 0.0, "average_r": 0.0, "median_r": 0.0, "costs": costs, "slippage": slippage, "exposure": exposure}
    equity = 0.0
    peak = 0.0
    max_drawdown = 0.0
    for change in returns:
        equity += change
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
    deviation = pstdev(returns)
    positive = sum(value for value in returns if value > 0)
    negative = abs(sum(value for value in returns if value < 0))
    multiples = r_multiples or returns
    return {"win_rate": sum(value > 0 for value in returns) / len(returns), "expectancy": mean(returns), "sharpe": mean(returns) / deviation if deviation else 0.0, "max_drawdown": max_drawdown, "profit_factor": positive / negative if negative else (float("inf") if positive else 0.0), "average_r": mean(multiples) if multiples else 0.0, "median_r": median(multiples) if multiples else 0.0, "costs": costs, "slippage": slippage, "exposure": exposure}


def summarize_regimes(returns: list[float], regimes: list[str]) -> dict[str, dict[str, float]]:
    grouped: dict[str, list[float]] = {}
    for value, regime in zip(returns, regimes):
        grouped.setdefault(regime, []).append(value)
    return {regime: {"trades": float(len(values)), "win_rate": sum(value > 0 for value in values) / len(values), "expectancy": mean(values)} for regime, values in grouped.items() if values}