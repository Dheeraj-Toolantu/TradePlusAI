"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart } from "lightweight-charts";

type Quote = {
  symbol: string;
  price: number;
  change: number;
  percent: number;
  closes: number[];
  source: string;
  volume?: number;
};
type Provider = "groww" | "yahoo" | "fallback";
type Mode = "Paper" | "Assisted" | "Algo Live";
type CandleInterval = "1m" | "3m" | "5m" | "10m" | "15m" | "1h" | "4h" | "1D" | "1W" | "1M";
type EmaPeriod = "off" | "9" | "20" | "50" | "100" | "200";
type ChartStrategy = "none" | "technical-plan" | "ema-cross" | "vwap-reversion" | "breakout" | "momentum";
type Candle = { open: number; high: number; low: number; close: number; volume: number; timestamp: string };
type OptionContext = { support?: number; resistance?: number; supportStrike?: number; resistanceStrike?: number; callLtp?: number; putLtp?: number; source: string };
const symbols = ["NIFTY", "BANKNIFTY", "SENSEX", "INDIA VIX"];
const nav = [
  "Dashboard",
  "Live Signals",
  "Markets",
  "Options Chain",
  "Strategy Builder",
  "Backtesting",
  "Paper Trading",
  "Algo Trading",
  "Trade Journal",
  "Analytics",
  "AI Insights",
  "Broker Connections",
  "Settings",
];
const signals = [
  [
    "NIFTY",
    "24,900 CE",
    "BUY",
    "110 - 115",
    "150 / 170",
    "2.4",
    "84%",
    "Bullish momentum + volume",
  ],
  [
    "BANKNIFTY",
    "54,300 PE",
    "SELL",
    "220 - 225",
    "170 / 150",
    "2.1",
    "78%",
    "Bearish reversal + OI build-up",
  ],
  [
    "NIFTY",
    "24,800 PE",
    "SELL",
    "82 - 86",
    "60 / 48",
    "1.9",
    "71%",
    "Bearish reversal + OI build-up",
  ],
  [
    "SENSEX",
    "81,500 CE",
    "BUY",
    "620 - 630",
    "720 / 780",
    "2.2",
    "76%",
    "Bullish momentum + volume",
  ],
];
const optionRows = [
  ["24,700", "18.6", "+18%", "245.10", "41.30", "-16%", "22.3"],
  ["24,750", "26.8", "+21%", "196.70", "57.80", "-19%", "31.1"],
  ["24,800", "38.4", "+32%", "148.75", "76.40", "-25%", "42.7"],
  ["24,850", "52.2", "+45%", "104.90", "101.20", "-34%", "53.4"],
  ["24,900", "68.1", "+38%", "73.40", "128.30", "-42%", "64.1"],
];
const money = (value: number) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const indiaTime = (value: number | string | Date, includeDate = false) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: includeDate ? "2-digit" : undefined, month: includeDate ? "short" : undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(typeof value === "number" ? value * 1000 : value));
const candleDurationSeconds: Record<CandleInterval, number> = { "1m": 60, "3m": 180, "5m": 300, "10m": 600, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800, "1M": 2592000 };

function liveCandleFor(quote: Quote, history: Candle[], timeframe: CandleInterval, timestamp: string): Candle[] {
  const duration = candleDurationSeconds[timeframe];
  const epochSeconds = Math.floor(new Date(timestamp).getTime() / 1000);
  const bucketTime = Math.floor(epochSeconds / duration) * duration;
  const previous = history.at(-1);
  const volume = quote.volume && quote.volume > 0 ? quote.volume : Math.max(1, Math.round(Math.abs(quote.price - (previous?.close ?? quote.price)) * 100));
  if (previous && Math.floor(new Date(previous.timestamp).getTime() / 1000) === bucketTime) {
    return [...history.slice(0, -1), { ...previous, high: Math.max(previous.high, quote.price), low: Math.min(previous.low, quote.price), close: quote.price, volume: previous.volume + volume }];
  }
  return [...history, { open: quote.price, high: quote.price, low: quote.price, close: quote.price, volume, timestamp: new Date(bucketTime * 1000).toISOString() }];
}

function emaValues(values: number[], period: number) { const multiplier = 2 / (period + 1); let previous = values[0]; return values.map((value, index) => { previous = index === 0 ? value : (value - previous) * multiplier + previous; return index + 1 < period ? null : previous; }); }
function optionContext(): OptionContext {
  const numberOrUndefined = (value: string) => { const parsed = Number(value.replace(/,/g, "")); return Number.isFinite(parsed) ? parsed : undefined; };
  const rows = optionRows.flatMap((row) => { const callOi = numberOrUndefined(row[0]); const callLtp = numberOrUndefined(row[2]); const strike = numberOrUndefined(row[3]); const putLtp = numberOrUndefined(row[4]); const putOi = numberOrUndefined(row[6]); return callOi !== undefined && callLtp !== undefined && strike !== undefined && putLtp !== undefined && putOi !== undefined ? [{ callOi, callLtp, strike, putLtp, putOi }] : []; });
  const supportRow = rows.reduce((best, row) => row.putOi > best.putOi ? row : best, rows[0]);
  const resistanceRow = rows.reduce((best, row) => row.callOi > best.callOi ? row : best, rows[0]);
  return { support: supportRow?.strike, resistance: resistanceRow?.strike, supportStrike: supportRow?.strike, resistanceStrike: resistanceRow?.strike, callLtp: resistanceRow?.callLtp, putLtp: supportRow?.putLtp, source: "Demo option chain" };
}

