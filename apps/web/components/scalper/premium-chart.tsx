"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export type ChartBar = { time: number; open: number; high: number; low: number; close: number };
export type ChartLevel = { price: number; color: string; title: string; dashed?: boolean };

const IST_S = 330 * 60;
/** lightweight-charts renders UTC; shift by +05:30 so the axis reads IST. */
const chartTime = (epochS: number) => (epochS + IST_S) as UTCTimestamp;

/** Candles plus horizontal levels (entry/SL/target, supports/resistances). Data is owned by the caller. */
export function PremiumChart({ bars, levels, height = 300 }: { bars: ChartBar[]; levels: ChartLevel[]; height?: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const firstTime = useRef<number | null>(null);
  const length = useRef(0);

  useEffect(() => {
    if (!host.current) return;
    const instance = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#9fb0b4", fontSize: 11 },
      grid: { vertLines: { color: "rgba(120,150,160,.08)" }, horzLines: { color: "rgba(120,150,160,.08)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(120,150,160,.2)" },
      timeScale: { borderColor: "rgba(120,150,160,.2)", timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    series.current = instance.addSeries(CandlestickSeries, { upColor: "#22d59b", downColor: "#fa6b78", borderVisible: false, wickUpColor: "#22d59b", wickDownColor: "#fa6b78" });
    chart.current = instance;
    return () => { instance.remove(); chart.current = null; series.current = null; lines.current = []; firstTime.current = null; length.current = 0; };
  }, []);

  useEffect(() => {
    const target = series.current;
    if (!target) return;
    const data = bars.map((bar) => ({ time: chartTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
    // Full reset when the series changes (new contract or timeframe), otherwise update in place.
    const grew = data.length - length.current;
    length.current = data.length;
    if (firstTime.current !== (bars[0]?.time ?? null) || data.length < 2 || grew < 0 || grew > 1) {
      target.setData(data);
      firstTime.current = bars[0]?.time ?? null;
      if (data.length) chart.current?.timeScale().scrollToRealTime();
    } else target.update(data.at(-1)!);
  }, [bars]);

  useEffect(() => {
    const target = series.current;
    if (!target) return;
    for (const line of lines.current) target.removePriceLine(line);
    lines.current = levels.filter((level) => Number.isFinite(level.price) && level.price > 0).map((level) => target.createPriceLine({ price: level.price, color: level.color, lineWidth: 1, lineStyle: level.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: level.title }));
  }, [levels]);

  return <div ref={host} className="scalper-chart-canvas" style={{ height }} />;
}

/** Fold a live price into the current bucket (or start a new one). */
export function foldTick(bars: ChartBar[], price: number, minutes: number, nowS = Math.floor(Date.now() / 1000)): ChartBar[] {
  if (!(price > 0)) return bars;
  const bucket = Math.floor(nowS / (minutes * 60)) * minutes * 60;
  const last = bars.at(-1);
  if (!last || bucket > last.time) return [...bars.slice(-600), { time: bucket, open: last?.close ?? price, high: Math.max(last?.close ?? price, price), low: Math.min(last?.close ?? price, price), close: price }];
  if (last.close === price) return bars;
  return [...bars.slice(0, -1), { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }];
}

/** Regroup 1-minute bars into N-minute bars. */
export function regroupBars(bars: ChartBar[], minutes: number): ChartBar[] {
  if (minutes <= 1) return bars;
  const out: ChartBar[] = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar.time / (minutes * 60)) * minutes * 60;
    const last = out.at(-1);
    if (last && last.time === bucket) { last.high = Math.max(last.high, bar.high); last.low = Math.min(last.low, bar.low); last.close = bar.close; }
    else out.push({ ...bar, time: bucket });
  }
  return out;
}
