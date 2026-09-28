"""Beginner-facing market intelligence for NIFTY, BANKNIFTY and SENSEX options.

Combines option-chain positioning (OI, 5-minute OI change, writers, PCR, max pain),
India VIX, smart-money-concept price structure (BOS/CHoCH, fair value gaps, order
blocks, liquidity sweeps) and session technicals into one explainable verdict and a
risk-defined trade plan. Every number is derived from caller-supplied market data;
nothing is synthesised, and missing evidence is reported rather than guessed.
"""
from .engine import analyze_market

__all__ = ["analyze_market"]
