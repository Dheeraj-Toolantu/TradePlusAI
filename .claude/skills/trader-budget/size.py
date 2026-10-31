#!/usr/bin/env python3
"""Position sizing for trader-budget. Standard library only, no network.

India first (NSE, IST, rupees, Groww). `--market US` (or "market": "US" in the
config, or TRADER_MARKET=US) gives the original NYSE / Alpaca behaviour,
described in the rest of this docstring. In India mode:

  - whole shares only (NSE has no fractional shares), sized so that
    qty x (entry - stop) + charges(qty, entry, stop) <= max_loss_per_trade_inr
    when "include_charges" is true (brokerage, STT, exchange, SEBI, stamp,
    GST from trader-market's IN_CHARGES, overridden by "charges" in the config);
  - the cash and position limits assume no MIS leverage ("allow_margin": false);
    the cash limit also leaves room for the buy-side charges;
  - reward:risk is checked net of charges;
  - the entry is a LIMIT at the sized price by default (--market-order for MARKET),
    prices are rounded to the NSE tick;
  - each order keeps the upstream fields trader-risk and trader-broker read and adds
    a "groww" block shaped like the Groww Trade API place_order params. Groww has no
    equity bracket order, so the bracket becomes legs: the LIMIT BUY entry now, then,
    once it fills, an SL_M SELL at the stop. The target is NOT a second resting sell
    (two live exits could both fill and leave you short): trader-alerts watches it,
    and when it rings you modify or cancel the SL-M and sell.

Default mode: sizes ONE day trade from trader/plan.json (written by
trader-exit) to your budget and your max loss per trade, then writes one
bracket order (entry, stop-loss, take-profit) to trader/orders.json in the
shape of Alpaca's place_stock_order. It never places anything: trader-risk
checks the order and trader-broker asks you yes or no.

    python3 size.py                                  # trader/plan.json + trader/config.json
    python3 size.py --write                          # write trader/orders.json
    python3 size.py --limit                          # a limit order at the plan's entry
    python3 size.py --limit 364.00 --write           # a limit order at 364.00
    python3 size.py --now "2026-10-19 10:15" --json  # pin the clock (New York time)

How many shares. Whole shares only: Alpaca takes no fractions in a bracket.

    shares = floor of the smallest of
      max loss       max_loss_per_trade_usd / risk per share (entry minus stop)
      position cap   budget x max_position_pct / entry
      max order      max_order_usd / entry
      cash           (budget minus the cash buffer) / entry
                     (and no more than the cash in trader/portfolio.json, if you have one)

The entry it sizes at: a limit order's limit price; for a market order the
plan's entry, or the price in trader/prices.json if that is fresh (under 15
minutes old) and higher, because a price that ran up since the plan means a
bigger loss at the same stop. Zero shares (the stop is too far away for your
max loss) is a plain refusal: no order is written. So is a reward:risk under
min_reward_risk (the price ran toward the target since the plan).

Weights mode (kept from v1, no longer the headline): split a budget across a
list of stocks by weight.

    python3 size.py --weights AAPL=22.04,AXP=17.14,GOOGL=12.62,KO=10.86,BAC=9.20
    python3 size.py --targets my-weights.json --budget 5000 --write
    python3 size.py --weights ... --whole-shares --prices trader/prices.json

  1. cash buffer   budget x cash_buffer_pct stays in cash, never invested
  2. weights       renormalised to 100 over the stocks you keep (blocked
                   tickers are dropped first; --top N keeps the N biggest)
  3. cap           no stock gets more than max_position_pct of the budget;
                   anything over the cap is shared out to the others by
                   weight, again and again until nobody is over
  4. min order     a slice under min_order_usd is dropped and its weight
                   shared out, so you never place a $2 order
  5. rounding      whole dollars by default (--cents for cents); the rounding
                   dollar goes to the biggest position that is not capped
  6. whole shares  with --whole-shares or "fractional": false; needs prices

Money that cannot be invested is reported as "left idle", never hidden.
"""

import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import os
import sys


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

# v2 defaults: the contract's config.example.json. Missing keys fall back to these.
US_DEFAULTS = {
    "budget": None,
    "cash_buffer_pct": 10,
    "max_position_pct": 75,
    "max_order_usd": 4000,
    "min_order_usd": 5,
    "max_loss_per_trade_usd": 50,
    "max_daily_loss_usd": 150,
    "max_trades_per_day": 3,
    "max_orders_per_day": 10,
    "min_reward_risk": 1.0,
    "require_stop": True,
    "no_entries_before": "09:45",
    "no_entries_after": "15:30",
    "flat_by": "15:55",
    "fractional": False,
    "broker": "alpaca",
    "paper": True,
    "blocked": [],
    "allow_options": False,
    "allow_margin": False,
    "allow_short": False,
    "pdt_guard": False,
}
DEFAULTS = dict(US_DEFAULTS)
EPS = 1e-9
FRESH_MINUTES = 15
SETUP_WORDS = {"orb": "opening-range breakout", "flag": "flag", "bounce": "oversold bounce"}


class SizeError(Exception):
    pass


MK = None
PLACE = "New York"   # how exchange-local times are labelled in the text


def india_defaults(mk):
    """The India example config's limits, in rupees (the internal names stay *_usd)."""
    d = dict(US_DEFAULTS)
    d.update({
        "budget": None, "cash_buffer_pct": 10, "max_position_pct": 80,
        "max_order_usd": 80000, "min_order_usd": 100, "max_loss_per_trade_usd": 500,
        "max_daily_loss_usd": 1500, "max_trades_per_day": 3, "max_orders_per_day": 10,
        "min_reward_risk": 1.5, "require_stop": True, "fractional": False,
        "broker": mk.broker, "product": "MIS", "paper": True, "include_charges": True, "charges": {},
    })
    d.update(mk.defaults)
    d.pop("pdt_guard", None)
    return d


def apply_market(mk):
    """Point this module at one market profile (IN or US)."""
    global MK, DEFAULTS, PLACE
    MK = mk
    if mk.code == "US":
        DEFAULTS = dict(US_DEFAULTS)
        PLACE = "New York"
    else:
        DEFAULTS = india_defaults(mk)
        PLACE = mk.tz_label
    return mk


def india():
    return MK is not None and MK.code == "IN"


apply_market(market.resolve())


# ---------------------------------------------------------------- time (New York, no tz files)

def _nth_sunday(year, month, n):
    d = datetime.date(year, month, 1)
    d += datetime.timedelta(days=(6 - d.weekday()) % 7)
    return d + datetime.timedelta(weeks=n - 1)


def eastern_offset(utc):
    """Hours from UTC for the active market's clock (the name is upstream's): New York -4 in
    daylight time, -5 otherwise (US rule since 2007); India 5.5 all year."""
    return MK.utc_offset(utc)


