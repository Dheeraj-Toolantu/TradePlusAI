#!/usr/bin/env python3
"""trader-market: the market profile every trader-* tool shares.

TradePulse trades Indian markets, so the default market is India (NSE, IST, INR). The original
US profile (NYSE, New York time, USD) is kept so the upstream pack and its tests still work.

    python3 market.py status                       # is the market open right now, next open
    python3 market.py status --at "2026-11-10 10:00"
    python3 market.py holidays [--year 2026]       # the trading holiday list
    python3 market.py tick 245.37                  # NSE tick size and the price rounded to it
    python3 market.py charges --qty 40 --buy 1250 --sell 1262.5
                                                   # intraday round-trip charges (Groww + NSE)
    add --market US to any of them for the NYSE profile.

How the market is chosen (first one set wins): a --market flag, "market" in trader/config.json,
the TRADER_MARKET environment variable, then "IN".

Other tools load this file by path (`load_market()` below), so it must stay standard-library only
and Python 3.8 compatible (no zoneinfo): IST is a fixed UTC+05:30 with no daylight time, and the
US offset is computed from the 2007 DST rule.

Facts, and where they come from (check them again when they matter, they change):
  NSE capital market hours  9:15 to 15:30 IST, pre-open 9:00 to 9:08.
  NSE 2026 holidays         NSE circular NSE/CMTR/71775 (Dec 2025) plus the 15 Jan 2026
                            Maharashtra municipal election holiday. The 2027 list is not
                            published yet (NSE issues it in December), so 2027 dates are
                            checked for weekends only and flagged.
  NSE tick sizes            from 15 Apr 2025 (NSE/CMTR/67133): below Rs 250: 0.01;
                            250 to 1,000: 0.05; 1,000 to 5,000: 0.10; 5,000 to 10,000: 0.50;
                            10,000 to 20,000: 1.00; above 20,000: 5.00.
                            NSE assigns the tick by band and reviews the band periodically
                            from closing prices, so a stock trading just across a boundary can
                            still carry its old tick. tick(price, ref=...) and the round_*
                            helpers take the coarser of the two bands' ticks (the coarser tick
                            is a multiple of the finer one, so the price is valid in either),
                            which covers the common case of a stop or target on the other side
                            of a boundary from the entry.
  Intraday equity charges   STT 0.025% of the sell value; NSE transaction charge 0.00297% and
                            SEBI fee 0.0001% and IPFT 0.0001% of both sides; stamp duty 0.003%
                            of the buy value; GST 18% on brokerage, transaction charge and SEBI
                            fee. Brokerage defaults to Groww's intraday rate: 0.1% of the order
                            value, at most Rs 20 and at least Rs 5 per executed order. Override
                            any of these under "charges" in trader/config.json.
  Square-off                brokers auto square-off intraday (MIS) positions from about
                            15:10 to 15:20 and charge for it, so flat_by defaults to 15:10.
"""

import argparse
import datetime
import importlib.util
import json
import math
import os
import sys

EPOCH = datetime.datetime(1970, 1, 1)
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- calendars

NSE_HOLIDAYS = {
    "2026-01-15": "Municipal Corporation Election (Maharashtra)",
    "2026-01-26": "Republic Day",
    "2026-03-03": "Holi",
    "2026-03-26": "Shri Ram Navami",
    "2026-03-31": "Shri Mahavir Jayanti",
    "2026-04-03": "Good Friday",
    "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
    "2026-05-01": "Maharashtra Day",
    "2026-05-28": "Bakri Id",
    "2026-06-26": "Muharram",
    "2026-09-14": "Ganesh Chaturthi",
    "2026-10-02": "Mahatma Gandhi Jayanti",
    "2026-10-20": "Dussehra",
    "2026-11-10": "Diwali Balipratipada",
    "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
    "2026-12-25": "Christmas",
}
# holidays that fall on a weekend in 2026 (no effect on trading, listed for completeness)
NSE_WEEKEND_HOLIDAYS = {
    "2026-02-15": "Mahashivratri",
    "2026-03-21": "Id-Ul-Fitr (Ramadan Eid)",
    "2026-08-15": "Independence Day",
    "2026-11-08": "Diwali Laxmi Pujan (Muhurat trading, timings announced by NSE)",
}
NSE_SPECIAL_SESSIONS = {
    "2026-11-08": "Muhurat trading (Diwali): a short evening session, timings per NSE circular",
}

