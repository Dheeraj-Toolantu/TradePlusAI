"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade, TradeLeg } from "../../../../services/backtest/src/strategy-backtest";
import { RiskRewardPrimitive, type RiskRewardBox } from "./risk-reward-primitive";

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
    const bucket = bucketOf(time, tf);
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
const LEG_LABEL: Record<string, string> = { TARGET_1: "T1", TARGET_2: "T2", STOP_LOSS: "SL", BREAKEVEN_STOP: "BE", TRAIL_STOP: "Trail", TIME_STOP: "Time", SQUARE_OFF: "Sq-off", SESSION_END: "EOD", DATA_END: "End" };
const legReason = (reason: string) => LEG_LABEL[reason] ?? reason;
/** Exit legs are stamped at the END of the 1-minute bar that filled them; markers go on that bar. */
const fillBar = (exitEpochS: number) => exitEpochS - 60;

type Legend = { bar: Bar; ema?: number; vwap?: number };
/** Replay of one session: `cursor` is the number of base candles of that day already printed. */
type Replay = { day: string; cursor: number; playing: boolean; speed: number };
const SPEEDS = [1, 3, 10, 30, 60];
/** A trade as far as it has happened by `cutoff` (replay): only the legs already filled. */
type VisibleTrade = BacktestTrade & { visibleLegs: TradeLeg[]; open: boolean };

