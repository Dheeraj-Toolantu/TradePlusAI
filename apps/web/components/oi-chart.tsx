"use client";

import { memo, useMemo, useState, type PointerEvent } from "react";
import type { StoredSnapshot } from "../lib/sentiment-history";
import type { OiReading } from "../lib/oi-history";

/**
 * Call vs put writers' open interest for one index, one point per 5-minute snapshot. Each point is
 * the average of the 3-minute OI samples taken in that window.
 */
const CALL = "#e66767"; // call writers: resistance overhead
const PUT = "#199e70"; // put writers: support underneath
const HEIGHT = 230;
const PAD = { top: 14, right: 16, bottom: 28, left: 64 };
const WIDTH = 900;
const GAP_MS = 45 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
const istTime = (t: number) => new Date(t + IST_OFFSET_MS).toISOString().slice(11, 16);
const units = (value: number) => (value >= 1e7 ? `${(value / 1e7).toFixed(2)} Cr` : `${(value / 1e5).toFixed(1)} L`);
const signed = (value: number | null) => (value === null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`);

type Point = { t: number; oi: OiReading; time: string };

export const OiChart = memo(function OiChart({ snapshots, index, name }: { snapshots: StoredSnapshot[]; index: string; name: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo<Point[]>(() => snapshots
    .flatMap((snapshot) => {
      const oi = snapshot.indices?.[index]?.oi as OiReading | undefined;
      const t = Date.parse(snapshot.recordedAt);
      return oi && Number.isFinite(t) ? [{ t, oi, time: snapshot.time ?? istTime(t) }] : [];
    })
    .sort((a, b) => a.t - b.t), [index, snapshots]);
  if (points.length < 2) return <p className="isa-muted">The {name} OI chart appears once two snapshots with OI are saved (every 5 minutes in market hours).</p>;

  const minT = points[0].t; const maxT = points[points.length - 1].t;
  const values = points.flatMap((point) => [point.oi.call_oi, point.oi.put_oi]);
  const lo = Math.min(...values); const hi = Math.max(...values);
  const span = hi - lo || hi * 0.01 || 1;
  const minY = lo - span * 0.08; const maxY = hi + span * 0.08;
  const x = (t: number) => PAD.left + ((t - minT) / (maxT - minT || 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + ((maxY - value) / (maxY - minY)) * (HEIGHT - PAD.top - PAD.bottom);
  const path = (pick: (point: Point) => number) => points.map((point, i) => `${i && point.t - points[i - 1].t <= GAP_MS ? "L" : "M"}${x(point.t).toFixed(1)},${y(pick(point)).toFixed(1)}`).join(" ");
  const ticksY = Array.from({ length: 5 }, (_, i) => minY + ((maxY - minY) * i) / 4);
  const ticksX = points.filter((_, i) => i % Math.max(1, Math.ceil(points.length / 8)) === 0);
  const shown = hover === null ? null : points[hover];
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * WIDTH;
    let best = 0;
    points.forEach((point, i) => { if (Math.abs(x(point.t) - px) < Math.abs(x(points[best].t) - px)) best = i; });
    setHover(best);
  };

  return (
    <div className="oi-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${name}: call and put writers' open interest every 5 minutes`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticksY.map((value) => <g key={value}><line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(value)} y2={y(value)} stroke="#173241" /><text x={PAD.left - 6} y={y(value) + 3} fill="#7f9ba3" fontSize="10" textAnchor="end">{units(value)}</text></g>)}
        {ticksX.map((point) => <text key={point.t} x={x(point.t)} y={HEIGHT - 8} fill="#7f9ba3" fontSize="10" textAnchor="middle">{point.time}</text>)}
        <path d={path((point) => point.oi.call_oi)} fill="none" stroke={CALL} strokeWidth="2" />
        <path d={path((point) => point.oi.put_oi)} fill="none" stroke={PUT} strokeWidth="2" />
        {points.map((point) => <g key={point.t}><circle cx={x(point.t)} cy={y(point.oi.call_oi)} r="2.2" fill={CALL} /><circle cx={x(point.t)} cy={y(point.oi.put_oi)} r="2.2" fill={PUT} /></g>)}
        {shown ? <line x1={x(shown.t)} x2={x(shown.t)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#5aa9ff" strokeDasharray="3 3" /> : null}
      </svg>
      <div className="oi-chart-legend">
        <span><i style={{ background: CALL }} />Call writers OI</span>
        <span><i style={{ background: PUT }} />Put writers OI</span>
        {shown ? (
          <b>{shown.time} · CE {units(shown.oi.call_oi)} ({signed(shown.oi.call_change_pct)}) · PE {units(shown.oi.put_oi)} ({signed(shown.oi.put_change_pct)}) · PCR {shown.oi.pcr?.toFixed(2) ?? "--"} · avg of {shown.oi.samples ?? 1} × 3-min sample{(shown.oi.samples ?? 1) === 1 ? "" : "s"} · {shown.oi.signal}</b>
        ) : <small className="isa-muted">Each point: the average of the 3-minute OI samples in that 5-minute window. Hover for values.</small>}
      </div>
    </div>
  );
});