NYSE_HOLIDAYS = {
    "2026-01-01": "New Year's Day",
    "2026-01-19": "Martin Luther King, Jr. Day",
    "2026-02-16": "Washington's Birthday",
    "2026-04-03": "Good Friday",
    "2026-05-25": "Memorial Day",
    "2026-06-19": "Juneteenth National Independence Day",
    "2026-07-03": "Independence Day (observed)",
    "2026-09-07": "Labor Day",
    "2026-11-26": "Thanksgiving Day",
    "2026-12-25": "Christmas Day",
    "2027-01-01": "New Year's Day",
    "2027-01-18": "Martin Luther King, Jr. Day",
    "2027-02-15": "Washington's Birthday",
    "2027-03-26": "Good Friday",
    "2027-05-31": "Memorial Day",
    "2027-06-18": "Juneteenth National Independence Day (observed)",
    "2027-07-05": "Independence Day (observed)",
    "2027-09-06": "Labor Day",
    "2027-11-25": "Thanksgiving Day",
    "2027-12-24": "Christmas Day (observed)",
}
NYSE_EARLY_CLOSE = {  # 1:00 p.m. ET
    "2026-11-27": "day after Thanksgiving",
    "2026-12-24": "Christmas Eve",
    "2027-11-26": "day after Thanksgiving",
}

# ---------------------------------------------------------------- charges (India, intraday equity)

IN_CHARGES = {
    "brokerage_pct": 0.1,        # % of the order value, per executed order
    "brokerage_max": 20.0,       # Rs per executed order
    "brokerage_min": 5.0,        # Rs per executed order
    "stt_sell_pct": 0.025,       # securities transaction tax, sell side (intraday)
    "exchange_pct": 0.00297,     # NSE transaction charge, both sides
    "sebi_pct": 0.0001,          # SEBI turnover fee (Rs 10 per crore), both sides
    "ipft_pct": 0.0001,          # NSE investor protection fund trust charge, both sides
    "stamp_buy_pct": 0.003,      # stamp duty, buy side (intraday)
    "gst_pct": 18.0,             # on brokerage + exchange charge + SEBI fee
}


class MarketError(Exception):
    pass


def _nth_sunday(year, month, n):
    d = datetime.date(year, month, 1)
    d += datetime.timedelta(days=(6 - d.weekday()) % 7)
    return d + datetime.timedelta(weeks=n - 1)


def _us_offset(utc):
    """Hours from UTC for New York: -4 in daylight time, -5 otherwise (US rule since 2007)."""
    y = utc.year
    start = datetime.datetime.combine(_nth_sunday(y, 3, 2), datetime.time(7, 0))
    end = datetime.datetime.combine(_nth_sunday(y, 11, 1), datetime.time(6, 0))
    naive = utc.replace(tzinfo=None)
    return -4 if start <= naive < end else -5


def _in_offset(utc):
    return 5.5


def _hhmm(text):
    h, m = str(text).split(":")
    return datetime.time(int(h), int(m))


def indian_grouping(n):
    """1234567 -> '12,34,567' (lakh and crore grouping)."""
    s = str(int(n))
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts) + "," + tail


