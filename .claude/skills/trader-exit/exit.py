#!/usr/bin/env python3
"""Exit Planner for trader-exit: sets the stop and the target BEFORE you
enter, so you know when to get out. Standard library only. Long side only.
It never places an order.

India (NSE, IST, INR) is the default market; --market US (or "market" in
trader/config.json, or TRADER_MARKET=US) gives the original NYSE behaviour, unchanged.

    python3 exit.py plan                                    # from trader/entry.json: or-mid stop, 2R target
    python3 exit.py plan --symbol RELIANCE --entry 1415.30 --or-high 1412 --or-low 1398 --date 2026-10-30
    python3 exit.py --market US plan --symbol TSLA --entry 364.18 --or-high 362.18 --or-low 354.47
    python3 exit.py plan --stop or-mid --target 1R --write  # the reel: stop 358.32, target 370.04
    python3 exit.py plan --symbol TSLA --entry 364.18 --or-high 362.18 --or-low 354.47
    python3 exit.py plan --stop atr:1.5 --offline TSLA.json # ATR needs the session's bars
    python3 exit.py plan --symbol NVDA --entry 190.25 --setup level --stop pct:1
    python3 exit.py show                                    # the current trader/plan.json

Stops (a long's stop rounds DOWN, away from the entry: to the cent in the US, to the
NSE tick in India):
  or-mid     the opening-range midpoint (the default for an orb entry)
  or-low     the opening-range low
  price:X    your price
  pct:X      X percent under the entry
  atr:K      K times the 14-bar ATR under the entry, on the session's bars up
             to the entry bar (--offline FILE or Yahoo). With fewer than 14
             bars by then it averages all of them and says so.
  A level setup has no opening-range default: give a stop.

Targets (US: round half up to the cent; India: UP to the NSE tick):
  2R (default), 1R, 1.5R ...   entry + R x risk, where risk = entry - stop
  price:X                      your price

Refused, with the reason: a stop at or above the entry, a target at or below
it, a risk under 0.05% of the price (too tight to survive the spread), an
entry.json that has not triggered (unless you give --entry), a short (v2
plans longs only).

flat_by (default 15:10 IST in India, 15:55 ET in the US, or "flat_by" in
trader/config.json): out by then, win or lose. On an NYSE 1:00 p.m. early close
it moves up with the close (12:55); NSE has no early closes.

India (the default): the stop rounds DOWN and the target rounds UP to the NSE
tick (0.05 from Rs 250, 0.10 from Rs 1,000 ...), the entry to the nearest tick.
The stop and the target share one tick: the coarsest of the bands of the entry,
the stop and the target (plan.json's "tick"). NSE reviews a stock's band
periodically from its close, so a stock just across a boundary can still carry
its old tick; the coarser tick is a multiple of the finer one and is valid in
either band (entry Rs 1,000.20, stop Rs 999.27 -> Rs 999.20, not 999.25). A plan
dated on an NSE holiday or weekend, or outside the holiday list's years, gets a
note. flat_by defaults to 15:10 IST, ahead of the broker's intraday
(MIS) auto square-off. "Too tight to survive the spread" is a risk under
MIN_TICKS (5) ticks of the entry's tick size, or under 0.05% of the price,
whichever is larger: RELIANCE at Rs 1,415.30 (tick 0.10) needs a stop at least
Rs 0.71 under the entry. The plan also prints the estimated round-trip charges
(brokerage, STT, exchange, SEBI, IPFT, stamp duty, GST from trader-market) for
a reference quantity (--ref-qty, default the whole shares in Rs 1 lakh) as
information only; sizing stays with trader-budget. plan.json keeps every
upstream field and adds market, currency, tick and charges_ref.
"min_reward_risk" in the config (default 1.0) only warns here; trader-risk
enforces it.

A stop is a plan, not a guarantee: a gap or a fast market can fill past it.
Exit codes: plan 0 = a plan, 1 = refused or an error. show 0 = a plan exists.
"""

import argparse
import datetime
import gzip
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP

UA = "Mozilla/5.0 (compatible; day-trader-skill/2.0; +https://github.com/Jakeschincariol/day-trader-skill)"
BACKOFF = 5.0
HOSTS = ("query2", "query1")
INTERVALS = {"1m": 60, "5m": 300}
DEFAULTS = {"flat_by": "15:55", "min_reward_risk": 1.0}
ATR_BARS = 14
MIN_RISK_PCT = Decimal("0.05")     # risk under 0.05% of the price is inside the spread's noise
MIN_TICKS = 5                      # India: and at least 5 NSE ticks (a 1-2 tick spread plus wiggle)
REF_NOTIONAL = 100000              # India: the charges line uses the whole shares in Rs 1 lakh
CENT = Decimal("0.01")
EPOCH = datetime.datetime(1970, 1, 1)
NOTE = "A stop is a plan, not a guarantee: a gap or a fast market can fill past it."

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
OPEN = datetime.time(9, 30)
CLOSE = datetime.time(16, 0)
EARLY = datetime.time(13, 0)
HOLIDAYS, EARLY_CLOSE = NYSE_HOLIDAYS, NYSE_EARLY_CLOSE


