#!/usr/bin/env python3
"""Bulk and block deals tracker for trader-deals. Standard library only.

Reads the daily bulk-deal and block-deal files NSE publishes after the close and lists who
bought or sold how much of what, with the value in rupees crore.

    python3 deals.py fetch                                  # today's bulk and block deals
    python3 deals.py fetch --kind block --min-value-cr 50   # block deals of Rs 50 crore or more
    python3 deals.py fetch --symbol RELIANCE --symbol M&M   # only these symbols
    python3 deals.py fetch --client "goldman" --side buy    # a client name contains "goldman"
    python3 deals.py new                                    # only deals not shown before
    python3 deals.py fetch --file bulk.csv                  # a saved copy instead of the network

Where the data comes from (NSE archives, CSV, one trading day per file):
  https://archives.nseindia.com/content/equities/bulk.csv
  https://archives.nseindia.com/content/equities/block.csv
  header: Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,
          Trade Price / Wght. Avg. Price,Remarks       (dates like 31-Oct-2026)

What a deal is, and is not:
  - A bulk deal is a trade (or trades) in one session by one client totalling more than 0.5%
    of the company's listed equity shares; the broker reports it the same day. A block deal is
    a single large trade (at least Rs 10 crore) in the exchange's separate block-deal window.
  - Both are PUBLIC post-trade disclosures, published after the trade is done. A well-known
    name buying is not a signal to copy: they may be a market maker, an arbitrage desk, or
    selling the other leg elsewhere.

State: `new` remembers the deals it has shown in trader/state/deals.json, so each alerts once.
Every run writes the deals that matched to trader/deals.json (`new` marks the unseen ones
with "new": true; --no-write skips it).
Holdings: symbols in trader/portfolio.json ("positions": [{"ticker" or "symbol"}]) and
trader/watchlist.json ("hits": [{"symbol"}]) are flagged.
"""

import argparse
import csv
import datetime as _dt
import importlib.util
import io
import json
import os
import re
import sys
import urllib.error
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

URLS = {
    "bulk": "https://archives.nseindia.com/content/equities/bulk.csv",
    "block": "https://archives.nseindia.com/content/equities/block.csv",
}
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0 Safari/537.36")
CRORE = 1e7
MANUAL = ("nseindia.com > Market Data > Bulk / Block Deals (or Reports > Equities), download "
          "the CSV and pass it with --file")
NOTE = ("Public post-trade disclosures from NSE, published after the trade is done. A big name "
        "buying is not a signal to copy. Not financial advice.")
SEEN_CAP = 20000

MK = None
TZ = "IST"


def apply_market(mk):
    """Deals are an NSE dataset: the active market is always the India profile."""
    global MK, TZ
    if mk.code != "IN":
        raise DealsError("bulk and block deals are NSE (India) data; for US Congress trades "
                         "use /trader-pelosi")
    MK, TZ = mk, mk.tz_label
    return mk


class DealsError(Exception):
    pass


apply_market(market.get("IN"))


# ---------------------------------------------------------------- parsing

def _key(h):
    return re.sub(r"\s+", " ", (h or "").replace("﻿", "")).strip().lower()


COLUMNS = (
    ("date", lambda k: k == "date" or k.startswith("deal date")),
    ("symbol", lambda k: k == "symbol"),
    ("security", lambda k: k.startswith("security name") or k == "security"),
    ("client", lambda k: k.startswith("client name") or k == "client"),
    ("side", lambda k: k.startswith("buy/sell") or k in ("buy / sell", "side")),
    ("qty", lambda k: k.startswith("quantity")),
    ("price", lambda k: k.startswith("trade price") or k.startswith("wght") or k == "price"),
    ("remarks", lambda k: k.startswith("remarks")),
)
MONTHS = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def iso_date(text):
    """'31-Oct-2026' (or 31-OCT-2026, 31-10-2026, 2026-10-31) -> '2026-10-31'."""
    t = (text or "").strip()
    m = re.match(r"^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$", t)
    try:
        if m:
            return _dt.date(int(m.group(3)), MONTHS[m.group(2).upper()], int(m.group(1))).isoformat()
        m = re.match(r"^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$", t)
        if m:
            return _dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        return _dt.date.fromisoformat(t).isoformat()
    except (ValueError, KeyError):
        return None


