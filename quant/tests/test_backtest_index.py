import json
import random
import unittest
from datetime import date, datetime, timedelta, timezone

from tradepulse_quant.sentiment.backtest_index import binomial_p, directional, markdown, replay_day, run, spearman, truncate
from tradepulse_quant.sentiment.constituents import INDICES
from tradepulse_quant.sentiment.index_engine import parse_chart

IST = timezone(timedelta(hours=5, minutes=30))
START = date(2026, 8, 3)


def trading_days(count):
    days, day = [], START
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


DAYS = trading_days(45)


def chart(returns, base=100.0):
    stamps, opens, highs, lows, closes, volumes = [], [], [], [], [], []
    price = base
    for day, ret in zip(DAYS, returns):
        new = price * (1 + ret / 100)
        stamps.append(int(datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST).timestamp()))
        opens.append(price), closes.append(new), highs.append(max(price, new) * 1.002), lows.append(min(price, new) * 0.998), volumes.append(1_000_000)
        price = new
    return json.dumps({"chart": {"result": [{"meta": {}, "timestamp": stamps, "indicators": {"quote": [{"open": opens, "high": highs, "low": lows, "close": closes, "volume": volumes}]}}]}})


def rss(items):
    body = "".join(f"<item><title>{title}</title><link>https://example.com/{i}</link><pubDate>{when.strftime('%a, %d %b %Y %H:%M:%S GMT')}</pubDate></item>" for i, (title, when) in enumerate(items))
    return f"<?xml version='1.0'?><rss version='2.0'><channel>{body}</channel></rss>"


def oracle_fixtures(seed=3):
    """Stocks move randomly; a pre-market headline (08:00 IST) correctly calls the direction of half the moves."""
    rng = random.Random(seed)
    symbols = INDICES["NIFTY"]["weights"]
    returns = {symbol: [rng.gauss(0, 1.2) for _ in DAYS] for symbol in symbols}
    weights = INDICES["NIFTY"]["weights"]
    index_returns = [sum(weights[s] * returns[s][i] for s in symbols) / sum(weights.values()) for i in range(len(DAYS))]
    news = {}
    from tradepulse_quant.sentiment.constituents import STOCKS
    for symbol in symbols:
        name = STOCKS[symbol][0].split(" (")[0]
        items = []
        for i, day in enumerate(DAYS[25:], start=25):
            if rng.random() < 0.6:
                at = datetime(day.year, day.month, day.day, 8, 0, tzinfo=IST).astimezone(timezone.utc)
                up = returns[symbol][i] > 0
                items.append((f"{name} shares {'surge as brokerages turn bullish' if up else 'plunge as brokerages turn bearish'}", at))
                items.append((f"{name} {'rallies on strong buying' if up else 'slumps on heavy selling'}", at - timedelta(hours=2)))
                # Published after the open: must never leak into that day's reading.
                items.append((f"{name} {'crashes' if up else 'soars'} in afternoon trade", at + timedelta(hours=5)))
        news[symbol] = rss(items)
    charts = {symbol: chart(returns[symbol]) for symbol in symbols}
    charts["NIFTY"] = chart(index_returns, 24000)
    return {"charts": charts, "news": news, "participant_oi": {}, "deals": {}}


class StatisticsTests(unittest.TestCase):
    def test_binomial_and_rank_correlation(self):
        self.assertAlmostEqual(binomial_p(10, 20), 1.0)
        self.assertLess(binomial_p(18, 20), 0.001)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        result = directional([(50, 1.0), (-50, -0.5), (60, -0.2), (5, 3.0), (40, 0.01)])
        self.assertEqual((result["calls"], result["hits"]), (3, 2))  # |score| < 12 and flat days are not calls


class NoLookAheadTests(unittest.TestCase):
    def test_replay_uses_only_information_before_the_open(self):
        fixtures = oracle_fixtures()
        data = {"charts": {key: parse_chart(raw) for key, raw in fixtures["charts"].items()},
                "news": {}, "participants": {}, "deals": []}
        from tradepulse_quant.sentiment.engine import parse_rss
        data["news"] = {symbol: [{**item, "source": "x", "region": "INDIA"} for item in parse_rss(raw)] for symbol, raw in fixtures["news"].items()}
        day = DAYS[30]
        replay = replay_day(day, INDICES, ["NIFTY"], data, 18.0)
        infy = replay["stocks"]["INFY"]
        previous_close = truncate(data["charts"]["INFY"], day)["rows"][-1]["close"]
        self.assertAlmostEqual(infy["price"], round(previous_close, 2))  # D's own bar is never used
        self.assertTrue(all("afternoon" not in headline["title"] for headline in infy["headlines"]))


class OracleRunTests(unittest.TestCase):
    def test_harness_detects_a_signal_that_is_really_there(self):
        report = run({"indices": ["NIFTY"], "days": 20, "end": DAYS[-1].isoformat(), "fixtures": oracle_fixtures()})
        nifty = report["indices"]["NIFTY"]
        self.assertEqual(nifty["days_scored"], 20)
        # Pre-market headlines carry real information here, so the news lens must rank stocks well...
        self.assertGreater(nifty["cross_section"]["lens_mean_ic"]["news"], 0.3)
        # The blend keeps only a fraction of it: price/volume lenses carry no information on a random
        # walk yet hold ~35% of the weight, diluting a 0.8 news IC to ~0.2. Guard the floor.
        self.assertGreater(nifty["cross_section"]["mean_rank_ic"], 0.1)
        self.assertGreater(nifty["cross_section"]["top_minus_bottom_quintile_pct"], 0.5)
        # ...while backward-looking price momentum on random walks must not.
        self.assertLess(abs(nifty["cross_section"]["lens_mean_ic"]["price"]), 0.15)
        self.assertIn("NIFTY 50", markdown(report))

    def test_unreachable_market_data_is_reported_not_faked(self):
        report = run({"indices": ["NIFTY"], "days": 5, "fixtures": {"charts": {}, "news": {}, "participant_oi": {}, "deals": {}}})
        self.assertFalse(report["ok"])
        self.assertIn("unreachable", report["error"])


if __name__ == "__main__":
    unittest.main()