class PlanError(Exception):
    pass


# ---------------------------------------------------------------- market (trader-market/market.py)

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
MK = None


def apply_market(mk):
    """Rebind the session constants, the calendar and flat_by's default to market mk."""
    global MK, OPEN, CLOSE, EARLY, HOLIDAYS, EARLY_CLOSE, NYSE_HOLIDAYS, NYSE_EARLY_CLOSE, DEFAULTS
    MK = mk
    OPEN, CLOSE, EARLY = mk.open, mk.close, mk.early
    HOLIDAYS, EARLY_CLOSE = mk.holidays, mk.early_close
    NYSE_HOLIDAYS, NYSE_EARLY_CLOSE = HOLIDAYS, EARLY_CLOSE      # the upstream names
    DEFAULTS = {"flat_by": mk.defaults["flat_by"], "min_reward_risk": 1.0}
    return mk


apply_market(market.resolve())


def is_us():
    return MK.code == "US"


def a_tz():
    return "a New York time" if is_us() else "an %s time" % MK.tz_label


# ---------------------------------------------------------------- time

def _nth_sunday(year, month, n):
    d = datetime.date(year, month, 1)
    d += datetime.timedelta(days=(6 - d.weekday()) % 7)
    return d + datetime.timedelta(weeks=n - 1)


def eastern_offset(utc):
    """Hours from UTC for the active market's clock: 5.5 (IST) or -4/-5 (New York)."""
    return MK.utc_offset(utc)


def to_eastern(utc):
    """Naive UTC -> naive exchange-local time (IST in India, New York in US mode)."""
    return MK.to_local(utc)


def eastern_to_utc(local):
    return MK.local_to_utc(local)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None)


def utc_of(ts):
    return EPOCH + datetime.timedelta(seconds=int(ts))


def parse_now(text):
    """--now -> naive UTC. A time without an offset is exchange-local (IST, or New York)."""
    if not text:
        return utc_now()
    t = text.strip()
    for lab in (" ET", " IST"):
        if t.upper().endswith(lab):
            t = t[:-len(lab)].strip()
            break
    if re.match(r"^\d{1,2}:\d{2}$", t):
        t = "%s %s" % (to_eastern(utc_now()).date().isoformat(), t.zfill(5))
    t = t.replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(t)
    except ValueError:
        raise PlanError('--now wants %s like "%s" (or ...Z for UTC)'
                        % (a_tz(), "2026-10-19 10:15" if is_us() else "2026-10-30 09:50"))
    if dt.tzinfo is None:
        return eastern_to_utc(dt)
    return (dt - dt.utcoffset()).replace(tzinfo=None)


def parse_hhmm(text, what):
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", str(text))
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise PlanError("%s wants %s like %s, not %r" % (what, a_tz(), DEFAULTS["flat_by"], text))
    return datetime.time(int(m.group(1)), int(m.group(2)))


def parse_clock(text, what):
    """10:15 AM, 10:15, 3:05 PM -> time."""
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$", str(text))
    if not m:
        raise PlanError("%s wants a time like 10:15 AM, not %r" % (what, text))
    h, mi = int(m.group(1)), int(m.group(2))
    if m.group(3):
        if not 1 <= h <= 12:
            raise PlanError("%s wants a time like 10:15 AM, not %r" % (what, text))
        h = h % 12 + (12 if m.group(3).upper() == "PM" else 0)
    if h > 23 or mi > 59:
        raise PlanError("%s wants a time like 10:15 AM, not %r" % (what, text))
    return datetime.time(h, mi)


def hm(t):
    return "%02d:%02d" % (t.hour, t.minute)


def ampm(t):
    h = t.hour % 12 or 12
    return "%d:%02d %s" % (h, t.minute, "AM" if t.hour < 12 else "PM")


def session(d):
    """(open_time, close_time) in exchange-local time, or None if closed all day."""
    if d.weekday() >= 5 or d.isoformat() in HOLIDAYS:
        return None
    return OPEN, (EARLY if d.isoformat() in EARLY_CLOSE else CLOSE)


# ---------------------------------------------------------------- money math (Decimal, to the cent)

def D(x, what="a number"):
    try:
        if isinstance(x, float):
            return Decimal(repr(x))
        s = str(x).strip()
        for sym in ("$", "\u20b9", "Rs.", "Rs", "rs.", "rs"):
            if s.startswith(sym):
                s = s[len(sym):].strip()
                break
        return Decimal(s.replace(",", ""))
    except (InvalidOperation, ValueError):
        raise PlanError("%s is not a number: %r" % (what, x))


def cents(x):
    """Round half up to the cent."""
    return D(x).quantize(CENT, rounding=ROUND_HALF_UP)


def floor_cents(x):
    """A long's stop: round down, away from the entry."""
    return D(x).quantize(CENT, rounding=ROUND_FLOOR)


def money(x):
    if not is_us():
        return MK.money(float(D(x)))
    return "$%s" % format(D(x).quantize(CENT), ",f")


