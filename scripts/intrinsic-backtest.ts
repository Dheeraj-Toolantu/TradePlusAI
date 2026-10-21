/**
 * Replays the Intrinsic Value OTM strategy on recorded Groww candles for chosen days.
 *
 *   npx tsx scripts/intrinsic-backtest.ts --days 2026-10-19,2026-10-21 [--indices NIFTY,BANKNIFTY,SENSEX]
 *
 * Needs Groww credentials (.env.local or apps/web/.env.local) and Python on PATH. For each index
 * and day it loads 5m index candles, daily candles, the point-in-time 09:00 IST sentiment score
 * (sentiment.backtest_index) and 5m premium candles for strikes within ±2% of the open on the
 * nearest still-listed expiry, then runs tradepulse_quant.backtest.intrinsic_backtest under both
 * sentiment mappings. Writes reports/intrinsic-backtest-<last day>.md and .json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGrowwTransport } from "../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../adapters/groww/src/groww-instruments";
import { runPythonModule } from "../apps/web/lib/python";

for (const filename of [path.resolve(".env.local"), path.resolve("apps/web/.env.local")]) {
  if (!existsSync(filename)) continue;
  for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Replay = { symbol: string; day: string; mapping: string; sentiment: { score?: number | null; label?: string }; bars_evaluated: number; decisions: Record<string, number>; options_loaded: number; pnl_points: number; pnl_rupees_1_lot: number;
  trades: Array<{ contract: string; entry_time: string; entry: number; stop: number; target: number; trail: number; exit_time: string; exit: number; exit_reason: string; pnl_points: number; pnl_rupees_1_lot: number; r_multiple: number; key_value: number; spot_at_entry: number }>;
  timeline: Array<{ time: string; decision: string; reason: string }> };

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const days = (arg("days") ?? "").split(",").filter(Boolean).sort();
const indices = (arg("indices") ?? "NIFTY,BANKNIFTY,SENSEX").split(",");
if (!days.length) { console.error("Usage: --days YYYY-MM-DD[,YYYY-MM-DD]"); process.exit(1); }

const transport = createGrowwTransport();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(body: unknown): Candle[] {
  const payload = ((body as { payload?: unknown })?.payload ?? body) as { candles?: unknown[] };
  return (payload?.candles ?? []).flatMap((row) => {
    if (!Array.isArray(row) || row.length < 5) return [];
    const [time, open, high, low, close, volume] = row.map(Number);
    return [time, open, high, low, close].every(Number.isFinite) ? [{ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }] : [];
  });
}

async function candles(exchange: string, segment: "CASH" | "FNO", tradingSymbol: string, from: string, to: string, minutes: number): Promise<Candle[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = await transport.request(`/v1/historical/candle/range?exchange=${exchange}&segment=${segment}&trading_symbol=${encodeURIComponent(tradingSymbol)}&start_time=${encodeURIComponent(`${from} 09:15:00`)}&end_time=${encodeURIComponent(`${to} 15:30:00`)}&interval_in_minutes=${minutes}`, { method: "GET" });
      return parse(body);
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(1500 * (attempt + 1)); // rate limit
    }
  }
  return [];
}

async function main() {
  const catalog = await loadGrowwInstrumentCatalog();
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  console.error("Point-in-time sentiment (09:00 IST replay)…");
  const sentiment = await runPythonModule<{ ok: boolean; error?: string; indices?: Record<string, { daily: Array<{ date: string; score: number; label: string }> }> }>(
    "tradepulse_quant.sentiment.backtest_index", { days: 8, end: days.at(-1), indices }, 600_000);
  if (!sentiment.ok) console.error(`Sentiment replay failed: ${sentiment.error}`);

  const runs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  for (const symbol of indices) {
    const exchange = symbol === "SENSEX" ? "BSE" : "NSE";
    const index = catalog.getByTradingSymbol(exchange, symbol);
    const daily = await candles(exchange, "CASH", index?.tradingSymbol ?? symbol, addDays(days[0], -45), days.at(-1)!, 1440);
    for (const day of days) {
      const bars = await candles(exchange, "CASH", index?.tradingSymbol ?? symbol, addDays(day, -6), day, 5);
      const session = bars.filter((bar) => new Date((bar.time + 19_800) * 1000).toISOString().slice(0, 10) === day);
      if (!session.length) { notes.push(`${symbol} ${day}: no index candles`); continue; }
      const open = session[0].open;
      // Expired weeklies drop out of the contract master, so a past day uses the nearest expiry still listed.
      const listed = catalog.getAll().filter((item) => item.segment === "FNO" && item.underlyingSymbol === symbol && (item.instrumentType === "CE" || item.instrumentType === "PE") && String(item.expiryDate ?? "") >= (day > today ? day : today) && String(item.expiryDate ?? "") >= day);
      const expiry = listed.map((item) => String(item.expiryDate)).sort()[0];
      const strikes = listed.filter((item) => item.expiryDate === expiry && Math.abs(Number(item.strikePrice) - open) / open <= 0.02);
      const options = [];
      for (const item of strikes) {
        const premium = await candles(item.exchange, "FNO", item.tradingSymbol, day, day, 5).catch(() => [] as Candle[]);
        if (premium.length) options.push({ symbol: item.tradingSymbol, type: item.instrumentType, strike: Number(item.strikePrice), expiry, lot_size: Number(item.lotSize), candles: premium });
        await sleep(120);
      }
      const reading = sentiment.indices?.[symbol]?.daily.find((row) => row.date === day);
      if (!reading) notes.push(`${symbol} ${day}: no point-in-time sentiment score`);
      notes.push(`${symbol} ${day}: ${session.length} index bars, ${options.length}/${strikes.length} option contracts (expiry ${expiry})`);
      for (const mapping of ["CONTRARIAN", "FOLLOW"]) {
        runs.push({ symbol, day, mapping, sentiment: reading ? { score: reading.score, label: reading.label } : null, candles_5m: bars, daily_candles: daily, options });
      }
    }
  }
  const { runs: results } = await runPythonModule<{ runs: Replay[] }>("tradepulse_quant.backtest.intrinsic_backtest", { runs }, 600_000);

  const lines = [`# Intrinsic Value OTM replay: ${days.join(", ")}`, "", "Walk-forward on Groww 5m candles; sentiment is the point-in-time 09:00 IST score. Strategy rules only: no OI wall, VIX or broker gates. One lot, no costs.", ""];
  for (const mapping of ["CONTRARIAN", "FOLLOW"]) {
    const rows = results.filter((row) => row.mapping === mapping);
    lines.push(`## ${mapping === "CONTRARIAN" ? "Contrarian (as specified: very positive → PE, very negative → CE)" : "Follow (very positive → CE, very negative → PE)"}`, "",
      "| Index | Day | Sentiment | Trades | P&L (pts) | P&L ₹ (1 lot) |", "|---|---|---|---|---|---|");
    for (const row of rows) lines.push(`| ${row.symbol} | ${row.day} | ${row.sentiment?.score ?? "--"} | ${row.trades.length} | ${row.pnl_points} | ${row.pnl_rupees_1_lot} |`);
    const trades = rows.flatMap((row) => row.trades.map((trade) => ({ ...trade, symbol: row.symbol, day: row.day })));
    if (trades.length) {
      lines.push("", "| Day | Contract | Entry | SL / trail / target | Exit | Reason | R | ₹ |", "|---|---|---|---|---|---|---|---|");
      for (const t of trades) lines.push(`| ${t.day} | ${t.contract} | ${t.entry_time} @ ${t.entry} | ${t.stop} / ${t.trail} / ${t.target} | ${t.exit_time} @ ${t.exit} | ${t.exit_reason} | ${t.r_multiple} | ${t.pnl_rupees_1_lot} |`);
    }
    lines.push("", "Why no trade (last reason per index/day):", "");
    for (const row of rows.filter((item) => !item.trades.length)) lines.push(`- ${row.symbol} ${row.day}: ${row.timeline.at(-1)?.reason ?? "no bars evaluated"}`);
    lines.push("");
  }
  lines.push("## Data", "", ...notes.map((note) => `- ${note}`), "");
  mkdirSync("reports", { recursive: true });
  const base = `reports/intrinsic-backtest-${days.at(-1)}`;
  writeFileSync(`${base}.md`, lines.join("\n"));
  writeFileSync(`${base}.json`, JSON.stringify(results.map(({ timeline, ...rest }) => ({ ...rest, timeline })), null, 2));
  console.log(lines.join("\n"));
  console.error(`Wrote ${base}.md and ${base}.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