def to_eastern(utc):
    """naive UTC -> naive exchange-local time (New York, or IST in India)."""
    return MK.to_local(utc)


def eastern_to_utc(local):
    return MK.local_to_utc(local)


def parse_now(text):
    """ISO time -> naive UTC. A time without an offset is taken as exchange-local time."""
    if not text:
        return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None)
    t = text.strip().replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(t)
    except ValueError:
        raise SizeError("--now wants a time like \"2026-10-19 10:15\" (%s) or ...Z (UTC)" % PLACE)
    if dt.tzinfo is None:
        return eastern_to_utc(dt)
    return (dt - dt.utcoffset()).replace(tzinfo=None)


def parse_utc(text):
    """"2026-10-19T14:52:13Z" -> naive UTC, or None."""
    if not text:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(text).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = (dt - dt.utcoffset()).replace(tzinfo=None)
    return dt


def utc_iso(now_utc=None):
    now_utc = now_utc or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    return now_utc.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- inputs

def read_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        raise SizeError("no %s at %s" % (what, path))
    except json.JSONDecodeError as e:
        raise SizeError("%s is not valid JSON: %s" % (path, e))


def load_config(path):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        cfg.update(market.normalize_config(read_json(path, "config")))
    return cfg


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def parse_weights(data):
    """Accept a weights file, a {ticker: weight} dict or a list of rows.

    Returns [{"ticker", "name", "weight"}] with weight as a float."""
    if isinstance(data, dict) and "weights" in data:
        data = data["weights"]
    rows = []
    if isinstance(data, dict):
        for t, w in data.items():
            rows.append({"ticker": t, "name": "", "weight": w})
    elif isinstance(data, list):
        for i, r in enumerate(data):
            if not isinstance(r, dict):
                raise SizeError("weights[%d] is not an object" % i)
            t = r.get("ticker") or r.get("symbol")
            w = r.get("weight", r.get("weight_pct", r.get("pct")))
            if not t or w is None:
                raise SizeError("weights[%d] needs a ticker and a weight" % i)
            rows.append({"ticker": t, "name": r.get("name", ""), "weight": w})
    else:
        raise SizeError("weights must be a list or an object")
    out = []
    for r in rows:
        try:
            w = float(r["weight"])
        except (TypeError, ValueError):
            raise SizeError("weight for %s is not a number: %r" % (r["ticker"], r["weight"]))
        out.append({"ticker": str(r["ticker"]).strip().upper(), "name": r["name"] or "", "weight": w})
    return out


def weights_from_arg(text):
    """AAPL=22.04,AXP=17.14 -> {ticker: weight}"""
    out = {}
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise SizeError("--weights wants TICKER=WEIGHT pairs, got %r" % part)
        t, w = part.split("=", 1)
        out[t.strip().upper()] = w.strip()
    return out


def load_prices(path):
    if not path:
        return {}
    data = read_json(path, "prices")
    prices = data.get("prices", data) if isinstance(data, dict) else {}
    out = {}
    for t, p in prices.items():
        try:
            out[str(t).upper()] = float(p)
        except (TypeError, ValueError):
            continue
    return out


def price_time(doc, sym):
    """When this symbol's price is from: the quote's own time (detail[sym].time), else when it
    was fetched (detail[sym].fetched), else the file's as_of."""
    det = ((doc or {}).get("detail") or {}).get(sym) or {}
    for key in ("time", "fetched"):
        t = parse_utc(det.get(key))
        if t:
            return t
    return parse_utc((doc or {}).get("as_of"))


def fresh_price(doc, sym, now_utc, minutes=FRESH_MINUTES):
    """(price, fetched_utc, fresh) for sym from a prices.json doc, or (None, None, False)."""
    if not isinstance(doc, dict):
        return None, None, False
    p = _f((doc.get("prices") or {}).get(sym))
    if p is None or p <= 0:
        return None, None, False
    t = price_time(doc, sym)
    if t is None:
        return p, None, False
    age = (now_utc - t).total_seconds()
    return p, t, -60 <= age <= minutes * 60


# ---------------------------------------------------------------- money helpers

def round_cent(x):
    """Round a price to the cent (half up)."""
    return math.floor(float(x) * 100 + 0.5 + EPS) / 100.0


def shares_for(usd, per_share):
    """Whole shares that fit in usd at per_share, in exact integer cents."""
    u, p = int(round(float(usd) * 100)), int(round(float(per_share) * 100))
    if p <= 0 or u <= 0:
        return 0
    return u // p


def _price(x):
    """358.32 -> "358.32": Alpaca wants prices as strings."""
    return "%.2f" % round_cent(x)


def _num(x):
    """1250 -> "1250", 1118.13 -> "1118.13" (Alpaca wants these as strings)."""
    x = round(float(x), 2)
    if abs(x - round(x)) < 0.005:
        return str(int(round(x)))
    return "%.2f" % x


def money(x):
    x = float(x)
    if india():
        return MK.money(x, 0 if abs(x - round(x)) < 0.005 else 2)
    if abs(x - round(x)) < 0.005:
        return "$" + "{:,.0f}".format(round(x))
    return "$" + "{:,.2f}".format(x)


def _cur_num(x):
    """Upstream's "$1250" style in US text; rupees in India."""
    return money(x) if india() else "$" + _num(x)


def round_price(x, how="near"):
    """A price on the exchange's grid: the cent in the US, the NSE tick in India."""
    if india():
        return {"near": MK.round_tick, "down": MK.round_down, "up": MK.round_up}[how](float(x))
    return round_cent(x)


def charges(qty, buy, sell, cfg):
    """Round-trip charges (India) for qty shares bought at buy and sold at sell; 0 in the US
    or when "include_charges" is false."""
    if not india() or not cfg.get("include_charges", True) or qty <= 0:
        return {"total": 0.0}
    return MK.charges(qty, buy, sell, cfg)


def _largest(n, fits):
    """The largest q in [0, n] with fits(q) true (fits is monotone: true, then false)."""
    lo, hi = 0, int(n)
    if hi <= 0:
        return 0
    if fits(hi):
        return hi
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid
    return lo


# ---------------------------------------------------------------- plan mode (the default)