def amt(x):
    """An exact amount in a sentence: $358.325 (upstream) or Rs 1,405.00 / Rs 1,401.177 in India."""
    if is_us():
        return "$%s" % num(x)
    d = D(x)
    if d == d.quantize(CENT):
        return MK.money(float(d))
    return MK.symbol + num(d)


def tick_of(x, ref=None):
    """The price step at x: 0.01 in the US; the NSE tick band in India. With ref (the entry),
    the coarser of the ticks at x and at ref: NSE sets a stock's tick from its band, reviewed
    periodically from the close, so a stop or target across a band boundary from the entry
    stays valid whichever band the stock carries."""
    if is_us():
        return CENT
    return D(MK.tick(float(D(x)), None if ref is None else float(D(ref))))


def to_tick(x, rounding, ref=None, tick=None):
    t = tick if tick is not None else tick_of(x, ref)
    return ((D(x) / t).to_integral_value(rounding=rounding) * t).quantize(CENT)


def entry_px(x, ref=None):
    """The entry: to the cent (US) or the nearest NSE tick (India; with ref, the opening-range high)."""
    return cents(x) if is_us() else to_tick(x, ROUND_HALF_UP, ref)


def stop_px(x, ref=None, tick=None):
    """A long's stop: down, away from the entry, to the cent or the NSE tick."""
    return floor_cents(x) if is_us() else to_tick(x, ROUND_FLOOR, ref, tick)


def target_px(x, ref=None, tick=None):
    """A long's target: half up to the cent (US, upstream) or UP to the NSE tick (India)."""
    return cents(x) if is_us() else to_tick(x, ROUND_CEILING, ref, tick)


def level_px(x):
    """An opening-range high or low from the bars."""
    return cents(x) if is_us() else to_tick(x, ROUND_HALF_UP)


def num(x):
    """1, 1.5, 2.25: a Decimal without trailing zeros."""
    s = format(D(x).normalize(), "f")
    return s


def ratio(x):
    """reward:risk for people: 1.0, 1.5, 1.37."""
    s = "%.2f" % float(x)
    return s[:-1] if s.endswith("0") else s


WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def parse_stop(text):
    t = str(text).strip().lower()
    if t in ("or-mid", "or_mid", "mid", "or-midpoint"):
        return "or_mid", None
    if t in ("or-low", "or_low", "low"):
        return "or_low", None
    m = re.match(r"^(price|pct|atr):\s*(?:\$|\u20b9|rs\.?)?\s*([0-9][0-9,]*\.?[0-9]*)$", t)
    if not m:
        raise PlanError("--stop is or-mid, or-low, price:X, pct:X or atr:K (got %r)" % text)
    kind, val = m.group(1), D(m.group(2), "--stop")
    if val <= 0:
        raise PlanError("--stop %s needs a number above 0" % kind)
    if kind == "pct" and val >= 100:
        raise PlanError("--stop pct:X needs X under 100")
    return kind, val


def parse_target(text):
    t = str(text).strip()
    m = re.match(r"^([0-9]*\.?[0-9]+)\s*[Rr]$", t)
    if m:
        r = D(m.group(1), "--target")
        if r <= 0:
            raise PlanError("--target needs an R multiple above 0, like 1R or 2R")
        return "r", r
    m = re.match(r"^price:\s*(?:\$|\u20b9|rs\.?)?\s*([0-9][0-9,]*\.?[0-9]*)$", t.lower())
    if m:
        return "price", D(m.group(1), "--target")
    raise PlanError("--target is 2R, 1R, 1.5R ... or price:X (got %r)" % text)


def r_label(r):
    n = int(r) if r == r.to_integral_value() else None
    return "%sR (%s times the risk)" % (num(r), WORDS.get(n, num(r)))


