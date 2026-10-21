"use client";

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { StoredSnapshot } from "../lib/sentiment-history";

// Categorical slots (dark steps of the reference palette), validated on the panel surface #0a1c27:
// adjacent CVD ΔE >= 8.4, normal-vision ΔE >= 19.3, every slot >= 3:1. Fixed per instrument, so a
// series keeps its color whatever else is shown.
const SLOT: Record<string, string> = {
  NIFTY: "#3987e5", BANKNIFTY: "#d95926", SENSEX: "#199e70", CRUDEOIL: "#c98500",
  NATURALGAS: "#d55181", GOLD: "#008300", SILVER: "#9085e9", COPPER: "#e66767",
};
const FALLBACK = "#7f9ba3";
const BAND = 10; // the reversal hysteresis band
const GAP_MS = 45 * 60_000; // a longer gap (overnight, recorder down) breaks the line
const HEIGHT = 260;
const PAD = { top: 14, right: 124, bottom: 30, left: 40 };
const NARROW = 560; // below this the legend carries identity and the plot takes the full width
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60_000;

export type ChartSeries = { id: string; name: string };
type Point = { t: number; score: number; snapshot: StoredSnapshot };

const istParts = (t: number) => { const ist = new Date(t + IST_OFFSET_MS); return { date: `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}`, time: ist.toISOString().slice(11, 16) }; };
const signed = (value: number) => { const text = Math.abs(value).toFixed(0); return Number(text) === 0 ? text : `${value > 0 ? "+" : "-"}${text}`; };
export const seriesColor = (id: string) => SLOT[id] ?? FALLBACK;

function readingOf(snapshot: StoredSnapshot, id: string) {
  return snapshot.indices?.[id] ?? snapshot.commodities?.[id];
}

/** Nice x ticks: every 15 min .. 1 day, aiming for ~6 labels. */
function timeTicks(min: number, max: number, target: number): number[] {
  const steps = [15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);
  const step = steps.find((value) => (max - min) / value <= target) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  // Align to IST boundaries.
  for (let t = Math.ceil((min + IST_OFFSET_MS) / step) * step - IST_OFFSET_MS; t <= max; t += step) ticks.push(t);
  return ticks;
}

/**
 * Sentiment score over time, one 2px line per instrument on a single -100..+100 axis (zoomed to the
 * data, symmetric around zero). The ±10 band is where a score keeps its previous direction; rings
 * mark the snapshots saved because that instrument reversed. Hover or arrow keys move a crosshair
 * whose readout lists every visible series at that time.
 */
