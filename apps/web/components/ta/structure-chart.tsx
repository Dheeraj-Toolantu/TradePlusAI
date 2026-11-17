"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { computeSmcStructure, forDisplay, type Bar, type SmcStructure } from "../../lib/smc-structure";
import { SmcStructurePrimitive, type StructureLayers } from "./smc-structure-primitive";

export type ChartCandle = Bar & { volume: number };
const IST_SHIFT = 330 * 60; // lightweight-charts renders UTC; shift so the axis reads IST
const money = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function emaLine(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((value, index) => out.push(index === 0 ? value : (value - out[index - 1]) * k + out[index - 1]));
  return out;
}

/** The structure the chart draws, computed on exactly the candles shown (indices line up). */
export function useStructure(candles: ChartCandle[], swingLength: number) {
  const bars = useMemo(() => [...candles].sort((a, b) => a.time - b.time).slice(-300), [candles]);
  const full = useMemo(() => (bars.length >= 2 * swingLength + 3 ? computeSmcStructure(bars, { length: swingLength }) : null), [bars, swingLength]);
  const shown = useMemo(() => (full ? forDisplay(full, bars) : null), [bars, full]);
  return { bars, full, shown };
}

function StructureChartView({ bars, structure, layers, levels }: { bars: ChartCandle[]; structure: SmcStructure | null; layers: StructureLayers; levels?: { support: number; resistance: number; entry?: string; stop?: string } | null }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const smc = useRef<SmcStructurePrimitive | null>(null);
  const latest = useRef({ bars, structure, layers });
  latest.current = { bars, structure, layers };

  const apply = () => {
    const { bars: data, structure: s, layers: l } = latest.current;
    if (!candleSeries.current || !volumeSeries.current || !emaSeries.current) return;
    candleSeries.current.setData(data.map((c) => ({ time: (c.time + IST_SHIFT) as Time, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.current.setData(data.map((c) => ({ time: (c.time + IST_SHIFT) as Time, value: c.volume, color: c.close >= c.open ? "rgba(34,213,155,.35)" : "rgba(250,107,120,.35)" })));
    const ema = emaLine(data.map((c) => c.close), 20);
    emaSeries.current.setData(data.map((c, i) => ({ time: (c.time + IST_SHIFT) as Time, value: ema[i] })));
    smc.current?.set(s, data.length - 1, l);
  };

  // The chart library loads on demand, so the page's controls paint first.
  useEffect(() => {
    let disposed = false;
    void import("lightweight-charts").then(({ CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart }) => {
      if (disposed || !container.current) return;
      const instance = createChart(container.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: "#081c24" }, textColor: "#789aa1" },
        grid: { vertLines: { color: "rgba(65,116,125,.12)" }, horzLines: { color: "rgba(65,116,125,.15)" } },
        rightPriceScale: { borderColor: "#173944" }, timeScale: { borderColor: "#173944", timeVisible: true, rightOffset: 8 },
      });
      candleSeries.current = instance.addSeries(CandlestickSeries, { upColor: "#22d59b", downColor: "#fa6b78", borderVisible: false, wickUpColor: "#22d59b", wickDownColor: "#fa6b78" });
      volumeSeries.current = instance.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", base: 0 });
      instance.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      emaSeries.current = instance.addSeries(LineSeries, { color: "#eebd54", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      smc.current = new SmcStructurePrimitive();
      candleSeries.current.attachPrimitive(smc.current);
      chart.current = instance;
      apply();
      instance.timeScale().fitContent();
    });
    return () => { disposed = true; chart.current?.remove(); chart.current = null; candleSeries.current = null; volumeSeries.current = null; emaSeries.current = null; smc.current = null; };
  }, []);

  const firstTime = bars[0]?.time; const count = bars.length;
  useEffect(() => { apply(); chart.current?.timeScale().fitContent(); }, [firstTime, count]); // new data set: refit
  useEffect(() => { apply(); }, [bars, structure, layers]);

  return (
    <div className="ta-real-chart">
      <div ref={container} />
      {levels ? <div className="ta-chart-overlay"><span>SUPPORT {money(levels.support)}</span><span>RESISTANCE {money(levels.resistance)}</span>{levels.entry ? <><span>ENTRY {levels.entry}</span><span>SL {levels.stop}</span></> : null}</div> : null}
    </div>
  );
}

export const StructureChart = memo(StructureChartView);
