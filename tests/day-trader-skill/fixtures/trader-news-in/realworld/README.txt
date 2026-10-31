Synthetic, realistic-looking variants for test_news_india.py (RealWorld*). Nothing is real news.
gnews-RELIANCE.xml   Google News RSS as it looks: titles ending " - Publisher", <source>, an HTML
                     <a>..</a>&nbsp;&nbsp;<font>Publisher</font> description, the same story from two
                     publishers (A1, A6), and headlines with common words that must not be tagged
                     ("as a result", "Pat Cummins", "pit stop", "hackathon", "default to growth",
                     "Diwali bonus", "split screen") next to true positives.
nse-announcements.xml  titles that are only the company name (Reliance Industries / Infrastructure /
                     Power, Bajaj Auto / Finance, M&M / M&M Financial Services, TCS / Tata Consumer /
                     Tata Communications), the subject in a CDATA <description> starting
                     "<Company> has informed the Exchange ...", NSE and RFC 822 pubDates.
nse-results.xml      one older result. nse-board-meetings.xml an empty feed.
EQUITY_L.csv         the NSE equity list rows for those companies.
