"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export type ChartBar = { time: number; open: number; high: number; low: number; close: number };
export type ChartLevel = { price: number; color: string; title: string; dashed?: boolean };
/** A long-premium risk-reward drawing: reward zone (entry→target) over risk zone (entry→stop). */
export type RiskRewardBox = { entry: number; stop: number; target: number; fromTime?: number | null; quantity?: number; label?: string; stopTitle?: string };
type BoxLayout = { left: number; width: number; targetY: number; entryY: number; stopY: number };
const RR_MIN_WIDTH = 190;
const RR_RIGHT_OFFSET_BARS = 34; // room right of the last candle for the drawing (34 bars x 6 px > RR_MIN_WIDTH)

/** Pixel layout of the risk-reward zones; null when a price is off-scale or the box would be empty. */
export function riskRewardLayout(box: RiskRewardBox, toY: (price: number) => number | null, plotWidth: number, fromX: number | null): BoxLayout | null {
  const targetY = toY(box.target);
  const entryY = toY(box.entry);
  const stopY = toY(box.stop);
  if (targetY === null || entryY === null || stopY === null || !(plotWidth > 0)) return null;
  // At least RR_MIN_WIDTH px wide (or the whole plot if narrower), so the labels stay inside the plot.
  const minWidth = Math.min(RR_MIN_WIDTH, plotWidth);
  const left = Math.min(Math.max(0, fromX ?? plotWidth * 0.55), plotWidth - minWidth);
  return { left, width: Math.max(minWidth, plotWidth - left), targetY, entryY, stopY };
}

const IST_S = 330 * 60;
/** lightweight-charts renders UTC; shift by +05:30 so the axis reads IST. */
const chartTime = (epochS: number) => (epochS + IST_S) as UTCTimestamp;

/** Candles plus horizontal levels (entry/SL/target, supports/resistances). Data is owned by the caller. */
export function PremiumChart({ bars, levels, height = 300, riskReward = null }: { bars: ChartBar[]; levels: ChartLevel[]; height?: number; riskReward?: RiskRewardBox | null }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<BoxLayout | null>(null);
  const boxRef = useRef<RiskRewardBox | null>(riskReward);
  boxRef.current = riskReward;
  const relayout = useCallback(() => {
    const box = boxRef.current;
    const target = series.current;
    const instance = chart.current;
    if (!box || !target || !instance || !host.current) { setLayout(null); return; }
    const plotWidth = host.current.clientWidth - instance.priceScale("right").width();
    const fromX = box.fromTime ? instance.timeScale().timeToCoordinate(chartTime(box.fromTime)) : null;
    setLayout(riskRewardLayout(box, (price) => target.priceToCoordinate(price), plotWidth, fromX));
  }, []);
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
    // Keep the risk-reward zones glued to their prices while the chart scrolls, zooms or resizes.
    const onRange = () => requestAnimationFrame(relayout);
    instance.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onRange);
    observer?.observe(host.current);
    return () => { observer?.disconnect(); instance.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); instance.remove(); chart.current = null; series.current = null; lines.current = []; firstTime.current = null; length.current = 0; };
  }, [relayout]);

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
    requestAnimationFrame(relayout);
  }, [bars, relayout]);

  useEffect(() => {
    const target = series.current;
    if (!target) return;
    // Like a position tool, the drawing extends into the future: leave room right of the last candle.
    chart.current?.timeScale().applyOptions({ rightOffset: riskReward ? RR_RIGHT_OFFSET_BARS : 6 });
    // The zones must stay on-screen: widen the autoscale to include the target and the stop.
    target.applyOptions({ autoscaleInfoProvider: riskReward ? (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
      const base = original();
      if (!base) return base;
      return { ...base, priceRange: { minValue: Math.min(base.priceRange.minValue, riskReward.stop), maxValue: Math.max(base.priceRange.maxValue, riskReward.target) } };
    } : undefined });
    requestAnimationFrame(relayout);
  }, [riskReward, relayout]);

  useEffect(() => {
    const target = series.current;
    if (!target) return;
    for (const line of lines.current) target.removePriceLine(line);
    lines.current = levels.filter((level) => Number.isFinite(level.price) && level.price > 0).map((level) => target.createPriceLine({ price: level.price, color: level.color, lineWidth: 1, lineStyle: level.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: level.title }));
  }, [levels]);

  const risk = riskReward ? riskReward.entry - riskReward.stop : 0;
  const reward = riskReward ? riskReward.target - riskReward.entry : 0;
  const ratio = risk > 0 ? reward / risk : 0;
  const qty = riskReward?.quantity ?? 0;
  const rupees = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return (
    <div className="rr-chart-wrap" style={{ position: "relative", height }}>
      <div ref={host} className="scalper-chart-canvas" style={{ height }} />
      {riskReward && layout ? (
        <div className="rr-overlay" aria-label={`Risk reward ${ratio.toFixed(2)} to 1`} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }}>
          <div className="rr-zone rr-reward" style={{ position: "absolute", left: layout.left, width: layout.width, top: Math.min(layout.targetY, layout.entryY), height: Math.abs(layout.entryY - layout.targetY), background: "rgba(34,213,155,.16)", borderTop: "1px solid #22d59b" }}>
            <span className="rr-label" style={{ position: "absolute", top: 2, left: 6, fontSize: 11, color: "#22d59b", whiteSpace: "nowrap" }}>Target {rupees(riskReward.target)} · +{rupees(reward)}{qty ? ` (${rupees(reward * qty)})` : ""}{risk > 0 ? ` · ${ratio.toFixed(2)}R` : ""}</span>
          </div>
          {risk > 0 ? (
            <div className="rr-zone rr-risk" style={{ position: "absolute", left: layout.left, width: layout.width, top: Math.min(layout.entryY, layout.stopY), height: Math.abs(layout.stopY - layout.entryY), background: "rgba(250,107,120,.16)", borderBottom: "1px solid #fa6b78" }}>
              <span className="rr-label" style={{ position: "absolute", bottom: 2, left: 6, fontSize: 11, color: "#fa6b78", whiteSpace: "nowrap" }}>{riskReward.stopTitle ?? "Stop"} {rupees(riskReward.stop)} · −{rupees(risk)}{qty ? ` (${rupees(risk * qty)})` : ""}</span>
            </div>
          ) : (
            // The stop has trailed to (or above) the entry: the trade can no longer lose; show what it locks.
            <div className="rr-zone rr-locked" style={{ position: "absolute", left: layout.left, width: layout.width, top: layout.stopY, borderTop: "2px solid #f0c36b" }}>
              <span className="rr-label" style={{ position: "absolute", top: 2, left: 6, fontSize: 11, color: "#f0c36b", whiteSpace: "nowrap" }}>{riskReward.stopTitle ?? "Trail SL"} {rupees(riskReward.stop)} (+{qty ? rupees(-risk * qty) : rupees(-risk)})</span>
            </div>
          )}
          <div className="rr-entry" style={{ position: "absolute", left: layout.left, width: layout.width, top: layout.entryY, borderTop: "1px dashed #c9d3d6" }}>
            <span className="rr-label" style={{ position: "absolute", top: 2, left: 6, fontSize: 11, color: "#c9d3d6", whiteSpace: "nowrap" }}>{riskReward.label ?? "Entry"} {rupees(riskReward.entry)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
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