export function BacktestCandles({ symbol, candles, candleMinutes = 1, replayMinutes = null, trades, focusId, onFocus }: { symbol: string; candles: CandleRow[]; candleMinutes?: number; replayMinutes?: Record<string, CandleRow[]> | null; trades: BacktestTrade[]; focusId: number | null; onFocus: (id: number | null) => void }) {
  const [tf, setTf] = useState<Timeframe>(5);
  const [showEma, setShowEma] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayPick, setReplayPick] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const boxes = useRef<RiskRewardPrimitive | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);

  // Replay: the previous session for context plus the replayed day, printed up to the cursor.
  const allDays = useMemo(() => [...new Set(candles.map((row) => istDay(row[0])))], [candles]);
  const replayDay = replay?.day ?? null;
  const replayRows = useMemo(() => {
    if (!replayDay) return null;
    const index = allDays.indexOf(replayDay);
    const previous = candles.filter((row) => istDay(row[0]) === allDays[index - 1]);
    // Minute-level replay when the day's 1-minute candles were shipped (long ranges send 5m charts).
    const today = replayMinutes?.[replayDay] ?? candles.filter((row) => istDay(row[0]) === replayDay);
    return [...previous, ...today];
  }, [replayDay, allDays, candles, replayMinutes]);
  const baseMinutes = replayDay && replayMinutes?.[replayDay] ? 1 : candleMinutes;
  const timeframes = TIMEFRAMES.filter((value) => value >= baseMinutes);
  const replayStart = useMemo(() => (replayRows && replayDay ? replayRows.findIndex((row) => istDay(row[0]) === replayDay) : 0), [replayRows, replayDay]);
  const replayLength = replayRows ? replayRows.length - replayStart : 0;
  const replayCursor = replay?.cursor ?? 0;
  const visibleRows = useMemo(() => (replayRows ? replayRows.slice(0, replayStart + Math.max(1, replayCursor)) : candles), [replayRows, replayStart, replayCursor, candles]);
  const cutoff = replayRows ? visibleRows.at(-1)![0] + baseMinutes * 60 : Infinity;

  const bars = useMemo(() => aggregate(visibleRows, tf), [visibleRows, tf]);
  const emaValues = useMemo(() => ema(bars, 20), [bars]);
  const vwapValues = useMemo(() => vwap(bars), [bars]);
  const hasVolume = useMemo(() => candles.some((row) => row[5] > 0), [candles]);
  const days = useMemo(() => [...new Set(bars.map((bar) => istDay(bar.time)))], [bars]);
  const indexByTime = useMemo(() => new Map(bars.map((bar, index) => [bar.time, index])), [bars]);
  const sorted = useMemo(() => [...trades].sort((a, b) => a.entryTime - b.entryTime), [trades]);
  const visibleTrades = useMemo<VisibleTrade[]>(() => sorted
    .filter((trade) => trade.entryTime < cutoff)
    .map((trade) => {
      const visibleLegs = trade.legs.filter((leg) => leg.time <= cutoff);
      return { ...trade, visibleLegs, open: visibleLegs.reduce((sum, leg) => sum + leg.fraction, 0) < 0.999 };
    }), [sorted, cutoff]);
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
    boxes.current = new RiskRewardPrimitive();
    candleSeries.current.attachPrimitive(boxes.current);
    const onMove = (param: MouseEventParams<Time>) => {
      const { bars: list, emaValues: e, vwapValues: v, indexByTime: map } = lookup.current;
      const index = param.time === undefined ? list.length - 1 : map.get((param.time as number) - IST_S);
      if (index === undefined || !list[index]) return;
      setLegend({ bar: list[index], ema: e[index], vwap: v[index] });
    };
    instance.subscribeCrosshairMove(onMove);
    chart.current = instance;
    return () => { instance.unsubscribeCrosshairMove(onMove); instance.remove(); chart.current = null; candleSeries.current = null; volumeSeries.current = null; emaSeries.current = null; vwapSeries.current = null; markers.current = null; boxes.current = null; priceLines.current = []; };
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
    for (const trade of visibleTrades) {
      const long = trade.side === "LONG";
      const selected = trade.id === focusId;
      list.push({ time: chartTime(bucketOf(trade.entryTime, tf)), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: ENTRY_COLOR, text: `#${trade.id} ${long ? "BUY" : "SELL"}`, size: selected ? 1.3 : 1 });
      trade.visibleLegs.forEach((leg, index) => {
        const last = !trade.open && index === trade.visibleLegs.length - 1;
        const won = long ? leg.price >= trade.entryPrice : leg.price <= trade.entryPrice;
        list.push({ time: chartTime(bucketOf(fillBar(leg.time), tf)), position: "atPriceMiddle", price: leg.price, shape: "circle", color: won ? GAIN : LOSS, text: last ? `${legReason(leg.reason)} ${signedR(trade.rMultiple)}` : legReason(leg.reason), size: selected ? 1.1 : 0.8 });
      });
    }
    markers.current.setMarkers(list.sort((a, b) => (a.time as number) - (b.time as number)));
  }, [visibleTrades, tf, showTrades, focusId, hasVolume]);

  // Risk:reward boxes for every (visible) trade, from entry to exit — or to "now" while it is open.
  useEffect(() => {
    if (!boxes.current) return;
    if (!showTrades) { boxes.current.setBoxes([]); return; }
    const lastBar = bars.at(-1);
    const list: RiskRewardBox[] = [];
    for (const trade of visibleTrades) {
      const fromIndex = indexByTime.get(bucketOf(trade.entryTime, tf));
      const toIndex = trade.open ? bars.length - 1 : indexByTime.get(bucketOf(fillBar(trade.exitTime), tf));
      if (fromIndex === undefined || toIndex === undefined) continue;
      const side = trade.side === "LONG" ? 1 : -1;
      const risk = Math.abs(trade.entryPrice - trade.stop) || 1;
      let liveR: number | null = null;
      if (trade.open && lastBar) {
        const booked = trade.visibleLegs.reduce((sum, leg) => sum + (leg.price - trade.entryPrice) * side * leg.fraction, 0);
        const remaining = 1 - trade.visibleLegs.reduce((sum, leg) => sum + leg.fraction, 0);
        liveR = (booked + remaining * (lastBar.close - trade.entryPrice) * side) / risk;
      }
      list.push({ id: trade.id, long: side > 0, fromIndex, toIndex, entry: trade.entryPrice, stop: trade.stop, target1: trade.target1, target2: trade.target2, resultR: trade.open ? null : trade.rMultiple, liveR, focused: trade.id === focusId || trade.open });
    }
    boxes.current.setBoxes(list);
  }, [visibleTrades, bars, indexByTime, tf, showTrades, focusId, hasVolume]);

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
    if (replayDay) return; // the replay owns the viewport
    const from = indexByTime.get(bucketOf(focused.entryTime, tf));
    const to = indexByTime.get(bucketOf(fillBar(focused.exitTime), tf));
    if (from !== undefined && to !== undefined) {
      const pad = Math.max(20, Math.round((to - from) * 1.5));
      chart.current.timeScale().setVisibleLogicalRange({ from: from - pad, to: to + pad });
    }
  }, [focused, tf, indexByTime, hasVolume, replayDay]);

  // Without a focused trade, open on the most recent session (not during a replay).
  useEffect(() => { if (focusId === null && !replayDay) showDay(days.at(-1)); }, [bars, hasVolume]);

  // Replay viewport: the whole session width is reserved up front, so candles print left to right
  // across an empty day exactly as they would live.
  useEffect(() => {
    if (!replayDay || !chart.current) return;
    const first = bars.findIndex((bar) => istDay(bar.time) === replayDay);
    if (first < 0) return;
    chart.current.timeScale().setVisibleLogicalRange({ from: first - 12, to: first + Math.ceil(375 / tf) + 4 });
    // Re-pinned on every printed candle: the chart would otherwise shift the view as bars are added.
  }, [replayDay, tf, hasVolume, bars]);

  // Replay clock.
  const playing = replay?.playing ?? false;
  const speed = replay?.speed ?? 10;
  useEffect(() => {
    if (!playing || !replayLength) return;
    const id = setInterval(() => setReplay((current) => {
      if (!current) return current;
      if (current.cursor >= replayLength) return { ...current, playing: false };
      return { ...current, cursor: current.cursor + 1 };
    }), Math.max(16, 1000 / speed));
    return () => clearInterval(id);
  }, [playing, speed, replayLength]);

  const startReplay = (day: string) => { if (!day) return; setReplay({ day, cursor: 1, playing: true, speed: replay?.speed ?? 10 }); };
  const stopReplay = () => { setReplay(null); if (tf < candleMinutes) setTf(5); };

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

  // Live replay status: the open position and the day's closed trades so far.
  const openTrade = replayDay ? visibleTrades.find((trade) => trade.open) ?? null : null;
  const closedToday = replayDay ? visibleTrades.filter((trade) => !trade.open && trade.day === replayDay) : [];
  const lastBar = bars.at(-1);
  const liveR = openTrade && lastBar ? (() => {
    const side = openTrade.side === "LONG" ? 1 : -1;
    const risk = Math.abs(openTrade.entryPrice - openTrade.stop) || 1;
    const booked = openTrade.visibleLegs.reduce((sum, leg) => sum + (leg.price - openTrade.entryPrice) * side * leg.fraction, 0);
    const remaining = 1 - openTrade.visibleLegs.reduce((sum, leg) => sum + leg.fraction, 0);
    return (booked + remaining * (lastBar.close - openTrade.entryPrice) * side) / risk;
  })() : null;
  const tradeDays = useMemo(() => new Map(sorted.map((trade) => [trade.day, sorted.filter((other) => other.day === trade.day).length])), [sorted]);

  const change = legend ? legend.bar.close - legend.bar.open : 0;
  const changePct = legend && legend.bar.open ? (change / legend.bar.open) * 100 : 0;

  return (
    <div className="bt-candles" ref={wrap}>
      <div className="bt-candles-toolbar" role="toolbar" aria-label="Chart controls">
        <div className="bt-seg" role="group" aria-label="Timeframe">
          {timeframes.map((value) => <button key={value} type="button" className={tf === value ? "on" : ""} aria-pressed={tf === value} onClick={() => setTf(value)}>{tfLabel(value)}</button>)}
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
        <div className="bt-seg bt-replay-pick" role="group" aria-label="Replay a session">
          <select aria-label="Session to replay" value={replayPick || replayDay || focused?.day || allDays.at(-1) || ""} onChange={(event) => setReplayPick(event.target.value)}>
            {allDays.map((day) => <option key={day} value={day}>{dayName(day)}{tradeDays.get(day) ? ` · ${tradeDays.get(day)} trade${tradeDays.get(day) === 1 ? "" : "s"}` : ""}</option>)}
          </select>
          <button type="button" className="bt-replay-go" onClick={() => startReplay(replayPick || focused?.day || allDays.at(-1) || "")}>▶ Replay day</button>
        </div>
        <div className="bt-seg">
          <button type="button" onClick={() => { onFocus(null); stopReplay(); chart.current?.timeScale().fitContent(); }}>Fit all</button>
          <button type="button" onClick={toggleFullscreen} aria-label="Full screen">⛶</button>
        </div>
      </div>

      {replay ? (
        <div className="bt-replay-bar" role="toolbar" aria-label="Replay controls">
          <span className="bt-replay-live"><i className={playing ? "on" : ""} />REPLAY {dayName(replay.day)} · {lastBar ? clock(Math.min(cutoff, lastBar.time + tf * 60)) : "--"}</span>
          <div className="bt-seg">
            <button type="button" aria-label="Restart" onClick={() => setReplay({ ...replay, cursor: 1, playing: false })}>⏮</button>
            <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => setReplay({ ...replay, playing: !playing, cursor: replay.cursor >= replayLength ? 1 : replay.cursor })}>{playing ? "⏸" : "▶"}</button>
            <button type="button" aria-label="Next candle" onClick={() => setReplay({ ...replay, playing: false, cursor: Math.min(replayLength, replay.cursor + 1) })}>⏭</button>
            <button type="button" aria-label="Skip to next trade event" onClick={() => {
              const now = cutoff;
              const events = sorted.filter((trade) => trade.day === replay.day).flatMap((trade) => [trade.entryTime + 60, ...trade.legs.map((leg) => leg.time)]).filter((time) => time > now).sort((a, b) => a - b);
              if (!events.length || !replayRows) return;
              const target = replayRows.findIndex((row) => row[0] + baseMinutes * 60 >= events[0]);
              if (target >= 0) setReplay({ ...replay, playing: false, cursor: Math.min(replayLength, target - replayStart + 1) });
            }}>Next trade ⏩</button>
          </div>
          <label className="bt-replay-speed">Speed
            <select value={speed} onChange={(event) => setReplay({ ...replay, speed: Number(event.target.value) })}>{SPEEDS.map((value) => <option key={value} value={value}>{value} candle{value === 1 ? "" : "s"}/s</option>)}</select>
          </label>
          <input className="bt-replay-seek" type="range" min={1} max={Math.max(1, replayLength)} value={Math.min(replay.cursor, replayLength)} aria-label="Replay position" onChange={(event) => setReplay({ ...replay, playing: false, cursor: Number(event.target.value) })} />
          <button type="button" className="bt-link" onClick={stopReplay}>Exit replay</button>
          <span className="bt-replay-status">
            {openTrade ? <><b className={openTrade.side === "LONG" ? "long" : "short"}>{openTrade.side === "LONG" ? "▲ CE" : "▼ PE"} #{openTrade.id}</b> entry {fmt(openTrade.entryPrice)} · stop {fmt(openTrade.stop)} · T1 {fmt(openTrade.target1)} · <b className={liveR !== null && liveR >= 0 ? "up" : "down"}>{liveR !== null ? signedR(liveR) : ""}</b></> : <>Flat · waiting for a setup</>}
            {closedToday.length ? <> · closed {closedToday.length}: <b>{signedR(closedToday.reduce((sum, trade) => sum + trade.rMultiple, 0))}</b> ({inr(closedToday.reduce((sum, trade) => sum + trade.pnl, 0))})</> : null}
          </span>
        </div>
      ) : null}

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
          <button type="button" className="bt-link" onClick={() => startReplay(focused.day)}>▶ Replay this day</button>
          <button type="button" className="bt-link" onClick={() => onFocus(null)}>Clear</button>
          <p>{focused.reason}</p>
        </div>
      ) : (
        <p className="bt-candles-hint">Boxes show each trade's risk (orange, entry → stop) and reward (blue, entry → T2, dashed T1) with its R:R. Arrows mark entries; dots mark exits at the fill price. Pick a session and press ▶ Replay day to watch it print candle by candle. Use ‹ › to step through trades, or click a trade in the log. Times are IST.</p>
      )}
    </div>
  );
}