class Market(object):
    def __init__(self, code, **kw):
        self.code = code
        self.__dict__.update(kw)

    # ------------------------------------------------ time
    def utc_offset(self, utc):
        """Hours from UTC at that instant (5.5 for IST, -4/-5 for New York)."""
        return self._offset(utc)

    def to_local(self, utc):
        """Naive UTC -> naive exchange-local time."""
        return utc.replace(tzinfo=None) + datetime.timedelta(hours=self._offset(utc))

    def local_to_utc(self, local):
        """Naive exchange-local time -> naive UTC."""
        local = local.replace(tzinfo=None)
        for off in self.offsets:
            utc = local - datetime.timedelta(hours=off)
            if self._offset(utc) == off:
                return utc
        return local - datetime.timedelta(hours=self.offsets[-1])

    def now_local(self):
        return self.to_local(utc_now())

    # ------------------------------------------------ calendar
    def calendar_known(self, d):
        return d.year in self.calendar_years

    def trading_day(self, d):
        """(is_trading_day, reason)."""
        if d.weekday() >= 5:
            return False, "weekend"
        name = self.holidays.get(d.isoformat())
        if name:
            return False, "%s holiday: %s" % (self.exchange, name)
        return True, ""

    def session(self, d):
        """(open, close) exchange-local times, or None when closed all day."""
        ok, _ = self.trading_day(d)
        if not ok:
            return None
        return self.open, (self.early if d.isoformat() in self.early_close else self.close)

    def next_open(self, d):
        """'YYYY-MM-DD HH:MM' of the next session after day d, or None."""
        nd = d + datetime.timedelta(days=1)
        for _ in range(15):
            if self.session(nd):
                return "%s %s" % (nd.isoformat(), self.open.strftime("%H:%M"))
            nd += datetime.timedelta(days=1)
        return None

    def status(self, utc=None):
        utc = utc or utc_now()
        local = self.to_local(utc)
        d = local.date()
        ok, why = self.trading_day(d)
        out = {"market": self.code, "exchange": self.exchange, "local_time": local.strftime("%Y-%m-%d %H:%M"),
               "tz": self.tz_label, "weekday": local.strftime("%A"), "calendar_known": self.calendar_known(d),
               "open": False, "phase": "closed", "reason": why}
        sess = self.session(d)
        if sess:
            op, cl = sess
            t = local.time()
            if t < op:
                out.update(phase="pre-open", reason="opens at %s %s" % (op.strftime("%H:%M"), self.tz_label))
            elif t < cl:
                out.update(open=True, phase="open", reason="closes at %s %s" % (cl.strftime("%H:%M"), self.tz_label))
            else:
                out.update(phase="closed", reason="closed at %s %s" % (cl.strftime("%H:%M"), self.tz_label))
            out["session"] = [op.strftime("%H:%M"), cl.strftime("%H:%M")]
        special = self.special_sessions.get(d.isoformat())
        if special:
            out["special_session"] = special
        if out["phase"] == "pre-open":
            out["next_open"] = "%s %s" % (d.isoformat(), self.open.strftime("%H:%M"))
        elif not out["open"]:
            out["next_open"] = self.next_open(d)
        if out.get("next_open") and self.code == "IN":
            out["next_open_calendar_known"] = self.calendar_known(datetime.date.fromisoformat(out["next_open"][:10]))
        return out

    # ------------------------------------------------ prices
    def _band_tick(self, price):
        for upto, t in self.tick_bands:
            if upto is None or price < upto:
                return t
        return self.tick_bands[-1][1]

    def tick(self, price, ref=None):
        """The tick at price; with ref (say the entry, or the previous close), the coarser of the
        ticks at price and at ref, which is valid in either band."""
        t = self._band_tick(price)
        if ref is not None:
            t = max(t, self._band_tick(ref))
        return t

    def _round(self, price, how, ref=None):
        t = self.tick(price, ref)
        n = price / t
        n = math.floor(n + 1e-9) if how == "down" else math.ceil(n - 1e-9) if how == "up" else round(n)
        return round(n * t, 2)

    def round_down(self, price, ref=None):
        return self._round(price, "down", ref)

    def round_up(self, price, ref=None):
        return self._round(price, "up", ref)

    def round_tick(self, price, ref=None):
        return self._round(price, "near", ref)

    def money(self, x, decimals=2):
        if x is None:
            return "-"
        neg = x < 0
        x = abs(float(x))
        if self.grouping == "indian":
            whole = int(round(x, decimals) // 1)
            frac = ("%.*f" % (decimals, x)).split(".")[1] if decimals else ""
            body = indian_grouping(whole) + (("." + frac) if decimals else "")
        else:
            body = "{:,.{d}f}".format(x, d=decimals)
        return ("-" if neg else "") + self.symbol + body

    # ------------------------------------------------ symbols
    def yahoo_symbol(self, sym):
        s = str(sym).strip().upper()
        if self.code == "IN":
            if s.endswith(".NS") or s.endswith(".BO") or s.startswith("^"):
                return s
            return s + self.yahoo_suffix
        return s.replace(".", "-")

    def plain_symbol(self, sym):
        s = str(sym).strip().upper()
        for suf in (".NS", ".BO"):
            if self.code == "IN" and s.endswith(suf):
                return s[:-len(suf)]
        return s

    # ------------------------------------------------ costs
    def charges(self, qty, buy_price, sell_price, cfg=None):
        """Round-trip intraday charges for qty shares bought at buy_price and sold at sell_price.
        Returns a dict of each charge and "total", all in the market's currency."""
        qty = float(qty or 0)
        buy_v, sell_v = qty * float(buy_price or 0), qty * float(sell_price or 0)
        if self.code != "IN" or qty <= 0:
            return {"total": 0.0, "buy_value": round(buy_v, 2), "sell_value": round(sell_v, 2)}
        c = dict(IN_CHARGES)
        c.update(((cfg or {}).get("charges") or {}))

        def brokerage(v):
            if v <= 0:
                return 0.0
            b = v * c["brokerage_pct"] / 100.0
            return max(float(c["brokerage_min"]), min(float(c["brokerage_max"]), b))

        out = {
            "brokerage": brokerage(buy_v) + brokerage(sell_v),
            "stt": sell_v * c["stt_sell_pct"] / 100.0,
            "exchange": (buy_v + sell_v) * c["exchange_pct"] / 100.0,
            "sebi": (buy_v + sell_v) * c["sebi_pct"] / 100.0,
            "ipft": (buy_v + sell_v) * c["ipft_pct"] / 100.0,
            "stamp": buy_v * c["stamp_buy_pct"] / 100.0,
        }
        out["gst"] = (out["brokerage"] + out["exchange"] + out["sebi"]) * c["gst_pct"] / 100.0
        total = sum(out.values())
        out = dict((k, round(v, 2)) for k, v in out.items())
        out.update(total=round(total, 2), buy_value=round(buy_v, 2), sell_value=round(sell_v, 2))
        return out


MARKETS = {
    "IN": Market(
        "IN", name="India (NSE)", exchange="NSE", tz_label="IST", tz_name="India (IST)",
        currency="INR", symbol="₹", grouping="indian",
        _offset=_in_offset, offsets=(5.5,),
        open=datetime.time(9, 15), close=datetime.time(15, 30), early=datetime.time(15, 30),
        pre_open=(datetime.time(9, 0), datetime.time(9, 8)),
        holidays=NSE_HOLIDAYS, early_close={}, special_sessions=NSE_SPECIAL_SESSIONS,
        calendar_years=(2026,), calendar_source="nseindia.com (Exchange Communication, Holidays)",
        yahoo_suffix=".NS",
        tick_bands=((250, 0.01), (1000, 0.05), (5000, 0.10), (10000, 0.50), (20000, 1.00), (None, 5.00)),
        defaults={"no_entries_before": "09:30", "no_entries_after": "14:45", "flat_by": "15:10"},
        broker="groww",
    ),
    "US": Market(
        "US", name="United States (NYSE/Nasdaq)", exchange="NYSE", tz_label="ET", tz_name="New York (ET)",
        currency="USD", symbol="$", grouping="western",
        _offset=_us_offset, offsets=(-4, -5),
        open=datetime.time(9, 30), close=datetime.time(16, 0), early=datetime.time(13, 0),
        pre_open=(datetime.time(4, 0), datetime.time(9, 30)),
        holidays=NYSE_HOLIDAYS, early_close=NYSE_EARLY_CLOSE, special_sessions={},
        calendar_years=(2026, 2027), calendar_source="nyse.com",
        yahoo_suffix="",
        tick_bands=((None, 0.01),),
        defaults={"no_entries_before": "09:45", "no_entries_after": "15:30", "flat_by": "15:55"},
        broker="alpaca",
    ),
}
ALIASES = {"IN": "IN", "INDIA": "IN", "NSE": "IN", "BSE": "IN", "US": "US", "USA": "US", "NYSE": "US",
           "NASDAQ": "US"}


def get(code):
    key = ALIASES.get(str(code or "").strip().upper())
    if not key:
        raise MarketError("unknown market %r: use IN (NSE) or US (NYSE)" % (code,))
    return MARKETS[key]


def resolve(flag=None, cfg=None):
    """--market flag, then cfg["market"], then $TRADER_MARKET, then India."""
    for cand in (flag, (cfg or {}).get("market") if isinstance(cfg, dict) else None,
                 os.environ.get("TRADER_MARKET")):
        if cand:
            return get(cand)
    return MARKETS["IN"]


def normalize_config(cfg):
    """India configs write money limits as *_inr; the tools read the upstream *_usd names.
    Copies each x_inr onto x_usd (an explicit x_usd wins) and returns a new dict."""
    out = dict(cfg or {})
    for k, v in list(out.items()):
        if k.endswith("_inr"):
            out.setdefault(k[:-4] + "_usd", v)
    return out


def read_config(path="trader/config.json"):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None)


