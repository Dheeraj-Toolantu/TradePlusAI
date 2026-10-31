#!/usr/bin/env python3
"""Chart Scanner for trader-scanner: scan thousands of charts for setups. Standard library only.

India (NSE, IST, rupees) is the default market; --market US gives the original NYSE behaviour.

    python3 scan.py universe                          # NSE EQUITY_L + Nifty 500 -> trader/universe.txt
    python3 scan.py universe --index nifty100         # nifty50 | nifty100 | nifty200 | nifty500 | all
    python3 scan.py daily                             # before the open: daily setups -> trader/watchlist.json
    python3 scan.py daily --symbols RELIANCE,TCS,INFY # or --watchlist FILE, or --limit 200
    python3 scan.py orb                               # after 9:35 IST: opening-range breakouts so far
    python3 scan.py orb --at 10:00 --or-minutes 15    # cut the clock at 10:00 IST
    python3 scan.py --market US orb --at 10:15        # the NYSE profile (New York time, dollars)

universe (IN)  Reads NSE's equity list (archives.nseindia.com/content/equities/EQUITY_L.csv),
          keeps SERIES == EQ only (BE / BZ are trade-to-trade and cannot be day traded),
          then keeps the members of --index (default nifty500) from
          archives.nseindia.com/content/indices/ind_<index>list.csv, or every EQ
          stock with --index all. The raw CSVs are cached as published under
          trader/cache/ (EQUITY_L.csv, ind_<index>list.csv); when NSE cannot be
          reached the cache is used and the tool says so. universe.txt holds one
          SYMBOL|Company Name|Industry a line, plain NSE symbols (no .NS).
          --offline DIR (a folder with EQUITY_L.csv and the index CSV), or
          --file EQUITY_L.csv and --index-file ind_nifty500list.csv, read files.

universe (US)  Downloads Nasdaq Trader's symbol directories (nasdaqlisted.txt and
          otherlisted.txt) and keeps US-listed common stocks, ordinary shares
          and ADRs. The rule, in order:
            1. not a test issue, not an ETF, not NextShares
            2. a plain ticker: 1 to 5 letters, or 1 to 4 letters plus one
               class letter after a dot (BRK.B); a .U / .W / .R suffix
               (units, warrants, rights) is out, and so is a $ preferred
            3. out, whatever else the name says: warrants; SPAC units and
               rights ("Units, each consisting of", "Rights to receive");
               notes, ETNs, debentures; a % coupon; "Depositary Shares" that
               are not American or Global (those carry a preferred)
            4. in: the name calls it common stock / shares / units, ordinary
               shares, shares of beneficial interest, ADS / ADR / American or
               Global depositary shares, or partnership / trust units
            5. out: the name still says unit, right, bond, preferred or preference
            6. in: everything else (plain names like "AMETEK, Inc.")

daily     Pre-market scan of daily CLOSES (Yahoo spark: 20 symbols a request,
          3 months of 1-day bars, closes only). Liquidity: US, from the spark
          meta, regularMarketPrice >= --min-price ($5) and regularMarketVolume
          >= --min-volume (1,000,000); India, price >= Rs 50 and an average
          daily traded value >= --min-value-cr (10 crore). Setups, from closes only:
            breakout_20d     the last close is above every close of the 20 before it
            bull_flag        up more than 10 % over the 10 sessions before the
                             last 5, then the last 5 closes inside a 5 % range
            reclaim_ma20     closed under the 20-day average, then closed above it
            oversold         RSI 14 (Wilder) under 30
            oversold_bounce  RSI 14 was under 30 yesterday and today closed up
          Today's daily bar is dropped until the session's close.

orb       Opening-range breakouts, 5-minute bars. The range is the first
          --or-minutes (15) of the session. Stage 1: spark closes for every
          symbol (1 day of 5-minute bars, 20 a request); a chart goes on only
          if a completed bar after the range closed at or above the highest
          close of the range (a necessary condition). Stage 2: each candidate's
          v8 chart (real highs and lows): range high = the highest high of the
          range bars, a hit = the first completed bar to CLOSE above it, at that
          bar's close time. Stage 2 fetches at most --max-confirm (200) charts,
          the most traded candidates first (price x volume so far), and says
          so when it stops short. A chart is usable only when every 5-minute
          bar from the open (9:15 IST, 9:30 ET) to the cutoff is there (a
          missing bar is a halt or no trades). Floors: US --min-price 5 (last
          close), --min-volume 0; India Rs 50 and Rs 1 crore traded so far.

Bars: null closes are dropped, a bar off the 5-minute grid (the live tick,
like 10:49:45) is dropped, and a bar counts only once it is complete
(start + 5 minutes <= the clock). Times are exchange-local: IST in India,
New York (ET) in the US. --now pins the clock ("2026-10-30 10:00" IST, or
"2026-10-19 10:15" New York time with --market US; ...Z for UTC). A date past
the NSE holiday list's years is flagged; on a closed day the error names the
holiday (and the Muhurat session on Diwali).

Yahoo's endpoints are free, unofficial and can lag. query2 first, query1 on
a 429 or 5xx, one retry after a pause on a 429. A polite pause between
requests (--pause). Partial results are reported as partial.

--offline PATH reads files instead of the network: universe wants a folder
with EQUITY_L.csv and ind_<index>list.csv (India) or nasdaqlisted.txt and
otherlisted.txt (US); daily and orb take a folder of
<T>.json v8 chart files or spark responses (RELIANCE.NS.json in India), or one
file that is a spark response, a v8 chart, or a bundle {"TSLA": <v8 json>, ...}. .json.gz is fine.

India: Yahoo symbols get .NS (URL-quoted, so M&M works), the session is
9:15 to 15:30 IST, the 15-minute opening range is the 9:15, 9:20 and 9:25 bars,
--at and --now are IST. Floors are in rupees: --min-price 50 and
--min-value-cr (average daily traded value in rupee crore: 10 for daily,
traded so far today: 1 for orb). See SKILL.md for why.

A scan is a list of charts that match a rule, not a list of stocks to buy.
Exit code 0 when the scan found something, 1 when it did not or could not run.
"""

import argparse
import csv
import datetime
import gzip
import importlib.util
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def _market_module():
    name = "trader_market_shared"
    if name in sys.modules:
        return sys.modules[name]
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "trader-market", "market.py")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


market = _market_module()

UA = "Mozilla/5.0 (compatible; day-trader-skill/2.0; +https://github.com/Jakeschincariol/day-trader-skill)"
YAHOO_HOSTS = ("https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com")
NASDAQ_FILES = ("nasdaqlisted.txt", "otherlisted.txt")
NASDAQ_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/"
SPARK_MAX = 20      # Yahoo's spark answers 400 above 20 symbols
PAUSE = 0.3         # seconds between requests: be polite to free endpoints
BACKOFF = 5.0       # seconds to wait before the one retry after a 429
SLEEP = time.sleep  # tests swap this out
BAR_MIN = 5
MAX_CONFIRM = 200   # stage-2 v8 charts per orb scan, most traded first
MIN_DAILY_BARS = 30
DEFAULT_UNIVERSE = "trader/universe.txt"
NOTE = "A scan is a list of charts that match a rule, not a list of stocks to buy."

NSE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/124.0.0.0 Safari/537.36")
NSE_HEADERS = {"User-Agent": NSE_UA, "Accept": "text/csv,text/plain,application/octet-stream,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.nseindia.com/"}
NSE_EQUITY_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
NSE_INDEX_URL = "https://archives.nseindia.com/content/indices/ind_%slist.csv"
NSE_EQUITY_FILE = "EQUITY_L.csv"
NSE_INDICES = ("nifty50", "nifty100", "nifty200", "nifty500", "all")
CRORE = 1e7

# The market globals below are rebound by apply_market(); the values here are placeholders.
MK = None
NYSE_HOLIDAYS = {}
NYSE_EARLY_CLOSE = {}
HOLIDAYS = {}
EARLY_CLOSE = {}
CALENDAR_YEARS = ()
OPEN = CLOSE = EARLY = None
DEFAULTS = {}
TZ = "ET"
TIME_PHRASE = "a New York time"
EXAMPLE_AT = "10:15"
FLOORS = {}


