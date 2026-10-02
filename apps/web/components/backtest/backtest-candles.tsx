"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade } from "../../../../services/backtest/src/strategy-backtest";

/** [epoch seconds, open, high, low, close, volume] — 1-minute bars as returned by /api/backtest. */
export type CandleRow = [number, number, number, number, number, number];
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

const IST_S = 330 * 60;
const SESSION_OPEN_S = (9 * 60 + 15) * 60;
const TIMEFRAMES = [1, 3, 5, 15, 60] as const;
type Timeframe = (typeof TIMEFRAMES)[number];
const tfLabel = (tf: Timeframe) => (tf === 60 ? "1H" : `${tf}m`);

const UP = "#22d59b";
const DOWN = "#fa6b78";
const GAIN = "#3d93d6";
const LOSS = "#d6743c";
const EMA_COLOR = "#eebd54";
const VWAP_COLOR = "#b493f5";
const ENTRY_COLOR = "#e4f1f1";

const istDay = (epochS: number) => new Date((epochS + IST_S) * 1000).toISOString().slice(0, 10);
/** Buckets align to the 09:15 IST session open, so 15m and 1H bars match what brokers show. */
function bucketOf(epochS: number, tf: Timeframe) {
  const open = Math.floor((epochS + IST_S) / 86_400) * 86_400 - IST_S + SESSION_OPEN_S;
  return open + Math.floor((epochS - open) / (tf * 60)) * tf * 60;
}
/** lightweight-charts renders timestamps as UTC; shift by +05:30 so the axis reads IST. */
const chartTime = (epochS: number) => (epochS + IST_S) as UTCTimestamp;

function aggregate(rows: CandleRow[], tf: Timeframe): Bar[] {
  const bars: Bar[] = [];
  for (const [time, open, high, low, close, volume] of rows) {
    const bucket = tf === 1 ? time : bucketOf(time, tf);
    const last = bars.at(-1);
    if (last && last.time === bucket) { last.high = Math.max(last.high, high); last.low = Math.min(last.low, low); last.close = close; last.volume += volume; }
    else bars.push({ time: bucket, open, high, low, close, volume });
  }
  return bars;
}

function ema(bars: Bar[], period: number) {
  const k = 2 / (period + 1);
  let value = bars[0]?.close ?? 0;
  return bars.map((bar, index) => { value = index === 0 ? bar.close : (bar.close - value) * k + value; return value; });
}

/** Session-anchored VWAP; falls back to an equal-weight average when the feed has no volume. */
function vwap(bars: Bar[]) {
  let day = ""; let pv = 0; let v = 0; let sum = 0; let n = 0;
  return bars.map((bar) => {
    const d = istDay(bar.time);
    if (d !== day) { day = d; pv = 0; v = 0; sum = 0; n = 0; }
    const typical = (bar.high + bar.low + bar.close) / 3;
    pv += typical * bar.volume; v += bar.volume; sum += typical; n += 1;
    return v > 0 ? pv / v : sum / n;
  });
}

