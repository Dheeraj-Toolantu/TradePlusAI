#!/usr/bin/env python3
"""News monitor for trader-news. Standard library only.

Watches headlines and exchange filings for the stocks you watch or hold and
prints only what is new since the last check, newest first, with how far each
stock has moved today and a flag on anything that touches your tickers.
India (NSE, IST) is the default market; --market US gives the original
Yahoo + SEC 8-K behaviour in New York time.

    python3 news.py                                  # watchlist + plan + portfolio tickers
    python3 news.py --tickers RELIANCE TCS INFY
    python3 news.py --tickers HDFCBANK --all --hours 72  # everything in the last 3 days, seen or not
    python3 news.py --no-filings                     # headlines only (same as --no-sec)
    python3 news.py --no-moves                       # skip the price line per ticker
    python3 news.py --market US --tickers TSLA       # Yahoo headlines + SEC 8-Ks, New York time

Your tickers, when --tickers is not given: every hit in trader/watchlist.json
(trader-scanner), the symbol in trader/plan.json (trader-exit) and the
positions in trader/portfolio.json. India symbols are plain NSE symbols
(RELIANCE, M&M); ".NS" is accepted and dropped.

India sources (--market IN, the default):
  - Google News RSS, one search per ticker, the company name and the symbol:
    https://news.google.com/rss/search?q=%22Reliance%20Industries%22%20OR%20RELIANCE.NS&hl=en-IN&gl=IN&ceid=IN:en
  - optional (--yahoo): Yahoo Finance headline RSS for the NSE symbol:
    https://feeds.finance.yahoo.com/rss/2.0/headline?s=RELIANCE.NS&region=IN&lang=en-IN
  - NSE filings, three RSS 2.0 feeds read once per check (not per ticker) and
    matched to your tickers by company name (an item's title starts with it):
      announcements  https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml
      results        https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml
      board meetings https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml
  - company names: --names FILE or trader/names.json ({"RELIANCE": "Reliance
    Industries Limited"}), the name in the watchlist, then NSE's equity list
    trader/cache/EQUITY_L.csv (fetched from
    https://archives.nseindia.com/content/equities/EQUITY_L.csv when missing or
    over 7 days old, with a browser-like User-Agent).
  - the move: Yahoo's chart for <SYM>.NS against yesterday's close.
  No SEC User-Agent is needed in India.

US sources (--market US), one request each per ticker:
  - Yahoo Finance headline RSS:
    https://feeds.finance.yahoo.com/rss/2.0/headline?s=<TICKER>&region=US&lang=en-US
  - SEC EDGAR filings Atom feed for the company (8-K by default: earnings,
    executive changes, deals, restatements):
    https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<CIK>&type=8-K&count=10&output=atom
    SEC needs a User-Agent with your name and email (sec_user_agent in
    trader/config.json or SEC_USER_AGENT). Without one the SEC part is skipped
    and the tool says so; headlines still run.

  - The move: Yahoo Finance's chart endpoint (unofficial, can lag), the last
    price against yesterday's close:
    https://query2.finance.yahoo.com/v8/finance/chart/<TICKER>?range=1d&interval=5m

Times print in exchange time (IST in India, ET in the US). State:
trader/state/news.json remembers what you have seen (30 days), so an item
shows once. Offline: --offline DIR reads, in India, gnews-<SYM>.xml,
yahoo-<SYM>.xml, nse-announcements.xml, nse-results.xml,
nse-board-meetings.xml, EQUITY_L.csv and chart-<SYM>.json; in the US,
yahoo-<TICKER>.xml, chart-<TICKER>.json, sec-<FORM>-<CIK>.xml and
company_tickers.json. The tests use it.

Headlines are leads, not facts: open the story before acting, and treat
nothing here as advice.
"""

import argparse
import csv
import datetime as _dt
import email.utils
import gzip
import hashlib
import html
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
import xml.etree.ElementTree as ET


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

