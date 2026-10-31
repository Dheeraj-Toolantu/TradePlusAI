# Day-trader replay tools

- `replay.py CHART.json[.gz] SYMBOL OUTDIR [--days N]`: replays the India day-trade pipeline
  (trader-entry, exit, timemachine, budget, risk) on every NSE session in a saved Yahoo 5-minute chart.
  - Each step sees only the data up to its own moment. The actual outcome comes from the bars that
    followed: the stop or target hit first (a bar touching both counts as the stop), otherwise out at
    the 15:05 close. P&L is shown net of charges.
  - Paper only: nothing is sent to a broker.
- `term2png.js OUT.png "TITLE" FILE...`: renders captured terminal output as a PNG screenshot (Node and
  Playwright).

Fetch 60 days of real 5-minute candles (needs `query1/query2.finance.yahoo.com` allowed in the network
settings), then replay:

```bash
curl -sS -A "Mozilla/5.0" "https://query2.finance.yahoo.com/v8/finance/chart/COALINDIA.NS?range=60d&interval=5m&includePrePost=false" -o /tmp/COALINDIA.NS-60d5m.json
python3 -I scripts/day-trader/replay.py /tmp/COALINDIA.NS-60d5m.json COALINDIA /tmp/replay-coalindia
```