export const SentimentChart = memo(function SentimentChart({ snapshots, series }: { snapshots: StoredSnapshot[]; series: ChartSeries[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { times, lines, domain } = useMemo(() => {
    const ordered = [...snapshots].map((snapshot) => ({ snapshot, t: Date.parse(snapshot.recordedAt) })).filter((row) => Number.isFinite(row.t)).sort((a, b) => a.t - b.t);
    const lines = series.map((item) => ({
      ...item,
      points: ordered.flatMap(({ snapshot, t }): Point[] => {
        const score = readingOf(snapshot, item.id)?.score;
        return typeof score === "number" ? [{ t, score, snapshot }] : [];
      }),
    }));
    const extent = Math.max(BAND * 2, ...lines.flatMap((line) => line.points.map((point) => Math.abs(point.score))));
    return { times: ordered, lines, domain: Math.min(100, Math.ceil((extent * 1.15) / 10) * 10) };
  }, [snapshots, series]);

  if (!times.length || !lines.some((line) => line.points.length)) return <div className="smc" ref={wrap} />;

  const narrow = width < NARROW;
  const right = narrow ? 12 : PAD.right;
  const innerWidth = width - PAD.left - right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const t0 = times[0].t;
  const t1 = times[times.length - 1].t;
  const span = Math.max(t1 - t0, 15 * 60_000);
  const x = (t: number) => PAD.left + (times.length === 1 ? innerWidth / 2 : ((t - t0) / span) * innerWidth);
  const y = (score: number) => PAD.top + ((domain - score) / (2 * domain)) * innerHeight;
  const yTicks = [-domain, -domain / 2, 0, domain / 2, domain];
  const xTicks = timeTicks(t0, t1, Math.max(3, Math.floor(innerWidth / 90)));
  const multiDay = istParts(t0).date !== istParts(t1).date;

  const path = (points: Point[]) => points.map((point, index) => `${index === 0 || point.t - points[index - 1].t > GAP_MS ? "M" : "L"}${x(point.t).toFixed(1)},${y(point.score).toFixed(1)}`).join("");
  const nearest = (clientX: number) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return null;
    const px = clientX - box.left;
    let best = 0;
    times.forEach((row, index) => { if (Math.abs(x(row.t) - px) < Math.abs(x(times[best].t) - px)) best = index; });
    return best;
  };
  const onMove = (event: PointerEvent<SVGSVGElement>) => setActive(nearest(event.clientX));
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setActive((current) => Math.max(0, Math.min(times.length - 1, (current ?? times.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  };

  // Direct labels at each line's last point (<= 4 series), nudged apart so they never overlap.
  const labels = lines.length <= 4 && !narrow ? lines.filter((line) => line.points.length).map((line) => {
    const last = line.points[line.points.length - 1];
    return { id: line.id, name: line.name, score: last.score, y: y(last.score), color: seriesColor(line.id) };
  }).sort((a, b) => a.y - b.y) : [];
  labels.forEach((label, index) => { if (index && label.y - labels[index - 1].y < 14) label.y = labels[index - 1].y + 14; });

  const hovered = active === null ? null : times[active];
  const readout = hovered ? lines.map((line) => ({ line, reading: readingOf(hovered.snapshot, line.id) })).filter((row) => typeof row.reading?.score === "number") : [];
  const hx = hovered ? x(hovered.t) : 0;

  return (
    <div className="smc" ref={wrap}>
      <svg
        width={width} height={HEIGHT} role="img" tabIndex={0}
        aria-label={`Sentiment score over time for ${lines.map((line) => line.name).join(", ")}. Use the left and right arrow keys to read each snapshot.`}
        onPointerMove={onMove} onPointerLeave={() => setActive(null)} onKeyDown={onKey} onBlur={() => setActive(null)}
      >
        <rect className="smc-band" x={PAD.left} y={y(BAND)} width={innerWidth} height={y(-BAND) - y(BAND)} />
        {yTicks.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? "smc-zero" : "smc-grid"} x1={PAD.left} x2={PAD.left + innerWidth} y1={y(tick)} y2={y(tick)} />
            <text className="smc-axis" x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end">{signed(tick)}</text>
          </g>
        ))}
        {xTicks.map((tick, index) => {
          const parts = istParts(tick);
          const showDate = multiDay && (index === 0 || istParts(xTicks[index - 1]).date !== parts.date);
          return <text key={tick} className="smc-axis" x={x(tick)} y={HEIGHT - 10} textAnchor="middle">{showDate ? `${parts.date} ${parts.time}` : parts.time}</text>;
        })}

        {lines.map((line) => (
          <g key={line.id}>
            <path d={path(line.points)} fill="none" stroke={seriesColor(line.id)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {line.points.length === 1 ? <circle cx={x(line.points[0].t)} cy={y(line.points[0].score)} r={4} fill={seriesColor(line.id)} /> : null}
            {line.points.filter((point) => point.snapshot.reversals?.some((item) => item.instrument === line.id)).map((point) => (
              <circle key={point.t} className="smc-flip" cx={x(point.t)} cy={y(point.score)} r={5} stroke={seriesColor(line.id)}>
                <title>{`${line.name} reversed at ${istParts(point.t).time} IST`}</title>
              </circle>
            ))}
          </g>
        ))}

        {labels.map((label) => (
          <text key={label.id} className="smc-label" x={PAD.left + innerWidth + 8} y={label.y} dy="0.32em">
            <tspan fill={label.color}>━ </tspan>{label.name.replace(/ \(.*\)$/, "")} <tspan className="smc-label-value">{signed(label.score)}</tspan>
          </text>
        ))}

        {hovered ? (
          <g pointerEvents="none">
            <line className="smc-cross" x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + innerHeight} />
            {readout.map(({ line, reading }) => <circle key={line.id} cx={hx} cy={y(reading!.score as number)} r={4} fill={seriesColor(line.id)} stroke="#0a1c27" strokeWidth={2} />)}
          </g>
        ) : null}
      </svg>

      {hovered ? (
        <div className="smc-tip" style={{ left: Math.min(Math.max(hx + 12, 0), width - 190), top: PAD.top }} role="status">
          <small>{istParts(hovered.t).date} · {istParts(hovered.t).time} IST</small>
          {readout.sort((a, b) => (b.reading!.score as number) - (a.reading!.score as number)).map(({ line, reading }) => (
            <div key={line.id}>
              <i style={{ background: seriesColor(line.id) }} />
              <b>{signed(reading!.score as number)}</b>
              <span>{line.name}</span>
              {typeof reading!.price === "number" ? <em>{reading!.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</em> : null}
            </div>
          ))}
          {hovered.snapshot.reversals?.length ? <small className="smc-tip-flip">Reversal: {hovered.snapshot.reversals.map((item) => `${item.instrument} ${item.type.toLowerCase()} → ${item.to.toLowerCase()}`).join(", ")}</small> : null}
        </div>
      ) : null}
      <small className="smc-note">Shaded: the ±{BAND} band, where a score keeps its previous direction (a reversal needs a cross from one side to the other). Rings: snapshots saved on that line&apos;s reversal. Hover, or focus the chart and use ← →, to read each snapshot.</small>
    </div>
  );
});