YAHOO = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=US&lang=en-US"
YAHOO_IN = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=IN&lang=en-IN"
GNEWS = "https://news.google.com/rss/search?q=%s&hl=en-IN&gl=IN&ceid=IN:en"
CHART = "https://%s.finance.yahoo.com/v8/finance/chart/%s?range=1d&interval=5m"
SEC_FEED = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=%s&type=%s"
            "&dateb=&owner=include&count=%d&output=atom")
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
NSE_FEEDS = (  # (offline file, label, url)
    ("nse-announcements.xml", "announcement",
     "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml"),
    ("nse-results.xml", "financial results",
     "https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml"),
    ("nse-board-meetings.xml", "board meeting",
     "https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml"),
)
EQUITY_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
EQUITY_CACHE = "trader/cache/EQUITY_L.csv"
EQUITY_MAX_AGE_DAYS = 7
NAMES_FILE = "trader/names.json"
PLACEHOLDER = "you@example.com"
BROWSER_UA = "Mozilla/5.0 (compatible; day-trader-skill/2.0; +https://github.com/Jakeschincariol/day-trader-skill)"
# NSE's archive hosts refuse non-browser clients, so their requests look like a browser
NSE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/124.0.0.0 Safari/537.36")
KEEP_DAYS = 30
MOVE_PCT = 3.0  # a stock this far from yesterday's close is flagged as moving
ITEMS_8K = {
    "1.01": "material agreement", "1.02": "agreement ended", "1.03": "bankruptcy",
    "1.05": "cybersecurity incident", "2.01": "acquisition or sale of assets",
    "2.02": "earnings results", "2.03": "new debt", "2.04": "debt acceleration",
    "2.05": "restructuring costs", "2.06": "impairment", "3.01": "delisting notice",
    "3.02": "unregistered share sale", "3.03": "shareholder rights change",
    "4.01": "auditor change", "4.02": "past financials no longer reliable",
    "5.01": "change in control", "5.02": "director or officer change",
    "5.03": "bylaws or fiscal year change", "5.07": "shareholder vote results",
    "7.01": "Regulation FD disclosure", "8.01": "other events", "9.01": "exhibits",
}
IMPORTANT_ITEMS = {"1.03", "1.05", "2.02", "2.04", "2.06", "3.01", "4.02", "5.01", "5.02"}
KEYWORDS_US = [
    ("earnings", r"\bearnings\b|\bresults\b|\bEPS\b|\bguidance\b|\bforecast\b"),
    ("analyst", r"\bupgrade[sd]?\b|\bdowngrade[sd]?\b|price target|\boutperform\b|\bunderperform\b"),
    ("legal", r"\blawsuit\b|\bsued\b|\bprobe\b|\binvestigation\b|\bSEC charges\b|\bantitrust\b|\bjudge\b|\bcourt\b"),
    ("deal", r"\bacqui(?:re|res|red|sition)\b|\bmerger\b|\bbuyout\b|\btakeover\b|\bdeal\b"),
    ("capital", r"\bdividend\b|\bbuyback\b|\brepurchase\b|\bstock split\b|\boffering\b"),
    ("people", r"\bCEO\b|\bCFO\b|\bresign|\bsteps down\b|\bappoint"),
    ("risk", r"\brecall\b|\bbankrupt|\bdefault\b|\bdelist|\bhack|\bbreach\b|\boutage\b"),
    ("halt", r"\bhalt(?:s|ed)?\b|\btrading (?:pause|suspen)"),
    ("regulatory", r"\bFDA\b|\bapproval\b|\bapproves\b|\bclinical\b|\bFTC\b|\bDOJ\b"),
    ("macro", r"\bFed\b|\bFOMC\b|\bCPI\b|\binflation\b|\bjobs report\b|\bpayrolls\b|\btariffs?\b|\bfutures\b"),
]
KEYWORDS = KEYWORDS_US

# India: the exchange-filing tags first, then upstream's generic ones with Indian
# regulators and macro words added.
KEYWORDS_IN_FILINGS = [
    # "results" / "financial result", "earnings", "quarterly", Q2 FY27 / Q2FY27, net profit and
    # EBITDA; PAT only in upper case (not "Pat Cummins"); a bare "result" ("as a result") is not.
    ("results", r"\bresults\b|\bfinancial results?\b|\bearnings\b|\bquarterly\b|"
                r"\bQ[1-4]\s*FY\s*'?\d{2,4}\b|\bQ[1-4]\b(?=\s+(?:numbers|profit|net|earnings|results|show))|"
                r"\bnet profit\b|\bEBITDA\b|(?-i:\bPAT\b)"),
    ("board meeting", r"\bboard meeting\b|\bmeeting of the board\b|\boutcome of (?:the )?board\b"),
    ("dividend", r"\bdividends?\b"),
    # a bonus issue, not an employee or festive "bonus"; a stock split, not a "split screen"
    ("bonus", r"\bbonus\s+(?:issue|shares?|equity|ratio)\b|\bissue of bonus\b|\b\d+\s*:\s*\d+\s+bonus\b"),
    ("split", r"\b(?:stock|share|equity)\s+split\b|\bsplit of (?:the )?(?:equity )?shares\b|"
              r"\bsub-?division\b|\bface value split\b"),
    ("buyback", r"\bbuy-?backs?\b"),
    ("rights issue", r"\brights issue\b|\brights entitlement\b"),
    ("sebi order", r"\bSEBI\b[^.]{0,60}\b(?:order|penalty|penalises|penalizes|bans?|show[- ]cause|settlement|"
                   r"adjudicat\w*)\b|\b(?:order|penalty|show[- ]cause notice)\b[^.]{0,60}\bSEBI\b"),
    ("block/bulk deal", r"\b(?:block|bulk) deals?\b"),
    ("pledge", r"\bpledg(?:e|ed|es|ing)\b|\bencumbrance\b|\bencumbered\b"),
    ("promoter", r"\bpromoters?\b"),
    ("credit rating", r"\bcredit rating\b|\b(?:CRISIL|ICRA|CARE Ratings|India Ratings|Brickwork|Acuite)\b|"
                      r"\brating (?:upgrade|downgrade|reaffirm\w*|revision)"),
    # PIT and SAST only in upper case (not a "pit stop")
    ("insider/pit", r"\binsiders?\b|(?-i:\bSAST\b)|(?-i:\bPIT\b)|\binsider trading\b|\btrading window\b"),
]
KEYWORDS_IN = KEYWORDS_IN_FILINGS + [
    (lab, rx) for lab, rx in KEYWORDS_US if lab not in ("legal", "regulatory", "macro", "risk")] + [
    # a real cyber incident (not a "hackathon"), a payment or loan default (not "default to growth")
    ("risk", r"\brecall\b|\bbankrupt|\b(?:payment|loan|debt|interest|bond|NCD|repayment)s?\s+defaults?\b|"
             r"\bdefault(?:ed|s)?\s+on\b|\bwilful defaulter|\bdefaulter\b|\bhacked\b|\bcyber[- ]?attack|"
             r"\bdata breach\b|\bsecurity breach\b|\bransomware\b|\bdelist|\boutage\b"),
    ("legal", r"\blawsuit\b|\bsued\b|\bprobe\b|\binvestigation\b|\bNCLT\b|\bNCLAT\b|\binsolvency\b|"
              r"\bED raid|\bIncome Tax (?:raid|search)|\bCCI\b|\bjudge\b|\bcourt\b"),
    ("regulatory", r"\bSEBI\b|\bRBI\b|\bIRDAI\b|\bTRAI\b|\bUSFDA\b|\bFDA\b|\bDCGI\b|\bapproval\b|\bapproves\b|"
                   r"\bclinical\b|\blicen[cs]e\b"),
    ("macro", r"\bRBI policy\b|\bMPC\b|\brepo rate\b|\bCPI\b|\bWPI\b|\binflation\b|\bGDP\b|\bFIIs?\b|\bFPIs?\b|"
              r"\bDIIs?\b|\bUnion Budget\b|\bGST\b|\btariffs?\b|\bcrude\b|\brupee\b|\bSensex\b|\bNifty\b"),
]
# an NSE filing carrying one of these tags is marked "!" (important)
IMPORTANT_IN = {"results", "sebi order", "pledge", "credit rating", "buyback", "bonus", "split",
                "rights issue", "risk", "halt"}