def compute(entry, stop_rule, stop_param, target_rule, target_param, or_high=None, or_low=None,
            atr=None, atr_bars=None):
    """The stop, the target and the risk, in exact cents (on the NSE tick in India).
    Raises PlanError with the reason."""
    e = entry_px(entry) if is_us() else entry_px(entry, or_high)
    if e <= 0:
        raise PlanError("the entry price must be above %s" % money(0).split(".")[0])
    detail = ""
    if stop_rule in ("or_mid", "or_low"):
        if or_high is None or or_low is None:
            raise PlanError("an %s stop needs the opening range (--or-high and --or-low)" % stop_rule.replace("_", "-"))
        oh, ol = level_px(or_high), level_px(or_low)
        if oh <= ol:
            raise PlanError("the opening-range high %s must be above its low %s" % (money(oh), money(ol)))
        if stop_rule == "or_mid":
            raw = (oh + ol) / 2
            label = "opening-range midpoint"
            detail = "(%s + %s) / 2 = %s" % (money(oh), money(ol), amt(raw))
        else:
            raw, label = ol, "opening-range low"
    elif stop_rule == "price":
        raw, label = stop_param, "your price"
    elif stop_rule == "pct":
        raw = e * (1 - stop_param / 100)
        label = "%s%% under the entry" % num(stop_param)
        detail = "%s x (1 - %s%%) = %s" % (money(e), num(stop_param), amt(raw))
    elif stop_rule == "atr":
        if atr is None:
            raise PlanError("an atr stop needs the session's bars")
        a = D(round(atr, 6))
        raw = e - stop_param * a
        label = "%s x ATR(%d) under the entry" % (num(stop_param), atr_bars)
        detail = "ATR %s%s over the %d bars to the entry%s" % (
            "$" if is_us() else MK.symbol, num(a.quantize(Decimal("0.0001"))), atr_bars, " (fewer than 14 so far)" if atr_bars < ATR_BARS else "")
    else:
        raise PlanError("unknown stop rule %r" % stop_rule)
    if is_us():
        stop = stop_px(raw)
        tick = CENT
    else:
        # one tick for the stop and the target: the coarsest of the bands of the entry, the
        # stop and the target (each coarser tick is a multiple of the finer ones)
        tick = tick_of(raw, e)
        for _ in range(3):
            stop = stop_px(raw, tick=tick)
            t_raw = (e + target_param * (e - stop)) if target_rule == "r" else target_param
            t2 = max(tick, tick_of(t_raw)) if t_raw > 0 else tick
            if t2 == tick:
                break
            tick = t2
    if stop != D(raw):
        how = "rounded down" if is_us() else "rounded down to the %s tick" % num(tick)
        detail = (detail + ", " + how if detail else "%s %s" % (amt(raw), how))
    if stop >= e:
        raise PlanError("the stop %s (%s) is at or above the entry %s: a long's stop goes under the entry"
                        % (money(stop), label, money(e)))
    if stop <= 0:
        raise PlanError("the stop works out to %s: pick a stop above %s" % (money(stop), money(0).split(".")[0]))
    risk = e - stop
    floor_risk = e * MIN_RISK_PCT / 100
    if not is_us():
        tk = tick_of(e)
        need = max(floor_risk, tk * MIN_TICKS)
        if risk < need:
            by_ticks = tk * MIN_TICKS >= floor_risk
            raise PlanError("the stop is %s under the entry (%s tick(s) of %s): risk %s is under the %s minimum "
                            "(the larger of %d ticks = %s and 0.05%% of the price = %s on %s; the %s rule binds): "
                            "too tight to survive the spread, normal wiggle would stop you out. Widen it."
                            % (money(risk), num(risk / tk), num(tk), money(risk),
                               money(need.quantize(CENT, rounding=ROUND_CEILING)),
                               MIN_TICKS, money(tk * MIN_TICKS), amt(floor_risk.normalize()), money(e),
                               "%d-tick" % MIN_TICKS if by_ticks else "0.05%"))
    if risk < floor_risk:
        raise PlanError("the stop is %s under the entry, less than 0.05%% of the price (%s on %s): too tight to "
                        "survive the spread, normal wiggle would stop you out. Widen it."
                        % (money(risk), money(floor_risk.quantize(CENT, rounding=ROUND_HALF_UP)), money(e)))
    if target_rule == "r":
        target = target_px(e + target_param * risk) if is_us() else target_px(e + target_param * risk, tick=tick)
        t_label = r_label(target_param)
    else:
        target = target_px(target_param) if is_us() else target_px(target_param, tick=tick)
        t_label = None
    if target <= e:
        raise PlanError("the target %s is at or below the entry %s: a long's target goes above it"
                        % (money(target), money(e)))
    rr = ((target - e) / risk).quantize(CENT, rounding=ROUND_HALF_UP)
    if t_label is None:
        t_label = "your price (%sR)" % ratio(rr)
    out = {"entry": e, "stop": stop, "stop_label": label, "stop_detail": detail, "target": target,
           "target_r": target_param if target_rule == "r" else rr, "target_label": t_label,
           "risk": risk, "reward_risk": rr}
    if not is_us():
        out["tick"] = tick      # the tick the stop and the target were rounded to (plan.json's "tick")
    return out


# ---------------------------------------------------------------- bars for ATR (same reader as trader-entry)