def apply_market(mk):
    """Make mk (a market.Market) the active market: calendar, session, labels and default floors."""
    global MK, NYSE_HOLIDAYS, NYSE_EARLY_CLOSE, HOLIDAYS, EARLY_CLOSE, CALENDAR_YEARS, OPEN, CLOSE, EARLY
    global DEFAULTS, TZ, TIME_PHRASE, EXAMPLE_AT, FLOORS
    MK = mk
    HOLIDAYS = NYSE_HOLIDAYS = mk.holidays
    EARLY_CLOSE = NYSE_EARLY_CLOSE = mk.early_close
    CALENDAR_YEARS = tuple(mk.calendar_years)
    OPEN, CLOSE, EARLY = mk.open, mk.close, mk.early
    DEFAULTS = dict(mk.defaults)
    TZ = mk.tz_label
    if mk.code == "US":
        TIME_PHRASE, EXAMPLE_AT = "a New York time", "10:15"
        FLOORS = {"daily": (5.0, 1000000, 0.0), "orb": (5.0, 0, 0.0)}   # price, shares, crore (unused)
    else:
        TIME_PHRASE, EXAMPLE_AT = "an %s time" % mk.tz_label, "10:00"
        FLOORS = {"daily": (50.0, 0, 10.0), "orb": (50.0, 0, 1.0)}      # rupees, shares, rupee crore
    return mk


apply_market(market.resolve())

SETUPS = [
    ("breakout_20d", "20-day closing-high breakout"),
    ("bull_flag", "bull flag"),
    ("reclaim_ma20", "reclaimed the 20-day average"),
    ("oversold", "oversold (RSI under 30)"),
    ("oversold_bounce", "oversold bounce"),
]
LABEL = dict(SETUPS)


class ScanError(Exception):
    pass


# ---------------------------------------------------------------- time

def eastern_offset(utc):
    """Hours from UTC at the exchange (the name is upstream's): 5.5 for IST; for New York -4 in
    daylight time, -5 otherwise (US rule since 2007)."""
    return MK.utc_offset(utc)


def to_eastern(utc):
    """Naive UTC -> naive exchange-local time (IST in India, New York time in US mode)."""
    return MK.to_local(utc)


def eastern_to_utc(local):
    return MK.local_to_utc(local)


def ts_to_eastern(ts):
    """Unix seconds -> naive exchange-local time. Never uses the machine's time zone."""
    return to_eastern(datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=int(ts)))


def parse_now(text):
    """ISO time -> naive UTC. A time without an offset is taken as exchange-local time."""
    if not text:
        return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None)
    t = text.strip().replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(t)
    except ValueError:
        raise ScanError('--now wants a time like "2026-10-19 %s" (%s) or ...Z (UTC)'
                        % (EXAMPLE_AT, "New York" if MK.code == "US" else MK.tz_label))
    if dt.tzinfo is None:
        return eastern_to_utc(dt)
    return (dt - dt.utcoffset()).replace(tzinfo=None)


def parse_hhmm(text, flag="--at"):
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", text or "")
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise ScanError("%s wants %s like %s" % (flag, TIME_PHRASE, EXAMPLE_AT))
    return datetime.time(int(m.group(1)), int(m.group(2)))


def trading_day(d):
    """(is_trading_day, reason). Weekends and the exchange holiday list."""
    return MK.trading_day(d)


def session(d):
    """(open_time, close_time) in exchange-local time, or None if closed all day."""
    return MK.session(d)


def clock_label(t):
    """datetime or time -> '10:15 AM'."""
    h = t.hour % 12 or 12
    return "%d:%02d %s" % (h, t.minute, "AM" if t.hour < 12 else "PM")


def day_label(d):
    return "%s %s" % (d.strftime("%a"), d.isoformat())


def calendar_note(d):
    """India: the holiday list's caveat for a date outside its years (as trader-entry says it), else None."""
    if MK.code == "US" or MK.calendar_known(d):
        return None
    return "Holiday list covers %s only: check %s for this date." % (
        " and ".join(map(str, CALENDAR_YEARS)), MK.calendar_source)


def next_session_label(d):
    """India: the next trading day after d as 'Wed 2026-11-11' (from the market's calendar)."""
    nxt = MK.next_open(d)
    if not nxt:
        return "the next trading day"
    return day_label(datetime.date.fromisoformat(nxt[:10]))


# ---------------------------------------------------------------- network

def http_get(url, timeout=20, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def yahoo_get(path):
    """GET a Yahoo Finance path. query2 first, query1 on a 429 or 5xx, and one
    more round after BACKOFF seconds if a 429 was seen. 4xx other than 429 is final."""
    last = "no answer"
    for attempt in (0, 1):
        saw_429 = False
        for host in YAHOO_HOSTS:
            try:
                return http_get(host + path)
            except urllib.error.HTTPError as e:
                last = "HTTP %d" % e.code
                try:
                    body = e.read().decode("utf-8", "replace") if 400 <= e.code < 500 and e.code != 429 else ""
                except Exception:
                    body = ""
                finally:
                    e.close()
                if e.code == 429:
                    saw_429 = True
                    continue
                if e.code >= 500:
                    continue
                if body.strip().startswith("{"):
                    return body  # Yahoo's JSON error ("No data found"), parsed by the caller
                raise ScanError("Yahoo answered %s for %s" % (last, path.split("?")[0]))
            except (urllib.error.URLError, OSError) as e:
                last = str(getattr(e, "reason", e))
                continue
        if attempt == 0 and saw_429:
            SLEEP(BACKOFF)
            continue
        break
    raise ScanError("Yahoo answered %s for %s" % (last, path.split("?")[0]))


def to_yahoo(sym):
    """Our symbol -> Yahoo's: RELIANCE -> RELIANCE.NS in India, BRK.B -> BRK-B in the US."""
    if MK.code == "US":
        return sym.upper().replace(".", "-")
    return MK.yahoo_symbol(sym)


def from_yahoo(ysym):
    """Yahoo's symbol -> ours: RELIANCE.NS -> RELIANCE, BRK-B -> BRK.B."""
    if MK.code == "US":
        return ysym.upper().replace("-", ".")
    return MK.plain_symbol(ysym)


def plain(sym):
    """A symbol as the user or a file wrote it -> the plain symbol we keep (no .NS in India)."""
    s = str(sym).strip().upper()
    return s if MK.code == "US" else MK.plain_symbol(s)


def _q(ysym):
    return urllib.parse.quote(ysym, safe="^.-")


def spark_path(symbols, rng, interval):
    return "/v7/finance/spark?symbols=%s&range=%s&interval=%s" % (
        ",".join(_q(to_yahoo(s)) for s in symbols), rng, interval)


def chart_path(sym, rng, interval):
    return "/v8/finance/chart/%s?range=%s&interval=%s" % (_q(to_yahoo(sym)), rng, interval)


# ---------------------------------------------------------------- parsing

def series_from_result(res):
    """A Yahoo chart result (v8 or one spark response) -> plain lists."""
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0] or {}
    t = res.get("timestamp") or []
    n = len(t)

    def col(k):
        v = q.get(k)
        return list(v) + [None] * (n - len(v)) if isinstance(v, list) else None
    return {"t": list(t), "c": col("close") or [None] * n, "o": col("open"), "h": col("high"),
            "l": col("low"), "v": col("volume"), "meta": res.get("meta") or {}}


def parse_spark(text_or_doc, wanted=None):
    """Spark JSON -> {SYM: series}. Symbols Yahoo does not know are simply missing
    from the answer. `wanted` maps Yahoo symbols back to ours (BRK-B -> BRK.B)."""
    doc = json.loads(text_or_doc) if isinstance(text_or_doc, str) else text_or_doc
    sp = (doc or {}).get("spark") if isinstance(doc, dict) else None
    if not isinstance(sp, dict):
        raise ScanError("Yahoo's spark answer is not the shape this tool knows")
    err = sp.get("error")
    out = {}
    for item in sp.get("result") or []:
        resp = item.get("response") or []
        if not resp:
            continue
        ysym = item.get("symbol") or (resp[0].get("meta") or {}).get("symbol") or ""
        sym = (wanted or {}).get(ysym.upper(), from_yahoo(ysym))
        out[sym] = series_from_result(resp[0])
    if err and not out:
        raise ScanError("Yahoo spark: %s" % (err.get("description") or err.get("code") or err))
    return out