def _num(text):
    t = (text or "").replace(",", "").strip()
    if not t or t in ("-", "NA"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def deal_id(d):
    return "|".join(str(x) for x in (d["kind"], d["date"], d["symbol"], d["client"].upper(),
                                     d["side"], d["qty"], d["price"]))


def parse_deals(text, kind="bulk"):
    """Rows from a bulk.csv / block.csv body. Header spaces are stripped, the Remarks column
    may be missing, and a "NO RECORDS" body (or an empty one) gives []."""
    text = (text or "").lstrip("﻿")
    if not text.strip():
        return []
    rows = list(csv.reader(io.StringIO(text)))
    head_at = None
    for i, r in enumerate(rows):
        keys = [_key(c) for c in r]
        if "symbol" in keys and any(k.startswith("buy/sell") or k == "side" for k in keys):
            head_at = i
            break
    if head_at is None:
        if re.search(r"no\s+records?", text, re.I):
            return []
        raise DealsError("not a bulk/block deals CSV (no Symbol and Buy/Sell header)")
    keys = [_key(c) for c in rows[head_at]]
    idx = {}
    for name, test in COLUMNS:
        for j, k in enumerate(keys):
            if test(k) and name not in idx:
                idx[name] = j
    missing = [n for n in ("symbol", "side", "qty", "price") if n not in idx]
    if missing:
        raise DealsError("deals CSV is missing column(s): %s" % ", ".join(missing))
    out = []
    for r in rows[head_at + 1:]:
        if not r or not any(c.strip() for c in r):
            continue
        cell = lambda n: (r[idx[n]].strip() if n in idx and idx[n] < len(r) else "")
        sym = market.get("IN").plain_symbol(cell("symbol"))
        if not sym or re.search(r"no\s+records?", " ".join(r), re.I):
            continue
        side_raw = cell("side").upper()
        side = "buy" if side_raw.startswith("B") else "sell" if side_raw.startswith("S") else side_raw.lower()
        qty, price = _num(cell("qty")), _num(cell("price"))
        if qty is None or price is None:
            continue
        value = qty * price
        d = {"kind": kind, "date": iso_date(cell("date")) or cell("date"), "symbol": sym,
             "security": cell("security"), "client": re.sub(r"\s+", " ", cell("client")),
             "side": side, "qty": int(qty) if qty == int(qty) else qty, "price": price,
             "value": round(value, 2), "value_cr": round(value / CRORE, 2),
             "remarks": cell("remarks") if cell("remarks") not in ("-", "") else ""}
        d["id"] = deal_id(d)
        out.append(d)
    return out


# ---------------------------------------------------------------- fetching

def download(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "text/csv,*/*",
                                               "Referer": "https://www.nseindia.com/"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise DealsError("HTTP %s for %s. NSE blocks some scripts: %s" % (exc.code, url, MANUAL))
    except urllib.error.URLError as exc:
        raise DealsError("could not reach %s (%s). %s" % (url, exc.reason, MANUAL))


def _kind_of_file(path, default):
    base = os.path.basename(path).lower()
    if "block" in base:
        return "block"
    if "bulk" in base:
        return "bulk"
    return default


def load_deals(kind="all", files=None, bulk_file=None, block_file=None):
    """All deals of the kinds asked for. files: [paths] whose kind is read from the name
    (block*.csv / bulk*.csv) or, failing that, --kind."""
    kinds = ["bulk", "block"] if kind == "all" else [kind]
    sources = {}
    if bulk_file:
        sources["bulk"] = bulk_file
    if block_file:
        sources["block"] = block_file
    for f in files or []:
        sources[_kind_of_file(f, "bulk" if kind == "all" else kind)] = f
    out = []
    use_files = bool(sources)
    for k in kinds:
        if use_files:
            path = sources.get(k)
            if not path:
                continue
            with open(path, encoding="utf-8-sig", errors="replace") as fh:
                out.extend(parse_deals(fh.read(), k))
        else:
            out.extend(parse_deals(download(URLS[k]), k))
    return out


# ---------------------------------------------------------------- filters and holdings

def select(deals, symbols=None, client=None, side=None, min_value_cr=None):
    syms = set(market.get("IN").plain_symbol(s) for s in (symbols or []))
    cl = (client or "").strip().lower()
    out = []
    for d in deals:
        if syms and d["symbol"] not in syms:
            continue
        if cl and cl not in d["client"].lower():
            continue
        if side and d["side"] != side:
            continue
        if min_value_cr is not None and d["value_cr"] < min_value_cr:
            continue
        out.append(d)
    out.sort(key=lambda d: (d["date"], d["value"]), reverse=True)
    return out


def _read_json(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def my_symbols(portfolio=None, watchlist=None, extra=None):
    """{symbol: "held" | "watchlist"} from portfolio.json positions, watchlist.json hits and
    --tickers. Held wins over watchlist."""
    plain = market.get("IN").plain_symbol
    out = {}
    wl = _read_json(watchlist)
    items = wl.get("hits", []) if isinstance(wl, dict) else (wl if isinstance(wl, list) else [])
    for h in items:
        s = h.get("symbol") or h.get("ticker") if isinstance(h, dict) else h
        if s:
            out[plain(s)] = "watchlist"
    for s in extra or []:
        out[plain(s)] = "watchlist"
    pf = _read_json(portfolio)
    for p in (pf.get("positions", []) if isinstance(pf, dict) else []):
        s = p.get("ticker") or p.get("symbol")
        if s:
            out[plain(s)] = "held"
    return out


def tag(deals, mine):
    for d in deals:
        d["yours"] = mine.get(d["symbol"])
    return deals


# ---------------------------------------------------------------- state

def load_state(path):
    st = _read_json(path)
    if not isinstance(st, dict):
        return {"seen": [], "last_check": None}
    st.setdefault("seen", [])
    st.setdefault("last_check", None)
    return st


def save_state(path, state):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    state["seen"] = state["seen"][-SEEN_CAP:]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
        fh.write("\n")


def unseen(deals, state):
    seen = set(state.get("seen", []))
    return [d for d in deals if d["id"] not in seen]


# ---------------------------------------------------------------- output

def crore(v):
    """12345.5 (crore) -> '₹12,345.50 Cr'."""
    return MK.money(v) + " Cr"


def qty_text(q):
    return market.indian_grouping(int(q)) if q == int(q) else str(q)


def render(deals, title=None):
    out = []
    if title:
        out.append(title)
    if not deals:
        out.append("No deals match.")
        return "\n".join(out) + "\n"
    out.append("%-10s %-5s %-12s %-4s %14s %12s %14s  %s" % (
        "date", "kind", "symbol", "side", "quantity", "price", "value", "client"))
    for d in deals:
        flag = ""
        if d.get("yours") == "held":
            flag = "  <- you hold %s" % d["symbol"]
        elif d.get("yours") == "watchlist":
            flag = "  <- on your watchlist"
        out.append("%-10s %-5s %-12s %-4s %14s %12s %14s  %s%s" % (
            d["date"], d["kind"], d["symbol"][:12], d["side"].upper(), qty_text(d["qty"]),
            MK.money(d["price"]), crore(d["value_cr"]), d["client"][:48], flag))
        if d.get("remarks"):
            out.append("%-10s remarks: %s" % ("", d["remarks"]))
    buys = sum(d["value_cr"] for d in deals if d["side"] == "buy")
    sells = sum(d["value_cr"] for d in deals if d["side"] == "sell")
    out.append("%d deals: buys %s, sells %s." % (len(deals), crore(buys), crore(sells)))
    return "\n".join(out) + "\n"


def write_out(path, deals, kind, filters):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    now = MK.now_local().strftime("%Y-%m-%d %H:%M")
    doc = {"as_of": now, "tz": TZ, "market": "IN", "currency": "INR", "kind": kind,
           "source": [URLS[k] for k in (["bulk", "block"] if kind == "all" else [kind])],
           "filters": filters, "note": NOTE, "deals": deals}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


# ---------------------------------------------------------------- CLI

def _parser():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--market", help="IN only (NSE data); US is refused, see /trader-pelosi")
    sub = ap.add_subparsers(dest="cmd")
    for name, helptext in (("fetch", "list the latest bulk and block deals"),
                           ("new", "only deals not shown at the last check")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--market", dest="market_sub", help=argparse.SUPPRESS)
        p.add_argument("--kind", choices=("bulk", "block", "all"), default="all")
        p.add_argument("--symbol", action="append", help="NSE symbol; repeat for more")
        p.add_argument("--client", help="client name contains this text (any case)")
        p.add_argument("--side", choices=("buy", "sell"))
        p.add_argument("--min-value-cr", type=float, help="only deals worth at least this many crore")
        p.add_argument("--file", action="append", help="a saved bulk.csv / block.csv (repeatable)")
        p.add_argument("--bulk-file")
        p.add_argument("--block-file")
        p.add_argument("--portfolio", default="trader/portfolio.json")
        p.add_argument("--watchlist", default="trader/watchlist.json")
        p.add_argument("--tickers", nargs="*", help="also flag deals in these symbols")
        p.add_argument("--mine", action="store_true", help="only deals in symbols you hold or watch")
        p.add_argument("--out", default="trader/deals.json")
        p.add_argument("--no-write", action="store_true", help="do not write trader/deals.json")
        p.add_argument("--json", action="store_true")
        if name == "new":
            p.add_argument("--state", default="trader/state/deals.json")
            p.add_argument("--dry-run", action="store_true", help="do not update the state file")
    return ap


def main(argv=None):
    ap = _parser()
    args = ap.parse_args(argv)
    try:
        flag = getattr(args, "market_sub", None) or args.market
        apply_market(market.get(flag) if flag else market.get("IN"))
    except (DealsError, market.MarketError) as exc:
        print("deals: %s" % exc, file=sys.stderr)
        return 2
    if not args.cmd:
        ap.print_help()
        return 2
    try:
        return _run(args)
    except (DealsError, OSError) as exc:
        print("deals: %s" % exc, file=sys.stderr)
        return 2


def _run(args):
    deals = load_deals(args.kind, args.file, args.bulk_file, args.block_file)
    picked = select(deals, args.symbol, args.client, args.side, args.min_value_cr)
    mine = my_symbols(args.portfolio, args.watchlist, args.tickers)
    tag(picked, mine)
    if args.mine:
        picked = [d for d in picked if d.get("yours")]
    filters = {"symbols": args.symbol or [], "client": args.client, "side": args.side,
               "min_value_cr": args.min_value_cr, "mine": bool(args.mine)}

    if args.cmd == "fetch":
        shown = picked
        if args.json:
            print(json.dumps({"deals": shown, "note": NOTE}, indent=2, ensure_ascii=False))
        else:
            sys.stdout.write(render(shown, "NSE %s deals (%d of %d in the file)" % (
                "bulk and block" if args.kind == "all" else args.kind, len(shown), len(deals))))
            print(NOTE)
        if not args.no_write:
            write_out(args.out, shown, args.kind, filters)
        return 0 if shown else 1

    # new
    state = load_state(args.state)
    fresh = unseen(picked, state)
    if args.json:
        print(json.dumps({"new": fresh, "note": NOTE}, indent=2, ensure_ascii=False))
    else:
        if not fresh:
            print("Nothing new since %s." % (state.get("last_check") or "the last check"))
        else:
            held = [d for d in fresh if d.get("yours") == "held"]
            sys.stdout.write(render(fresh, "NEW NSE deals: %d%s" % (
                len(fresh), (", %d in symbols you hold" % len(held)) if held else "")))
            print(NOTE)
    if not args.no_write:
        ids = set(d["id"] for d in fresh)
        write_out(args.out, [dict(d, new=d["id"] in ids) for d in picked], args.kind, filters)
    if not args.dry_run:
        seen = list(state.get("seen", []))
        have = set(seen)
        for d in picked:
            if d["id"] not in have:
                seen.append(d["id"])
                have.add(d["id"])
        state["seen"] = seen
        state["last_check"] = MK.now_local().strftime("%Y-%m-%d %H:%M") + " " + TZ
        save_state(args.state, state)
    return 0 if fresh else 1


if __name__ == "__main__":
    sys.exit(main())