def _open_url(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _sleep(seconds):
    time.sleep(seconds)


def yahoo_get(path):
    """query2 first, query1 on 429 or 5xx; one retry after a pause on 429."""
    last = "no answer"
    for host in HOSTS:
        url = "https://%s.finance.yahoo.com%s" % (host, path)
        for attempt in (0, 1):
            try:
                return _open_url(url)
            except urllib.error.HTTPError as e:
                code, body = e.code, None
                try:
                    if code == 404:     # Yahoo says why in the body: an unknown ticker
                        body = e.read().decode("utf-8", "replace")
                except Exception:
                    body = None
                finally:
                    e.close()
                if code == 404:
                    if body:
                        return body
                    raise PlanError("Yahoo has no chart at %s (HTTP 404)" % url.split("?")[0])
                last = "HTTP %d" % code
                if code == 429 and attempt == 0:
                    _sleep(BACKOFF)
                    continue
                if code == 429 or code >= 500:
                    break
                raise PlanError("Yahoo answered HTTP %d for %s" % (code, url.split("?")[0]))
            except urllib.error.URLError as e:
                last = "could not connect: %s" % (e.reason,)
                break
            except OSError as e:
                last = "network error: %s" % (e,)
                break
    raise PlanError("Yahoo did not answer (%s on query2 and query1): wait a minute and try again" % last)


def read_text(path):
    if path.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return fh.read()
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def load_chart(sym, interval, day, offline=None):
    ysym = MK.yahoo_symbol(sym)
    if offline:
        path = offline
        if os.path.isdir(offline):
            path = os.path.join(offline, ysym + ".json")
            for name in (ysym, MK.plain_symbol(sym)):
                for ext in (".json", ".json.gz"):
                    if os.path.exists(os.path.join(offline, name + ext)):
                        path = os.path.join(offline, name + ext)
                        break
                else:
                    continue
                break
            else:
                path += ".gz"
        if not os.path.exists(path):
            raise PlanError("no offline file %s" % path)
        try:
            text = read_text(path)
        except (OSError, ValueError) as e:
            raise PlanError("could not read %s: %s" % (path, e))
    else:
        back = (to_eastern(utc_now()).date() - day).days
        rng = "1d" if back <= 0 else "5d" if back <= 6 else "1mo" if back <= 28 else "60d"
        if interval == "1m" and back > 6:
            raise PlanError("Yahoo keeps 1-minute bars for about a week")
        text = yahoo_get("/v8/finance/chart/%s?range=%s&interval=%s" % (urllib.parse.quote(ysym, safe="^.-"),
                                                                        rng, interval))
    try:
        data = json.loads(text)
        res = data["chart"]["result"]
    except (ValueError, KeyError, TypeError):
        raise PlanError("Yahoo returned something unexpected for %s" % sym)
    if not res:
        err = (data.get("chart") or {}).get("error") or {}
        raise PlanError("Yahoo has no data for %s: %s" % (sym, err.get("description") or "unknown ticker"))
    r = res[0] or {}
    meta = r.get("meta") or {}
    if str(meta.get("symbol") or ysym).upper() != ysym:
        raise PlanError("the chart file holds %s, not %s" % (MK.plain_symbol(meta.get("symbol")), sym))
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0] or {}

    def at(key, i):
        arr = q.get(key) or []
        return arr[i] if i < len(arr) else None

    bars = []
    for i, t in enumerate(r.get("timestamp") or []):
        c = at("close", i)
        if t is None or c is None:
            continue
        h, lo = at("high", i), at("low", i)
        bars.append({"t": int(t), "h": float(c if h is None else h), "l": float(c if lo is None else lo),
                     "c": float(c)})
    return {"bars": bars, "data_time": meta.get("regularMarketTime")}


def session_bars(chart, day, interval, upto_slot=None, now_utc=None):
    """Closed, on-grid bars of one exchange session, oldest first (the live tick is dropped)."""
    step = INTERVALS[interval]
    s = session(day)
    if not s:
        return []
    open_dt = datetime.datetime.combine(day, s[0])
    close_dt = datetime.datetime.combine(day, s[1])
    if now_utc is None and chart.get("data_time"):
        now_utc = utc_of(chart["data_time"])
    local = to_eastern(now_utc) if now_utc else None
    out = {}
    for b in chart["bars"]:
        if b["t"] % step:
            continue
        et = to_eastern(utc_of(b["t"]))
        if et.date() != day or not (open_dt <= et < close_dt):
            continue
        if local and et + datetime.timedelta(seconds=step) > local:
            continue
        slot = int((et - open_dt).total_seconds()) // step
        if upto_slot is not None and slot > upto_slot:
            continue
        out[slot] = b
    return [out[k] for k in sorted(out)]


def atr_of(bars, n=ATR_BARS):
    """Average true range of the last n bars (all of them if fewer). The first
    bar of the session uses its own high - low (no overnight gap)."""
    trs, prev = [], None
    for b in bars:
        tr = b["h"] - b["l"]
        if prev is not None:
            tr = max(tr, abs(b["h"] - prev), abs(b["l"] - prev))
        trs.append(tr)
        prev = b["c"]
    use = trs[-n:]
    return sum(use) / len(use), len(use)


# ---------------------------------------------------------------- plan

def read_json(path, what):
    if not path or not os.path.exists(path):
        raise PlanError("no %s at %s" % (what, path))
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except ValueError as e:
        raise PlanError("%s is not valid JSON: %s" % (path, e))


def read_config(path):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        doc = market.normalize_config(read_json(path, "config"))
        for k in DEFAULTS:
            if doc.get(k) is not None:
                cfg[k] = doc[k]
        if isinstance(doc.get("charges"), dict):
            cfg["charges"] = doc["charges"]        # overrides for trader-market's charge rates
    return cfg


def resolve_flat_by(day, explicit, cfg, entry_time):
    """(HH:MM, note). The config's flat-by moves up with a 1:00 p.m. early close."""
    t = parse_hhmm(explicit or cfg.get("flat_by") or DEFAULTS["flat_by"], "--flat-by" if explicit else "flat_by")
    note = ""
    s = session(day) if day else None
    if s:
        close_dt = datetime.datetime.combine(day, s[1])
        at = datetime.datetime.combine(day, t)
        if at >= close_dt:
            if explicit:
                raise PlanError("--flat-by %s is at or after the %s close on %s" % (hm(t), ampm(s[1]), day))
            moved = at - (datetime.datetime.combine(day, CLOSE) - close_dt)
            if moved.time() <= OPEN:
                raise PlanError("flat_by %s in the config is at or after the close" % hm(t))
            t = moved.time()
            note = "moved up for the 1:00 p.m. early close (%s)" % EARLY_CLOSE.get(day.isoformat(), "")
    if entry_time and entry_time >= t:
        raise PlanError("the entry at %s is at or after your flat-by %s: there is no time left to hold it"
                        % (ampm(entry_time), hm(t)))
    return hm(t), note