def size_trade(plan, cfg, budget=None, limit=None, price=None, cash=None, today=None, market_order=False):
    """Pure function: one plan + your rules -> the sizing (a dict). qty may be 0.

    limit  the limit price for a limit order (None = market)
    price  a FRESH latest price; a market order is sized at the higher of it and the plan's entry
    cash   the cash in trader/portfolio.json, if there is one
    today  exchange-local date (YYYY-MM-DD); a plan for another day is refused
    market_order  India only: a MARKET entry instead of the default LIMIT at the sized price"""
    c = dict(DEFAULTS)
    c.update(market.normalize_config(cfg or {}))
    ind = india()
    if not isinstance(plan, dict):
        raise SizeError("the plan is not a JSON object")
    sym = str(plan.get("symbol") or "").strip().upper()
    if ind:
        sym = MK.plain_symbol(sym)
    if not sym:
        raise SizeError("the plan has no symbol (run trader-exit)")
    side = str(plan.get("side") or "buy").strip().lower()
    if side != "buy":
        raise SizeError("this pack sizes long (buy) day trades only; the plan says %r" % side)
    if today and plan.get("date") and str(plan["date"]) != today:
        raise SizeError("the plan is for %s and today is %s in %s: make a new plan with trader-exit"
                        % (plan["date"], today, PLACE))
    entry_plan, stop, target = _f(plan.get("entry")), _f(plan.get("stop")), _f(plan.get("target"))
    for name, v in (("entry", entry_plan), ("stop", stop), ("target", target)):
        if v is None or v <= 0:
            raise SizeError("the plan needs a positive %s (run trader-exit); a bracket order needs entry, "
                            "stop and target" % name)
    blocked = {str(b).upper() for b in (c.get("blocked") or [])}
    if ind:
        blocked = {MK.plain_symbol(b) for b in blocked}
    if sym in blocked:
        raise SizeError("%s is on your blocked list" % sym)

    budget = float(budget if budget is not None else (c.get("budget") or 0))
    if budget <= 0:
        raise SizeError("no budget: pass --budget or set \"budget\" in trader/config.json")
    buf_pct = float(c.get("cash_buffer_pct") or 0)
    if not 0 <= buf_pct < 100:
        raise SizeError("cash_buffer_pct must be between 0 and 100")

    if limit is not None:
        ref, ref_from = round_price(limit), "limit"
    elif price is not None and round_price(price) > round_price(entry_plan):
        ref, ref_from = round_price(price), "price"
    else:
        ref, ref_from = round_price(entry_plan), "plan"
    if ind:   # off-grid levels move the conservative way: a lower stop, a lower target
        stop, target = MK.round_down(stop), MK.round_down(target)
    else:
        stop, target = round_cent(stop), round_cent(target)
    if stop >= ref:
        raise SizeError("the stop %s is not below the entry %s; a long trade needs its stop underneath"
                        % (_price(stop), _price(ref)))
    if target <= ref:
        raise SizeError("the target %s is not above the entry %s: the move has already happened. "
                        "Skip it or make a new plan with trader-exit" % (_price(target), _price(ref)))
    risk_c = int(round((ref - stop) * 100))
    reward_c = int(round((target - ref) * 100))
    risk = risk_c / 100.0

    cash_buffer = round(budget * buf_pct / 100.0, 2)
    available = budget - cash_buffer
    cash_note = "budget %s minus the %s cash buffer" % (money(budget), money(cash_buffer))
    if cash is not None and cash - cash_buffer < available - 0.005:
        available = cash - cash_buffer
        cash_note = "cash %s in trader/portfolio.json minus the %s buffer" % (money(cash), money(cash_buffer))
    available = max(round(available, 2), 0.0)

    limits = []
    with_charges = ind and bool(c.get("include_charges", True))
    max_loss = _f(c.get("max_loss_per_trade_usd"))
    if max_loss and with_charges:
        def loss_fits(q):
            return q * risk_c / 100.0 + charges(q, ref, stop, c)["total"] <= max_loss + 0.005
        n = _largest(shares_for(max_loss, risk), loss_fits)
        ch = charges(n, ref, stop, c)["total"]
        limits.append({"name": "max loss", "usd": max_loss, "per": risk, "shares": n,
                       "how": "%s max loss: %d x %s risk + %s charges = %s"
                              % (money(max_loss), n, _price(risk), money(ch),
                                 money(round(n * risk_c / 100.0 + ch, 2)))})
    elif max_loss:
        limits.append({"name": "max loss", "usd": max_loss, "per": risk, "shares": shares_for(max_loss, risk),
                       "how": "%s max loss / %s risk a share" % (money(max_loss), _price(risk))})
    cap_pct = _f(c.get("max_position_pct"))
    if cap_pct:
        cap = round(budget * cap_pct / 100.0, 2)
        limits.append({"name": "position cap", "usd": cap, "per": ref, "shares": shares_for(cap, ref),
                       "how": "%s%% of %s = %s / %s" % (_num(cap_pct), money(budget), money(cap), _price(ref))})
    max_order = _f(c.get("max_order_usd"))
    if max_order:
        limits.append({"name": "max order", "usd": max_order, "per": ref, "shares": shares_for(max_order, ref),
                       "how": "%s / %s" % (money(max_order), _price(ref))})
    if with_charges:
        def cash_fits(q):
            return q * ref + charges(q, ref, 0, c)["total"] <= available + 0.005
        n = _largest(shares_for(available, ref), cash_fits)
        limits.append({"name": "cash", "usd": available, "per": ref, "shares": n,
                       "how": "%s = %s / %s, with the buy charges, no MIS leverage"
                              % (cash_note, money(available), _price(ref))})
    elif ind:
        limits.append({"name": "cash", "usd": available, "per": ref, "shares": shares_for(available, ref),
                       "how": "%s = %s / %s, no MIS leverage" % (cash_note, money(available), _price(ref))})
    else:
        limits.append({"name": "cash", "usd": available, "per": ref, "shares": shares_for(available, ref),
                       "how": "%s = %s / %s" % (cash_note, money(available), _price(ref))})

    qty = max(0, min(l["shares"] for l in limits))
    bound = [l["name"] for l in limits if l["shares"] == qty]
    for l in limits:
        l["binds"] = l["name"] == bound[0]
    cost = round(qty * ref, 2)
    loss_gross = round(qty * risk_c / 100.0, 2)
    ch_stop = round(charges(qty, ref, stop, c)["total"], 2)
    ch_target = round(charges(qty, ref, target, c)["total"], 2)
    loss = round(loss_gross + ch_stop, 2)
    reward_net = round(qty * reward_c / 100.0 - ch_target, 2)
    rr_net = round(reward_net / loss, 2) if (with_charges and loss > 0) else None
    refusal = None
    min_rr = _f(c.get("min_reward_risk"))
    if qty == 0:
        if bound[0] == "max loss" and with_charges and risk <= max_loss + EPS:
            one = charges(1, ref, stop, c)["total"]
            refusal = ("one share risks %s (entry %s minus stop %s) plus %s charges = %s, more than your %s "
                       "max loss per trade. No order. Skip this trade, or plan a closer stop with trader-exit."
                       % (money(risk), _price(ref), _price(stop), money(one), money(risk + one), money(max_loss)))
        elif bound[0] == "max loss":
            refusal = ("one share risks %s (entry %s minus stop %s), more than your %s max loss per trade. "
                       "No order. Skip this trade, or plan a closer stop with trader-exit."
                       % (money(risk), _price(ref), _price(stop), money(max_loss)))
        else:
            refusal = ("one share of %s costs %s, more than your %s limit (%s). No order."
                       % (sym, money(ref), bound[0], limits[[l["name"] for l in limits].index(bound[0])]["how"]))
    elif with_charges and min_rr is not None and rr_net < min_rr - EPS:
        refusal = ("net reward:risk %.2f after charges (%s at the target less %s charges, against %s at the stop "
                   "with charges; gross %.2f) is under your minimum %s, so trader-risk would block it. No order. "
                   "Skip it, or make a new plan with trader-exit."
                   % (rr_net, money(qty * reward_c / 100.0), money(ch_target), money(loss),
                      reward_c / float(risk_c), _num(min_rr)))
    elif _f(c.get("min_reward_risk")) and reward_c < _f(c["min_reward_risk"]) * risk_c - EPS:
        refusal = ("reward:risk %.2f (target %s, entry %s, stop %s) is under your minimum %s, so trader-risk "
                   "would block it. No order. Skip it, or make a new plan with trader-exit."
                   % (reward_c / float(risk_c), _price(target), _price(ref), _price(stop), _num(c["min_reward_risk"])))
    elif cost < float(c.get("min_order_usd") or 0) - 0.005:
        refusal = ("%d share%s of %s is %s, under your %s minimum order. No order."
                   % (qty, "" if qty == 1 else "s", sym, money(cost), money(c["min_order_usd"])))
    order_type = "limit" if limit is not None else "market"
    if ind and not market_order:
        order_type = "limit"
    out = {
        "symbol": sym, "side": "buy", "setup": plan.get("setup", ""), "date": plan.get("date"),
        "entry_time": plan.get("entry_time", ""), "entry_plan": round_price(entry_plan),
        "entry": ref, "entry_from": ref_from, "stop": stop, "target": target,
        "risk_per_share": risk, "reward_risk": round(reward_c / float(risk_c), 2),
        "stop_label": plan.get("stop_label", ""), "target_label": plan.get("target_label", ""),
        "budget": budget, "cash_buffer_pct": buf_pct, "cash_buffer": cash_buffer, "cash_available": available,
        "max_loss_per_trade_usd": max_loss, "limits": limits, "qty": qty, "bound_by": bound[0],
        "cost": cost, "max_loss": loss, "flat_by": plan.get("flat_by") or c.get("flat_by"),
        "order_type": order_type, "refusal": refusal,
    }
    if ind:
        out.update({
            "market": "IN", "currency": MK.currency, "exchange": MK.exchange,
            "product": str(c.get("product") or "MIS").upper(), "include_charges": with_charges,
            "loss_gross": loss_gross, "charges_at_stop": ch_stop, "charges_at_target": ch_target,
            "reward_gross": round(qty * reward_c / 100.0, 2), "reward_net": reward_net,
            "reward_risk_net": rr_net,
        })
    return out


