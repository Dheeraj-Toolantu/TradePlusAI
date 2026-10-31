Synthetic fixtures for the India (NSE) tests of trader-news (test_news_india.py).

Nothing here is real news, a real filing or real market data: every headline starts with
"Synthetic:", every filing link ends in _synthetic.pdf, and Zentra Power (ZENTRA, ZENTRATRAN) is a
made-up company. The files copy the shape of the live endpoints:

  gnews-<SYM>.xml          Google News RSS search (news.google.com/rss/search?q=...&hl=en-IN&gl=IN&ceid=IN:en):
                           titles end in " - Publisher", <source url=...>, HTML <description>
  yahoo-RELIANCE.xml       Yahoo Finance headline RSS for RELIANCE.NS (region=IN, lang=en-IN)
  nse-announcements.xml    NSE RSS 2.0: content/RSS/Online_announcements.xml
  nse-results.xml          NSE RSS 2.0: content/RSS/Financial_Results.xml
  nse-board-meetings.xml   NSE RSS 2.0: content/RSS/Board_Meetings.xml
                           (titles start with the company name; pubDate as NSE's "29-Oct-2026 19:05:12"
                           in IST, and one RFC 822 date with +0530)
  EQUITY_L.csv             NSE's equity list as published (header SYMBOL,NAME OF COMPANY, SERIES, ...)
  chart-<SYM>.json         Yahoo chart JSON for <SYM>.NS, 5m bars from 03:45Z (9:15 IST), INR, NSI,
                           Asia/Kolkata, gmtoffset 19800

The check in the tests runs at 2026-10-30 10:50 IST (05:20Z).