function candlePattern(current: Candle, previous: Candle) {
  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, 0.0001);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const doji = body / range <= 0.1;
  const bullishEngulfing = current.close > current.open && previous.close < previous.open && current.open <= previous.close && current.close >= previous.open;
  const bearishEngulfing = current.close < current.open && previous.close > previous.open && current.open >= previous.close && current.close <= previous.open;
  const hammer = lowerWick >= body * 2 && upperWick <= Math.max(body, range * 0.12) && current.close >= current.open;
  const shootingStar = upperWick >= body * 2 && lowerWick <= Math.max(body, range * 0.12) && current.close <= current.open;
  const insideBar = current.high <= previous.high && current.low >= previous.low;
  if (bullishEngulfing) return { name: "Bullish engulfing", signal: "BULLISH CONFIRMATION", confirmed: true };
  if (bearishEngulfing) return { name: "Bearish engulfing", signal: "BEARISH / SHORT CONFIRMATION", confirmed: true };
  if (hammer) return { name: "Hammer", signal: "BULLISH REVERSAL WATCH", confirmed: false };
  if (shootingStar) return { name: "Shooting star", signal: "BEARISH / SHORT WATCH", confirmed: false };
  if (doji) return { name: "Doji", signal: "INDECISION - WAIT FOR BREAK", confirmed: false };
  if (insideBar) return { name: "Inside bar", signal: "CONSOLIDATION - WAIT FOR BREAK", confirmed: false };
  return { name: current.close > current.open ? "Bullish candle" : "Bearish candle", signal: "NO CONFIRMED PATTERN", confirmed: false };
}

function buildTechnicalPlan(candles: Candle[], options: OptionContext) {
  if (!candles.length) return null;
  const recent = candles.slice(-Math.min(candles.length, 60));
  const closes = recent.map((candle) => candle.close);
  const current = recent.at(-1)!;
  const previous = recent.at(-2) ?? current;
  const ema9 = emaValues(closes, 9).at(-1) ?? closes.at(-1) ?? 0;
  const ema21 = emaValues(closes, 21).at(-1) ?? closes.at(-1) ?? 0;
  const lookback = recent.slice(-Math.min(recent.length, 20));
  const priceSupport = lookback.length ? Math.min(...lookback.map((candle) => candle.low)) : current.low;
  const priceResistance = lookback.length ? Math.max(...lookback.map((candle) => candle.high)) : current.high;
  const optionSupportRelevant = options.support !== undefined && Math.abs(options.support - current.close) / current.close < 0.1;
  const optionResistanceRelevant = options.resistance !== undefined && Math.abs(options.resistance - current.close) / current.close < 0.1;
  const support = optionSupportRelevant ? Math.min(priceSupport, options.support!) : priceSupport;
  const resistance = optionResistanceRelevant ? Math.max(priceResistance, options.resistance!) : priceResistance;
  const atrWindow = recent.slice(-Math.min(recent.length, 14));
  const atr = atrWindow.length ? atrWindow.reduce((sum, candle) => sum + candle.high - candle.low, 0) / atrWindow.length : 0;
  const averageVolume = lookback.length ? lookback.reduce((sum, candle) => sum + candle.volume, 0) / lookback.length : 0;
  const pattern = candlePattern(current, previous);
  const bullishCandle = pattern.signal.includes("BULLISH") && pattern.confirmed;
  const bearishCandle = pattern.signal.includes("BEARISH") && pattern.confirmed;
  const side = ema9 > ema21 && bullishCandle ? "LONG" : ema9 < ema21 && bearishCandle ? "SHORT" : ema9 >= ema21 ? "WATCH LONG" : "WATCH SHORT";
  const entry = current.close;
  const longRisk = Math.max(Math.abs(entry - support), atr * 0.8, 0.0001);
  const shortRisk = Math.max(Math.abs(resistance - entry), atr * 0.8, 0.0001);
  const stop = side.includes("LONG") ? Math.max(support, entry - longRisk) : Math.min(resistance, entry + shortRisk);
  const longReward = Math.max(Math.abs(resistance - entry) * 1.5, Math.abs(entry - support) * 1.2, atr * 2, 0.0001);
  const shortReward = Math.max(Math.abs(entry - support) * 1.5, Math.abs(resistance - entry) * 1.2, atr * 2, 0.0001);
  const target = side.includes("LONG") ? entry + longReward : entry - shortReward;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const riskReward = risk > 0 ? reward / risk : 0;
  const riskRewardLabel = `1:${riskReward.toFixed(2)}`;
  return { side, entry, stop, target, support, resistance, ema9, ema21, volumeRatio: averageVolume ? current.volume / averageVolume : 0, candle: pattern.name, candleSignal: pattern.signal, candleConfirmed: pattern.confirmed, optionSupport: options.supportStrike, optionResistance: options.resistanceStrike, callLtp: options.callLtp, putLtp: options.putLtp, optionSource: options.source, riskReward, riskRewardLabel };
}