const fmt = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (epochS: number) => new Date(epochS * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });
const dayName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const signedR = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}R`;
const inr = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const LEG_LABEL: Record<string, string> = { TARGET_1: "T1", TARGET_2: "T2", STOP_LOSS: "SL", BREAKEVEN_STOP: "BE", TIME_STOP: "Time", SQUARE_OFF: "Sq-off", SESSION_END: "EOD", DATA_END: "End" };
const legReason = (reason: string) => LEG_LABEL[reason] ?? reason;
/** Exit legs are stamped at the END of the 1-minute bar that filled them; markers go on that bar. */
const fillBar = (exitEpochS: number) => exitEpochS - 60;

type Legend = { bar: Bar; ema?: number; vwap?: number };

export function BacktestCandles({ symbol, candles, trades, focusId, onFocus }: { symbol: string; candles: CandleRow[]; trades: BacktestTrade[]; focusId: number | null; onFocus: (id: number | null) => void }) {
  const [tf, setTf] = useState<Timeframe>(5);
  const [showEma, setShowEma] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [legend, setLegend] = useState<Legend | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);

  const bars = useMemo(() => aggregate(candles, tf), [candles, tf]);
  const emaValues = useMemo(() => ema(bars, 20), [bars]);
  const vwapValues = useMemo(() => vwap(bars), [bars]);
  const hasVolume = useMemo(() => candles.some((row) => row[5] > 0), [candles]);
  const days = useMemo(() => [...new Set(bars.map((bar) => istDay(bar.time)))], [bars]);
  const indexByTime = useMemo(() => new Map(bars.map((bar, index) => [bar.time, index])), [bars]);
  const sorted = useMemo(() => [...trades].sort((a, b) => a.entryTime - b.entryTime), [trades]);
  const focused = sorted.find((trade) => trade.id === focusId) ?? null;
  const focusIndex = focused ? sorted.indexOf(focused) : -1;
  const lookup = useRef({ bars, emaValues, vwapValues, indexByTime });
  lookup.current = { bars, emaValues, vwapValues, indexByTime };

  // Create the chart once (re-created only if the feed gains/loses volume, which adds a pane).
  useEffect(() => {
    if (!host.current) return;
    const instance = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#081c24" }, textColor: "#8eadb2", fontFamily: "'DM Mono', monospace", fontSize: 11, panes: { separatorColor: "#173944", separatorHoverColor: "rgba(48,212,202,.25)" } },
      grid: { vertLines: { color: "rgba(65,116,125,.10)" }, horzLines: { color: "rgba(65,116,125,.14)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#4f7d86", labelBackgroundColor: "#173944" }, horzLine: { color: "#4f7d86", labelBackgroundColor: "#173944" } },
      rightPriceScale: { borderColor: "#173944", scaleMargins: { top: 0.12, bottom: 0.06 } },
      timeScale: { borderColor: "#173944", timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7 },
      localization: { locale: "en-IN" },
    });
    candleSeries.current = instance.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceLineColor: "#4f7d86", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    emaSeries.current = instance.addSeries(LineSeries, { color: EMA_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    vwapSeries.current = instance.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    volumeSeries.current = hasVolume ? instance.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1) : null;
    if (hasVolume) instance.panes()[1]?.setHeight(84);
    markers.current = createSeriesMarkers(candleSeries.current, [], { zOrder: "top" });
    const onMove = (param: MouseEventParams<Time>) => {
      const { bars: list, emaValues: e, vwapValues: v, indexByTime: map } = lookup.current;
      const index = param.time === undefined ? list.length - 1 : map.get((param.time as number) - IST_S);
      if (index === undefined || !list[index]) return;
      setLegend({ bar: list[index], ema: e[index], vwap: v[index] });
    };
    instance.subscribeCrosshairMove(onMove);
    chart.current = instance;
    return () => { instance.unsubscribeCrosshairMove(onMove); instance.remove(); chart.current = null; candleSeries.current = null; volumeSeries.current = null; emaSeries.current = null; vwapSeries.current = null; markers.current = null; priceLines.current = []; };
  }, [hasVolume]);

  // Price, volume and indicator data.
  useEffect(() => {
    if (!candleSeries.current) return;
    candleSeries.current.setData(bars.map((bar) => ({ time: chartTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    volumeSeries.current?.setData(bars.map((bar) => ({ time: chartTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? "rgba(34,213,155,.45)" : "rgba(250,107,120,.45)" })));
    emaSeries.current?.setData(bars.map((bar, index) => ({ time: chartTime(bar.time), value: emaValues[index] })));
    vwapSeries.current?.setData(bars.map((bar, index) => ({ time: chartTime(bar.time), value: vwapValues[index] })));
    if (bars.length) setLegend({ bar: bars.at(-1)!, ema: emaValues.at(-1), vwap: vwapValues.at(-1) });
  }, [bars, emaValues, vwapValues, hasVolume]);

  useEffect(() => { emaSeries.current?.applyOptions({ visible: showEma }); }, [showEma, hasVolume]);
  useEffect(() => { vwapSeries.current?.applyOptions({ visible: showVwap }); }, [showVwap, hasVolume]);

  // Entry arrows and exit dots at the exact fill prices.
  useEffect(() => {
    if (!markers.current) return;
    if (!showTrades) { markers.current.setMarkers([]); return; }
    const list: SeriesMarker<Time>[] = [];
    for (const trade of sorted) {
      const long = trade.side === "LONG";
      const selected = trade.id === focusId;
      list.push({ time: chartTime(bucketOf(trade.entryTime, tf)), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: ENTRY_COLOR, text: `#${trade.id} ${long ? "BUY" : "SELL"}`, size: selected ? 1.3 : 1 });
      trade.legs.forEach((leg, index) => {
        const last = index === trade.legs.length - 1;
        const won = long ? leg.price >= trade.entryPrice : leg.price <= trade.entryPrice;
        list.push({ time: chartTime(bucketOf(fillBar(leg.time), tf)), position: "atPriceMiddle", price: leg.price, shape: "circle", color: won ? GAIN : LOSS, text: last ? `${legReason(leg.reason)} ${signedR(trade.rMultiple)}` : legReason(leg.reason), size: selected ? 1.1 : 0.8 });
      });
    }
    markers.current.setMarkers(list.sort((a, b) => (a.time as number) - (b.time as number)));
  }, [sorted, tf, showTrades, focusId, hasVolume]);

  // Plan lines for the focused trade, and zoom to it.
  useEffect(() => {
    const series = candleSeries.current;
    if (!series || !chart.current) return;
    for (const line of priceLines.current) series.removePriceLine(line);
    priceLines.current = [];
    if (!focused) return;
    const add = (price: number, title: string, color: string, style: LineStyle) => priceLines.current.push(series.createPriceLine({ price, title, color, lineStyle: style, lineWidth: 1, axisLabelVisible: true }));
    add(focused.entryPrice, `#${focused.id} entry`, ENTRY_COLOR, LineStyle.Solid);
    add(focused.stop, "stop", LOSS, LineStyle.Dashed);
    add(focused.target1, "T1", GAIN, LineStyle.Dashed);
    if (focused.target2 && focused.target2 !== focused.target1) add(focused.target2, "T2", GAIN, LineStyle.Dotted);
    const from = indexByTime.get(bucketOf(focused.entryTime, tf));
    const to = indexByTime.get(bucketOf(fillBar(focused.exitTime), tf));
    if (from !== undefined && to !== undefined) {
      const pad = Math.max(20, Math.round((to - from) * 1.5));
      chart.current.timeScale().setVisibleLogicalRange({ from: from - pad, to: to + pad });
    }
  }, [focused, tf, indexByTime, hasVolume]);

  // Without a focused trade, open on the most recent session.
  useEffect(() => { if (focusId === null) showDay(days.at(-1)); }, [bars, hasVolume]);

  function showDay(day: string | undefined) {
    if (!day || !chart.current) return;
    const first = bars.findIndex((bar) => istDay(bar.time) === day);
    if (first < 0) return;
    let last = first;
    while (last + 1 < bars.length && istDay(bars[last + 1].time) === day) last += 1;
    chart.current.timeScale().setVisibleLogicalRange({ from: first - 2, to: last + 6 });
  }

  const step = (direction: 1 | -1) => {
    if (!sorted.length) return;
    const next = focusIndex < 0 ? (direction > 0 ? 0 : sorted.length - 1) : Math.min(sorted.length - 1, Math.max(0, focusIndex + direction));
    onFocus(sorted[next].id);
  };
  const toggleFullscreen = () => {
    if (!wrap.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current.requestFullscreen?.();
  };

  const change = legend ? legend.bar.close - legend.bar.open : 0;
  const changePct = legend && legend.bar.open ? (change / legend.bar.open) * 100 : 0;

  return (
    <div className="bt-candles" ref={wrap}>
      <div className="bt-candles-toolbar" role="toolbar" aria-label="Chart controls">
        <div className="bt-seg" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((value) => <button key={value} type="button" className={tf === value ? "on" : ""} aria-pressed={tf === value} onClick={() => setTf(value)}>{tfLabel(value)}</button>)}
        </div>
        <div className="bt-seg" role="group" aria-label="Overlays">
          <button type="button" className={showEma ? "on" : ""} aria-pressed={showEma} onClick={() => setShowEma(!showEma)}><i style={{ background: EMA_COLOR }} />EMA 20</button>
          <button type="button" className={showVwap ? "on" : ""} aria-pressed={showVwap} onClick={() => setShowVwap(!showVwap)}><i className="dashed" style={{ borderColor: VWAP_COLOR }} />VWAP</button>
          <button type="button" className={showTrades ? "on" : ""} aria-pressed={showTrades} onClick={() => setShowTrades(!showTrades)}>Trades</button>
        </div>
        <select className="bt-candles-day" aria-label="Jump to session" value="" onChange={(event) => { onFocus(null); showDay(event.target.value); }}>
          <option value="" disabled>Jump to session…</option>
          {days.map((day) => <option key={day} value={day}>{dayName(day)}</option>)}
        </select>
        <div className="bt-seg bt-seg-nav" role="group" aria-label="Trade navigation">
          <button type="button" onClick={() => step(-1)} disabled={!sorted.length || focusIndex === 0} aria-label="Previous trade">‹</button>
          <span>{focused ? `Trade ${focusIndex + 1}/${sorted.length}` : `${sorted.length} trades`}</span>
          <button type="button" onClick={() => step(1)} disabled={!sorted.length || focusIndex === sorted.length - 1} aria-label="Next trade">›</button>
        </div>
        <div className="bt-seg">
          <button type="button" onClick={() => { onFocus(null); chart.current?.timeScale().fitContent(); }}>Fit all</button>
          <button type="button" onClick={toggleFullscreen} aria-label="Full screen">⛶</button>
        </div>
      </div>

      <div className="bt-candles-stage">
        {legend ? (
          <div className="bt-ohlc" aria-live="off">
            <strong>{symbol} · {tfLabel(tf)}</strong>
            <span className="opt">{dayName(istDay(legend.bar.time))}</span> <span>{clock(legend.bar.time)}</span>
            <span>O <b>{fmt(legend.bar.open)}</b></span><span>H <b>{fmt(legend.bar.high)}</b></span><span>L <b>{fmt(legend.bar.low)}</b></span><span>C <b>{fmt(legend.bar.close)}</b></span>
            <span className={change >= 0 ? "up" : "down"}>{change >= 0 ? "+" : "−"}{fmt(Math.abs(change))} ({change >= 0 ? "+" : "−"}{Math.abs(changePct).toFixed(2)}%)</span>
            {hasVolume ? <span className="opt">Vol <b>{legend.bar.volume.toLocaleString("en-IN")}</b></span> : null}
            {showEma && legend.ema !== undefined ? <span className="opt" style={{ color: EMA_COLOR }}>EMA20 {fmt(legend.ema)}</span> : null}
            {showVwap && legend.vwap !== undefined ? <span className="opt" style={{ color: VWAP_COLOR }}>VWAP {fmt(legend.vwap)}</span> : null}
          </div>
        ) : null}
        <div ref={host} className="bt-candles-canvas" />
      </div>

      {focused ? (
        <div className="bt-candles-trade">
          <span className={`bt-side ${focused.side === "LONG" ? "long" : "short"}`}>{focused.side === "LONG" ? "▲ CE" : "▼ PE"}</span>
          <strong>#{focused.id} · {dayName(focused.day)} · {clock(focused.entryTime)} → {clock(focused.exitTime)}</strong>
          <span>entry <b>{fmt(focused.entryPrice)}</b></span><span>stop <b>{fmt(focused.stop)}</b></span><span>T1 <b>{fmt(focused.target1)}</b></span>
          <span>exit <b>{fmt(focused.exitPrice)}</b></span><span><b>{signedR(focused.rMultiple)}</b> · <b>{inr(focused.pnl)}</b></span>
          <button type="button" className="bt-link" onClick={() => onFocus(null)}>Clear</button>
          <p>{focused.reason}</p>
        </div>
      ) : (
        <p className="bt-candles-hint">Arrows mark entries; dots mark exits at the fill price (blue = profit, orange = loss). Use ‹ › to step through trades, or click a trade in the log. Times are IST.</p>
      )}
    </div>
  );
}
