const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const dir = process.argv[2]; const out = process.argv[3];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.join(dir, "strategy.html"), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: out, format: "A4", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: '<div style="width:100%;font-family:Inter,sans-serif;font-size:7.5pt;color:#7a8a93;padding:0 16mm;display:flex;justify-content:space-between"><span>TradePulse AI · VWAP-EMA Scalper · Strategy guide v1.0</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  await browser.close();
  console.log(out);
})().catch((e) => { console.error(e); process.exit(1); });
