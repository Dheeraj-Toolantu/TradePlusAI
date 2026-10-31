Synthetic fixtures for the India (NSE) path of trader-analyst/facts.py. The numbers are made up
(round figures in rupees crore), only the shapes follow the real endpoints:

timeseries-<SYM>.NS.json  Yahoo fundamentals-timeseries
    https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/<SYM>.NS
    {"timeseries": {"result": [{"meta": {"symbol": [..], "type": [..]}, "timestamp": [..],
     "<type>": [{"asOfDate", "periodType", "currencyCode", "reportedValue": {"raw", "fmt"}}, null]}],
     "error": null}}
    RELIANCE: the March 2026 quarter is missing from the quarterly revenue, net income and EPS
    series, so it is derived from the FY26 annual figures. One gross-profit entry is null.
    HDFCBANK: a bank, no gross profit or operating income, no diluted EPS (basic EPS is used),
    one null revenue entry.
    NOSUCH: an empty result, as Yahoo returns for an unknown symbol.
Financial_Results.xml     NSE's results RSS, https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml
    (item title = company name, link, description, pubDate). Shape written from memory, not
    checked live. Includes Reliance Infrastructure as a decoy for the RELIANCE symbol.
Financial_Results-lookalikes.xml  look-alike companies (Mahindra & Mahindra Financial Services listed
    before Mahindra & Mahindra, ITC Hotels next to ITC), mixed pubDate formats (NSE's 31-Oct-2026
    18:05:12 and RFC 822) and items out of date order (an older ITC result first).
timeseries-NOGP.NS.json   a non-financial company with no gross profit; the March 2026 quarter derived.
timeseries-USDCO.NS.json  the same shape with currencyCode "USD" (Yahoo reports some companies in USD).
timeseries-CRUMB.NS.json  Yahoo's {"finance": {"error": {"code": "Unauthorized", "description":
    "Invalid Crumb"}}} refusal.
