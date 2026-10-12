"""Index constituents with approximate free-float weights, sectors and news aliases.

Weights are approximate (NSE/BSE publish the exact factsheet monthly and rebalance the
composition semi-annually); they are normalised inside each index, so small drifts only nudge
the reading. Override the whole table with INDEX_CONSTITUENTS_JSON (a JSON object or a file
path) shaped like ``INDICES`` when the composition changes.

``aliases`` are regexes matched against lowercased headlines/posts with word boundaries; they
avoid sibling companies (e.g. "sbi" must not match "SBI Life" or "SBI Card").
"""
from __future__ import annotations

import json
import os

# symbol -> (company name, sector, aliases)
STOCKS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "HDFCBANK": ("HDFC Bank", "Banks", (r"hdfc bank", r"hdfcbank")),
    "ICICIBANK": ("ICICI Bank", "Banks", (r"icici bank", r"icicibank")),
    "RELIANCE": ("Reliance Industries", "Energy & Conglomerate", (r"reliance industries", r"reliance(?! power| infra| capital| home| general| nippon)", r"\bril\b", r"mukesh ambani")),
    "INFY": ("Infosys", "IT", (r"infosys", r"\binfy\b")),
    "BHARTIARTL": ("Bharti Airtel", "Telecom", (r"bharti airtel", r"airtel", r"bhartiartl")),
    "LT": ("Larsen & Toubro", "Capital Goods", (r"larsen", r"l&t(?! finance| technology| mindtree)", r"\bl and t\b")),
    "ITC": ("ITC", "FMCG", (r"\bitc\b(?! hotels)",)),
    "TCS": ("Tata Consultancy Services", "IT", (r"\btcs\b", r"tata consultancy")),
    "SBIN": ("State Bank of India", "Banks", (r"state bank of india", r"\bsbi\b(?! life| card| mutual| funds| general| cards)", r"\bsbin\b")),
    "AXISBANK": ("Axis Bank", "Banks", (r"axis bank", r"axisbank")),
    "KOTAKBANK": ("Kotak Mahindra Bank", "Banks", (r"kotak mahindra bank", r"kotak bank", r"kotakbank")),
    "M&M": ("Mahindra & Mahindra", "Auto", (r"mahindra (&|and) mahindra", r"\bm&m\b(?! finance| financial)")),
    "BAJFINANCE": ("Bajaj Finance", "NBFC & Insurance", (r"bajaj finance", r"bajfinance")),
    "HINDUNILVR": ("Hindustan Unilever", "FMCG", (r"hindustan unilever", r"\bhul\b", r"hindunilvr")),
    "SUNPHARMA": ("Sun Pharmaceutical", "Pharma & Healthcare", (r"sun pharma", r"sunpharma")),
    "HCLTECH": ("HCLTech", "IT", (r"hcl ?tech", r"hcl technologies")),
    "MARUTI": ("Maruti Suzuki", "Auto", (r"maruti",)),
    "NTPC": ("NTPC", "Power & Utilities", (r"\bntpc\b(?! green)",)),
    "ETERNAL": ("Eternal (Zomato)", "Consumer Services", (r"\beternal\b(?! sunshine)", r"zomato", r"blinkit")),
    "TITAN": ("Titan Company", "Consumer Durables", (r"titan company", r"\btitan\b")),
    "ULTRACEMCO": ("UltraTech Cement", "Cement & Materials", (r"ultratech", r"ultracemco")),
    "TMPV": ("Tata Motors (PV)", "Auto", (r"tata motors", r"\btmpv\b", r"jaguar land rover", r"\bjlr\b")),
    "POWERGRID": ("Power Grid Corporation", "Power & Utilities", (r"power grid", r"powergrid")),
    "BEL": ("Bharat Electronics", "Capital Goods", (r"bharat electronics", r"\bbel\b")),
    "TATASTEEL": ("Tata Steel", "Metals & Mining", (r"tata steel", r"tatasteel")),
    "ADANIPORTS": ("Adani Ports & SEZ", "Infra & Logistics", (r"adani ports", r"adaniports", r"\bapsez\b")),
    "BAJAJFINSV": ("Bajaj Finserv", "NBFC & Insurance", (r"bajaj finserv", r"bajajfinsv")),
    "JSWSTEEL": ("JSW Steel", "Metals & Mining", (r"jsw steel", r"jswsteel")),
    "ASIANPAINT": ("Asian Paints", "Consumer Durables", (r"asian paints", r"asianpaint")),
    "HINDALCO": ("Hindalco Industries", "Metals & Mining", (r"hindalco", r"novelis")),
    "TECHM": ("Tech Mahindra", "IT", (r"tech mahindra", r"\btechm\b")),
    "ONGC": ("ONGC", "Energy & Conglomerate", (r"\bongc\b", r"oil and natural gas")),
    "GRASIM": ("Grasim Industries", "Cement & Materials", (r"grasim",)),
    "COALINDIA": ("Coal India", "Metals & Mining", (r"coal india", r"coalindia")),
    "SHRIRAMFIN": ("Shriram Finance", "NBFC & Insurance", (r"shriram finance", r"shriramfin")),
    "TRENT": ("Trent", "Consumer Services", (r"\btrent\b", r"zudio")),
    "NESTLEIND": ("Nestle India", "FMCG", (r"nestle india", r"nestleind")),
    "EICHERMOT": ("Eicher Motors", "Auto", (r"eicher", r"royal enfield")),
    "SBILIFE": ("SBI Life Insurance", "NBFC & Insurance", (r"sbi life", r"sbilife")),
    "HDFCLIFE": ("HDFC Life Insurance", "NBFC & Insurance", (r"hdfc life", r"hdfclife")),
    "JIOFIN": ("Jio Financial Services", "NBFC & Insurance", (r"jio financial", r"jiofin")),
    "CIPLA": ("Cipla", "Pharma & Healthcare", (r"\bcipla\b",)),
    "BAJAJ-AUTO": ("Bajaj Auto", "Auto", (r"bajaj auto",)),
    "DRREDDY": ("Dr. Reddy's Laboratories", "Pharma & Healthcare", (r"dr\.? reddy", r"drreddy")),
    "TATACONSUM": ("Tata Consumer Products", "FMCG", (r"tata consumer", r"tataconsum")),
    "APOLLOHOSP": ("Apollo Hospitals", "Pharma & Healthcare", (r"apollo hospital", r"apollohosp")),
    "WIPRO": ("Wipro", "IT", (r"\bwipro\b",)),
    "ADANIENT": ("Adani Enterprises", "Energy & Conglomerate", (r"adani enterprises", r"adanient")),
    "INDIGO": ("InterGlobe Aviation (IndiGo)", "Consumer Services", (r"interglobe", r"\bindigo\b")),
    "MAXHEALTH": ("Max Healthcare", "Pharma & Healthcare", (r"max healthcare", r"maxhealth")),
    # Bank Nifty only
    "INDUSINDBK": ("IndusInd Bank", "Banks", (r"indusind",)),
    "FEDERALBNK": ("Federal Bank", "Banks", (r"federal bank", r"federalbnk")),
    "BANKBARODA": ("Bank of Baroda", "Banks", (r"bank of baroda", r"bankbaroda")),
    "AUBANK": ("AU Small Finance Bank", "Banks", (r"au small finance", r"\bau bank\b", r"\baubank\b")),
    "IDFCFIRSTB": ("IDFC First Bank", "Banks", (r"idfc first",)),
    "PNB": ("Punjab National Bank", "Banks", (r"punjab national bank", r"\bpnb\b(?! housing)")),
    "CANBK": ("Canara Bank", "Banks", (r"canara bank", r"\bcanbk\b")),
    "YESBANK": ("Yes Bank", "Banks", (r"yes bank", r"yesbank")),
    "UNIONBANK": ("Union Bank of India", "Banks", (r"union bank of india", r"unionbank")),
}