def gather(a):
    """The entry facts, from trader/entry.json or the flags."""
    if a.symbol and a.from_path:
        raise PlanError("use --from or --symbol, not both")
    if a.side in ("sell", "short"):
        raise PlanError("v2 plans longs only: no stops above a short entry. Plan a buy instead.")
    if a.symbol:
        if a.entry is None:
            raise PlanError("--symbol needs --entry PRICE")
        if (a.or_high is None) != (a.or_low is None):
            raise PlanError("give both --or-high and --or-low, or neither")
        info = {"symbol": MK.plain_symbol(a.symbol), "entry": a.entry, "setup": a.setup or ("orb" if a.or_high is not None else "level"),
                "date": a.date, "entry_time": a.time, "entry_bar": a.entry_bar, "interval": a.interval or "5m",
                "or_high": a.or_high, "or_low": a.or_low, "or_minutes": a.or_minutes, "source": "flags"}
    else:
        path = a.from_path or "trader/entry.json"
        doc = read_json(path, "entry (run /trader-entry first, or give --symbol and --entry)")
        if doc.get("market") and market.get(doc["market"]).code != MK.code:
            raise PlanError("%s is for the %s market, this run is %s: add --market %s"
                            % (path, doc["market"], MK.code, market.get(doc["market"]).code))
        if str(doc.get("side") or "buy").lower() not in ("buy", "long"):
            raise PlanError("%s is a %s: v2 plans longs only" % (path, doc.get("side")))
        if doc.get("status") != "triggered" and a.entry is None:
            raise PlanError("%s says %s is %s, not triggered: plan once it triggers, or give --entry PRICE to plan ahead"
                            % (path, doc.get("symbol"), doc.get("status") or "unknown"))
        orr = doc.get("opening_range") or {}
        info = {"symbol": MK.plain_symbol(str(doc.get("symbol") or "")), "entry": a.entry if a.entry is not None else doc.get("price"),
                "setup": a.setup or doc.get("setup") or "orb", "date": a.date or doc.get("date"),
                "entry_time": a.time or (doc.get("time") if a.entry is None else None),
                "entry_bar": a.entry_bar if a.entry_bar is not None else (doc.get("bar_index") if a.entry is None else None),
                "interval": a.interval or doc.get("interval") or "5m",
                "or_high": a.or_high if a.or_high is not None else orr.get("high"),
                "or_low": a.or_low if a.or_low is not None else orr.get("low"),
                "or_minutes": orr.get("minutes") or a.or_minutes, "source": path}
        if not info["symbol"] or info["entry"] is None:
            raise PlanError("%s has no symbol or price" % path)
    if info["interval"] not in INTERVALS:
        raise PlanError("interval is 5m or 1m")
    return info