MK = None
TZ = "ET"


def apply_market(mk):
    """Point the module's clock, wording and tag list at market mk."""
    global MK, TZ, KEYWORDS
    MK = mk
    TZ = mk.tz_label
    KEYWORDS = KEYWORDS_US if mk.code == "US" else KEYWORDS_IN
    return mk


apply_market(market.resolve())


def is_us():
    return MK.code == "US"


class NewsError(Exception):
    pass


# ---------------------------------------------------------------- time

def eastern_offset(utc):
    """Hours from UTC for the exchange clock: New York -4 in daylight time, -5 otherwise
    (US rule since 2007); India 5.5 all year."""
    return MK.utc_offset(utc)


def to_eastern(utc):
    """Aware or naive UTC -> naive exchange wall-clock time (New York or IST). Name kept from upstream."""
    if utc.tzinfo is not None:
        utc = utc.astimezone(_dt.timezone.utc)
    return MK.to_local(utc.replace(tzinfo=None))


# ---------------------------------------------------------------- inputs

def load_json(path):
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return None


def watch_from_files(portfolio="trader/portfolio.json", watchlist="trader/watchlist.json",
                     plan="trader/plan.json"):
    """{ticker: name or None}: the scanner's hits, the planned trade and your holdings."""
    out = {}
    wl = load_json(watchlist) or {}
    for h in wl.get("hits", []):
        sym = h.get("symbol") or h.get("ticker")
        if sym:
            out[plain(sym)] = h.get("name")
    pl = load_json(plan) or {}
    if pl.get("symbol"):
        out.setdefault(plain(pl["symbol"]), pl.get("name"))
    pf = load_json(portfolio) or {}
    for p in pf.get("positions", []):
        sym = p.get("ticker") or p.get("symbol")
        if sym:
            out[plain(sym)] = p.get("name") or out.get(plain(sym))
    return out


def plain(sym):
    """RELIANCE.NS -> RELIANCE in India; upper case in the US, as upstream."""
    return str(sym).upper() if is_us() else MK.plain_symbol(sym)


def sec_user_agent(cli=None, config="trader/config.json"):
    ua = (cli or os.environ.get("SEC_USER_AGENT") or "").strip()
    if not ua:
        cfg = load_json(config) or {}
        ua = str(cfg.get("sec_user_agent") or "").strip()
    if not ua or "@" not in ua or PLACEHOLDER in ua:
        return None
    return ua


# ---------------------------------------------------------------- fetching

class Fetcher(object):
    def __init__(self, sec_ua=None, offline=None, pause=0.15):
        self.sec_ua = sec_ua
        self.offline = offline
        self.pause = pause
        self._last = 0.0

    def get(self, url, name, sec=False, ua=None):
        if self.offline:
            path = os.path.join(self.offline, name)
            if not os.path.isfile(path):
                raise NewsError("offline: no file %s" % path)
            with open(path, "rb") as fh:
                return fh.read()
        if sec and not self.sec_ua:
            raise NewsError("no SEC User-Agent set")
        gap = time.time() - self._last
        if gap < self.pause:
            time.sleep(self.pause - gap)
        self._last = time.time()
        headers = {"User-Agent": self.sec_ua if sec else (ua or BROWSER_UA), "Accept-Encoding": "gzip"}
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except urllib.error.HTTPError as exc:
            raise NewsError("HTTP %s for %s" % (exc.code, url))
        except urllib.error.URLError as exc:
            raise NewsError("could not reach %s: %s" % (url, exc.reason))


def yahoo_symbol(ticker):
    """US: BRK.B -> BRK-B. India: RELIANCE -> RELIANCE.NS."""
    if is_us():
        return ticker.upper().replace(".", "-")
    return MK.yahoo_symbol(ticker)


def url_symbol(ticker):
    """The Yahoo symbol, URL-quoted (M&M -> M%26M.NS); unchanged in the US."""
    if is_us():
        return yahoo_symbol(ticker)
    return urllib.parse.quote(yahoo_symbol(ticker), safe="^.-")


def cik_map(fetcher, state):
    """ticker -> 10-digit CIK, from SEC's company_tickers.json (cached in state)."""
    cached = state.setdefault("ciks", {})
    if cached:
        return cached
    data = json.loads(fetcher.get(TICKERS_URL, "company_tickers.json", sec=True).decode("utf-8"))
    for v in data.values():
        cached.setdefault(v["ticker"].upper().replace("-", "."), str(v["cik_str"]).zfill(10))
    return cached


# ---------------------------------------------------------------- parsing

def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _text(el, name):
    for c in el.iter():
        if _local(c.tag) == name:
            return (c.text or "").strip()
    return ""


