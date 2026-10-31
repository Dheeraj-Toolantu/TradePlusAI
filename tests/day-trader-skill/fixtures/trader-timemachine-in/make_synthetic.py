"""Writes the SYNTHETIC RELIANCE.NS fixtures (not market data): python3 make_synthetic.py
  ../trader-timemachine-in/RELIANCE.NS-60d5m-synthetic.json.gz  60 NSE sessions of 5m bars, range=60d
  ../trader-entry-in/RELIANCE.NS-2026-10-30-5m-synthetic.json    the last session alone, like range=1d
Deterministic (random.Random(2026)), NSE 2026 holidays skipped, prices on the 0.10 tick then
passed through float32 the way Yahoo serves them. 2026-10-16 is cut short (72 bars) on purpose."""
import datetime, gzip, json, os, random, struct

HERE = os.path.dirname(os.path.abspath(__file__))
HOL = {"2026-08-15", "2026-09-14", "2026-10-02", "2026-10-20"}
LAST = datetime.date(2026, 10, 30)
EPOCH = datetime.datetime(1970, 1, 1)


def f32(x):
    return struct.unpack("f", struct.pack("f", x))[0]


def tick(x):
    return round(round(x * 10) / 10.0, 2)


def days():
    out, d = [], LAST
    while len(out) < 60:
        if d.weekday() < 5 and d.isoformat() not in HOL:
            out.append(d)
        d -= datetime.timedelta(days=1)
    return out[::-1]


def bar(rng, p, drift, vol):
    c = tick(p * (1 + rng.gauss(drift, vol)))
    h = tick(max(p, c) * (1 + abs(rng.gauss(0, vol / 2))))
    lo = tick(min(p, c) * (1 - abs(rng.gauss(0, vol / 2))))
    return [p, h, lo, c]


def main():
    rng = random.Random(2026)
    ts, rows, p = [], [], 1286.0
    for d in days():
        p = tick(p * (1 + rng.gauss(0, 0.006))) if d != LAST else 1401.0
        start = int((datetime.datetime.combine(d, datetime.time(3, 45)) - EPOCH).total_seconds())
        n = 72 if d.isoformat() == "2026-10-16" else 75
        script = None
        if d == LAST:   # opening range 1398.00-1412.00, the 9:40 bar closes 1415.30 above it
            script = [[p, 1412.0, 1398.0, 1405.0], [1405.0, 1410.0, 1400.5, 1407.2], [1407.2, 1411.0, 1403.1, 1409.8],
                      [1409.8, 1411.9, 1404.4, 1408.0], [1408.0, 1412.0, 1406.0, 1410.5], [1410.5, 1413.0, 1407.7, 1411.2],
                      [1411.2, 1417.0, 1410.9, 1415.3]]
        for i in range(n):
            o, h, lo, c = script[i] if script and i < len(script) else bar(rng, p, 0.0, 0.0022)
            ts.append(start + 300 * i)
            v = int(rng.uniform(0.6, 1.4) * (90000 if i in (0, 1, 74) else 30000))
            rows.append([f32(o), f32(h), f32(lo), f32(c), v])
            p = c
        if d != LAST:
            day_close = p
    meta = {"currency": "INR", "symbol": "RELIANCE.NS", "exchangeName": "NSI", "fullExchangeName": "NSE",
            "instrumentType": "EQUITY", "firstTradeDate": 820467900, "regularMarketTime": ts[-1] + 300,
            "hasPrePostMarketData": False, "gmtoffset": 19800, "timezone": "IST",
            "exchangeTimezoneName": "Asia/Kolkata", "regularMarketPrice": rows[-1][3],
            "longName": "Reliance Industries Limited", "shortName": "RELIANCE INDUSTRIES LTD",
            "chartPreviousClose": rows[0][0], "priceHint": 2, "dataGranularity": "5m", "range": "60d"}

    def doc(sl, extra):
        q = {"open": [r[0] for r in sl], "high": [r[1] for r in sl], "low": [r[2] for r in sl],
             "close": [r[3] for r in sl], "volume": [r[4] for r in sl]}
        return {"chart": {"result": [{"meta": dict(meta, **extra), "timestamp": None, "indicators": {"quote": [q]}}],
                          "error": None}}
    full = doc(rows, {})
    full["chart"]["result"][0]["timestamp"] = ts
    with gzip.GzipFile(os.path.join(HERE, "RELIANCE.NS-60d5m-synthetic.json.gz"), "wb", mtime=0) as fh:
        fh.write(json.dumps(full).encode("utf-8"))
    one = doc(rows[-75:], {"range": "1d", "previousClose": day_close, "chartPreviousClose": day_close})
    one["chart"]["result"][0]["timestamp"] = ts[-75:]
    with open(os.path.join(HERE, "..", "trader-entry-in", "RELIANCE.NS-2026-10-30-5m-synthetic.json"), "w") as fh:
        json.dump(one, fh)


if __name__ == "__main__":
    main()
