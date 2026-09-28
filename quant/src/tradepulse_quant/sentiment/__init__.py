"""Public retail and media sentiment for Indian and global markets.

Reads public RSS feeds and public Reddit listings (no scraping of pages that forbid it),
scores every item with a finance-specific lexicon, and aggregates by region and by
audience (retail forums vs. news media) with recency and engagement weighting.
"""
from .engine import analyze_sentiment

__all__ = ["analyze_sentiment"]