def parse_time(value):
    """RFC 822 (RSS) or ISO 8601 (Atom) -> aware UTC datetime, or None."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        d = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        d = None
    if d is None:
        try:
            d = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    return d.astimezone(_dt.timezone.utc)


def parse_rss(data, ticker):
    """Yahoo headline RSS -> items."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise NewsError("RSS for %s is not valid XML: %s" % (ticker, exc))
    out = []
    for it in root.iter("item"):
        title = _text(it, "title")
        link = _text(it, "link")
        guid = _text(it, "guid") or link
        out.append({"id": "rss:" + guid, "source": "Yahoo Finance", "kind": "headline",
                    "ticker": ticker, "title": title, "summary": _text(it, "description"),
                    "link": link, "time": parse_time(_text(it, "pubDate"))})
    return out


def parse_sec_atom(data, ticker):
    """EDGAR company filings Atom -> items."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise NewsError("SEC feed for %s is not valid XML: %s" % (ticker, exc))
    company = ""
    for el in root.iter():
        if _local(el.tag) == "conformed-name":
            company = (el.text or "").strip()
            break
    out = []
    for entry in root.iter():
        if _local(entry.tag) != "entry":
            continue
        form = _text(entry, "filing-type")
        acc = _text(entry, "accession-number")
        items = re.findall(r"\d+\.\d+", _text(entry, "items-desc"))
        labels = [ITEMS_8K.get(i, "item " + i) for i in items if i != "9.01"]
        link = ""
        for c in entry.iter():
            if _local(c.tag) == "link":
                link = c.get("href", "")
        title = "%s filed a %s" % (company or ticker, form)
        if labels:
            title += ": " + ", ".join(labels)
        out.append({"id": "sec:" + acc, "source": "SEC EDGAR", "kind": "filing", "form": form,
                    "ticker": ticker, "title": title, "summary": _text(entry, "form-name"),
                    "items": items, "important": bool(set(items) & IMPORTANT_ITEMS),
                    "link": link, "time": parse_time(_text(entry, "updated"))})
    return out


def parse_chart(data, ticker):
    """Yahoo chart JSON -> {"ticker", "price", "prev_close", "pct", "time"} or raise."""
    try:
        doc = json.loads(data.decode("utf-8") if isinstance(data, bytes) else data)
        meta = doc["chart"]["result"][0]["meta"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise NewsError("chart for %s is not usable" % ticker)
    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    if not price or not prev:
        raise NewsError("chart for %s has no price" % ticker)
    when = meta.get("regularMarketTime")
    return {"ticker": ticker, "price": round(float(price), 2), "prev_close": round(float(prev), 2),
            "pct": round((float(price) / float(prev) - 1) * 100, 2),
            "time": _dt.datetime.fromtimestamp(when, _dt.timezone.utc) if when else None}


def collect_moves(fetcher, watch, errors=None):
    errors = [] if errors is None else errors
    out = []
    for t in sorted(watch):
        name = "chart-%s.json" % t
        try:
            try:
                data = fetcher.get(CHART % ("query2", url_symbol(t)), name)
            except NewsError as exc:
                if fetcher.offline or not re.search(r"HTTP (429|5\d\d)", str(exc)):
                    raise
                data = fetcher.get(CHART % ("query1", url_symbol(t)), name)
            out.append(parse_chart(data, t))
        except NewsError as exc:
            if not (fetcher.offline and "no file" in str(exc)):
                errors.append("price for %s: %s" % (t, exc))
    return out


def mention_patterns(watch):
    if not is_us():
        return mention_patterns_in(watch)
    pats = {}
    for t, name in watch.items():
        alts = [r"\(%s\)" % re.escape(t), r"\$%s\b" % re.escape(t),
                r"\b(?:NYSE|NASDAQ|Nasdaq)\s*:\s*%s\b" % re.escape(t)]
        if name and len(name) >= 4:
            alts.append(r"\b%s\b" % re.escape(name).replace(r"\ ", r"[\s-]"))
        pats[t] = re.compile("|".join(alts))
    return pats


def tag(items, watch):
    """Which of your tickers each item touches, and why it matters."""
    pats = mention_patterns(watch)
    for it in items:
        hay = "%s %s" % (it["title"], it.get("summary") or "")
        touches = {it["ticker"]} if it["ticker"] in watch else set()
        for t, rx in pats.items():
            if rx.search(hay):
                touches.add(t)
        it["touches"] = sorted(touches)
        it["tags"] = [label for label, rx in KEYWORDS if re.search(rx, hay, re.I)]
        if it["kind"] == "filing" and "2.02" in it.get("items", []) and "earnings" not in it["tags"]:
            it["tags"].insert(0, "earnings")
        if it["kind"] == "filing" and it.get("source") == "NSE":
            feed_tag = {"financial results": "results", "board meeting": "board meeting"}.get(it.get("form"))
            if feed_tag and feed_tag not in it["tags"]:
                it["tags"].insert(0, feed_tag)
            it["important"] = bool(set(it["tags"]) & IMPORTANT_IN)
    return items


def dedupe(items):
    """One item per story: same id, or same link, or same title the same day."""
    seen, out = {}, []
    for it in items:
        keys = [it["id"], it["link"],
                "%s|%s" % (re.sub(r"\W+", " ", it["title"].lower()).strip(),
                           it["time"].date() if it["time"] else "")]
        hit = next((seen[k] for k in keys if k and k in seen), None)
        if hit is not None and not is_us():
            # India: remember the folded copy too, so it does not come back as new later
            fps = hit.setdefault("_dupes", [])
            for fp in [fingerprint(it)] + it.get("_dupes", []):
                if fp not in fps and fp != fingerprint(hit):
                    fps.append(fp)
        if hit is not None:
            for t in it.get("touches", []):
                if t not in hit["touches"]:
                    hit["touches"].append(t)
            hit["touches"].sort()
            continue
        for k in keys:
            if k:
                seen[k] = it
        out.append(it)
    return out


def fingerprint(it):
    return hashlib.sha1(it["id"].encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- India: names, Google News, NSE filings

_SUFFIX = re.compile(r"\s*\b(?:limited|ltd)\b\.?\s*$", re.I)
_SEP = r"(?=\s*(?:$|[-:|,(–]))"   # what may follow a company name in an NSE title


def short_name(name):
    """'Reliance Industries Limited' -> 'Reliance Industries'."""
    return _SUFFIX.sub("", str(name or "").strip()).strip()


def _strip_html(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_equity_list(text):
    """NSE's EQUITY_L.csv (header SYMBOL,NAME OF COMPANY, SERIES, ...) -> {SYMBOL: company name}.
    The header cells carry leading spaces as published; EQ / BE series win over others."""
    rows = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = [h.strip().upper() for h in next(rows, [])]
    if "SYMBOL" not in header or "NAME OF COMPANY" not in header:
        raise NewsError("EQUITY_L.csv has no SYMBOL / NAME OF COMPANY columns")
    si, ni = header.index("SYMBOL"), header.index("NAME OF COMPANY")
    se = header.index("SERIES") if "SERIES" in header else None
    out, rank = {}, {}
    for r in rows:
        if len(r) <= max(si, ni):
            continue
        sym, name = r[si].strip().upper(), r[ni].strip()
        if not sym or not name:
            continue
        series = r[se].strip().upper() if se is not None and len(r) > se else ""
        k = 0 if series in ("EQ", "BE", "") else 1
        if sym not in out or k < rank[sym]:
            out[sym], rank[sym] = name, k
    return out


def _read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def load_equity_list(fetcher, path=EQUITY_CACHE, errors=None):
    """{SYMBOL: name} from the cached NSE equity list; fetched (browser-like User-Agent) and
    cached when missing or older than EQUITY_MAX_AGE_DAYS. Offline: DIR/EQUITY_L.csv, then the
    cache; never the network."""
    errors = [] if errors is None else errors
    text = None
    if fetcher.offline:
        for p in (os.path.join(fetcher.offline, "EQUITY_L.csv"), path):
            if p and os.path.isfile(p):
                text = _read_text(p)
                break
        if text is None:
            return {}
    else:
        fresh = path and os.path.isfile(path) and \
            time.time() - os.path.getmtime(path) < EQUITY_MAX_AGE_DAYS * 86400
        if fresh:
            text = _read_text(path)
        else:
            try:
                text = fetcher.get(EQUITY_URL, "EQUITY_L.csv", ua=NSE_UA).decode("utf-8", "replace")
                parse_equity_list(text)  # do not cache an error page
                if path:
                    folder = os.path.dirname(path)
                    if folder:
                        os.makedirs(folder, exist_ok=True)
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(text)
            except NewsError as exc:
                if path and os.path.isfile(path):
                    errors.append("NSE equity list: %s; using the cached copy %s" % (exc, path))
                    text = _read_text(path)
                else:
                    errors.append("NSE equity list: %s (company names come only from --names or %s)"
                                  % (exc, NAMES_FILE))
                    return {}
    try:
        return parse_equity_list(text)
    except NewsError as exc:
        errors.append("NSE equity list: %s" % exc)
        return {}


def company_names(watch, fetcher, names_path=None, equity_path=EQUITY_CACHE, errors=None):
    """Fill watch {SYM: name} in place. The --names file (or trader/names.json) wins, then a
    name the watchlist, plan or portfolio already gave, then NSE's EQUITY_L.csv."""
    errors = [] if errors is None else errors
    over = {}
    path = names_path or NAMES_FILE
    try:
        doc = load_json(path)
    except ValueError as exc:
        errors.append("names file %s is not valid JSON: %s" % (path, exc))
        doc = None
    if names_path and doc is None and not os.path.isfile(names_path):
        errors.append("names file %s not found" % names_path)
    if isinstance(doc, dict):
        over = dict((plain(k), str(v).strip()) for k, v in doc.items() if v)
    missing = [t for t in watch if not over.get(t) and not watch.get(t)]
    eq = load_equity_list(fetcher, equity_path, errors) if missing else {}
    for t in list(watch):
        watch[t] = over.get(t) or watch.get(t) or eq.get(t)
        if not watch[t]:
            errors.append("no company name for %s: NSE filings are matched by name, so add it to %s "
                          "(\"%s\": \"Company Name Limited\") or pass --names" % (t, NAMES_FILE, t))
    return watch