function Sparkline({ quote }: { quote?: Quote }) {
  const values = quote?.closes.length
    ? quote.closes.slice(-20)
    : [42, 49, 45, 58, 52, 64, 60, 72, 66, 78];
  const min = Math.min(...values),
    range = Math.max(...values) - min || 1;
  return (
    <svg className="sparkline" viewBox="0 0 120 34">
      <polyline
        points={values
          .map(
            (value, index) =>
              `${index * (120 / (values.length - 1))},${30 - ((value - min) / range) * 25}`,
          )
          .join(" ")}
      />
    </svg>
  );
}

function PriceChart({ quote, candles, timeframe, emaPeriod, strategy, options, autoRiskReward, setAutoRiskReward, loadingOlder, onRequestOlderHistory }: { quote?: Quote; candles: Candle[]; timeframe: string; emaPeriod: EmaPeriod; strategy: ChartStrategy; options: OptionContext; autoRiskReward: boolean; setAutoRiskReward: (value: boolean | ((current: boolean) => boolean)) => void; loadingOlder: boolean; onRequestOlderHistory: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const lineSeriesRef = useRef<any[]>([]);
  const indicatorSeriesRef = useRef<any[]>([]);
  const olderHistoryRequestRef = useRef(onRequestOlderHistory);
  const previousDataLengthRef = useRef(0);
  const hasFitContentRef = useRef(false);
  const [drawing, setDrawing] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<{ time: number; price: number } | null>(null);
  const [trendLines, setTrendLines] = useState<Array<{ start: { time: number; price: number }; end: { time: number; price: number } }>>([]);
  const visible = candles;
  const plan = strategy === "technical-plan" ? buildTechnicalPlan(visible, options) : null;
  const priceLinesRef = useRef<any[]>([]);

  useEffect(() => { olderHistoryRequestRef.current = onRequestOlderHistory; }, [onRequestOlderHistory]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, { autoSize: true, layout: { background: { type: ColorType.Solid, color: "#081c24" }, textColor: "#789aa1" }, localization: { timeFormatter: (time: number) => indiaTime(time) }, grid: { vertLines: { color: "rgba(65,116,125,.12)" }, horzLines: { color: "rgba(65,116,125,.15)" } }, crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#30d4ca", labelBackgroundColor: "#17606a" }, horzLine: { color: "#30d4ca", labelBackgroundColor: "#17606a" } }, rightPriceScale: { borderColor: "#173944", scaleMargins: { top: .08, bottom: .24 } }, timeScale: { borderColor: "#173944", timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: (time: number) => indiaTime(time, true) } });
    const candleSeries = chart.addSeries(CandlestickSeries, { upColor: "#22d59b", downColor: "#fa6b78", borderVisible: false, wickUpColor: "#22d59b", wickDownColor: "#fa6b78", priceLineVisible: true, lastValueVisible: true });
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", color: "#286d70", base: 0 });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
    chartRef.current = chart; candleSeriesRef.current = candleSeries; volumeSeriesRef.current = volumeSeries;
    const handleVisibleRange = (range: { from?: number; to?: number } | null) => {
      if (range?.from !== undefined && range.from <= 2) olderHistoryRequestRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);
    return () => { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange); chart.remove(); chartRef.current = null; candleSeriesRef.current = null; volumeSeriesRef.current = null; lineSeriesRef.current = []; indicatorSeriesRef.current = []; };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const fallback = [24810, 24820, 24805, 24840, 24832, 24855, 24848, 24872, 24865, 24882, 24871].map((close, index, values) => ({ open: values[index - 1] ?? close, high: close + 12, low: close - 12, close, volume: 35 + index * 7, timestamp: String(index) }));
    const data = (visible.length ? visible : fallback).map((candle, index) => ({ time: Math.floor(new Date(candle.timestamp).getTime() / 1000) || 1700000000 + index * 300, open: candle.open, high: candle.high, low: candle.low, close: candle.close }));
    const volume = (visible.length ? visible : fallback).map((candle, index) => ({ time: data[index].time, value: candle.volume, color: candle.close >= candle.open ? "rgba(34,213,155,.45)" : "rgba(250,107,120,.45)" }));
    const previousLength = previousDataLengthRef.current;
    const addedCandles = Math.max(0, data.length - previousLength);
    const previousRange = chartRef.current?.timeScale().getVisibleLogicalRange();
    candleSeriesRef.current.setData(data); volumeSeriesRef.current.setData(volume);
    previousDataLengthRef.current = data.length;
    if (!hasFitContentRef.current) { chartRef.current?.timeScale().fitContent(); hasFitContentRef.current = true; }
    else if (addedCandles > 0 && previousRange) {
      requestAnimationFrame(() => chartRef.current?.timeScale().setVisibleLogicalRange({ from: previousRange.from + addedCandles, to: previousRange.to + addedCandles }));
    }
  }, [candles, timeframe]);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;
    for (const series of indicatorSeriesRef.current) chartRef.current.removeSeries(series);
    indicatorSeriesRef.current = [];
    const source = visible.length ? visible : [];
    if (!source.length) return;
    const closeValues = source.map((candle) => candle.close);
    const times = source.map((candle) => Math.floor(new Date(candle.timestamp).getTime() / 1000));
    const addLine = (values: Array<number | null>, color: string, title: string) => {
      const series = chartRef.current.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title });
      series.setData(values.flatMap((value, index) => value === null || !Number.isFinite(value) ? [] : [{ time: times[index], value }]));
      indicatorSeriesRef.current.push(series);
    };
    const ema = (period: number) => { const multiplier = 2 / (period + 1); let previous = closeValues[0]; return closeValues.map((value, index) => { previous = index === 0 ? value : (value - previous) * multiplier + previous; return index + 1 < period ? null : previous; }); };
    const vwap = closeValues.map((_, index) => { const slice = source.slice(0, index + 1); const volume = slice.reduce((sum, candle) => sum + Math.max(candle.volume, 1), 0); return slice.reduce((sum, candle) => sum + candle.close * Math.max(candle.volume, 1), 0) / volume; });
    const rollingHigh = closeValues.map((_, index) => index < 20 ? null : Math.max(...source.slice(index - 20, index).map((candle) => candle.high)));
    const rollingLow = closeValues.map((_, index) => index < 20 ? null : Math.min(...source.slice(index - 20, index).map((candle) => candle.low)));
    if (emaPeriod !== "off") addLine(ema(Number(emaPeriod)), "#eebd54", `EMA ${emaPeriod}`);
    if (strategy === "ema-cross") { addLine(ema(9), "#30d4ca", "EMA 9"); addLine(ema(21), "#b98bd4", "EMA 21"); }
    if (strategy === "vwap-reversion") addLine(vwap, "#5792ff", "VWAP");
    if (strategy === "breakout") { addLine(rollingHigh, "#fa6b78", "20-bar high"); addLine(rollingLow, "#22d59b", "20-bar low"); }
    if (strategy === "momentum") addLine(ema(14), "#30d4ca", "Momentum EMA");
    if (strategy === "technical-plan" && plan) { addLine(ema(9), "#30d4ca", "EMA 9"); addLine(ema(21), "#b98bd4", "EMA 21"); }
  }, [candles, timeframe, emaPeriod, strategy, options]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    for (const line of priceLinesRef.current) candleSeriesRef.current.removePriceLine(line);
    priceLinesRef.current = [];
    if (!plan || strategy !== "technical-plan") return;
    const levels = [{ price: plan.support, title: "Support", color: "#22d59b" }, { price: plan.resistance, title: "Resistance", color: "#fa6b78" }, { price: plan.entry, title: `Entry ${plan.side}`, color: "#30d4ca" }, { price: plan.target, title: "Target", color: "#5792ff" }, { price: plan.stop, title: "Stop loss", color: "#eebd54" }];
    if (!autoRiskReward) return;
    priceLinesRef.current = levels.map((level) => candleSeriesRef.current.createPriceLine({ price: level.price, color: level.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: level.title }));
  }, [plan, strategy, autoRiskReward]);

  useEffect(() => {
    if (!chartRef.current) return;
    for (const series of lineSeriesRef.current) chartRef.current.removeSeries(series);
    lineSeriesRef.current = trendLines.map(() => chartRef.current.addSeries(LineSeries, { color: "#eebd54", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }));
    trendLines.forEach((line, index) => lineSeriesRef.current[index].setData([line.start, line.end]));
  }, [trendLines]);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || !drawing) return;
    const chart = chartRef.current;
    const handleClick = (param: any) => {
      if (!param.point || !param.time) return;
      const price = candleSeriesRef.current.coordinateToPrice(param.point.y);
      if (price === null || price === undefined) return;
      const point = { time: Number(param.time), price: Number(price) };
      if (pendingPoint) { setTrendLines((lines) => [...lines, { start: pendingPoint, end: point }]); setPendingPoint(null); setDrawing(false); }
      else setPendingPoint(point);
    };
    chart.subscribeClick(handleClick);
    return () => chart.unsubscribeClick(handleClick);
  }, [drawing, pendingPoint]);

  return <div className="chart-shell"><div className="chart-controls"><span className="chart-hint">{loadingOlder ? "Loading earlier candles..." : drawing ? pendingPoint ? "Click the second point" : "Click the first point" : "Drag to pan; scroll or pinch to zoom"}</span><button onClick={() => { setPendingPoint(null); setDrawing(!drawing); }} className={drawing ? "chart-tool active" : "chart-tool"}>{drawing ? "Cancel draw" : "Draw trend"}</button><button onClick={() => chartRef.current?.timeScale().fitContent()} className="chart-tool">Fit</button><button onClick={() => setTrendLines([])} className="chart-tool">Clear lines</button><button onClick={() => setAutoRiskReward((value) => !value)} className={autoRiskReward ? "chart-tool active" : "chart-tool"}>{autoRiskReward ? "RR On" : "Auto RR"}</button></div>{plan && <div className={`technical-plan ${plan.side.includes("LONG") ? "long" : "short"}`}><b>{plan.side}</b><span className={plan.candleConfirmed ? (plan.candleSignal.includes("BULLISH") ? "gain" : "loss") : "warning"}>{plan.candle}: {plan.candleSignal}</span><span>EMA {plan.ema9 > plan.ema21 ? "bullish" : "bearish"}</span><span>Vol {plan.volumeRatio.toFixed(1)}x</span><span>Entry {money(plan.entry)}</span><span>SL {money(plan.stop)}</span><span>Target {money(plan.target)}</span><span>R:R {plan.riskRewardLabel}</span><span>Opt S/R {plan.optionSupport?.toLocaleString("en-IN") ?? "--"}/{plan.optionResistance?.toLocaleString("en-IN") ?? "--"}</span><span>CE {plan.callLtp !== undefined ? money(plan.callLtp) : "--"} PE {plan.putLtp !== undefined ? money(plan.putLtp) : "--"}</span></div>}<div ref={containerRef} className="plugin-chart" role="img" aria-label={`${quote?.symbol ?? "NIFTY"} ${timeframe} candlestick and volume chart`} /></div>;
}