# Yahoo Finance tickers where the NSE symbol needs escaping or differs.
YAHOO_OVERRIDES = {"M&M": "M&M.NS", "BAJAJ-AUTO": "BAJAJ-AUTO.NS"}

INDICES: dict[str, dict] = {
    "NIFTY": {
        "name": "NIFTY 50",
        "yahoo": "^NSEI",
        "weights": {
            "HDFCBANK": 13.0, "ICICIBANK": 9.0, "RELIANCE": 8.5, "INFY": 4.8, "BHARTIARTL": 4.7, "LT": 3.9, "ITC": 3.4, "SBIN": 3.2,
            "AXISBANK": 3.0, "TCS": 2.9, "KOTAKBANK": 2.7, "M&M": 2.6, "BAJFINANCE": 2.5, "HINDUNILVR": 1.9, "ETERNAL": 1.7,
            "SUNPHARMA": 1.6, "MARUTI": 1.6, "HCLTECH": 1.4, "NTPC": 1.4, "TITAN": 1.3, "BEL": 1.3, "ULTRACEMCO": 1.2, "TMPV": 1.2,
            "TATASTEEL": 1.2, "POWERGRID": 1.1, "ADANIPORTS": 1.0, "INDIGO": 1.0, "BAJAJFINSV": 0.9, "JSWSTEEL": 0.9, "ASIANPAINT": 0.9,
            "HINDALCO": 0.9, "GRASIM": 0.9, "SHRIRAMFIN": 0.9, "TECHM": 0.8, "ONGC": 0.8, "TRENT": 0.8, "EICHERMOT": 0.8, "JIOFIN": 0.8,
            "BAJAJ-AUTO": 0.8, "COALINDIA": 0.7, "NESTLEIND": 0.7, "SBILIFE": 0.7, "HDFCLIFE": 0.7, "CIPLA": 0.6, "DRREDDY": 0.6,
            "TATACONSUM": 0.6, "APOLLOHOSP": 0.6, "WIPRO": 0.6, "MAXHEALTH": 0.6, "ADANIENT": 0.5,
        },
    },
    "BANKNIFTY": {
        "name": "BANK NIFTY",
        "yahoo": "^NSEBANK",
        "weights": {
            "HDFCBANK": 27.5, "ICICIBANK": 24.5, "SBIN": 9.0, "AXISBANK": 8.5, "KOTAKBANK": 8.0, "FEDERALBNK": 3.2, "INDUSINDBK": 3.0,
            "BANKBARODA": 3.0, "AUBANK": 2.8, "IDFCFIRSTB": 2.8, "CANBK": 2.8, "PNB": 2.6, "YESBANK": 1.5, "UNIONBANK": 1.2,
        },
    },
    "SENSEX": {
        "name": "SENSEX",
        "yahoo": "^BSESN",
        "weights": {
            "HDFCBANK": 15.0, "ICICIBANK": 10.4, "RELIANCE": 10.0, "INFY": 5.6, "BHARTIARTL": 5.4, "LT": 4.5, "ITC": 3.9, "SBIN": 3.7,
            "TCS": 3.4, "AXISBANK": 3.4, "KOTAKBANK": 3.1, "M&M": 3.0, "BAJFINANCE": 2.9, "HINDUNILVR": 2.2, "ETERNAL": 2.0,
            "SUNPHARMA": 1.9, "MARUTI": 1.8, "HCLTECH": 1.7, "NTPC": 1.6, "TITAN": 1.5, "BEL": 1.5, "ULTRACEMCO": 1.4, "TATASTEEL": 1.4,
            "TMPV": 1.3, "POWERGRID": 1.3, "ADANIPORTS": 1.2, "BAJAJFINSV": 1.0, "ASIANPAINT": 1.0, "TRENT": 1.0, "TECHM": 0.9,
        },
    },
}


def yahoo_symbol(symbol: str) -> str:
    return YAHOO_OVERRIDES.get(symbol, f"{symbol}.NS")


def configured_indices() -> dict[str, dict]:
    raw = os.environ.get("INDEX_CONSTITUENTS_JSON", "").strip()
    if not raw:
        return INDICES
    try:
        if not raw.startswith("{"):
            with open(raw, encoding="utf-8") as handle:
                raw = handle.read()
        table = json.loads(raw)
    except (OSError, ValueError):
        return INDICES
    valid = {key: value for key, value in table.items() if isinstance(value, dict) and isinstance(value.get("weights"), dict) and value["weights"]}
    return {**INDICES, **valid} if valid else INDICES
