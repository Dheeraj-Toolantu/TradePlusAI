Synthetic fixtures for trader-deals/deals.py. Client names and numbers are invented; only the
layout follows NSE's daily files:
  https://archives.nseindia.com/content/equities/bulk.csv
  https://archives.nseindia.com/content/equities/block.csv
bulk-synthetic.csv            header with trailing spaces (as NSE ships it), CRLF line ends,
                              quoted quantities with Indian commas, Remarks "-".
block-synthetic.csv           no Remarks column.
block-norecords-synthetic.csv header plus a "NO RECORDS" line (a day without block deals).
bulk-empty-synthetic.csv      a body that is only "NO RECORDS FOUND".
The exact header text and the "NO RECORDS" body are written from memory, not checked live.
Bulk-Deals-31-10-2026-to-31-10-2026-synthetic.csv  the nseindia.com report download: every cell
                              quoted, trailing spaces, "Buy / Sell " with spaces, 31-OCT-2026 dates,
                              a client name with a comma, prices like "1,502.25", a trailing blank line.
deals-a-synthetic.csv         a BOM, CRLF, "1,234.50" price; its name says neither bulk nor block.
bulk-api-synthetic.json       the website API's {"data": [{"BD_SYMBOL", ...}]} JSON.
largedeal-snapshot-synthetic.json  the website snapshot {"BULK_DEALS_DATA", "BLOCK_DEALS_DATA"}.
The JSON field names are from memory too, not checked live.