def gnews_query(ticker, name=None):
    """'"Reliance Industries" OR RELIANCE.NS'; just the Yahoo symbol when the name is unknown."""
    sym = MK.yahoo_symbol(ticker)
    nm = short_name(name)
    return '"%s" OR %s' % (nm, sym) if nm else sym


def gnews_url(ticker, name=None):
    return GNEWS % urllib.parse.quote(gnews_query(ticker, name), safe="")


def parse_gnews(data, ticker):
    """Google News RSS -> items. Its titles end in " - Publisher", which is dropped (and kept
    as "publisher") so the same story from Yahoo dedupes."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise NewsError("Google News RSS for %s is not valid XML: %s" % (ticker, exc))
    out = []
    for it in root.iter("item"):
        title = _text(it, "title")
        src = it.find("source")
        publisher = (src.text or "").strip() if src is not None else ""
        if publisher and title.endswith(" - " + publisher):
            title = title[:-(len(publisher) + 3)].rstrip()
        link = _text(it, "link")
        guid = _text(it, "guid") or link
        summary = _strip_html(_text(it, "description"))
        if summary.startswith(title):
            summary = summary[len(title):].strip()
        if publisher and summary == publisher:
            summary = ""
        out.append({"id": "gnews:" + guid, "source": "Google News", "publisher": publisher,
                    "kind": "headline", "ticker": ticker, "title": title, "summary": summary,
                    "link": link, "time": parse_time(_text(it, "pubDate"))})
    return out


def parse_nse_time(value):
    """An NSE feed pubDate -> aware UTC. Accepts RFC 822 and NSE's '30-Oct-2026 18:05:12';
    a time with no zone is IST (NSE publishes in IST)."""
    v = (value or "").strip()
    if not v:
        return None
    ist = market.get("IN")
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y",
                "%d-%b-%Y %I:%M:%S %p", "%d-%b-%Y %I:%M %p",
                "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y",
                "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y",
                "%d/%m/%Y %I:%M:%S %p", "%d/%m/%Y %I:%M %p",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %I:%M:%S %p"):
        try:
            local = _dt.datetime.strptime(v, fmt)
        except ValueError:
            continue
        return ist.local_to_utc(local).replace(tzinfo=_dt.timezone.utc)
    try:  # ISO 8601: with an offset as given, without one in IST
        d = _dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
        if d.tzinfo is None:
            return ist.local_to_utc(d).replace(tzinfo=_dt.timezone.utc)
        return d.astimezone(_dt.timezone.utc)
    except ValueError:
        pass
    try:
        d = email.utils.parsedate_to_datetime(v)
    except (TypeError, ValueError, IndexError):
        d = None
    if d is not None:
        if d.tzinfo is None:
            return ist.local_to_utc(d).replace(tzinfo=_dt.timezone.utc)
        return d.astimezone(_dt.timezone.utc)
    return parse_time(v)


def parse_nse_rss(data, label):
    """One NSE RSS 2.0 feed -> raw entries {title, description, link, guid, time, form}."""
    head = (data[:2000].decode("utf-8", "replace") if isinstance(data, bytes) else str(data)[:2000]).lower()
    if "access denied" in head or re.search(r"<\s*(?:!doctype\s+)?html\b", head):
        raise NewsError("NSE %s feed came back as an HTML page (Access Denied?), not RSS: NSE "
                        "blocked the request. Try again later, or check nseindia.com > Companies > "
                        "Corporate Filings in a browser" % label)
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise NewsError("NSE %s feed is not valid XML: %s" % (label, exc))
    if _local(root.tag).lower() not in ("rss", "feed", "rdf"):
        raise NewsError("NSE %s feed is not RSS (root <%s>)" % (label, _local(root.tag)))
    out = []
    for it in root.iter("item"):
        title = _text(it, "title")
        link = _text(it, "link")
        pub = _text(it, "pubDate")
        out.append({"title": title, "description": _strip_html(_text(it, "description")), "link": link,
                    "guid": _text(it, "guid") or link or "%s|%s" % (title, pub),
                    "time": parse_nse_time(pub), "form": label})
    return out


def name_regex(sym, name):
    """Matches an NSE title that starts with the company: its full name with Limited / Ltd (then
    anything), its name without the suffix followed by a separator or the end, or the symbol."""
    alts = [re.escape(sym) + _SEP]
    words = re.findall(r"[A-Za-z0-9]+|&", short_name(name))
    if words:
        parts = [r"(?:&|and)" if (w == "&" or w.lower() == "and") else re.escape(w) for w in words]
        body = r"[\W_]*".join(parts)
        alts.append(body + r"[\W_]*(?:limited|ltd)\b\.?")
        alts.append(body + _SEP)
    return re.compile(r"^\W*(?:%s)" % "|".join(alts), re.I)


_INFORMED = re.compile(r"^(?:has\s+)?(?:informed|intimated)\s+(?:to\s+)?(?:the\s+)?exchanges?\s*"
                       r"(?:about|regarding|that|of|on)?\s*[:-]?\s*", re.I)


def _without_company(text, rx):
    """'Reliance Industries Limited has informed the Exchange about Buyback' -> 'Buyback'
    (the company is already the start of the item title)."""
    text = (text or "").strip()
    m = rx.match(text)
    if not m:
        return text
    rest = text[m.end():].strip(" -:|,–")
    rest = _INFORMED.sub("", rest).strip()
    if not rest:
        return text
    return rest[0].upper() + rest[1:]


def match_filings(raw, watch):
    """NSE feed entries -> filing items for the watched companies (longest name match wins)."""
    rxs = dict((t, name_regex(t, n)) for t, n in watch.items())
    out = []
    for r in raw:
        best = None
        for t, rx in sorted(rxs.items()):
            m = rx.match(r["title"])
            if m and (best is None or len(m.group(0)) > best[1]):
                best = (t, len(m.group(0)))
        if not best:
            continue
        t, n = best
        company = r["title"][:n].strip(" -:|,–")
        if not company or company.upper() == t:
            company = watch.get(t) or t
        subject = r["title"][n:].strip(" -:|,–") or _without_company(r["description"], rxs[t])
        if len(subject) > 160:
            subject = subject[:157].rstrip() + "..."
        title = "%s, %s%s" % (company, r["form"], (": " + subject) if subject else "")
        out.append({"id": "nse:" + r["guid"], "source": "NSE", "kind": "filing", "form": r["form"],
                    "ticker": t, "title": title, "summary": r["description"], "items": [],
                    "important": False, "link": r["link"], "time": r["time"]})
    return out


def mention_patterns_in(watch):
    """India: (SYM), NSE: SYM / BSE: SYM, SYM.NS, the bare upper-case symbol (3+ letters) and
    the company name without Limited."""
    pats = {}
    for t, name in watch.items():
        e = re.escape(t)
        alts = [r"\(%s\)" % e, r"\b(?:NSE|BSE)\s*:\s*%s(?![A-Za-z0-9])" % e, r"\b%s\.(?:NS|BO)\b" % e]
        if len(t) >= 3:
            alts.append(r"(?<![A-Za-z0-9&-])%s(?![A-Za-z0-9&-])" % e)
        nm = short_name(name)
        if nm and len(nm) >= 4:
            alts.append(r"\b%s\b" % re.escape(nm).replace(r"\ ", r"[\s-]"))
        pats[t] = re.compile("|".join(alts))
    return pats


def collect_in(fetcher, watch, filings=True, yahoo=False, errors=None):
    """India: Google News per ticker (and Yahoo's NSE feed with yahoo=True), then the three NSE
    filing feeds once, matched to the watchlist by company name."""
    errors = [] if errors is None else errors
    items = []
    for t in sorted(watch):
        try:
            items += parse_gnews(fetcher.get(gnews_url(t, watch.get(t)), "gnews-%s.xml" % t), t)
        except NewsError as exc:
            errors.append("Google News for %s: %s" % (t, exc))
        if yahoo:
            try:
                items += parse_rss(fetcher.get(YAHOO_IN % url_symbol(t), "yahoo-%s.xml" % t), t)
            except NewsError as exc:
                errors.append("Yahoo headlines for %s: %s" % (t, exc))
    if filings:
        raw = []
        for fname, label, url in NSE_FEEDS:
            try:
                raw += parse_nse_rss(fetcher.get(url, fname, ua=NSE_UA), label)
            except NewsError as exc:
                errors.append("NSE %s feed: %s" % (label, exc))
        items += match_filings(raw, watch)
    return items


# ---------------------------------------------------------------- the check

def collect(fetcher, watch, state, sec=True, forms=("8-K",), count=10, errors=None):
    errors = [] if errors is None else errors
    items = []
    for t in sorted(watch):
        try:
            items += parse_rss(fetcher.get(YAHOO % yahoo_symbol(t), "yahoo-%s.xml" % t), t)
        except NewsError as exc:
            errors.append("headlines for %s: %s" % (t, exc))
    if sec:
        try:
            ciks = cik_map(fetcher, state)
        except NewsError as exc:
            errors.append("SEC ticker list: %s" % exc)
            ciks = {}
        for t in sorted(watch):
            cik = ciks.get(t)
            if not cik:
                if ciks:
                    errors.append("no SEC CIK for %s" % t)
                continue
            for form in forms:
                try:
                    data = fetcher.get(SEC_FEED % (cik, form, count),
                                       "sec-%s-%s.xml" % (form, cik), sec=True)
                    items += parse_sec_atom(data, t)
                except NewsError as exc:
                    errors.append("SEC %s for %s: %s" % (form, t, exc))
    return items


def select(items, state, now, hours=48, show_all=False):
    """Items within the window; only unseen ones unless show_all."""
    seen = state.setdefault("seen", {})
    cutoff = now - _dt.timedelta(hours=hours)
    ahead = now + _dt.timedelta(minutes=10)  # a pinned --now: nothing from after it
    out = []
    for it in items:
        if it["time"] is not None and (it["time"] < cutoff or it["time"] > ahead):
            continue
        fp = fingerprint(it)
        it["new"] = fp not in seen and not any(d in seen for d in it.get("_dupes", ()))
        if it["new"] or show_all:
            out.append(it)
    out.sort(key=lambda i: (i["time"] or now), reverse=True)
    return out


def remember(items, state, now):
    seen = state.setdefault("seen", {})
    stamp = now.isoformat()
    for it in items:
        seen.setdefault(fingerprint(it), stamp)
        for fp in it.get("_dupes", ()):
            seen.setdefault(fp, stamp)
    cutoff = (now - _dt.timedelta(days=KEEP_DAYS)).isoformat()
    state["seen"] = {k: v for k, v in seen.items() if v >= cutoff}
    state["last_check"] = stamp


def render_moves(moves, move_pct=MOVE_PCT):
    out = []
    for m in moves:
        flag = "MOVING" if abs(m["pct"]) >= move_pct else ""
        when = (" at %s %s" % (to_eastern(m["time"]).strftime("%H:%M"), TZ)) if m.get("time") else ""
        if is_us():
            price, prev = "{:,.2f}".format(m["price"]), "{:,.2f}".format(m["prev_close"])
        else:
            price, prev = MK.money(m["price"]), MK.money(m["prev_close"])
        out.append("%-6s %s %+.2f%% vs yesterday's close %s%s  %s" % (
            m["ticker"], price, m["pct"], prev, when, flag))
    return out


def render(items, errors, now, moves=None, move_pct=MOVE_PCT):
    out = render_moves(moves or [], move_pct)
    if out:
        out.append("")
    if not items:
        out.append("Nothing new.")
    for it in items:
        when = (to_eastern(it["time"]).strftime("%Y-%m-%d %H:%M ") + TZ) if it["time"] else "time unknown"
        mark = "!" if it.get("important") else " "
        who = ",".join(it["touches"]) or it["ticker"]
        out.append("%s %s  %-11s %-13s %s" % (mark, when, who, it["source"], it["title"]))
        extra = []
        if it["tags"]:
            extra.append("tags: " + ", ".join(it["tags"]))
        if it.get("publisher"):
            extra.append("via " + it["publisher"])
        extra.append(it["link"])
        out.append("      " + "  ".join(extra))
    for e in errors:
        out.append("note: %s" % e)
    out.append("Checked %s. Headlines are leads, not facts; open the story before acting. "
               "Not financial advice." % (to_eastern(now).strftime("%Y-%m-%d %H:%M ") + TZ))
    return "\n".join(out) + "\n"


def _json_ready(items):
    out = []
    for it in items:
        d = dict(it)
        d.pop("_dupes", None)
        d["time"] = it["time"].isoformat() if it["time"] else None
        if not is_us():
            d["local_time"] = (to_eastern(it["time"]).strftime("%Y-%m-%d %H:%M ") + TZ) if it["time"] else None
        out.append(d)
    return out


def parse_local_now(text):
    """India --now: ISO with an offset as given; without one it is IST ("2026-10-30 10:50")."""
    try:
        d = _dt.datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return parse_time(text)
    if d.tzinfo is None:
        return MK.local_to_utc(d).replace(tzinfo=_dt.timezone.utc)
    return d.astimezone(_dt.timezone.utc)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--market", help="IN (NSE, the default) or US (NYSE)")
    ap.add_argument("--tickers", nargs="*", help="default: watchlist + plan + portfolio")
    ap.add_argument("--portfolio", default="trader/portfolio.json")
    ap.add_argument("--watchlist", default="trader/watchlist.json")
    ap.add_argument("--plan", default="trader/plan.json")
    ap.add_argument("--state", default="trader/state/news.json")
    ap.add_argument("--hours", type=float, default=48, help="ignore items older than this")
    ap.add_argument("--all", action="store_true", help="show seen items too")
    ap.add_argument("--forms", default="8-K", help="US: SEC forms to watch, comma separated")
    ap.add_argument("--no-sec", "--no-filings", dest="no_sec", action="store_true",
                    help="headlines only (no NSE filings in India, no SEC filings in the US)")
    ap.add_argument("--no-moves", action="store_true", help="skip the price line per ticker")
    ap.add_argument("--move-pct", type=float, default=MOVE_PCT, help="flag a move this big (percent)")
    ap.add_argument("--user-agent", help="US: SEC User-Agent: \"Your Name you@example.com\"")
    ap.add_argument("--names", metavar="FILE", help="India: {\"SYM\": \"Company Name\"} JSON "
                                                    "(default %s when it exists)" % NAMES_FILE)
    ap.add_argument("--equity-list", default=EQUITY_CACHE, metavar="CSV",
                    help="India: NSE's EQUITY_L.csv cache (default %s)" % EQUITY_CACHE)
    ap.add_argument("--yahoo", action="store_true", help="India: add Yahoo's headline RSS for <SYM>.NS")
    ap.add_argument("--config", default="trader/config.json")
    ap.add_argument("--offline", metavar="DIR")
    ap.add_argument("--now", help="ISO time, for reproducible runs")
    ap.add_argument("--dry-run", action="store_true", help="do not update the state file")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        apply_market(market.resolve(args.market, market.read_config(args.config)))
    except market.MarketError as exc:
        print("news: %s" % exc, file=sys.stderr)
        return 2

    if args.tickers and not is_us() and any(not plain(t) for t in args.tickers):
        print("news: an empty ticker was given (--tickers \"\"): pass NSE symbols like RELIANCE TCS",
              file=sys.stderr)
        return 2
    if args.tickers:
        watch = {plain(t): None for t in args.tickers}
        known = watch_from_files(args.portfolio, args.watchlist, args.plan)
        watch.update({t: known[t] for t in watch if known.get(t)})
    else:
        watch = watch_from_files(args.portfolio, args.watchlist, args.plan)
    if not watch:
        print("news: no tickers. Pass --tickers, or run /trader-scanner first (it writes "
              "trader/watchlist.json).", file=sys.stderr)
        return 2
    if args.now and not is_us():
        now = parse_local_now(args.now)
    else:
        now = parse_time(args.now) if args.now else _dt.datetime.now(_dt.timezone.utc)
    if now is None:
        print("news: --now wants an ISO time like 2026-10-30T10:50:00+05:30", file=sys.stderr)
        return 2
    state = load_json(args.state) or {}
    errors = []
    if is_us():
        ua = sec_user_agent(args.user_agent, args.config)
        sec = not args.no_sec
        if sec and not ua and not args.offline:
            errors.append("SEC filings skipped: set sec_user_agent in trader/config.json or "
                          "SEC_USER_AGENT (\"Your Name you@example.com\") to include them")
            sec = False
        fetcher = Fetcher(ua, offline=args.offline)
        forms = [f.strip().upper() for f in args.forms.split(",") if f.strip()]
        items = collect(fetcher, watch, state, sec=sec, forms=forms, errors=errors)
    else:
        fetcher = Fetcher(None, offline=args.offline)
        company_names(watch, fetcher, args.names, args.equity_list, errors)
        items = collect_in(fetcher, watch, filings=not args.no_sec, yahoo=args.yahoo, errors=errors)
    items = dedupe(tag(items, watch))
    shown = select(items, state, now, hours=args.hours, show_all=args.all)
    moves = [] if args.no_moves else collect_moves(fetcher, watch, errors)
    if args.json:
        mv = [dict(m, time=m["time"].isoformat() if m.get("time") else None,
                   moving=abs(m["pct"]) >= args.move_pct) for m in moves]
        doc = {"checked": now.isoformat(), "moves": mv, "items": _json_ready(shown), "notes": errors}
        if not is_us():
            doc = dict({"market": MK.code, "tz": MK.tz_label, "currency": MK.currency,
                        "names": dict((t, watch[t]) for t in sorted(watch))}, **doc)
        print(json.dumps(doc, indent=2, ensure_ascii=is_us()))
    else:
        sys.stdout.write(render(shown, errors, now, moves, args.move_pct))
    if not args.dry_run:
        remember(items, state, now)
        folder = os.path.dirname(args.state)
        if folder:
            os.makedirs(folder, exist_ok=True)
        with open(args.state, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
            fh.write("\n")
    return 0 if any(i["new"] for i in shown) else 1


if __name__ == "__main__":
    sys.exit(main())
