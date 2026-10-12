import unittest
from datetime import datetime, timezone

from tradepulse_quant.sentiment.retail_desk import contrarian, crowd_label, crowded_stocks, parse_participant_oi, positioning, retail_desk

NOW = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)
HEADER = ("Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,Option Index Call Long,Option Index Put Long,"
          "Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,"
          "Total Long Contracts,Total Short Contracts")


def participant_csv(client_long, client_short, fii_long, fii_short, client_calls=900000, client_puts=400000):
    rows = [
        f"Client,{client_long},{client_short},1,1,{client_calls},{client_puts},500000,500000,1,1,1,1,1,1",
        f"DII,50000,100000,1,1,0,0,0,0,1,1,1,1,1,1",
        f"FII,{fii_long},{fii_short},1,1,300000,350000,200000,150000,1,1,1,1,1,1",
        "Pro,90000,80000,1,1,600000,700000,800000,900000,1,1,1,1,1,1",
        "TOTAL,1,1,1,1,1,1,1,1,1,1,1,1,1,1",
    ]
    return "Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 09, 2026\n" + HEADER + "\n" + "\n".join(rows)


def index(index_id, mood, score=10.0, posts=20):
    return {"id": index_id, "name": index_id, "score": score, "retail": {"mood": mood, "posts": posts, "bullish_pct": 80.0}, "constituents": []}


class ParticipantOiTests(unittest.TestCase):
    def test_parses_nse_file_with_title_line(self):
        rows = parse_participant_oi(participant_csv(300000, 100000, 80000, 240000))
        self.assertEqual(rows["CLIENT"]["future index long"], 300000)
        client = positioning(rows["CLIENT"])
        self.assertEqual(client["futures_long_pct"], 75.0)
        self.assertEqual(client["futures_score"], 50.0)
        self.assertGreater(client["options_net"], 0)  # more calls bought than puts
        self.assertIsNone(parse_participant_oi("<html>Not found</html>"))


class CrowdTests(unittest.TestCase):
    def test_labels_and_contrarian_only_at_extremes(self):
        self.assertEqual(crowd_label(70), "EUPHORIC")
        self.assertEqual(crowd_label(-40), "STRETCHED_SHORT")
        self.assertEqual(crowd_label(10), "BALANCED")
        self.assertEqual(contrarian(70, "NIFTY")["bias"], "BEARISH")
        self.assertEqual(contrarian(-70, "NIFTY")["bias"], "BULLISH")
        self.assertEqual(contrarian(10, "NIFTY")["bias"], "NONE")
        self.assertEqual(contrarian(10, "NIFTY")["strength"], 0)
        self.assertGreater(contrarian(90, "NIFTY")["strength"], contrarian(60, "NIFTY")["strength"])

    def test_euphoric_retail_long_against_fiis(self):
        fixtures = {"participant_oi": {"2026-10-09": participant_csv(400000, 100000, 60000, 240000), "2026-10-08": participant_csv(350000, 130000, 70000, 220000)}}
        desk = retail_desk([index("NIFTY", 70.0, score=-30.0)], {"mmi_score": 65.0, "mmi_value": "82 (extreme greed)"}, NOW, fixtures)
        nifty = desk["indices"][0]
        self.assertEqual(desk["participants_date"], "2026-10-09")
        self.assertEqual(nifty["crowd"], "EUPHORIC")
        self.assertEqual(nifty["contrarian"]["bias"], "BEARISH")
        client = desk["participants"]["CLIENT"]
        self.assertEqual(client["futures_long_change"], 50000)
        self.assertEqual(client["futures_short_change"], -30000)
        self.assertTrue(any("FIIs hold" in note for note in desk["notes"]))
        self.assertTrue(any("getting more bullish" in note for note in desk["notes"]))
        self.assertTrue(any("fighting the tape" in note for note in desk["notes"]))

    def test_missing_positioning_still_reads_forums_and_mmi(self):
        desk = retail_desk([index("BANKNIFTY", -70.0)], {"mmi_score": -60.0}, NOW, {"participant_oi": {}})
        self.assertIsNone(desk["participants"])
        self.assertEqual(desk["indices"][0]["contrarian"]["bias"], "BULLISH")
        lonely = retail_desk([index("SENSEX", -70.0)], {}, NOW, {"participant_oi": {}})
        self.assertEqual(lonely["indices"][0]["contrarian"]["bias"], "NO_DATA")  # one input is not enough

    def test_crowded_stocks_flag_retail_vs_institutions(self):
        stocks = [
            {"symbol": "ADANIENT", "name": "Adani Ent", "social_raw": 60.0, "retail": {"posts": 12}, "components": {"volume": -50.0, "orderflow": -30.0}, "orderflow": {"delivery_pct": 58.0}, "change_pct": -1.2},
            {"symbol": "INFY", "name": "Infosys", "social_raw": 45.0, "retail": {"posts": 5}, "components": {"volume": 40.0, "orderflow": 20.0}, "orderflow": {}, "change_pct": 1.0},
            {"symbol": "ITC", "name": "ITC", "social_raw": 10.0, "retail": {"posts": 30}, "components": {}, "orderflow": {}},
        ]
        rows = crowded_stocks(stocks)
        self.assertEqual([row["symbol"] for row in rows], ["ADANIENT", "INFY"])
        self.assertTrue(rows[0]["divergence"])
        self.assertIn("strong hands sell", rows[0]["read"])
        self.assertFalse(rows[1]["divergence"])


if __name__ == "__main__":
    unittest.main()
