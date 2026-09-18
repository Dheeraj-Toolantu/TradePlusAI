from dataclasses import dataclass


@dataclass(frozen=True)
class Fill:
    quantity: int
    price: float
    fees: float
    slippage: float


def simulate_market_fill(quantity: int, price: float, fee_rate: float = 0.0003, slippage: float = 0.0) -> Fill:
    return Fill(quantity=quantity, price=price + slippage, fees=quantity * price * fee_rate, slippage=slippage)