def parse_chart(text_or_doc, sym=""):
    """v8 chart JSON -> series. Raises ScanError for Yahoo's 'no data' answers."""
    try:
        doc = json.loads(text_or_doc) if isinstance(text_or_doc, str) else text_or_doc
        chart = doc["chart"]
    except (ValueError, KeyError, TypeError):
        raise ScanError("Yahoo returned something unexpected for %s" % sym)
    res = chart.get("result")
    if not res:
        err = chart.get("error") or {}
        raise ScanError("no data for %s: %s" % (sym, err.get("description", "unknown ticker")))
    return series_from_result(res[0])


def _read_maybe_gz(path):
    if path.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return fh.read()
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _stem(name):
    for ext in (".json.gz", ".json"):
        if name.endswith(ext):
            return name[:-len(ext)]
    return name


def _absorb(doc, name_hint, data, errors):
    """One parsed offline JSON doc -> data / errors."""
    if isinstance(doc, dict) and "spark" in doc:
        data.update(parse_spark(doc))
    elif isinstance(doc, dict) and "chart" in doc:
        sym = name_hint
        if not sym:
            try:
                sym = (doc["chart"].get("result") or [{}])[0]["meta"]["symbol"]
            except (AttributeError, KeyError, TypeError, IndexError):
                raise ScanError("an offline v8 chart without a symbol: name the file <TICKER>.json")
        sym = from_yahoo(sym)
        try:
            data[sym] = parse_chart(doc, sym)
        except ScanError as e:
            errors[sym] = str(e)
    elif isinstance(doc, dict):
        for k, v in doc.items():
            _absorb(v, k, data, errors)
    else:
        raise ScanError("offline file %s is not a spark answer, a v8 chart or a bundle" % name_hint)


def load_offline(path):
    """A folder of <T>.json(.gz) files or one file -> ({SYM: series}, {SYM: error})."""
    data, errors = {}, {}
    if os.path.isdir(path):
        names = sorted(f for f in os.listdir(path) if f.endswith((".json", ".json.gz")))
        if not names:
            raise ScanError("no .json files in %s" % path)
        for f in names:
            try:
                doc = json.loads(_read_maybe_gz(os.path.join(path, f)))
            except ValueError as e:
                raise ScanError("%s is not valid JSON: %s" % (f, e))
            if isinstance(doc, dict) and ("chart" in doc or "spark" in doc):
                _absorb(doc, "" if "spark" in doc else _stem(f), data, errors)
            else:
                _absorb(doc, "", data, errors)
    elif os.path.isfile(path):
        try:
            doc = json.loads(_read_maybe_gz(path))
        except ValueError as e:
            raise ScanError("%s is not valid JSON: %s" % (path, e))
        _absorb(doc, "", data, errors)
    else:
        raise ScanError("no offline file or folder at %s" % path)
    return data, errors


# ---------------------------------------------------------------- universe

TICKER = re.compile(r"^[A-Z]{1,5}$|^[A-Z]{1,4}\.[A-Z]$")
ALWAYS_OUT = [
    ("warrant", re.compile(r"\bwarrants?\b")),
    ("unit or right", re.compile(r"\b(units?|rights?),? (each|that|entitling)\b|(?<!the )\brights? to\b")),
    ("note", re.compile(r"\b(notes?|etns?|debentures?)\b")),
    ("coupon", re.compile(r"%")),
    ("depositary", re.compile(r"(?<!american )(?<!global )\bdepositary shares?\b")),
]
COMMON = re.compile(
    r"\bcommon (stock|shares?|units?)\b|\bord(inary)? shares?\b|\bshares? of beneficial interest\b"
    r"|\b(american|global) deposit[ao]ry\b|\bads[s]?\b|\badrs?\b"
    r"|\b(limited partnership|partnership|trust) units?\b|\bl\.?p\.? units?\b"
    r"|\bunits? (of|representing)\b.*\b(limited partner|partnership|beneficial interest|limited liability)")
SOFT_OUT = [
    ("unit", re.compile(r"\bunits?\b")),
    ("right", re.compile(r"\brights?\b")),
    ("bond", re.compile(r"\bbonds?\b")),
    ("preferred", re.compile(r"\bpreferred\b|\bpreference\b")),
]


def classify(row):
    """One symbol-directory row -> 'keep' or the rule that drops it."""
    sym = (row.get("Symbol") or row.get("ACT Symbol") or "").strip()
    if (row.get("Test Issue") or "").strip() != "N":
        return "test issue"
    if (row.get("ETF") or "").strip() != "N":
        return "ETF"
    if (row.get("NextShares") or "N").strip() != "N":
        return "NextShares"
    if not TICKER.match(sym):
        return "not a plain ticker"
    if re.search(r"\.[UWR]$", sym):
        return "unit / warrant / right suffix"
    name = " ".join((row.get("Security Name") or "").lower().split())
    for tag, rx in ALWAYS_OUT:
        if rx.search(name):
            return tag
    if COMMON.search(name):
        return "keep"
    for tag, rx in SOFT_OUT:
        if rx.search(name):
            return tag
    return "keep"


def parse_symdir(text):
    """Nasdaq Trader pipe file -> (rows, file_created). The last line is 'File Creation Time: ...'."""
    lines = [ln for ln in text.replace("\r", "").split("\n") if ln.strip()]
    if not lines or "|" not in lines[0]:
        raise ScanError("not a Nasdaq Trader symbol directory")
    hdr = [h.strip() for h in lines[0].split("|")]
    if "Security Name" not in hdr or not ({"Symbol", "ACT Symbol"} & set(hdr)):
        raise ScanError("not a Nasdaq Trader symbol directory (header %s)" % lines[0][:60])
    rows, created = [], None
    for ln in lines[1:]:
        if ln.startswith("File Creation Time"):
            m = re.search(r"(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})", ln)
            if m:
                created = "%s-%s-%s %s:%s" % (m.group(3), m.group(1), m.group(2), m.group(4), m.group(5))
            continue
        rows.append(dict(zip(hdr, ln.split("|"))))
    return rows, created


def build_universe(texts):
    """{filename: text} -> (kept [(SYM, name)], counts, created)."""
    kept, counts, created = {}, {}, None
    for fname in NASDAQ_FILES:
        if fname not in texts:
            raise ScanError("missing %s" % fname)
        rows, c = parse_symdir(texts[fname])
        created = created or c
        counts["rows"] = counts.get("rows", 0) + len(rows)
        for r in rows:
            why = classify(r)
            counts[why] = counts.get(why, 0) + 1
            if why == "keep":
                sym = (r.get("Symbol") or r.get("ACT Symbol")).strip()
                kept[sym] = " ".join((r.get("Security Name") or "").split())
    return sorted(kept.items()), counts, created


def _clean(x):
    return " ".join(str(x or "").replace("\ufeff", "").split())


def parse_nse_csv(text, need, what):
    """An NSE archive CSV -> rows with stripped keys and values. `need` = columns that must exist."""
    text = (text or "").lstrip("\ufeff")
    rd = csv.reader(io.StringIO(text))
    try:
        hdr = [_clean(h) for h in next(rd)]
    except StopIteration:
        raise ScanError("%s is empty" % what)
    up = [h.upper() for h in hdr]
    missing = [c for c in need if c.upper() not in up]
    if missing:
        raise ScanError("%s does not look like NSE's file (no %s column; header %s)"
                        % (what, ", ".join(missing), ",".join(hdr)[:80]))
    rows = []
    for rec in rd:
        if not any(x.strip() for x in rec):
            continue
        rows.append(dict((up[i], _clean(v)) for i, v in enumerate(rec) if i < len(up)))
    return rows


