Synthetic fixtures for the India (NSE) tests of trader-alerts (test_alerts_india.py).

Nothing here is real market data: the prices are made up. The files copy the exact shape of
Yahoo Finance's chart endpoint for an NSE stock (query2.finance.yahoo.com/v8/finance/chart/
RELIANCE.NS?range=1d&interval=1d): meta.currency "INR", exchangeName "NSI" (NSE) or "BSE",
exchangeTimezoneName "Asia/Kolkata", gmtoffset 19800, the session 03:45Z to 10:00Z
(9:15 to 15:30 IST), on Friday 2026-10-30.

  yahoo-<SYM>.json   the NSE (.NS) quote, read by --source yahoo
  bse-<SYM>.json     the BSE (.BO) quote, the fallback and --source bse
  yahoo-ZZZZ.json    Yahoo's "No data found" answer
  plan-RELIANCE.json a trader-exit plan for 2026-10-30 with no flat_by (the 15:10 IST default applies)