def build_plan(a, now_utc):
    info = gather(a)
    cfg = read_config(a.config)
    stop_text = a.stop
    if not stop_text:
        if info["setup"] != "orb":
            raise PlanError("a %s setup has no opening-range stop to default to: give --stop price:X, pct:X or atr:K"
                            % info["setup"])
        stop_text = "or-mid"
    stop_rule, stop_param = parse_stop(stop_text)
    target_rule, target_param = parse_target(a.target or "2R")
    day = None
    if info["date"]:
        try:
            day = datetime.date.fromisoformat(str(info["date"]))
        except ValueError:
            raise PlanError("date wants YYYY-MM-DD, not %r" % info["date"])
    else:
        day = to_eastern(now_utc).date()
    entry_time = parse_clock(info["entry_time"], "the entry time") if info["entry_time"] else None
    atr = atr_n = None
    if stop_rule == "atr":
        chart = load_chart(info["symbol"], info["interval"], day, a.offline)
        bars = session_bars(chart, day, info["interval"], info["entry_bar"], parse_now(a.now) if a.now else None)
        if len(bars) < 3:
            raise PlanError("an atr stop needs at least 3 closed %s bars of %s on %s by the entry; found %d"
                            % (info["interval"], info["symbol"], day, len(bars)))
        atr, atr_n = atr_of(bars)
    c = compute(info["entry"], stop_rule, stop_param, target_rule, target_param, info["or_high"], info["or_low"],
                atr, atr_n)
    flat_by, flat_note = resolve_flat_by(day, a.flat_by, cfg, entry_time)
    orr = None
    if info["or_high"] is not None and info["or_low"] is not None:
        orr = {"high": float(level_px(info["or_high"])), "low": float(level_px(info["or_low"])),
               "minutes": int(info["or_minutes"] or 15)}
    plan = {"created_by": "trader-exit", "symbol": info["symbol"], "side": "buy", "date": day.isoformat(),
            "setup": info["setup"], "entry": float(c["entry"]),
            "entry_time": ampm(entry_time) if entry_time else None,
            "entry_bar": info["entry_bar"], "interval": info["interval"], "opening_range": orr,
            "stop": float(c["stop"]), "stop_rule": stop_rule, "stop_label": c["stop_label"],
            "target": float(c["target"]), "target_r": float(c["target_r"]), "target_label": c["target_label"],
            "risk_per_share": float(c["risk"]), "reward_risk": float(c["reward_risk"]), "flat_by": flat_by,
            "stop_detail": c["stop_detail"], "created_at": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"), "note": NOTE}
    if atr is not None:
        plan["atr"] = round(atr, 4)
        plan["atr_bars"] = atr_n
    if not is_us():
        plan.update(market=MK.code, currency=MK.currency, tick=float(c["tick"]),
                    charges_ref=charges_ref(c, getattr(a, "ref_qty", None), cfg))
    warnings = []
    if flat_note:
        warnings.append("Flat-by %s: %s." % (flat_by, flat_note))
    if not is_us() and parse_hhmm(flat_by, "flat_by") > parse_hhmm(MK.defaults["flat_by"], "flat_by"):
        warnings.append("Flat-by %s is after %s %s: brokers square off intraday (MIS) positions from about 15:10 "
                        "to 15:20 and charge for it; close it yourself first." % (flat_by, MK.defaults["flat_by"],
                                                                                   MK.tz_label))
    mrr = cfg.get("min_reward_risk")
    try:
        if mrr is not None and c["reward_risk"] < D(mrr):
            warnings.append("Reward:risk %s is under your min_reward_risk %s in the config: trader-risk checks that."
                            % (ratio(c["reward_risk"]), num(D(mrr))))
    except PlanError:
        pass
    today = to_eastern(now_utc).date()
    if day != today:
        warnings.append("This plan is for %s, not today (%s)." % (day.isoformat(), today.isoformat()))
    if not is_us():
        ok, why = MK.trading_day(day)
        if not ok:
            nxt = MK.next_open(day)
            special = MK.special_sessions.get(day.isoformat())
            warnings.append("%s is not a regular NSE trading day (%s)%s%s."
                            % (day.isoformat(), why,
                               (": %s, which this plan does not cover" % special) if special else
                               ": there is no session to trade this plan in",
                               ("; next regular open %s %s" % (nxt, MK.tz_label)) if nxt else ""))
        if not MK.calendar_known(day):
            warnings.append("Holiday list covers %s only: check %s for this date."
                            % (" and ".join(map(str, MK.calendar_years)), MK.calendar_source))
    return plan, warnings


def charges_ref(c, qty, cfg):
    """Estimated round-trip charges for a reference quantity (info only: sizing is trader-budget's)."""
    e, stop, target = float(c["entry"]), float(c["stop"]), float(c["target"])
    auto = not qty
    if auto:
        qty = max(1, int(REF_NOTIONAL // e))
    if qty <= 0:
        raise PlanError("--ref-qty must be a whole number above 0")
    at_t = MK.charges(qty, e, target, cfg)["total"]
    at_s = MK.charges(qty, e, stop, cfg)["total"]
    risk, reward = float(c["risk"]) * qty, (target - e) * qty
    return {"qty": int(qty), "basis": "%s of stock" % MK.money(REF_NOTIONAL, 0) if auto else "--ref-qty",
            "at_target": at_t, "at_stop": at_s,
            "per_share_at_target": round(at_t / qty, 2), "per_share_at_stop": round(at_s / qty, 2),
            "reward_risk_net": round((reward - at_t) / (risk + at_s), 2) if risk + at_s > 0 else None,
            "note": "estimate at trader-market's intraday rates; information only, trader-budget sizes the trade"}


def describe(plan):
    day = datetime.date.fromisoformat(plan["date"])
    setup = {"orb": "opening-range breakout", "level": "close above a level"}.get(plan["setup"], plan["setup"])
    e = D(plan["entry"])
    risk = D(plan["risk_per_share"])
    pct = (risk / e * 100).quantize(CENT, rounding=ROUND_HALF_UP)
    when = ""
    if plan.get("entry_time"):
        when = " at %s" % plan["entry_time"]
        if plan.get("entry_bar") is not None:
            when += " (bar %d)" % plan["entry_bar"]
    out = ["Exit plan: %s long, %s, %s on %s bars" % (
        plan["symbol"], day.strftime("%a %Y-%m-%d"), setup, "5-minute" if plan["interval"] == "5m" else "1-minute")]
    out.append("  Entry         %s%s" % (money(plan["entry"]), when))
    out.append("  Stop          %s  %s%s" % (money(plan["stop"]), plan["stop_label"],
                                             (": " + plan["stop_detail"]) if plan.get("stop_detail") else ""))
    out.append("  Target        %s  %s" % (money(plan["target"]), plan["target_label"]))
    out.append("  Risk a share  %s (%s%% of the entry)" % (money(plan["risk_per_share"]), pct))
    out.append("  Reward:risk   %s" % ratio(plan["reward_risk"]))
    ch = plan.get("charges_ref")
    if ch:
        out.append("  Charges       about %s round trip at the target, %s at the stop, on %d shares (%s), "
                   "%s / %s a share; reward:risk after charges %s. Estimate, information only"
                   % (money(ch["at_target"]), money(ch["at_stop"]), ch["qty"], ch.get("basis", "reference"),
                      money(ch["per_share_at_target"]), money(ch["per_share_at_stop"]),
                      ratio(ch["reward_risk_net"]) if ch.get("reward_risk_net") is not None else "-"))
    out.append("  Flat by       %s %s, win or lose: no overnight hold%s" % (
        plan["flat_by"], MK.tz_label,
        " (ahead of the broker's MIS auto square-off)" if not is_us() and plan["flat_by"] <= MK.defaults["flat_by"]
        else ""))
    out.append("Set before the entry. If price hits the stop, you are out; never move it further away.")
    out.append(NOTE)
    return out


def cmd_plan(a):
    now = parse_now(a.now)
    plan, warnings = build_plan(a, now)
    if a.write:
        d = os.path.dirname(a.write)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(a.write, "w", encoding="utf-8") as fh:
            json.dump(plan, fh, indent=2)
            fh.write("\n")
    if a.json:
        print(json.dumps(dict(plan, warnings=warnings), indent=2))
        return 0
    for line in describe(plan):
        print(line)
    for w in warnings:
        print("Note: " + w)
    if a.write:
        print("Wrote %s." % a.write)
    print("Next: /trader-timemachine replays it, then /trader-budget sizes it to your max loss. Nothing was placed.")
    return 0


def cmd_show(a):
    if not os.path.exists(a.plan):
        print("No plan at %s yet. Make one: exit.py plan --write" % a.plan)
        return 1
    plan = read_json(a.plan, "plan")
    for k in ("symbol", "date", "entry", "stop", "target", "risk_per_share", "reward_risk", "flat_by"):
        if plan.get(k) is None:
            raise PlanError("%s is missing %r: make a new plan with exit.py plan --write" % (a.plan, k))
    if a.json:
        print(json.dumps(plan, indent=2))
        return 0
    for line in describe(dict({"setup": "orb", "interval": "5m", "stop_label": "", "target_label": ""}, **plan)):
        print(line)
    today = to_eastern(parse_now(a.now)).date().isoformat()
    if plan["date"] != today:
        print("Note: this plan is for %s, not today (%s)." % (plan["date"], today))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Exit Planner (trader-exit): the stop and target before the entry.")
    ap.add_argument("--market", dest="market_top", help="IN (NSE, IST, INR; the default) or US (NYSE)")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("plan", help="set the stop and target")
    p.add_argument("--from", dest="from_path", metavar="PATH", help="entry.json to plan from (default trader/entry.json)")
    p.add_argument("--symbol")
    p.add_argument("--entry", type=float, help="entry price (or a plan-ahead price with --from)")
    p.add_argument("--or-high", type=float)
    p.add_argument("--or-low", type=float)
    p.add_argument("--or-minutes", type=int, default=15)
    p.add_argument("--setup", choices=["orb", "level"])
    p.add_argument("--date", help="session date YYYY-MM-DD (default: the entry's, or today)")
    p.add_argument("--time", help="entry time, e.g. 10:15 AM")
    p.add_argument("--entry-bar", type=int)
    p.add_argument("--interval", choices=["5m", "1m"])
    p.add_argument("--side", default="buy", choices=["buy", "long", "sell", "short"], help="v2: buy only")
    p.add_argument("--stop", help="or-mid (orb default), or-low, price:X, pct:X, atr:K")
    p.add_argument("--target", help="2R (default), 1R, 1.5R, price:X")
    p.add_argument("--flat-by", help="HH:MM exchange-local (default: config flat_by, 15:10 IST or 15:55 ET)")
    p.add_argument("--ref-qty", type=int, help="India: shares for the charges estimate (default: Rs 1 lakh worth)")
    p.add_argument("--market", help="IN (NSE, IST, INR; the default) or US (NYSE)")
    p.add_argument("--config", default="trader/config.json")
    p.add_argument("--offline", metavar="PATH", help="saved Yahoo chart JSON for an atr stop")
    p.add_argument("--now", help='pretend it is this exchange-local time, e.g. "2026-10-30 09:50" (IST)')
    p.add_argument("--write", nargs="?", const="trader/plan.json", metavar="PATH",
                   help="save the plan (default trader/plan.json)")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("show", help="print the current plan")
    p.add_argument("--plan", default="trader/plan.json")
    p.add_argument("--now")
    p.add_argument("--json", action="store_true")
    p.add_argument("--config", default="trader/config.json")
    p.add_argument("--market", help="IN (NSE, IST, INR; the default) or US (NYSE)")
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 1
    try:
        try:
            apply_market(market.resolve(a.market or a.market_top, market.read_config(a.config)))
        except market.MarketError as e:
            raise PlanError(str(e))
        return {"plan": cmd_plan, "show": cmd_show}[a.cmd](a)
    except PlanError as e:
        print("exit.py: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