def build_nse_universe(equity_text, index_text=None):
    """EQUITY_L.csv text (+ an ind_<name>list.csv text, None for every EQ stock)
    -> (kept [(SYM, name, industry)], counts)."""
    rows = parse_nse_csv(equity_text, ("SYMBOL", "NAME OF COMPANY", "SERIES"), NSE_EQUITY_FILE)
    counts = {"rows": len(rows)}
    eq = {}
    for r in rows:
        sym = r.get("SYMBOL", "").upper()
        series = r.get("SERIES", "").upper()
        if not sym:
            continue
        if series != "EQ":
            tag = "series %s" % (series or "blank")
            counts[tag] = counts.get(tag, 0) + 1
            continue
        eq[sym] = r.get("NAME OF COMPANY", "")
    counts["eq"] = len(eq)
    if index_text is None:
        kept = [(sym, name, "") for sym, name in sorted(eq.items())]
        counts["keep"] = len(kept)
        return kept, counts
    idx = parse_nse_csv(index_text, ("Symbol", "Company Name"), "the index list")
    counts["index"] = len(idx)
    kept = {}
    for r in idx:
        sym = r.get("SYMBOL", "").upper()
        if not sym:
            continue
        if sym not in eq:
            counts["not EQ in EQUITY_L"] = counts.get("not EQ in EQUITY_L", 0) + 1
            continue
        kept[sym] = (sym, eq[sym] or r.get("COMPANY NAME", ""), r.get("INDUSTRY", ""))
    counts["not in the index"] = len(eq) - len(kept)
    counts["keep"] = len(kept)
    return [kept[k] for k in sorted(kept)], counts


def nse_get(url):
    try:
        return http_get(url, timeout=60, headers=NSE_HEADERS)
    except urllib.error.HTTPError as e:
        raise ScanError("archives.nseindia.com answered HTTP %d for %s" % (e.code, url.rsplit("/", 1)[-1]))
    except (urllib.error.URLError, OSError) as e:
        raise ScanError("could not reach archives.nseindia.com: %s" % getattr(e, "reason", e))


def _read_text(path):
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:   # keep CRLF as published
        return fh.read()


def _write_text(path, text):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def read_universe_meta(path):
    """universe.txt -> {SYM: {"name": ..., "industry": ...}} (SYMBOL|Name|Industry lines)."""
    out = {}
    if not path or not os.path.exists(path):
        return out
    try:
        text = _read_text(path)
    except OSError:
        return out
    if text.lstrip().startswith(("{", "[")):
        return out
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#") or "|" not in ln:
            continue
        parts = [x.strip() for x in ln.split("|")]
        meta = {}
        if len(parts) > 1 and parts[1]:
            meta["name"] = parts[1]
        if len(parts) > 2 and parts[2]:
            meta["industry"] = parts[2]
        if meta:
            out[plain(parts[0])] = meta
    return out


# ---------------------------------------------------------------- daily setups

