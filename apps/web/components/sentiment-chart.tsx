"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { StoredSnapshot } from "../lib/sentiment-history";
import type { OiReading } from "../lib/oi-history";

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
const SCORE_HEIGHT = 216; // the score pane's plot height
const OI_GAP = 26; // between the score pane and the OI pane (holds the OI pane's title)
const OI_HEIGHT = 130; // the OI pane's plot height
const AXIS = 30; // room for the time labels
const CALL = "#e66767"; // call writers' OI
const PUT = "#22b07d"; // put writers' OI
const FIVE_MIN = 5 * 60_000;
const PAD = { top: 14, right: 124, bottom: 30, left: 56 };
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

/** Time labels on 5-minute boundaries: every 5 min when there is room, else 10, 15, 30 … minutes. */
export function timeTicks(min: number, max: number, target: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);
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
export const oiUnitsShort = (value: number) => (value >= 1e7 ? `${(value / 1e7).toFixed(2)} Cr` : `${(value / 1e5).toFixed(1)} L`);
const pctText = (value: number | null | undefined) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`);
type OiPoint = { t: number; oi: OiReading };

/**
 * With `oiIndex`, a second pane under the scores plots that index's call writers' and put writers'
 * OI (the 5-minute average of the 3-minute samples) on the same time axis and crosshair.
 */
export const SentimentChart = memo(function SentimentChart({ snapshots, series, oiIndex = null, oiName }: { snapshots: StoredSnapshot[]; series: ChartSeries[]; oiIndex?: string | null; oiName?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const clipId = `smc-clip-${useId().replace(/:/g, "")}`;
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { times, lines, oiPoints, domain } = useMemo(() => {
    const ordered = [...snapshots].map((snapshot) => ({ snapshot, t: Date.parse(snapshot.recordedAt) })).filter((row) => Number.isFinite(row.t)).sort((a, b) => a.t - b.t);
    const lines = series.map((item) => ({
      ...item,
      points: ordered.flatMap(({ snapshot, t }): Point[] => {
        const score = readingOf(snapshot, item.id)?.score;
        return typeof score === "number" ? [{ t, score, snapshot }] : [];
      }),
    }));
    const extent = Math.max(BAND * 2, ...lines.flatMap((line) => line.points.map((point) => Math.abs(point.score))));
    const oiPoints: OiPoint[] = oiIndex ? ordered.flatMap(({ snapshot, t }) => { const oi = snapshot.indices?.[oiIndex]?.oi as OiReading | undefined; return oi && oi.call_oi > 0 ? [{ t, oi }] : []; }) : [];
    return { times: ordered, lines, oiPoints, domain: Math.min(100, Math.ceil((extent * 1.15) / 10) * 10) };
  }, [oiIndex, snapshots, series]);

  if (!times.length || !lines.some((line) => line.points.length)) return <div className="smc" ref={wrap} />;

  const narrow = width < NARROW;
  const right = narrow ? 12 : PAD.right;
  const innerWidth = width - PAD.left - right;
  const showOi = oiPoints.length > 0;
  const innerHeight = SCORE_HEIGHT;
  const oiTop = PAD.top + SCORE_HEIGHT + OI_GAP;
  const plotBottom = showOi ? oiTop + OI_HEIGHT : PAD.top + SCORE_HEIGHT;
  const HEIGHT = plotBottom + AXIS;
  const t0 = times[0].t;
  const t1 = times[times.length - 1].t;
  const span = Math.max(t1 - t0, 15 * 60_000);
  const oiValues = oiPoints.flatMap((point) => [point.oi.call_oi, point.oi.put_oi]);
  const oiLo = oiValues.length ? Math.min(...oiValues) : 0; const oiHi = oiValues.length ? Math.max(...oiValues) : 1;
  const oiPad = (oiHi - oiLo || oiHi * 0.02 || 1) * 0.12;
  const oiY = (value: number) => oiTop + ((oiHi + oiPad - value) / (oiHi - oiLo + 2 * oiPad)) * OI_HEIGHT;
  const oiTicks = [oiLo, (oiLo + oiHi) / 2, oiHi];
  const oiPath = (pick: (point: OiPoint) => number) => oiPoints.map((point, index) => `${index === 0 || point.t - oiPoints[index - 1].t > GAP_MS ? "M" : "L"}${x(point.t).toFixed(1)},${oiY(pick(point)).toFixed(1)}`).join("");
  // A small tick on every 5-minute boundary, under the labels (which thin out to fit).
  const fiveMinute: number[] = [];
  if ((t1 - t0) / FIVE_MIN <= 400) for (let t = Math.ceil(t0 / FIVE_MIN) * FIVE_MIN; t <= t1; t += FIVE_MIN) fiveMinute.push(t);
  const x = (t: number) => PAD.left + (times.length === 1 ? innerWidth / 2 : ((t - t0) / span) * innerWidth);
  const y = (score: number) => PAD.top + ((domain - score) / (2 * domain)) * innerHeight;
  const yTicks = [-domain, -domain / 2, 0, domain / 2, domain];
  const xTicks = timeTicks(t0, t1, Math.max(3, Math.floor(innerWidth / 46)));
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
  const hoveredOi = hovered && showOi ? (hovered.snapshot.indices?.[oiIndex as string]?.oi as OiReading | undefined) ?? null : null;

  return (
    <div className="smc" ref={wrap}>
      <svg
        width={width} height={HEIGHT} role="img" tabIndex={0}
        aria-label={`Sentiment score over time for ${lines.map((line) => line.name).join(", ")}. Use the left and right arrow keys to read each snapshot.`}
        onPointerMove={onMove} onPointerLeave={() => setActive(null)} onKeyDown={onKey} onBlur={() => setActive(null)}
      >
        <defs><clipPath id={clipId}><rect x={PAD.left - 6} y={PAD.top - 6} width={innerWidth + 12} height={innerHeight + 12} /></clipPath></defs>
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
          return <g key={tick}><line className="smc-grid" x1={x(tick)} x2={x(tick)} y1={PAD.top} y2={plotBottom} strokeOpacity={0.5} /><text className="smc-axis" x={x(tick)} y={HEIGHT - 10} textAnchor="middle">{showDate ? `${parts.date} ${parts.time}` : parts.time}</text></g>;
        })}
        {fiveMinute.map((tick) => <line key={tick} className="smc-grid" x1={x(tick)} x2={x(tick)} y1={plotBottom} y2={plotBottom + 4} />)}

        {showOi ? (
          <g>
            <text className="smc-axis" x={PAD.left} y={oiTop - 8}>{oiName ?? oiIndex} option writers&apos; OI (5-min average of 3-min samples)</text>
            {oiTicks.map((tick) => (
              <g key={tick}>
                <line className="smc-grid" x1={PAD.left} x2={PAD.left + innerWidth} y1={oiY(tick)} y2={oiY(tick)} />
                <text className="smc-axis" x={PAD.left - 6} y={oiY(tick)} dy="0.32em" textAnchor="end">{oiUnitsShort(tick)}</text>
              </g>
            ))}
            <path d={oiPath((point) => point.oi.call_oi)} fill="none" stroke={CALL} strokeWidth={2} strokeLinejoin="round" />
            <path d={oiPath((point) => point.oi.put_oi)} fill="none" stroke={PUT} strokeWidth={2} strokeLinejoin="round" />
            {oiPoints.length <= 1 ? oiPoints.map((point) => <g key={point.t}><circle cx={x(point.t)} cy={oiY(point.oi.call_oi)} r={3} fill={CALL} /><circle cx={x(point.t)} cy={oiY(point.oi.put_oi)} r={3} fill={PUT} /></g>) : null}
            {!narrow ? (() => {
              const last = oiPoints[oiPoints.length - 1];
              const callY = oiY(last.oi.call_oi); let putY = oiY(last.oi.put_oi);
              if (Math.abs(putY - callY) < 14) putY = callY + (putY >= callY ? 14 : -14);
              return (
                <>
                  <text className="smc-label" x={PAD.left + innerWidth + 8} y={callY} dy="0.32em"><tspan fill={CALL}>━ </tspan>Call OI <tspan className="smc-label-value">{oiUnitsShort(last.oi.call_oi)}</tspan></text>
                  <text className="smc-label" x={PAD.left + innerWidth + 8} y={putY} dy="0.32em"><tspan fill={PUT}>━ </tspan>Put OI <tspan className="smc-label-value">{oiUnitsShort(last.oi.put_oi)}</tspan></text>
                </>
              );
            })() : null}
          </g>
        ) : null}

        {lines.map((line) => (
          <g key={line.id} clipPath={`url(#${clipId})`}>
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
            <line className="smc-cross" x1={hx} x2={hx} y1={PAD.top} y2={plotBottom} />
            {readout.map(({ line, reading }) => <circle key={line.id} cx={hx} cy={y(reading!.score as number)} r={4} fill={seriesColor(line.id)} stroke="#0a1c27" strokeWidth={2} />)}
            {hoveredOi ? <><circle cx={hx} cy={oiY(hoveredOi.call_oi)} r={4} fill={CALL} stroke="#0a1c27" strokeWidth={2} /><circle cx={hx} cy={oiY(hoveredOi.put_oi)} r={4} fill={PUT} stroke="#0a1c27" strokeWidth={2} /></> : null}
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
          {hoveredOi ? (
            <>
              <div><i style={{ background: CALL }} /><b>{oiUnitsShort(hoveredOi.call_oi)}</b><span>{oiName ?? oiIndex} call writers OI</span><em>{pctText(hoveredOi.call_change_pct)}</em></div>
              <div><i style={{ background: PUT }} /><b>{oiUnitsShort(hoveredOi.put_oi)}</b><span>{oiName ?? oiIndex} put writers OI</span><em>{pctText(hoveredOi.put_change_pct)}</em></div>
              <small>PCR {hoveredOi.pcr?.toFixed(2) ?? "--"} · avg of {hoveredOi.samples ?? 1} × 3-min sample{(hoveredOi.samples ?? 1) === 1 ? "" : "s"} · {hoveredOi.signal}</small>
            </>
          ) : null}
          {hovered.snapshot.reversals?.length ? <small className="smc-tip-flip">Reversal: {hovered.snapshot.reversals.map((item) => `${item.instrument} ${item.type.toLowerCase()} → ${item.to.toLowerCase()}`).join(", ")}</small> : null}
        </div>
      ) : null}
      <small className="smc-note">Shaded: the ±{BAND} band, where a score keeps its previous direction (a reversal needs a cross from one side to the other). Rings: snapshots saved on that line&apos;s reversal. Hover, or focus the chart and use ← →, to read each 5-minute snapshot.{showOi ? " Lower pane: call writers' OI (red) and put writers' OI (green), each point the average of that window's 3-minute samples." : ""}</small>
    </div>
  );
});
