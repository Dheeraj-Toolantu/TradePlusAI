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