def rsi(closes, n=14):
    """Wilder's RSI on closes (the same math as the reel's refs/scan.py)."""
    if len(closes) < n + 1:
        return None
    g = [max(0.0, closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    lo = [max(0.0, closes[i - 1] - closes[i]) for i in range(1, len(closes))]
    ag, al = sum(g[:n]) / n, sum(lo[:n]) / n
    for i in range(n, len(g)):
        ag = (ag * (n - 1) + g[i]) / n
        al = (al * (n - 1) + lo[i]) / n
    return 100 - 100 / (1 + ag / al) if al else 100.0


def daily_closes(series, now_utc):
    """[(date, close)] of COMPLETE daily bars: null closes dropped, today's bar dropped
    until the session closes, anything dated after the clock dropped."""
    now = to_eastern(now_utc)
    today = now.date()
    s = session(today)
    today_done = s is None or now.time() >= s[1]
    out = {}
    for ts, c in zip(series["t"], series["c"]):
        if c is None:
            continue
        d = ts_to_eastern(ts).date()
        if d > today or (d == today and not today_done):
            continue
        out[d] = float(c)  # one bar a day: a late duplicate (the live tick) wins
    return sorted(out.items())


def avg_traded_value(series, now_utc, n=20):
    """Average daily traded value (close x volume) over the last n COMPLETE daily bars, when the
    series carries volumes (a v8 chart). A spark answer has closes only: then the last session's
    regularMarketPrice x regularMarketVolume from the meta. None when neither is known."""
    v = series.get("v")
    if v:
        now = to_eastern(now_utc)
        today = now.date()
        s = session(today)
        today_done = s is None or now.time() >= s[1]
        per = {}
        for ts, c, vol in zip(series["t"], series["c"], v):
            if c is None or vol is None:
                continue
            d = ts_to_eastern(ts).date()
            if d > today or (d == today and not today_done):
                continue
            per[d] = float(c) * float(vol)
        vals = [per[d] for d in sorted(per)][-n:]
        if vals:
            return sum(vals) / len(vals)
    meta = series.get("meta") or {}
    price, vol = meta.get("regularMarketPrice"), meta.get("regularMarketVolume")
    if price is None or vol is None:
        return None
    return float(price) * float(vol)


def find_setups(closes):
    """closes (oldest first, >= 30) -> (setup keys, numbers)."""
    c = closes
    last = c[-1]
    hi20 = max(c[-21:-1])
    ma20 = sum(c[-20:]) / 20.0
    ma20_prev = sum(c[-21:-1]) / 20.0
    run = c[-6] / c[-16] - 1
    rng5 = (max(c[-5:]) - min(c[-5:])) / last
    r = rsi(c)
    r_prev = rsi(c[:-1])
    tags = []
    if last > hi20:
        tags.append("breakout_20d")
    if run > 0.10 and rng5 < 0.05:
        tags.append("bull_flag")
    if c[-2] < ma20_prev and last > ma20:
        tags.append("reclaim_ma20")
    if r is not None and r < 30:
        tags.append("oversold")
    if r_prev is not None and r_prev < 30 and last > c[-2]:
        tags.append("oversold_bounce")
    return tags, {"rsi": r, "rsi_prev": r_prev, "high20": hi20, "ma20": ma20,
                  "run_pct": run * 100, "range5_pct": rng5 * 100}


def scan_daily(data, symbols, now_utc, min_price, min_volume, min_value=0.0):
    """Pure. data = {SYM: series}. min_value = average daily traded value floor in the market's
    currency (rupees in India; 0 = off). Returns (hits, counts, last_date)."""
    hits, dates = [], {}
    counts = {"requested": len(symbols), "fetched": 0, "illiquid": 0, "short": 0, "scanned": 0}
    for sym in symbols:
        s = data.get(sym)
        if not s:
            continue
        counts["fetched"] += 1
        bars = daily_closes(s, now_utc)
        meta = s.get("meta") or {}
        price = meta.get("regularMarketPrice")
        if price is None and bars:
            price = bars[-1][1]
        vol = meta.get("regularMarketVolume")
        if price is None or price < min_price or (min_volume > 0 and (vol is None or vol < min_volume)):
            counts["illiquid"] += 1
            continue
        value = avg_traded_value(s, now_utc) if min_value > 0 or MK.code != "US" else None
        if min_value > 0 and (value is None or value < min_value):
            counts["illiquid"] += 1
            continue
        if len(bars) < MIN_DAILY_BARS:
            counts["short"] += 1
            continue
        counts["scanned"] += 1
        d_last = bars[-1][0]
        dates[d_last] = dates.get(d_last, 0) + 1
        closes = [c for _, c in bars]
        tags, nums = find_setups(closes)
        if tags:
            hit = {"symbol": sym, "setups": tags, "price": round(closes[-1], 2),
                   "close_date": d_last.isoformat(), "rsi": round(nums["rsi"], 1),
                   "volume": int(vol) if vol is not None else None}
            if MK.code != "US":
                hit["traded_value_cr"] = round(value / CRORE, 2) if value is not None else None
            hits.append(hit)
    if MK.code == "US":
        hits.sort(key=lambda h: (-(h["price"] * (h["volume"] or 0)), h["symbol"]))  # most dollars traded first
    else:
        hits.sort(key=lambda h: (-(h.get("traded_value_cr") or 0), -(h["price"] * (h["volume"] or 0)),
                                 h["symbol"]))  # most rupees traded first
    last_date = max(dates, key=lambda d: (dates[d], d)) if dates else None
    counts["hits"] = len(hits)
    return hits, counts, last_date


# ---------------------------------------------------------------- opening-range breakout

def slot(day, k):
    return datetime.datetime.combine(day, OPEN) + datetime.timedelta(minutes=BAR_MIN * k)


def session_bars(series, day, cutoff):
    """5-minute bars of `day` that are complete at `cutoff` (naive exchange-local time),
    on the grid, with a close. Sorted, one per slot."""
    s = session(day)
    close_t = s[1] if s else CLOSE
    out = {}
    hs, ls = series.get("h"), series.get("l")
    for i, ts in enumerate(series["t"]):
        c = series["c"][i]
        if c is None:
            continue
        et = ts_to_eastern(ts)
        if et.date() != day or et.second or et.minute % BAR_MIN:
            continue  # another day, or the live tick off the grid
        if et.time() < OPEN or et.time() >= close_t:
            continue  # pre-open / pre-market, after hours, the closing print (15:30 IST, 4:00 PM ET)
        if et + datetime.timedelta(minutes=BAR_MIN) > cutoff:
            continue  # still in progress at the cutoff
        v = series.get("v")
        out[et] = {"start": et, "c": float(c),
                   "h": None if not hs or hs[i] is None else float(hs[i]),
                   "l": None if not ls or ls[i] is None else float(ls[i]),
                   "v": (v[i] or 0) if v else 0}
    return [out[k] for k in sorted(out)]


def usable(bars, day, cutoff, n_range):
    """Every slot from the open (9:15 IST, 9:30 ET) to the cutoff is there, and at least the range."""
    want = int((cutoff - slot(day, 0)).total_seconds() // (BAR_MIN * 60))
    s = session(day)
    if s:
        want = min(want, int((datetime.datetime.combine(day, s[1]) - slot(day, 0)).total_seconds()
                             // (BAR_MIN * 60)))
    if want < n_range or len(bars) != want:
        return False
    return all(b["start"] == slot(day, k) for k, b in enumerate(bars))


def orb_candidate(bars, n_range):
    """Stage 1, closes only: some completed bar after the range closed at or above
    the highest close of the range. Necessary for a breakout (range high >= any range close)."""
    top = max(b["c"] for b in bars[:n_range])
    return any(b["c"] >= top for b in bars[n_range:])


def orb_hit(bars, n_range):
    """Stage 2, real highs and lows: the first completed bar to CLOSE above the range high."""
    rng = bars[:n_range]
    if any(b["h"] is None or b["l"] is None for b in rng):
        return None
    oh = max(b["h"] for b in rng)
    ol = min(b["l"] for b in rng)
    for k in range(n_range, len(bars)):
        b = bars[k]
        if b["c"] > oh:
            closes_at = b["start"] + datetime.timedelta(minutes=BAR_MIN)
            return {"price": round(b["c"], 2), "at": clock_label(closes_at),
                    "bar_start": b["start"].strftime("%H:%M"), "bar_index": k,
                    "or_high": round(oh, 2), "or_low": round(ol, 2),
                    "pct_over": round((b["c"] / oh - 1) * 100, 2), "_t": closes_at}
    return None


def orb_window(now_utc, at, or_minutes, until, explicit_day=None):
    """-> (day, cutoff naive exchange-local time) or raise ScanError with the plain message."""
    now = to_eastern(now_utc)
    day = explicit_day or now.date()
    if or_minutes < BAR_MIN or or_minutes % BAR_MIN or or_minutes > 120:
        raise ScanError("--or-minutes wants a multiple of 5 from 5 to 120 (15 is the classic)")
    ok, why = trading_day(day)
    if not ok:
        special = MK.special_sessions.get(day.isoformat()) if MK.code != "US" else None
        raise ScanError("No session on %s (%s): the market is closed.%s Run orb on a trading day "
                        "after the opening range, or replay a past day with --offline." % (
                            day_label(day), why,
                            (" Note: %s; the scanner does not scan it." % special) if special else ""))
    s = session(day)
    range_end = slot(day, or_minutes // BAR_MIN)
    first_close = range_end + datetime.timedelta(minutes=BAR_MIN)
    close_dt = datetime.datetime.combine(day, s[1])
    if at is not None:
        cutoff = datetime.datetime.combine(day, at)
        if explicit_day is None and cutoff > now + datetime.timedelta(seconds=59):
            raise ScanError("--at %s is later than now (%s %s)." % (at.strftime("%H:%M"), clock_label(now), TZ))
        if cutoff > close_dt:
            raise ScanError("--at %s is after the %s close on %s." % (at.strftime("%H:%M"), clock_label(close_dt),
                                                                       day_label(day)))
    else:
        cutoff = now.replace(second=0, microsecond=0)
        if cutoff >= close_dt:
            raise ScanError("The market closed at %s %s on %s. Replay the session with --at %s."
                            % (clock_label(close_dt), TZ, day_label(day), EXAMPLE_AT))
    if cutoff < first_close:
        raise ScanError("It is %s %s: the %d-minute opening range runs %s to %s and the first bar after it "
                        "closes at %s. Run orb again after %s."
                        % (clock_label(cutoff), TZ, or_minutes, clock_label(OPEN), clock_label(range_end),
                           clock_label(first_close), clock_label(first_close)))
    if until is not None and cutoff.time() > until:
        raise ScanError("It is %s %s, after %s, your last time for new entries (no_entries_after): an "
                        "opening-range breakout found now is expired. Run orb %s after %s, or replay "
                        "today with --at %s." % (clock_label(cutoff), TZ, until.strftime("%H:%M"),
                                                   "tomorrow" if MK.code == "US" else "on " + next_session_label(day),
                                                   clock_label(first_close), EXAMPLE_AT))
    return day, cutoff


def scan_orb(stage1, symbols, day, cutoff, or_minutes, min_price=0.0, min_volume=0, confirm=None,
             max_confirm=None, min_value=0.0):
    """stage1 = {SYM: series} with closes (spark or v8). confirm(sym) -> series with highs/lows
    (None = use the stage-1 series). With confirm and max_confirm, only the max_confirm most
    traded candidates (price x volume so far) are confirmed; the rest are counted as unconfirmed.
    Returns (hits, counts, failed {sym: why})."""
    n_range = or_minutes // BAR_MIN
    counts = {"requested": len(symbols), "fetched": 0, "unusable": 0, "illiquid": 0, "scanned": 0,
              "candidates": 0, "confirmed": 0, "unconfirmed": 0}
    hits, failed, cands = [], {}, []
    for sym in symbols:
        s = stage1.get(sym)
        if not s:
            continue
        counts["fetched"] += 1
        bars = session_bars(s, day, cutoff)
        if not usable(bars, day, cutoff, n_range):
            counts["unusable"] += 1
            continue
        vol = sum(b["v"] for b in bars) if s.get("v") else (s.get("meta") or {}).get("regularMarketVolume") or 0
        if bars[-1]["c"] < min_price or vol < min_volume or (min_value > 0 and bars[-1]["c"] * vol < min_value):
            counts["illiquid"] += 1
            continue
        counts["scanned"] += 1
        if orb_candidate(bars, n_range):
            cands.append((sym, bars, bars[-1]["c"] * vol))
    counts["candidates"] = len(cands)
    if confirm is not None and max_confirm and len(cands) > max_confirm:
        cands.sort(key=lambda x: -x[2])
        counts["unconfirmed"] = len(cands) - max_confirm
        cands = cands[:max_confirm]
    for sym, bars, _ in cands:
        full = bars
        if confirm is not None:
            try:
                s2 = confirm(sym)
            except ScanError as e:
                failed[sym] = str(e)
                continue
            full = session_bars(s2, day, cutoff)
            if not usable(full, day, cutoff, n_range):
                failed[sym] = "the v8 chart has a missing bar"
                continue
        counts["confirmed"] += 1
        h = orb_hit(full, n_range)
        if h:
            hits.append(dict({"symbol": sym, "setups": ["orb"]}, **h))
    hits.sort(key=lambda x: (x["_t"], x["symbol"]))
    for h in hits:
        del h["_t"]
    counts["hits"] = len(hits)
    return hits, counts, failed


# ---------------------------------------------------------------- fetching

def progress(a, msg):
    if not getattr(a, "json", False) and not getattr(a, "quiet", False):
        print(msg, file=sys.stderr)


def fetch_spark(symbols, rng, interval, pause, a=None):
    """Batches of 20. -> ({SYM: series}, {SYM: error})."""
    data, failed = {}, {}
    batches = [symbols[i:i + SPARK_MAX] for i in range(0, len(symbols), SPARK_MAX)]
    for k, batch in enumerate(batches):
        if k and pause:
            SLEEP(pause)
        wanted = {to_yahoo(s): s for s in batch}
        try:
            got = parse_spark(yahoo_get(spark_path(batch, rng, interval)), wanted)
        except (ScanError, ValueError) as e:
            for s in batch:
                failed[s] = str(e)
            continue
        for s in batch:
            if s in got:
                data[s] = got[s]
            else:
                failed[s] = "no data from Yahoo"
        if a is not None and len(batches) > 25 and (k + 1) % 50 == 0:
            progress(a, "  spark %d of %d requests" % (k + 1, len(batches)))
    return data, failed


def read_symbols(a, offline_syms=None):
    if a.symbols:
        syms = [plain(s) for s in re.split(r"[,\s]+", a.symbols.upper()) if s]
    elif a.watchlist:
        syms = symbols_from_file(a.watchlist)
    elif offline_syms is not None and not a.universe:
        syms = sorted(offline_syms)  # offline: every chart in the file, unless a list was given
    else:
        path = a.universe or DEFAULT_UNIVERSE
        if not os.path.exists(path):
            raise ScanError("no %s yet: run `scan.py universe` first, or pass --symbols" % path)
        syms = symbols_from_file(path)
    out = []
    for s in syms:
        if s not in out:
            out.append(s)
    if a.limit:
        out = out[:a.limit]
    if not out:
        raise ScanError("no symbols to scan")
    return out


def symbols_from_file(path):
    if not os.path.exists(path):
        raise ScanError("no file at %s" % path)
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if text.lstrip().startswith(("{", "[")):
        try:
            doc = json.loads(text)
        except ValueError as e:
            raise ScanError("%s is not valid JSON: %s" % (path, e))
        items = doc.get("hits", []) if isinstance(doc, dict) else doc
        return [plain(x.get("symbol") if isinstance(x, dict) else x) for x in items if x]
    out = []
    for ln in text.splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("#"):
            out.append(plain(ln.split("|")[0]))
    return out


def read_config(path):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except ValueError as e:
        raise ScanError("%s is not valid JSON: %s" % (path, e))
    return cfg if isinstance(cfg, dict) else {}


def write_json(path, doc):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


def money(x):
    """'$364.18' in US mode, '₹2,945.60' in India (lakh / crore grouping)."""
    return MK.money(x)


def crore(x):
    """A rupee-crore figure for text: 10 -> '₹10 crore', 0.5 -> '₹0.5 crore'."""
    return "%s%s crore" % (MK.symbol, _n(x))


# ---------------------------------------------------------------- commands

def cmd_universe(a):
    if MK.code == "US":
        if a.index or a.file or a.index_file:
            raise ScanError("--index, --file and --index-file are for the India market (NSE)")
        return cmd_universe_us(a)
    return cmd_universe_in(a)


def _nse_source(label, url, cache_path, offline_path, a, notes):
    """The text of one NSE CSV: from a file when given, else the network (saved to the cache),
    else the cache with a note. -> text."""
    if offline_path:
        if not os.path.exists(offline_path):
            raise ScanError("no %s at %s" % (label, offline_path))
        text = _read_text(offline_path)
        if not a.no_write and cache_path and os.path.abspath(offline_path) != os.path.abspath(cache_path):
            _write_text(cache_path, text)
        return text
    try:
        text = nse_get(url)
    except ScanError as e:
        if cache_path and os.path.exists(cache_path):
            when = datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=int(os.path.getmtime(cache_path)))
            notes.append("NSE could not be reached (%s): used the cached %s of %s %s."
                         % (e, cache_path, to_eastern(when).strftime("%Y-%m-%d %H:%M"), TZ))
            return _read_text(cache_path)
        raise
    if not text.strip() or text.lstrip().startswith("<"):
        raise ScanError("archives.nseindia.com sent a web page, not %s: try again later" % label)
    if not a.no_write and cache_path:
        _write_text(cache_path, text)
    return text


def cmd_universe_in(a):
    t0 = time.time()
    index = (a.index or "nifty500").lower().replace(" ", "").replace("_", "")
    if index not in NSE_INDICES:
        raise ScanError("--index wants one of %s" % ", ".join(NSE_INDICES))
    cache = a.cache_dir or os.path.join(os.path.dirname(a.out) or ".", "cache")
    eq_file, idx_file = a.file, a.index_file
    idx_name = "ind_%slist.csv" % index
    if a.offline:
        eq_file = eq_file or os.path.join(a.offline, NSE_EQUITY_FILE)
        if index != "all":
            idx_file = idx_file or os.path.join(a.offline, idx_name)
    notes = []
    eq_text = _nse_source(NSE_EQUITY_FILE, NSE_EQUITY_URL, os.path.join(cache, NSE_EQUITY_FILE), eq_file, a, notes)
    idx_text = None
    if index != "all":
        if not eq_file and a.pause:
            SLEEP(a.pause)
        idx_text = _nse_source(idx_name, NSE_INDEX_URL % index, os.path.join(cache, idx_name), idx_file, a, notes)
    kept, counts = build_nse_universe(eq_text, idx_text)
    if not a.no_write:
        d = os.path.dirname(a.out)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as fh:
            for sym, name, industry in kept:
                fh.write("%s|%s|%s\n" % (sym, name, industry))
    not_eq = dict((k, v) for k, v in counts.items() if k.startswith("series "))
    if a.json:
        print(json.dumps({"market": MK.code, "exchange": MK.exchange, "index": index, "count": len(kept),
                          "rows": counts.get("rows", 0), "eq": counts.get("eq", 0),
                          "index_rows": counts.get("index"), "dropped_series": not_eq,
                          "index_not_eq": counts.get("not EQ in EQUITY_L", 0), "notes": notes,
                          "cache": None if a.no_write else cache, "out": None if a.no_write else a.out,
                          "seconds": round(time.time() - t0, 1)}, indent=2))
    else:
        for n in notes:
            print(n)
        print("NSE equity list (EQUITY_L.csv): %s rows, %s in the EQ series." % (
            "{:,}".format(counts.get("rows", 0)), "{:,}".format(counts.get("eq", 0))))
        if not_eq:
            print("Dropped (trade-to-trade and other series, not for intraday): " + ", ".join(
                "%s %s" % ("{:,}".format(v), k) for k, v in sorted(not_eq.items(), key=lambda kv: -kv[1])) + ".")
        if index == "all":
            print("Kept %s NSE EQ-series stocks (--index all)." % "{:,}".format(len(kept)))
        else:
            extra = counts.get("not EQ in EQUITY_L", 0)
            print("Kept %s of the %s %s members%s." % (
                "{:,}".format(len(kept)), "{:,}".format(counts.get("index", 0)), index.upper().replace("NIFTY",
                                                                                                     "Nifty "),
                (" (%d not in the EQ series today)" % extra) if extra else ""))
        if not a.no_write:
            print("Wrote %s (one SYMBOL|Company Name|Industry a line) and cached the raw CSV in %s." % (a.out, cache))
    return 0 if kept else 1


def cmd_universe_us(a):
    t0 = time.time()
    texts = {}
    for k, fname in enumerate(NASDAQ_FILES):
        if a.offline:
            p = os.path.join(a.offline, fname)
            if not os.path.exists(p):
                raise ScanError("no %s in %s" % (fname, a.offline))
            with open(p, encoding="utf-8", errors="replace") as fh:
                texts[fname] = fh.read()
        else:
            if k and a.pause:
                SLEEP(a.pause)
            try:
                texts[fname] = http_get(NASDAQ_URL + fname, timeout=60)
            except urllib.error.HTTPError as e:
                raise ScanError("nasdaqtrader.com answered HTTP %d for %s" % (e.code, fname))
            except (urllib.error.URLError, OSError) as e:
                raise ScanError("could not reach nasdaqtrader.com: %s" % getattr(e, "reason", e))
    kept, counts, created = build_universe(texts)
    if not a.no_write:
        d = os.path.dirname(a.out)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as fh:
            for sym, name in kept:
                fh.write("%s|%s\n" % (sym, name))
    dropped = {k: v for k, v in counts.items() if k not in ("keep", "rows")}
    if a.json:
        print(json.dumps({"count": len(kept), "rows": counts.get("rows", 0), "files_created": created,
                          "dropped": dropped, "out": None if a.no_write else a.out,
                          "seconds": round(time.time() - t0, 1)}, indent=2))
    else:
        print("Nasdaq Trader symbol directories%s: %s rows." % (
            (", files of %s ET" % created) if created else "", "{:,}".format(counts.get("rows", 0))))
        print("Kept %s US-listed common stocks, ordinary shares and ADRs." % "{:,}".format(len(kept)))
        print("Dropped: " + ", ".join("%s %s" % ("{:,}".format(v), k)
                                      for k, v in sorted(dropped.items(), key=lambda kv: -kv[1])) + ".")
        if not a.no_write:
            print("Wrote %s (one SYMBOL|Name a line)." % a.out)
    return 0 if kept else 1


def cmd_daily(a):
    t0 = time.time()
    now = parse_now(a.now)
    offline_syms = None
    if a.offline:
        data, failed = load_offline(a.offline)
        offline_syms = sorted(set(data) | set(failed))
    symbols = read_symbols(a, offline_syms)
    if not a.offline:
        progress(a, "Fetching daily closes for %s symbols (%d spark requests)..."
                 % ("{:,}".format(len(symbols)), (len(symbols) + SPARK_MAX - 1) // SPARK_MAX))
        data, failed = fetch_spark(symbols, "3mo", "1d", a.pause, a)
    hits, counts, last_date = scan_daily(data, symbols, now, a.min_price, a.min_volume, a.min_value_cr * CRORE)
    nfailed = len(symbols) - counts["fetched"]
    as_of = ("%s close" % last_date.isoformat()) if last_date else None
    _add_names(a, hits)
    doc = {"created_by": "trader-scanner", "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "mode": "daily",
           "as_of": as_of, "universe": len(symbols), "scanned": counts["scanned"], "failed": nfailed,
           "source": "yahoo", "filters": _filters(a), "note": NOTE, "hits": hits}
    _mark(doc)
    if calendar_note(to_eastern(now).date()):
        doc["calendar_known"] = False
    if a.offline:
        doc["offline"] = os.path.basename(a.offline.rstrip("/"))
    if not a.no_write:
        write_json(a.out, doc)
    if a.json:
        print(json.dumps(dict(doc, counts=counts, seconds=round(time.time() - t0, 1)), indent=2))
        return 0 if hits else 1
    local = to_eastern(now)
    print("Daily scan, %s %s, closes through %s (Yahoo spark, daily closes only)." % (
        local.strftime("%a %Y-%m-%d %H:%M"), TZ, last_date.isoformat() if last_date else "nothing"))
    if calendar_note(local.date()):
        print(calendar_note(local.date()))
    if MK.code == "US":
        floor = "$%s+ and %s+ shares" % (_n(a.min_price), "{:,}".format(a.min_volume))
    else:
        floor = "%s%s+ and %s+ traded a day" % (MK.symbol, _n(a.min_price), crore(a.min_value_cr))
        if a.min_volume:
            floor += ", %s+ shares" % "{:,}".format(a.min_volume)
    print("Fetched %s of %s charts%s. %s passed the liquidity filter (%s)%s; "
          "%s scanned." % ("{:,}".format(counts["fetched"]), "{:,}".format(len(symbols)),
                           (" (%s failed or had no data)" % "{:,}".format(nfailed)) if nfailed else "",
                           "{:,}".format(counts["fetched"] - counts["illiquid"]), floor,
                           (", %d had under %d days" % (counts["short"], MIN_DAILY_BARS)) if counts["short"] else "",
                           "{:,}".format(counts["scanned"])))
    if hits:
        per = [(k, sum(1 for h in hits if k in h["setups"])) for k, _ in SETUPS]
        print("%d chart%s matched a setup: %s." % (len(hits), "" if len(hits) == 1 else "s",
                                                  ", ".join("%d %s" % (n, LABEL[k]) for k, n in per if n)))
        print("Most traded first (%s):" % ("price x volume" if MK.code == "US" else "rupees traded a day"))
    else:
        print("No setups.")
    for h in hits[:a.show]:
        if MK.code == "US":
            print("  %-6s %10s  RSI %5.1f  %s" % (h["symbol"], money(h["price"]), h["rsi"],
                                                  ", ".join(LABEL[t] for t in h["setups"])))
        else:
            tv = h.get("traded_value_cr")
            print("  %-10s %12s  RSI %5.1f  %9s  %s" % (h["symbol"], money(h["price"]), h["rsi"],
                                                        ("%s cr" % _p(tv)) if tv is not None else "-",
                                                        ", ".join(LABEL[t] for t in h["setups"])))
    if len(hits) > a.show:
        print("  ... and %d more in the watchlist (--show N for more)." % (len(hits) - a.show))
    if not a.no_write:
        print("Wrote %s (mode daily, %d hit%s)." % (a.out, len(hits), "" if len(hits) == 1 else "s"))
    print(NOTE + " Next: pick one chart, then /trader-news TICKER.")
    return 0 if hits else 1


def _n(x):
    x = float(x)
    return str(int(x)) if x == int(x) else "%.2f" % x


def cmd_orb(a):
    t0 = time.time()
    now = parse_now(a.now)
    at = parse_hhmm(a.at) if a.at else None
    cfg = read_config(a.config)
    until = parse_hhmm(a.until or cfg.get("no_entries_after") or DEFAULTS.get("no_entries_after") or "15:30",
                       "--until")
    data = failed = None
    explicit_day = None
    offline_syms = None
    if a.offline:
        data, failed = load_offline(a.offline)
        offline_syms = sorted(set(data) | set(failed))
        if not a.now:
            days = [ts_to_eastern(s["t"][-1]).date() for s in data.values() if s["t"]]
            if days:
                explicit_day = max(days)
                if at is None:
                    raise ScanError("offline replay: give --at HH:MM or --now \"YYYY-MM-DD HH:MM\"")
    day, cutoff = orb_window(now, at, a.or_minutes, until, explicit_day)
    symbols = read_symbols(a, offline_syms)
    confirm = None
    if not a.offline:
        today = to_eastern(parse_now(None)).date()
        if (today - day).days > 6:
            raise ScanError("Yahoo's free 5-minute history is short: replay %s with --offline" % day.isoformat())
        rng = "1d" if day == today else "5d"
        progress(a, "Stage 1: 5-minute closes for %s symbols (%d spark requests)..."
                 % ("{:,}".format(len(symbols)), (len(symbols) + SPARK_MAX - 1) // SPARK_MAX))
        data, failed = fetch_spark(symbols, rng, "%dm" % BAR_MIN, a.pause, a)
        done = []

        def confirm(sym):
            if a.pause:
                SLEEP(a.pause)
            done.append(sym)
            if len(done) % 50 == 0:
                progress(a, "  stage 2: %d v8 charts so far" % len(done))
            return parse_chart(yahoo_get(chart_path(sym, rng, "%dm" % BAR_MIN)), sym)
    hits, counts, failed2 = scan_orb(data, symbols, day, cutoff, a.or_minutes, a.min_price, a.min_volume, confirm,
                                     a.max_confirm, a.min_value_cr * CRORE)
    _add_names(a, hits)
    failed = dict(failed or {})
    failed.update(failed2)
    nfailed = len([s for s in symbols if s in failed])
    as_of = "%s %s %s" % (day.isoformat(), cutoff.strftime("%H:%M"), TZ)
    doc = {"created_by": "trader-scanner", "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "mode": "orb",
           "as_of": as_of, "universe": len(symbols), "scanned": counts["scanned"], "failed": nfailed,
           "unconfirmed": counts["unconfirmed"], "source": "yahoo", "or_minutes": a.or_minutes,
           "interval": "%dm" % BAR_MIN,
           "filters": _filters(a), "note": NOTE, "hits": hits}
    _mark(doc)
    if calendar_note(day):
        doc["calendar_known"] = False
    if a.offline:
        doc["offline"] = os.path.basename(a.offline.rstrip("/"))
    if not a.no_write:
        write_json(a.out, doc)
    if a.json:
        print(json.dumps(dict(doc, counts=counts, seconds=round(time.time() - t0, 1)), indent=2))
        return 0 if hits else 1
    print("Opening-range breakout scan, %s %s %s: %d-minute range (%s to %s), 5-minute bars, Yahoo."
          % (day_label(day), clock_label(cutoff), TZ, a.or_minutes, clock_label(OPEN),
             clock_label(slot(day, a.or_minutes // BAR_MIN))))
    print("Fetched %s of %s charts%s; %s usable%s; %s candidates, %s confirmed with real highs and lows."
          % ("{:,}".format(counts["fetched"]), "{:,}".format(len(symbols)),
             (" (%s failed or had no data)" % "{:,}".format(nfailed)) if nfailed else "",
             "{:,}".format(counts["scanned"]),
             (" (%s under the price / %s floor)" % ("{:,}".format(counts["illiquid"]),
                                                    "volume" if MK.code == "US" else "traded-value"))
             if counts["illiquid"] else "",
             "{:,}".format(counts["candidates"]), "{:,}".format(counts["confirmed"])))
    if calendar_note(day):
        print(calendar_note(day))
    if counts["unconfirmed"]:
        print("PARTIAL: %s more candidates were not checked (only the %s most traded are; --max-confirm 0 "
              "checks all)." % ("{:,}".format(counts["unconfirmed"]), "{:,}".format(a.max_confirm)))
    if hits:
        print("%d of %s charts closed above their opening-range high by %s:"
              % (len(hits), ("the %s checked" % "{:,}".format(counts["confirmed"])) if counts["unconfirmed"]
                 else "{:,}".format(counts["scanned"]), clock_label(cutoff)))
        for h in hits[:a.show]:
            print(("  %8s  %-6s %10s  range %s to %s  %+.2f%% over" if MK.code == "US" else
                   "  %8s  %-10s %12s  range %s to %s  %+.2f%% over") % (
                h["at"], h["symbol"], money(h["price"]), _p(h["or_low"]), _p(h["or_high"]), h["pct_over"]))
        if len(hits) > a.show:
            print("  ... and %d more in the watchlist (--show N for more)." % (len(hits) - a.show))
    else:
        print("No chart closed above its opening-range high by %s." % clock_label(cutoff))
    if not a.no_write:
        print("Wrote %s (mode orb, %d hit%s)." % (a.out, len(hits), "" if len(hits) == 1 else "s"))
    print(NOTE + " Next: pick one chart, then /trader-news TICKER and /trader-entry TICKER.")
    return 0 if hits else 1


def _p(x):
    return "{:,.2f}".format(x) if MK.code == "US" else MK.money(x)[len(MK.symbol):]


def _filters(a):
    f = {"min_price": a.min_price, "min_volume": a.min_volume}
    if MK.code != "US":
        f["min_value_cr"] = a.min_value_cr
    return f


def _mark(doc):
    """India files carry their market and currency; US files stay as upstream wrote them."""
    if MK.code != "US":
        doc["market"] = MK.code
        doc["currency"] = MK.currency
        doc["exchange"] = MK.exchange
        doc["tz"] = MK.tz_label


def _add_names(a, hits):
    """India: copy the company name and industry from the universe file onto each hit."""
    if MK.code == "US" or not hits:
        return
    meta = read_universe_meta(a.universe or DEFAULT_UNIVERSE)
    for h in hits:
        m = meta.get(h["symbol"])
        if m:
            h.update(m)


def _config_for_market(path):
    """trader/config.json for the market choice only: unreadable means no choice."""
    try:
        return read_config(path)
    except ScanError:
        return {}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Chart Scanner (trader-scanner): daily setups and opening-range "
                                             "breakouts. India (NSE) by default, --market US for NYSE.")
    ap.add_argument("--market", help="IN (NSE, IST, rupees: the default) or US (NYSE, New York time, dollars)")
    sub = ap.add_subparsers(dest="cmd")

    def market_opt(p):
        p.add_argument("--market", default=argparse.SUPPRESS, help="IN (default) or US")
        p.add_argument("--config", default="trader/config.json",
                       help="trader/config.json (its \"market\" and no_entries_after)")

    p = sub.add_parser("universe", help="India: NSE EQUITY_L + an index list; US: Nasdaq Trader's lists "
                                        "-> trader/universe.txt")
    market_opt(p)
    p.add_argument("--out", default=DEFAULT_UNIVERSE)
    p.add_argument("--offline", metavar="DIR", help="India: a folder with EQUITY_L.csv and ind_<index>list.csv; "
                                                    "US: a folder with nasdaqlisted.txt and otherlisted.txt")
    p.add_argument("--index", help="India: nifty50, nifty100, nifty200, nifty500 (default) or all")
    p.add_argument("--file", metavar="CSV", help="India: read this EQUITY_L.csv instead of the network")
    p.add_argument("--index-file", metavar="CSV", help="India: read this ind_<index>list.csv instead of the network")
    p.add_argument("--cache-dir", help="India: where the raw NSE CSVs are cached (default trader/cache)")
    p.add_argument("--no-write", action="store_true")
    p.add_argument("--pause", type=float, default=PAUSE)
    p.add_argument("--json", action="store_true")

    def common(p):
        market_opt(p)
        g = p.add_mutually_exclusive_group()
        g.add_argument("--symbols", help="comma-separated symbols instead of the universe (RELIANCE,TCS or "
                                         "RELIANCE.NS; US: TSLA,NVDA)")
        g.add_argument("--watchlist", metavar="FILE", help="a watchlist.json (hits) or a text file of symbols")
        p.add_argument("--universe", help="symbol list, one SYMBOL|Name a line (default %s)" % DEFAULT_UNIVERSE)
        p.add_argument("--limit", type=int, help="scan only the first N symbols")
        p.add_argument("--min-price", type=float, help="last price floor (India ₹50, US $5)")
        p.add_argument("--min-volume", type=int, help="share volume floor (India 0, US daily 1,000,000)")
        p.add_argument("--min-value-cr", type=float,
                       help="India: traded value floor in rupee crore (daily: average a day, 10; orb: so far "
                            "today, 1). 0 turns it off")
        p.add_argument("--offline", metavar="PATH", help="fixture folder or file instead of the network")
        p.add_argument("--now", help='pretend it is this time ("2026-10-19 10:00" exchange time, or ...Z)')
        p.add_argument("--out", default="trader/watchlist.json")
        p.add_argument("--no-write", action="store_true")
        p.add_argument("--pause", type=float, default=PAUSE, help="seconds between requests (%.1f)" % PAUSE)
        p.add_argument("--show", type=int, default=50, help="hits to print (all are written)")
        p.add_argument("--quiet", action="store_true")
        p.add_argument("--json", action="store_true")

    p = sub.add_parser("daily", help="pre-market setups from daily closes")
    common(p)
    p = sub.add_parser("orb", help="opening-range breakouts so far today")
    common(p)
    p.add_argument("--or-minutes", type=int, default=15)
    p.add_argument("--max-confirm", type=int, default=MAX_CONFIRM,
                   help="v8 charts to fetch in stage 2, most traded first (%d; 0 = all)" % MAX_CONFIRM)
    p.add_argument("--at", help="cut the clock at this exchange time, HH:MM (IST in India, ET in US mode)")
    p.add_argument("--until", help="no new entries after HH:MM (default: config no_entries_after, "
                                   "else 14:45 IST / 15:30 ET)")
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 1
    try:
        cfg = market.normalize_config(_config_for_market(getattr(a, "config", None)))
        apply_market(market.resolve(getattr(a, "market", None), cfg))
    except market.MarketError as e:
        print("scan.py: %s" % e, file=sys.stderr)
        return 1
    if a.cmd in FLOORS:
        price, vol, value = FLOORS[a.cmd]
        if a.min_price is None:
            a.min_price = price
        if a.min_volume is None:
            a.min_volume = vol
        if a.min_value_cr is None:
            a.min_value_cr = value
        if MK.code == "US":
            a.min_value_cr = 0.0
    try:
        return {"universe": cmd_universe, "daily": cmd_daily, "orb": cmd_orb}[a.cmd](a)
    except ScanError as e:
        print("scan.py: %s" % e, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("scan.py: stopped", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
