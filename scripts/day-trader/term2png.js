// Render captured terminal output as a PNG: node term2png.js OUT.png "TITLE" FILE [FILE...]
// Each FILE: first line = the command, the rest = its output.
const fs = require('fs'); const { chromium } = require('playwright');
const [out, title, ...files] = process.argv.slice(2);
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const blocks = files.map(f => { const l = fs.readFileSync(f,'utf8').replace(/\n+$/,'').split('\n');
  return `<div class="cmd">$ ${esc(l[0])}</div><pre>${esc(l.slice(1).join('\n'))}</pre>`; }).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1117;font:14px/1.45 'DejaVu Sans Mono',monospace;color:#e6edf3}
.win{margin:16px;border:1px solid #30363d;border-radius:10px;overflow:hidden;width:1180px}
.bar{background:#161b22;padding:9px 14px;color:#8b949e;border-bottom:1px solid #30363d}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px}
.c{padding:10px 16px}.cmd{color:#7ee787;margin-top:8px}pre{margin:4px 0 10px;white-space:pre-wrap}
.tag{float:right;color:#f0883e}</style><div class="win"><div class="bar">
<span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span>
<span class="dot" style="background:#27c93f"></span> ${esc(title)} <span class="tag">PAPER TRADE: nothing is sent to Groww</span></div>
<div class="c">${blocks}</div></div>`;
(async () => { const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1214,height:400}, deviceScaleFactor:1.5});
  await p.setContent(html); await p.locator('.win').screenshot({path: out}); await b.close(); console.log(out); })();