export default function Home() {
  const [quotes, setQuotes] = useState<Quote[]>([]),
    [candles, setCandles] = useState<Record<string, Candle[]>>({}),
    [symbol, setSymbol] = useState("NIFTY"),
    [timeframe, setTimeframe] = useState<CandleInterval>("5m"),
    [emaPeriod, setEmaPeriod] = useState<EmaPeriod>("20"),
    [strategy, setStrategy] = useState<ChartStrategy>("none"),
    [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10)),
    [mode, setMode] = useState<Mode>("Paper"),
    [filter, setFilter] = useState("All"),
    [query, setQuery] = useState(""),
    [paused, setPaused] = useState(false),
    [killed, setKilled] = useState(false),
    [provider, setProvider] = useState<Provider>("groww"),
    [autoRiskReward, setAutoRiskReward] = useState(true),
    [loadingOlder, setLoadingOlder] = useState(false),
    [notice, setNotice] = useState("Loading market data..."),
    [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const olderHistoryRequests = useRef<Record<string, string>>({});
  const active = quotes.find((quote) => quote.symbol === symbol),
    options = useMemo(() => optionContext(), []),
    visibleSignals = useMemo(
      () => signals.filter((item) => filter === "All" || item[0] === filter),
      [filter],
    );
  const requestOlderHistory = useCallback(async () => {
    const history = candles[symbol] ?? [];
    if (loadingOlder || !history.length) return;
    const firstTimestamp = new Date(history[0].timestamp).getTime();
    if (!Number.isFinite(firstTimestamp)) return;
    const endDate = new Date(firstTimestamp - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const requestKey = `${provider}:${symbol}:${timeframe}`;
    if (olderHistoryRequests.current[requestKey] === endDate) return;
    olderHistoryRequests.current[requestKey] = endDate;
    setLoadingOlder(true);
    try {
      const response = await fetch(`/api/market-data/history?provider=${provider}&symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&period=week&date=${endDate}`, { cache: "no-store" });
      const data = await response.json();
      if (!Array.isArray(data.candles)) return;
      const older = data.candles.map((candle: Candle & { time?: number }) => ({ ...candle, timestamp: candle.time ? new Date(candle.time * 1000).toISOString() : String(candle.timestamp) }));
      setCandles((current) => {
        const combined = [...older, ...(current[symbol] ?? [])];
        const unique = new Map(combined.map((candle) => [candle.timestamp, candle]));
        return { ...current, [symbol]: [...unique.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()).slice(-10000) };
      });
      setNotice(data.source ?? "Earlier historical candles loaded");
    } catch {
      setNotice("Earlier historical candles unavailable");
    } finally {
      setLoadingOlder(false);
    }
  }, [candles, loadingOlder, provider, symbol, timeframe]);
  async function refresh() {
    try {
      const response = await fetch(
        `/api/market-data?provider=${provider}&symbols=NIFTY,BANKNIFTY,SENSEX,INDIA%20VIX`,
        { cache: "no-store" },
      );
      const data = await response.json();
      const today = new Date().toISOString().slice(0, 10);
      const isTodaySelection = selectedDate === today;
      setQuotes(data.quotes);
      setCandles((previous) => {
        const next = { ...previous };
        for (const quote of data.quotes as Quote[]) {
          const history = next[quote.symbol] ?? [];
          if (!isTodaySelection && history.length) {
            next[quote.symbol] = history;
            continue;
          }
          next[quote.symbol] = liveCandleFor(quote, history, timeframe, data.updatedAt).slice(-5000);
        }
        return next;
      });
      setUpdatedAt(new Date(data.updatedAt));
      setNotice(data.source ?? "Market data updated");
    } catch {
      setNotice("Market data unavailable");
    }
  }
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (!paused && !killed) refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [paused, killed, provider, timeframe, selectedDate]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market-data/history?provider=${provider}&symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&period=day&date=${selectedDate}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.candles)) return;
        setCandles((current) => ({ ...current, [symbol]: data.candles.map((candle: Candle & { time?: number }) => ({ ...candle, timestamp: candle.time ? new Date(candle.time * 1000).toISOString() : String(candle.timestamp) })) }));
        setNotice(data.source ?? "Historical candles loaded");
      })
      .catch(() => { if (!cancelled) setNotice("Historical candles unavailable; live candles are still updating."); });
    return () => { cancelled = true; };
  }, [provider, symbol, timeframe, selectedDate]);
  function navigate(item: string) {
    const routes: Record<string, string> = {
      "Live Signals": "/signals",
      "Strategy Builder": "/strategies/builder",
      Backtesting: "/validation",
      "Paper Trading": "/validation",
      "Algo Trading": "/execution",
      "AI Insights": "/intelligence",
      "Broker Connections": "/execution",
      Analytics: "/operations",
      "Trade Journal": "/operations",
    };
    if (routes[item]) window.location.href = routes[item];
    else setNotice(`${item} controls are available in this local preview.`);
  }
  function chooseMode(next: Mode) {
    setMode(next);
    if (next !== "Paper")
      setNotice(`${next} requires broker health and compliance approval; no live order was sent.`);
  }
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">↗</span>
          <div>
            <strong>TradePulse AI</strong>
            <small>Smart Trading. Smarter You.</small>
          </div>
        </div>
        <nav>
          <div className="nav-group">Workspace</div>
          {nav.map((item, index) => (
            <button
              className={`nav-link ${index === 0 ? "active" : ""}`}
              onClick={() => navigate(item)}
              key={item}
            >
              <span className="nav-icon">
                {["◈", "⌁", "◒", "◇", "⌘", "↗", "▣", "◎", "◌", "◌", "◌", "⚙", "⚙"][index]}
              </span>
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" /> {killed ? "Kill switch active" : "Market data monitored"}
          <span className="version">v0.2 live-data preview</span>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && query.trim()) {
                  setSymbol(query.trim().toUpperCase());
                  setNotice(
                    `Selected ${query.trim().toUpperCase()}; provider route supports configured indices.`,
                  );
                }
              }}
              aria-label="Search markets"
              placeholder="Search symbol, strategy or anything..."
            />
          </div>
          <div className="top-actions">
            <label className="provider-control">
              Data source
              <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)} aria-label="Market data provider">
                <option value="groww">Groww live</option>
                <option value="yahoo">Yahoo Finance</option>
                <option value="fallback">Fallback fixture</option>
              </select>
            </label>
            <span className="market-clock">
              NSE <b>{updatedAt?.toLocaleTimeString("en-IN") ?? "--:--:--"}</b>
            </span>
            <button
              className="icon-button"
              onClick={() => setNotice("Notifications: delayed quote refresh completed.")}
              aria-label="Notifications"
            >
              ◌<i />
            </button>
            <button
              className="avatar"
              onClick={() => setNotice("Profile controls are local-preview only.")}
              aria-label="Profile"
            >
              DV
            </button>
            <span className="profile-name">
              Dheeraj
              <br />
              <small>Pro trader</small>
            </span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">01 / MARKET OVERVIEW</span>
              <h1>Dashboard</h1>
            </div>
            <div className="session-state">
              <span className="status-dot" /> {killed ? "Safe state" : provider === "groww" ? "Groww live data" : provider === "yahoo" ? "Yahoo Finance" : "Fallback data"}{" "}
              <b>Live updates every 5s</b>
            </div>
          </div>
          <div className="notice-bar" role="status">
            {notice} {updatedAt ? `Last update ${updatedAt.toLocaleTimeString("en-IN")}` : ""}
          </div>
          <div className="strategy-summary">
            <div>
              <span className="panel-kicker">NIFTY OPTIONS STRATEGY · V5</span>
              <h3>Opening Range Breakout with retest confirmation and VWAP / OI support</h3>
            </div>
            <div className="strategy-badges">
              <span><small>Setup</small><b>ORB + Retest</b></span>
              <span><small>Regime</small><b>Trending</b></span>
              <span><small>Confirmation</small><b>VWAP + OI</b></span>
              <span><small>Exposure</small><b>1x • 25 qty</b></span>
            </div>
          </div>
          <section className="index-strip">
            {symbols.map((name) => {
              const quote = quotes.find((item) => item.symbol === name);
              return (
                <button
                  className={`index-card ${symbol === name ? "selected-card" : ""}`}
                  onClick={() => setSymbol(name)}
                  key={name}
                >
                  <div className="index-card-head">
                    <span>{name}</span>
                    <Sparkline quote={quote} />
                  </div>
                  <strong>{quote ? money(quote.price) : "Loading..."}</strong>
                  <div
                    className={`index-change ${(quote?.change ?? 0) >= 0 ? "positive" : "negative"}`}
                  >
                    <span>
                      {quote ? `${quote.change >= 0 ? "+" : ""}${money(quote.change)}` : "--"}
                    </span>
                    <span>
                      (
                      {quote
                        ? `${quote.percent >= 0 ? "+" : ""}${quote.percent.toFixed(2)}%`
                        : "--"}
                      )
                    </span>
                  </div>
                </button>
              );
            })}
          </section>
          <section className="dashboard-grid">
            <article className="panel chart-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">LIVE MARKET · DELAYED</span>
                  <h2>
                    {symbol} <span className="exchange">NSE</span>
                  </h2>
                </div>
                <div className="panel-actions">
                  {(["Paper", "Assisted", "Algo Live"] as Mode[]).map((item) => (
                    <button
                      key={item}
                      onClick={() => chooseMode(item)}
                      className={`mode-chip ${mode === item ? "selected" : ""}`}
                    >
                      {item}
                    </button>
                  ))}
                  <span className={killed ? "connected negative" : "connected"}>
                    <i /> {killed ? "Blocked" : "Connected"}
                  </span>
                </div>
              </div>
              <div className="chart-toolbar">
                <b>{active ? money(active.price) : "--"}</b>
                <span className={(active?.change ?? 0) >= 0 ? "positive" : "negative"}>
                  {active
                    ? `${active.change >= 0 ? "+" : ""}${money(active.change)} (${active.percent.toFixed(2)}%)`
                    : "Loading"}
                </span>
                    <span className="chart-tabs">
                      <span className="history-status">History</span>
                      <input className="chart-date" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} aria-label="Historical candle date" />
                      <label className="candle-select">Candle<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as CandleInterval)} aria-label="Candle interval"><option value="1m">1 min</option><option value="3m">3 min</option><option value="5m">5 min</option><option value="10m">10 min</option><option value="15m">15 min</option><option value="1h">1 hr</option><option value="4h">4 hr</option><option value="1W">1 week</option><option value="1D">1 day</option><option value="1M">1 month</option></select></label>
                      <label className="candle-select">EMA<select value={emaPeriod} onChange={(event) => setEmaPeriod(event.target.value as EmaPeriod)} aria-label="EMA indicator"><option value="off">Off</option><option value="9">EMA 9</option><option value="20">EMA 20</option><option value="50">EMA 50</option><option value="100">EMA 100</option><option value="200">EMA 200</option></select></label>
                      <label className="candle-select">Strategy<select value={strategy} onChange={(event) => setStrategy(event.target.value as ChartStrategy)} aria-label="Chart strategy"><option value="none">None</option><option value="technical-plan">Technical plan</option><option value="ema-cross">EMA crossover</option><option value="vwap-reversion">VWAP reversion</option><option value="breakout">20-bar breakout</option><option value="momentum">Momentum</option></select></label>
                </span>
              </div>
              <PriceChart quote={active} candles={candles[symbol] ?? []} timeframe={timeframe} emaPeriod={emaPeriod} strategy={strategy} options={options} autoRiskReward={autoRiskReward} setAutoRiskReward={setAutoRiskReward} loadingOlder={loadingOlder} onRequestOlderHistory={requestOlderHistory} />
              <div className="chart-legend">
                <span>
                  <i className="legend-vwap" /> VWAP
                </span>
                <span>
                  <i className="legend-ema" /> Volume / activity
                </span>
                <span className="live-badge">
                  <i /> {active?.source ?? "Waiting"}
                </span>
              </div>
            </article>
            <article className="panel signal-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">DECISION SUPPORT</span>
                  <h2>Live Signals</h2>
                </div>
                <button className="link-button" onClick={() => navigate("Live Signals")}>
                  View all →
                </button>
              </div>
              <div className="filter-row">
                {["All", "NIFTY", "BANKNIFTY", "SENSEX"].map((item) => (
                  <button
                    onClick={() => setFilter(item)}
                    className={`filter ${filter === item ? "active" : ""}`}
                    key={item}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <div className="signals">
                {visibleSignals.map((item) => (
                  <div className="signal-row" key={item[0] + item[1]}>
                    <div className="signal-main">
                      <div>
                        <strong>{item[0]}</strong>
                        <span>{item[1]}</span>
                      </div>
                      <span className={`side ${item[2] === "BUY" ? "buy" : "sell"}`}>
                        {item[2]}
                      </span>
                    </div>
                    <div className="signal-details">
                      <span>
                        <small>Entry</small>
                        {item[3]}
                      </span>
                      <span>
                        <small>Target</small>
                        {item[4]}
                      </span>
                      <span>
                        <small>R:R</small>
                        <b>{item[5]}</b>
                      </span>
                      <span>
                        <small>Confidence</small>
                        <b className="positive">{item[6]}</b>
                      </span>
                    </div>
                    <div className="signal-reason">
                      {item[7]}
                      <button
                        className="signal-state"
                        onClick={() =>
                          setNotice(
                            `${item[0]} ${item[1]} inspected in paper mode; risk gate required.`,
                          )
                        }
                      >
                        Inspect
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
            <article className="panel brain-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">CONTEXT ENGINE</span>
                  <h2>AI Market Brain</h2>
                </div>
                <span className="live-badge">
                  <i /> Active
                </span>
              </div>
              <div className="brain-regime">
                <span>GLOBAL SENTIMENT</span>
                <strong>
                  BEARISH <em>78</em>
                </strong>
              </div>
              <div className="sentiment-list">
                <span>
                  US <b className="negative">Bearish</b>
                </span>
                <span>
                  China <b className="neutral">Neutral</b>
                </span>
                <span>
                  Japan <b className="positive">Bullish</b>
                </span>
                <span>
                  Crude <b className="warning">High Risk</b>
                </span>
                <span>
                  USD/INR <b className="negative">Negative</b>
                </span>
                <span>
                  Fed <b className="warning">Hawkish</b>
                </span>
              </div>
              <div className="brain-divider" />
              <div className="brain-regime">
                <span>NIFTY REGIME</span>
                <strong className="negative">BEARISH</strong>
              </div>
              <div className="score-grid">
                <span>
                  News Impact <b>81/100</b>
                </span>
                <span>
                  Price Action <b>78/100</b>
                </span>
                <span>
                  Options / OI <b>84/100</b>
                </span>
                <span>
                  VWAP <b>91/100</b>
                </span>
              </div>
              <div className="composite">
                <span>Composite score</span>
                <strong>84</strong>
              </div>
              <div className="blocker">
                <span>Trade blocker</span>
                <b>No trade if NIFTY reclaims VWAP</b>
              </div>
            </article>
            <article className="panel options-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">DERIVATIVES · DEMO FEED</span>
                  <h2>Options Chain</h2>
                </div>
                <button
                  className="link-button"
                  onClick={() =>
                    setNotice(
                      "Options chain needs an authorized options-data provider; demo rows are clearly labelled.",
                    )
                  }
                >
                  Full chain →
                </button>
              </div>
              <div className="chain-toolbar">
                <button className="filter active">{symbol}</button>
                <span>Expiry</span>
                <b>Nearest available</b>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>CE OI</th>
                    <th>CE OI Chg</th>
                    <th>CE LTP</th>
                    <th>Strike</th>
                    <th>PE LTP</th>
                    <th>PE OI Chg</th>
                    <th>PE OI</th>
                  </tr>
                </thead>
                <tbody>
                  {optionRows.map((row) => (
                    <tr key={row[0]}>
                      {row.map((cell, index) => (
                        <td
                          className={
                            index === 1 || index === 2
                              ? "positive"
                              : index === 5
                                ? "negative"
                                : index === 0
                                  ? "strike"
                                  : ""
                          }
                          key={`${row[0]}-${index}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
            <article className="panel risk-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">CONTROL CENTER</span>
                  <h2>Risk &amp; Execution</h2>
                </div>
                <span className="safe-badge">
                  <i /> {killed ? "Kill switch" : paused ? "Paused" : "Safe"}
                </span>
              </div>
              <div className="risk-summary">
                <div>
                  <span>Daily P&amp;L</span>
                  <strong className="positive">+₹3,820</strong>
                  <small>Paper preview</small>
                </div>
                <div>
                  <span>Risk used</span>
                  <strong>0.8%</strong>
                  <small>of 3.0% limit</small>
                </div>
                <div>
                  <span>Open positions</span>
                  <strong>
                    1 <small>/ 2</small>
                  </strong>
                  <small>Within limit</small>
                </div>
              </div>
              <div className="risk-meter">
                <div>
                  <span>Daily loss limit</span>
                  <b>12.7% used</b>
                </div>
                <div className="meter">
                  <i />
                </div>
                <small>Paper account · no live orders</small>
              </div>
              <div className="control-actions">
                <button
                  className="outline-button"
                  onClick={() => {
                    setPaused(!paused);
                    setNotice(paused ? "Market refresh resumed." : "Market refresh paused.");
                  }}
                >
                  {paused ? "Resume feed" : "Pause feed"}
                </button>
                <button
                  className="danger-button"
                  onClick={() => {
                    setKilled(true);
                    setPaused(true);
                    setNotice("Kill switch active: new orders blocked.");
                  }}
                >
                  Kill switch
                </button>
              </div>
            </article>
            <article className="panel news-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">MARKET CONTEXT · DEMO FEED</span>
                  <h2>News Pulse</h2>
                </div>
                <span className="time-label">Context only</span>
              </div>
              {[
                "Global markets weigh central bank signals",
                "India manufacturing PMI beats estimates",
                "IT sector sees steady foreign inflows",
              ].map((headline, index) => (
                <button
                  className="news-item news-button"
                  onClick={() => setNotice(`News context selected: ${headline}`)}
                  key={headline}
                >
                  <span
                    className={`news-impact ${index === 0 ? "high" : index === 1 ? "medium" : "low"}`}
                  >
                    {index === 0 ? "HIGH" : index === 1 ? "MED" : "LOW"}
                  </span>
                  <div>
                    <strong>{headline}</strong>
                    <small>Context feed · select for details</small>
                  </div>
                  <b className={index === 0 ? "negative" : index === 1 ? "positive" : "neutral"}>
                    {index === 0 ? "Bearish" : index === 1 ? "Bullish" : "Neutral"}
                  </b>
                </button>
              ))}
            </article>
          </section>
          <footer className="footer">
            <span>
              TradePulse AI <b>•</b> Decision support, not financial advice
            </span>
            <span>
              Data source <b>{active?.source ?? "Loading"}</b> <i className="status-dot" />
            </span>
          </footer>
        </div>
      </section>
    </main>
  );
}