def utc_of(ts):
    return EPOCH + datetime.timedelta(seconds=int(ts))


def load_market():
    """For the other tools: `market = load_market()` without touching sys.path."""
    return sys.modules[__name__]


def load_from(path_of_caller):
    """Load this module from a sibling skill: load_from(__file__) in trader-x/tool.py."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(path_of_caller))),
                        "trader-market", "market.py")
    name = "trader_market_shared"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- CLI

def _parse_at(text, mk):
    t = text.strip().replace("T", " ")
    try:
        local = datetime.datetime.strptime(t, "%Y-%m-%d %H:%M")
    except ValueError:
        raise MarketError('--at wants local exchange time like "2026-11-10 10:00"')
    return mk.local_to_utc(local)


def main(argv=None):
    p = argparse.ArgumentParser(description="Market clock, holidays, tick size and charges.")
    p.add_argument("--market", help="IN (NSE, default) or US (NYSE)")
    p.add_argument("--config", default="trader/config.json")
    p.add_argument("--json", action="store_true")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("status")
    s.add_argument("--at")
    h = sub.add_parser("holidays")
    h.add_argument("--year", type=int)
    t = sub.add_parser("tick")
    t.add_argument("price", type=float)
    c = sub.add_parser("charges")
    c.add_argument("--qty", type=float, required=True)
    c.add_argument("--buy", type=float, required=True)
    c.add_argument("--sell", type=float, required=True)
    a = p.parse_args(argv)
    cfg = read_config(a.config)
    try:
        mk = resolve(a.market, cfg)
        cmd = a.cmd or "status"
        if cmd == "status":
            res = mk.status(_parse_at(a.at, mk) if getattr(a, "at", None) else None)
            if a.json:
                print(json.dumps(res, indent=2))
                return 0
            print("%s  %s %s (%s)  %s: %s" % (mk.exchange, res["local_time"], mk.tz_label, res["weekday"],
                                              res["phase"].upper(), res["reason"] or "-"))
            if res.get("next_open"):
                print("Next open: %s %s" % (res["next_open"], mk.tz_label))
            if res.get("special_session"):
                print("Note: " + res["special_session"])
            if not res["calendar_known"]:
                print("Holiday list covers %s only: check %s for this date."
                      % (", ".join(map(str, mk.calendar_years)), mk.calendar_source))
            elif mk.code == "IN" and res.get("next_open_calendar_known") is False:
                print("Holiday list covers %s only: check %s for the next open."
                      % (", ".join(map(str, mk.calendar_years)), mk.calendar_source))
        elif cmd == "holidays":
            year = a.year or mk.now_local().year
            rows = sorted((d, n) for d, n in mk.holidays.items() if d.startswith(str(year)))
            if a.json:
                print(json.dumps([{"date": d, "name": n} for d, n in rows], indent=2))
                return 0
            if not rows:
                print("No %s holiday list for %d yet: check %s." % (mk.exchange, year, mk.calendar_source))
            for d, n in rows:
                print("%s  %s  %s" % (d, datetime.date.fromisoformat(d).strftime("%a"), n))
        elif cmd == "tick":
            tk = mk.tick(a.price)
            res = {"price": a.price, "tick": tk, "down": mk.round_down(a.price), "up": mk.round_up(a.price)}
            print(json.dumps(res) if a.json else
                  "%s tick at %s is %s: rounds down to %s, up to %s"
                  % (mk.exchange, mk.money(a.price), tk, mk.money(res["down"]), mk.money(res["up"])))
        elif cmd == "charges":
            res = mk.charges(a.qty, a.buy, a.sell, cfg)
            if a.json:
                print(json.dumps(res, indent=2))
                return 0
            gross = (a.sell - a.buy) * a.qty
            for k in ("brokerage", "stt", "exchange", "sebi", "ipft", "stamp", "gst"):
                if k in res:
                    print("  %-10s %s" % (k, mk.money(res[k])))
            print("  %-10s %s" % ("total", mk.money(res["total"])))
            print("Gross P&L %s, net after charges %s. Estimates: check your contract note."
                  % (mk.money(gross), mk.money(gross - res["total"])))
    except MarketError as e:
        print("market.py: %s" % e, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