def reference_id(prefix, *parts):
    """A Groww order_reference_id: 8 to 20 letters, digits and at most two hyphens.
    Deterministic, so the same proposal gets the same id (and fingerprint) when re-run."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:8]
    day = "".join(ch for ch in str(parts[0] if parts else "") if ch.isdigit())[2:8] or "000000"
    return "%s-%s-%s" % (prefix, day, h)


def _g(x):
    """A Groww price: a number on the tick (2 decimals)."""
    return round(float(x), 2)


def groww_params(sym, qty, side, order_type, product, ref_id, price=None, trigger=None):
    """Groww Trade API place_order params (POST /v1/order/create), NSE cash segment."""
    p = {"trading_symbol": sym, "quantity": int(qty)}
    if order_type in ("LIMIT", "SL") and price is not None:
        p["price"] = _g(price)
    if order_type in ("SL", "SL_M") and trigger is not None:
        p["trigger_price"] = _g(trigger)
    p.update({"validity": "DAY", "exchange": "NSE", "segment": "CASH", "product": product,
              "order_type": order_type, "transaction_type": side, "order_reference_id": ref_id})
    return p


def groww_block(s):
    """The bracket as Groww legs: the entry now, the SL-M stop once it fills, the target watched."""
    day = s.get("date") or ""
    key = (day, s["symbol"], s["qty"], s["entry"], s["stop"], s["target"], s["order_type"])
    otype = "LIMIT" if s["order_type"] == "limit" else "MARKET"
    entry = groww_params(s["symbol"], s["qty"], "BUY", otype, s["product"], reference_id("TPE", *key),
                         price=s["entry"] if otype == "LIMIT" else None)
    stop = groww_params(s["symbol"], s["qty"], "SELL", "SL_M", s["product"], reference_id("TPS", *key),
                        trigger=s["stop"])
    return {
        "api": "Groww Trade API place_order (POST /v1/order/create)",
        "entry": entry,
        "stop_loss": stop,
        "stop_loss_when": ("only after the entry fills, for the filled quantity: a protective SL-M SELL "
                           "with its trigger at the stop"),
        "target": {"price": _g(s["target"]), "resting_order": False,
                   "how": ("not placed: a second live sell could fill as well as the SL-M and leave you "
                           "short. trader-alerts rings at the target; then modify or cancel the SL-M "
                           "and sell (ticket.py flatten)")},
        "flat_by": s["flat_by"],
        "square_off": ("Groww squares off open MIS positions itself near the close and charges for it; "
                       "be flat by %s IST" % (s["flat_by"] or MK.defaults["flat_by"])),
    }


def bracket_order(s):
    """The one proposed order, Alpaca place_stock_order fields (strings) plus why and plan.
    India: the same fields (trader-risk and trader-broker read them) plus a "groww" block."""
    if s["refusal"] or s["qty"] <= 0:
        return None
    if india():
        return _india_order(s)
    o = {"symbol": s["symbol"], "side": "buy", "qty": str(int(s["qty"])), "type": s["order_type"],
         "time_in_force": "day"}
    if s["order_type"] == "limit":
        o["limit_price"] = _price(s["entry"])
    setup = SETUP_WORDS.get(s["setup"], s["setup"] or "day trade")
    why = ("%s on %s: %d shares, bound by your %s (%d x %s = %s at the stop)"
           % (setup, s["symbol"], s["qty"], {"max loss": "%s max loss per trade" % money(s["max_loss_per_trade_usd"] or 0),
                                             "position cap": "position cap", "max order": "max order",
                                             "cash": "cash after the buffer"}[s["bound_by"]],
              s["qty"], _price(s["risk_per_share"]), money(s["max_loss"])))
    o.update({
        "order_class": "bracket",
        "take_profit_limit_price": _price(s["target"]),
        "stop_loss_stop_price": _price(s["stop"]),
        "why": why,
        "plan": {"entry": s["entry"], "stop": s["stop"], "target": s["target"],
                 "risk_per_share": s["risk_per_share"], "max_loss": s["max_loss"], "setup": s["setup"],
                 "entry_time": s["entry_time"], "flat_by": s["flat_by"]},
    })
    return o


def _india_order(s):
    o = {"symbol": s["symbol"], "side": "buy", "qty": str(int(s["qty"])), "type": s["order_type"],
         "time_in_force": "day"}
    if s["order_type"] == "limit":
        o["limit_price"] = _price(s["entry"])
    setup = SETUP_WORDS.get(s["setup"], s["setup"] or "day trade")
    bound = {"max loss": "%s max loss per trade" % money(s["max_loss_per_trade_usd"] or 0),
             "position cap": "position cap", "max order": "max order",
             "cash": "cash after the buffer (no MIS leverage)"}[s["bound_by"]]
    if s["include_charges"]:
        why = ("%s on %s: %d shares, bound by your %s (%d x %s = %s + %s charges = %s at the stop)"
               % (setup, s["symbol"], s["qty"], bound, s["qty"], _price(s["risk_per_share"]),
                  money(s["loss_gross"]), money(s["charges_at_stop"]), money(s["max_loss"])))
    else:
        why = ("%s on %s: %d shares, bound by your %s (%d x %s = %s at the stop, charges not included)"
               % (setup, s["symbol"], s["qty"], bound, s["qty"], _price(s["risk_per_share"]), money(s["max_loss"])))
    o.update({
        "order_class": "bracket",
        "take_profit_limit_price": _price(s["target"]),
        "stop_loss_stop_price": _price(s["stop"]),
        "market": "IN", "currency": s["currency"], "exchange": s["exchange"], "product": s["product"],
        "why": why,
        "plan": {"entry": s["entry"], "stop": s["stop"], "target": s["target"],
                 "risk_per_share": s["risk_per_share"], "max_loss": s["max_loss"],
                 "max_loss_gross": s["loss_gross"], "charges_at_stop": s["charges_at_stop"],
                 "charges_at_target": s["charges_at_target"], "reward_risk": s["reward_risk"],
                 "reward_risk_net": s["reward_risk_net"], "setup": s["setup"],
                 "entry_time": s["entry_time"], "flat_by": s["flat_by"]},
        "groww": groww_block(s),
    })
    return o


def _india_report_tail(s, order, lines):
    g = order["groww"]
    if s["include_charges"]:
        lines.append("Size: %d shares of %s = %s at %s. Max loss at the stop: %d x %s = %s + %s charges = %s."
                     % (s["qty"], s["symbol"], money(s["cost"]), _price(s["entry"]), s["qty"],
                        _price(s["risk_per_share"]), money(s["loss_gross"]), money(s["charges_at_stop"]),
                        money(s["max_loss"])))
        lines.append("At the target: %s less %s charges = %s. Reward:risk %.2f net of charges (%.2f gross)."
                     % (money(s["reward_gross"]), money(s["charges_at_target"]), money(s["reward_net"]),
                        s["reward_risk_net"], s["reward_risk"]))
        lines.append("Charges are estimates (brokerage, STT, exchange, SEBI, stamp, GST): your contract note "
                     "has the real ones.")
    else:
        lines.append("Size: %d shares of %s = %s at %s. Max loss at the stop: %d x %s = %s (charges not included)."
                     % (s["qty"], s["symbol"], money(s["cost"]), _price(s["entry"]), s["qty"],
                        _price(s["risk_per_share"]), money(s["max_loss"])))
    lines.append("A stop is an order, not a promise: in a fast market it can fill below %s." % _price(s["stop"]))
    lines.append("")
    lines.append("Proposed Groww orders (place_order params, nothing has been placed). Groww has no equity")
    lines.append("bracket order, so the bracket is placed as legs:")
    e = g["entry"]
    how = ("LIMIT %s" % _price(e["price"])) if e["order_type"] == "LIMIT" else "MARKET"
    lines.append("  1. now:              BUY %d %s, %s, %s, NSE cash, DAY" % (e["quantity"], s["symbol"], how,
                                                                             e["product"]))
    lines.append("  2. once it fills:    SELL %d %s, SL-M trigger %s, %s (the protective stop)"
                 % (g["stop_loss"]["quantity"], s["symbol"], _price(g["stop_loss"]["trigger_price"]),
                    g["stop_loss"]["product"]))
    lines.append("  3. target %s:   NOT a resting order. trader-alerts rings there; then modify or cancel"
                 % _price(g["target"]["price"]))
    lines.append("     the SL-M and sell. Two live sells could both fill and leave you short.")
    if s["flat_by"]:
        lines.append("Flat by %s IST: anything still open then gets closed (trader-alerts rings, trader-broker "
                     "flatten), ahead of Groww's MIS auto square-off, which carries its own charge." % s["flat_by"])
    lines.append("")
    lines.append("Next: trader-risk checks it, then trader-broker asks you yes or no.")
    lines.append("Education and tooling, not financial advice.")
    return "\n".join(lines)


def plan_report(s, order, notes=()):
    lines = []
    setup = SETUP_WORDS.get(s["setup"], s["setup"] or "setup")
    lines.append("%s buy, %s, entry %s%s" % (s["symbol"], setup, _price(s["entry_plan"]),
                                            (" at " + s["entry_time"]) if s["entry_time"] else ""))
    lines.append("Stop %s%s. Target %s%s." % (_price(s["stop"]), (": " + s["stop_label"]) if s["stop_label"] else "",
                                             _price(s["target"]),
                                             (": " + s["target_label"]) if s["target_label"] else ""))
    for n in notes:
        lines.append(n)
    src = {"plan": "the plan's entry", "price": "the latest price, above the plan's entry",
           "limit": "your limit price"}[s["entry_from"]]
    lines.append("Sized at %s (%s). Risk %s a share (entry %s minus stop %s). Reward:risk %.2f%s."
                 % (_price(s["entry"]), src, _price(s["risk_per_share"]), _price(s["entry"]), _price(s["stop"]),
                    s["reward_risk"], (" gross, %.2f net of charges" % s["reward_risk_net"])
                    if s.get("reward_risk_net") is not None else ""))
    lines.append("")
    lines.append("Limits (whole shares; the smallest one wins):")
    for l in s["limits"]:
        lines.append("  %-13s %-58s %3d shares%s" % (l["name"], l["how"], l["shares"],
                                                      "  <- binds" if l["binds"] else ""))
    lines.append("")
    if order is None:
        lines.append("No order: " + s["refusal"])
        lines.append("Education and tooling, not financial advice.")
        return "\n".join(lines)
    if india():
        bind = [l for l in s["limits"] if l["binds"]][0]
        lines.append("Decided by: %s (%s)." % (bind["name"], bind["how"]))
        return _india_report_tail(s, order, lines)
    lines.append("Size: %d shares of %s = %s at %s. Max loss at the stop: %d x %s = %s."
                 % (s["qty"], s["symbol"], money(s["cost"]), _price(s["entry"]), s["qty"],
                    _price(s["risk_per_share"]), money(s["max_loss"])))
    lines.append("A stop is an order, not a promise: in a fast market it can fill below %s." % _price(s["stop"]))
    lines.append("")
    lines.append("Proposed bracket order (place_stock_order arguments, nothing has been placed):")
    how = "limit %s" % order["limit_price"] if order["type"] == "limit" else "market"
    lines.append("  buy %s %s, %s, day, take-profit %s, stop-loss %s"
                 % (order["qty"], order["symbol"], how, order["take_profit_limit_price"],
                    order["stop_loss_stop_price"]))
    if s["flat_by"]:
        lines.append("Flat by %s %s: anything still open then gets closed (trader-alerts rings, "
                     "trader-broker flatten)." % (s["flat_by"], PLACE))
    lines.append("")
    lines.append("Next: trader-risk checks it, then trader-broker asks you yes or no.")
    lines.append("Education and tooling, not financial advice.")
    return "\n".join(lines)


# ---------------------------------------------------------------- weights mode (v1)

def normalise(rows, blocked=(), top=None):
    """Drop blocked and non-positive weights, keep the top N, renormalise to 100."""
    blocked = {str(b).upper() for b in (blocked or [])}
    dropped, keep, seen = [], [], set()
    for r in rows:
        if r["ticker"] in seen:
            raise SizeError("%s is listed twice in the weights" % r["ticker"])
        seen.add(r["ticker"])
        if r["ticker"] in blocked:
            dropped.append({"ticker": r["ticker"], "reason": "on your blocked list"})
        elif r["weight"] <= 0:
            dropped.append({"ticker": r["ticker"], "reason": "weight is zero or negative"})
        else:
            keep.append(dict(r))
    keep.sort(key=lambda r: -r["weight"])
    if top:
        for r in keep[top:]:
            dropped.append({"ticker": r["ticker"], "reason": "outside the top %d" % top})
        keep = keep[:top]
    total = sum(r["weight"] for r in keep)
    for r in keep:
        r["source_weight"] = r["weight"]
        r["weight"] = 100.0 * r["weight"] / total if total else 0.0
    return keep, dropped


def allocate(rows, investable, cap):
    """Exact (unrounded) dollars per ticker with the cap enforced.

    Proportional to weight; any stock over the cap is pinned at the cap and
    the rest of the money is shared over the others, repeated until no stock
    is over. Returns ({ticker: dollars}, set of capped tickers)."""
    alloc, capped = {}, set()
    active = [r for r in rows]
    money_left = investable
    while active:
        wsum = sum(r["weight"] for r in active)
        trial = {r["ticker"]: money_left * r["weight"] / wsum for r in active}
        over = [r for r in active if trial[r["ticker"]] > cap + EPS]
        if not over:
            alloc.update(trial)
            break
        for r in over:
            alloc[r["ticker"]] = cap
            capped.add(r["ticker"])
            money_left -= cap
        active = [r for r in active if r["ticker"] not in capped]
        if money_left <= EPS:
            for r in active:
                alloc[r["ticker"]] = 0.0
            break
    return alloc, capped


def round_to_unit(exact, capped, order, cap, unit):
    """Round to whole dollars (unit 1) or cents (unit 0.01) and keep the total.

    The total placed is the exact total rounded DOWN to the unit, so it never
    spends money you do not have. Each slice is rounded to the nearest unit,
    then the difference (usually one unit) goes to the biggest stock that is
    not capped, then the next, never pushing anyone over the cap."""
    def units(x):
        return int(math.floor(x / unit + EPS))

    cap_u = units(cap)
    total_u = units(sum(exact.values()))
    out = {}
    for t, v in exact.items():
        out[t] = cap_u if t in capped else int(math.floor(v / unit + 0.5 + EPS))
    diff = total_u - sum(out.values())
    takers = [t for t in order if t not in capped]
    guard = 0
    while diff != 0 and takers and guard < 100000:
        moved = False
        for t in takers:
            if diff == 0:
                break
            if diff > 0 and out[t] + 1 <= cap_u:
                out[t] += 1
                diff -= 1
                moved = True
            elif diff < 0 and out[t] > 0:
                out[t] -= 1
                diff += 1
                moved = True
        if not moved:
            break
        guard += 1
    return {t: round(u * unit, 2) for t, u in out.items()}


def whole_shares(dollars, prices, order, cap, cash):
    """Whole shares: floor each slice, then buy one more share at a time for the
    stock furthest below its slice while cash lasts and the cap holds."""
    shares = {}
    for t in order:
        shares[t] = int(math.floor(dollars[t] / prices[t] + EPS)) if dollars[t] > 0 else 0
    spent = sum(shares[t] * prices[t] for t in order)
    left = cash - spent
    while True:
        best, gap = None, None
        for t in order:
            p = prices[t]
            if p > left + EPS or (shares[t] + 1) * p > cap + EPS:
                continue
            g = dollars[t] - shares[t] * p
            if best is None or g > gap + EPS:
                best, gap = t, g
        if best is None:
            break
        shares[best] += 1
        left -= prices[best]
    return shares


def size(rows, cfg, budget=None, prices=None, whole=None, cents=False, top=None):
    """Weights mode. Pure function: weights + rules -> the full sizing result (a dict)."""
    budget = float(budget if budget is not None else (cfg.get("budget") or 0))
    if budget <= 0:
        raise SizeError("no budget: pass --budget or set \"budget\" in trader/config.json")
    buf_pct = float(cfg.get("cash_buffer_pct", 10))
    cap_pct = float(cfg.get("max_position_pct", 25))
    min_order = float(cfg.get("min_order_usd", 5) or 0)
    if not 0 <= buf_pct < 100:
        raise SizeError("cash_buffer_pct must be between 0 and 100")
    if not 0 < cap_pct <= 100:
        raise SizeError("max_position_pct must be above 0 and at most 100")
    if whole is None:
        whole = not cfg.get("fractional", True)
    if india():
        whole = True   # NSE has no fractional shares
    prices = prices or {}

    keep, dropped = normalise(rows, cfg.get("blocked"), top)
    if not keep:
        raise SizeError("nothing to size: no weights left after the blocked list")

    cash_buffer = round(budget * buf_pct / 100.0, 2)
    investable = round(budget - cash_buffer, 2)
    cap = round(budget * cap_pct / 100.0, 2)
    unit = 0.01 if (cents or whole) else 1.0

    if whole:
        missing = [r["ticker"] for r in keep if not prices.get(r["ticker"])]
        if missing:
            raise SizeError("whole shares need a price for: %s (add them to trader/prices.json, "
                            "e.g. with trader-alerts: alerts.py quote %s --write)"
                            % (", ".join(missing), " ".join(missing)))

    while True:
        live = [dict(r) for r in keep]
        tot = sum(r["source_weight"] for r in live)
        for r in live:
            r["weight"] = 100.0 * r["source_weight"] / tot
        exact, capped = allocate(live, investable, cap)
        order = [r["ticker"] for r in sorted(live, key=lambda r: -exact[r["ticker"]])]
        dollars = round_to_unit(exact, capped, order, cap, unit)
        shares = None
        if whole:
            shares = whole_shares(dollars, prices, order, cap, sum(dollars.values()))
            dollars = {t: round(shares[t] * prices[t], 2) for t in order}
        small = [r for r in live if dollars[r["ticker"]] < min_order - EPS]
        if not small:
            break
        worst = min(small, key=lambda r: (r["source_weight"], r["ticker"]))
        if whole and shares is not None and shares[worst["ticker"]] == 0 and prices.get(worst["ticker"], 0) > 0:
            reason = ("one share costs %s, more than its slice; it cannot be bought in whole shares"
                      % _cur_num(prices[worst["ticker"]]))
        elif india():
            reason = "its slice (%s) is under your %s minimum order" % (
                money(dollars[worst["ticker"]]), money(min_order))
        else:
            reason = "its slice ($%s) is under your $%s minimum order" % (
                _num(dollars[worst["ticker"]]), _num(min_order))
        dropped.append({"ticker": worst["ticker"], "reason": reason})
        keep = [r for r in keep if r["ticker"] != worst["ticker"]]
        if not keep:
            raise SizeError("every slice is under your minimum order; raise the budget or hold fewer stocks")

    positions = []
    for r in sorted(live, key=lambda r: -r["weight"]):
        t = r["ticker"]
        p = {"ticker": t, "name": r["name"], "weight": round(r["weight"], 2),
             "source_weight": r["source_weight"], "dollars": dollars[t],
             "capped": t in capped}
        if prices.get(t):
            p["price"] = prices[t]
            p["shares"] = shares[t] if whole else round(dollars[t] / prices[t], 4)
        positions.append(p)
    invested = round(sum(p["dollars"] for p in positions), 2)
    return {
        "budget": budget, "cash_buffer_pct": buf_pct, "cash_buffer": cash_buffer,
        "investable": investable, "max_position_pct": cap_pct, "cap": cap,
        "min_order_usd": min_order, "whole_shares": bool(whole),
        "positions": positions, "invested": invested,
        "idle": round(investable - invested, 2), "dropped": dropped,
    }


def orders_from(result, source=""):
    """Weights mode: proposed buy orders, one per position, in place_stock_order shape."""
    out = []
    for p in result["positions"]:
        if p["dollars"] <= 0:
            continue
        why = "%.2f%% of the split" % p["weight"]
        if source:
            why = "%s, weights from %s" % (why, source)
        if p["capped"]:
            why += "; capped at %s%% of the %s budget" % (_num(result["max_position_pct"]), money(result["budget"]))
        o = {"symbol": p["ticker"], "side": "buy"}
        if result["whole_shares"]:
            o["qty"] = str(int(p["shares"]))
        else:
            o["notional"] = _num(p["dollars"])
        o.update({"type": "market", "time_in_force": "day", "why": why})
        if india() and "qty" in o:
            # a long-term split is a delivery (CNC) buy, not an intraday (MIS) one
            o.update({"market": "IN", "currency": MK.currency, "exchange": MK.exchange, "product": "CNC"})
            o["groww"] = {"api": "Groww Trade API place_order (POST /v1/order/create)",
                          "entry": groww_params(p["ticker"], int(p["shares"]), "BUY", "MARKET", "CNC",
                                                reference_id("TPW", source or "split", p["ticker"],
                                                             p["shares"]))}
        out.append(o)
    return out


def report(result, orders, source=""):
    """Weights mode table."""
    r = result
    lines = []
    if source:
        lines.append("Weights from: %s" % source)
    lines.append("Budget %s, cash buffer %s%% = %s, investing %s, cap %s%% = %s per stock"
                 % (money(r["budget"]), _num(r["cash_buffer_pct"]), money(r["cash_buffer"]),
                    money(r["investable"]), _num(r["max_position_pct"]), money(r["cap"])))
    lines.append("")
    has_price = any("price" in p for p in r["positions"])
    head = "%-7s %-22s %8s %11s" % ("ticker", "name", "weight", "dollars")
    if has_price:
        head += " %10s %10s" % ("price", "shares")
    lines.append(head + "  note")
    for p in r["positions"]:
        row = "%-7s %-22s %7.2f%% %11s" % (p["ticker"], (p["name"] or "")[:22], p["weight"], money(p["dollars"]))
        if has_price:
            row += " %10s %10s" % (money(p["price"]) if "price" in p else "", p.get("shares", ""))
        if p["capped"]:
            row += "  capped at %s%%" % _num(r["max_position_pct"])
        lines.append(row)
    lines.append("%-7s %-22s %8s %11s" % ("", "invested", "", money(r["invested"])))
    lines.append("%-7s %-22s %8s %11s" % ("", "cash buffer", "", money(r["cash_buffer"])))
    lines.append("%-7s %-22s %8s %11s" % ("", "left idle", "", money(r["idle"])))
    if r["idle"] >= 1:
        lines.append("")
        lines.append("Left idle %s: %s" % (money(r["idle"]), (
            "whole shares do not divide evenly" if r["whole_shares"]
            else "every stock is at its cap; add stocks or raise max_position_pct")))
    for d in r["dropped"]:
        lines.append("Dropped %s: %s" % (d["ticker"], d["reason"]))
    lines.append("")
    lines.append("Proposed orders (place_stock_order arguments, nothing has been placed):")
    for o in orders:
        amount = ("notional \"%s\"" % o["notional"]) if "notional" in o else ("qty \"%s\"" % o["qty"])
        lines.append("  %s %s %s, %s, %s" % (o["side"], o["symbol"], amount, o["type"], o["time_in_force"]))
    lines.append("")
    lines.append("These buys have no stop. trader-risk blocks them while \"require_stop\" is true and applies "
                 "your day-trade limits to every buy.")
    lines.append("Next: trader-risk checks every order, then trader-broker asks you yes or no for each one.")
    lines.append("Education and tooling, not financial advice.")
    return "\n".join(lines)


# ---------------------------------------------------------------- orders file

def write_orders(path, orders, cfg, source="", now_utc=None):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    doc = {
        "created_by": "trader-budget",
        "created_at": utc_iso(now_utc),
        "status": "proposed",
        "paper": bool(cfg.get("paper", True)),
        "note": ("Proposals only. Nothing is placed until trader-risk passes each order "
                 "and you say yes to it in the chat."),
        "source": source,
        "orders": orders,
    }
    if india():
        doc.update({"market": "IN", "currency": MK.currency, "broker": cfg.get("broker") or MK.broker,
                    "note": ("Proposals only. Nothing is placed until trader-risk passes each order and you "
                             "say yes to it in the chat. Claude never places a live Groww order: you place it "
                             "in the Groww app or Trade API. Paper fills are simulated in trader/portfolio.json.")})
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------- main

def run_plan(a, cfg):
    now = parse_now(a.now)
    today = to_eastern(now).date().isoformat()
    plan = read_json(a.plan, "plan (run trader-exit first, or use --weights for a split)")
    limit = None
    if a.limit is not None:
        if a.limit == "plan":
            limit = _f((plan or {}).get("entry"))
        else:
            limit = _f(a.limit)
            if limit is None or limit <= 0:
                raise SizeError("--limit wants a price, like --limit 364.00")
    sym = str((plan or {}).get("symbol") or "").upper()
    if india():
        sym = MK.plain_symbol(sym)
    notes, price = [], None
    ppath = a.prices or ("trader/prices.json" if os.path.exists("trader/prices.json") else None)
    if ppath and limit is None and sym:
        pdoc = read_json(ppath, "prices")
        if india() and isinstance(pdoc, dict):
            pdoc = dict(pdoc, prices={MK.plain_symbol(k): v for k, v in (pdoc.get("prices") or {}).items()},
                        detail={MK.plain_symbol(k): v for k, v in (pdoc.get("detail") or {}).items()})
        p, t, fresh = fresh_price(pdoc, sym, now)
        if p is not None and fresh:
            price = p
            if round_price(p) > round_price(_f(plan.get("entry")) or 0):
                notes.append("%s last %s (as of %s %s) is above the plan's entry %s, so the risk "
                             "is bigger: sized at %s." % (sym, _price(p), to_eastern(t).strftime("%H:%M"), PLACE,
                                                          _price(plan.get("entry")), _price(round_price(p))))
        elif p is not None:
            notes.append("%s in %s is %s: not used (older than %d minutes). Sized at the plan's entry."
                         % (sym, ppath, ("from " + to_eastern(t).strftime("%Y-%m-%d %H:%M") + " " + PLACE)
                            if t else "undated", FRESH_MINUTES))
    cash = None
    if a.portfolio and os.path.exists(a.portfolio):
        pf = read_json(a.portfolio, "portfolio")
        cash = _f(pf.get("cash")) if isinstance(pf, dict) else None
    s = size_trade(plan, cfg, a.budget, limit, price, cash, today, market_order=a.market_order)
    order = bracket_order(s)
    if order and a.write:
        src = "trader/plan.json (%s %s %s)" % (s["symbol"], s["setup"] or "plan", s["date"] or today)
        write_orders(a.write, [order], cfg, src, now)
    if a.json:
        print(json.dumps({"sizing": s, "orders": [order] if order else [], "notes": notes}, indent=2))
    else:
        print(plan_report(s, order, notes))
        if order and a.write:
            print("Wrote 1 proposed bracket order to %s" % a.write)
    return 0 if order else 1


def run_weights(a, cfg):
    source = ""
    if a.weights:
        rows = parse_weights(weights_from_arg(a.weights))
    else:
        data = read_json(a.targets, "weights file")
        rows = parse_weights(data)
        if isinstance(data, dict):
            source = data.get("source", "")
    prices = load_prices(a.prices)
    if not prices and os.path.exists("trader/prices.json") and not a.prices:
        prices = load_prices("trader/prices.json")
    whole = True if a.whole_shares else None
    result = size(rows, cfg, a.budget, prices, whole, a.cents, a.top)
    orders = orders_from(result, source)
    if a.write:
        write_orders(a.write, orders, cfg, source, parse_now(a.now))
    if a.json:
        print(json.dumps({"result": result, "orders": orders}, indent=2))
    else:
        print(report(result, orders, source))
        if a.write:
            print("Wrote %d proposed orders to %s" % (len(orders), a.write))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Size a day trade to your budget and max loss (trader-budget).")
    ap.add_argument("--plan", default="trader/plan.json", help="the trade plan (default trader/plan.json)")
    ap.add_argument("--config", default="trader/config.json", help="rules (default trader/config.json)")
    ap.add_argument("--budget", type=float, help="override the budget in the config")
    ap.add_argument("--limit", nargs="?", const="plan", metavar="PRICE",
                    help="a limit order instead of market, at the plan's entry or at PRICE")
    ap.add_argument("--prices", help="prices JSON (default trader/prices.json if it exists)")
    ap.add_argument("--portfolio", default="trader/portfolio.json",
                    help="your account; its cash caps the size if it exists")
    ap.add_argument("--now", help="pretend it is this exchange-local time (IST, or New York with --market US), "
                                  "e.g. \"2026-11-02 09:45\"")
    ap.add_argument("--market", help="IN (NSE, Groww: the default) or US (NYSE, Alpaca)")
    ap.add_argument("--market-order", action="store_true",
                    help="India: a MARKET entry instead of the default LIMIT at the sized price")
    ap.add_argument("--write", nargs="?", const="trader/orders.json", metavar="PATH",
                    help="write the proposed order (default trader/orders.json)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of the report")
    g = ap.add_argument_group("weights mode (split a budget across a list)")
    g.add_argument("--weights", help="inline weights: AAPL=22.04,AXP=17.14")
    g.add_argument("--targets", help="a weights file: {\"weights\": [{\"ticker\", \"weight\"}]}")
    g.add_argument("--top", type=int, help="keep only the N biggest weights")
    g.add_argument("--whole-shares", action="store_true", help="whole shares only (needs --prices)")
    g.add_argument("--cents", action="store_true", help="size to the cent instead of whole dollars")
    a = ap.parse_args(argv)
    try:
        raw = market.read_config(a.config) if a.config else {}
        try:
            apply_market(market.resolve(a.market, raw))
        except market.MarketError as e:
            raise SizeError(str(e))
        cfg = load_config(a.config)
        if a.weights or a.targets:
            return run_weights(a, cfg)
        if a.top or a.whole_shares or a.cents:
            raise SizeError("--top, --whole-shares and --cents work with --weights or --targets")
        return run_plan(a, cfg)
    except SizeError as e:
        print("size.py: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
