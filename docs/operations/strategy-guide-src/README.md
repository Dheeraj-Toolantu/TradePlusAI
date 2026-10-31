# Source of VWAP-EMA-Scalper-Strategy-Guide.pdf

`strategy.html` is the guide (print-styled HTML with inline SVG figures). The screenshots are the
built app rendering the real engine on a synthetic NIFTY tape (labelled DEMO DATA in the guide).

Regenerate from the repo root (Node + Playwright):

```bash
node docs/operations/strategy-guide-src/render.js "$PWD/docs/operations/strategy-guide-src" docs/operations/VWAP-EMA-Scalper-Strategy-Guide.pdf
```

Update the numbers in sections 9 and 14 if `scalp_strategy.py` or `VWAP_EMA_TRAIL` change.
