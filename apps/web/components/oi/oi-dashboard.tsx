"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeOi, type OiAnalysis, type StrikeRow, type StrikeSample } from "../../lib/oi-analysis";

const INDICES = [["NIFTY", "NIFTY"], ["BANKNIFTY", "BANK NIFTY"], ["SENSEX", "SENSEX"]] as const;
const RANGES = [5, 8, 10, 15, 20];
const PUT = "#3fbf6b";
const CALL = "#e5606a";
const IST_OFFSET_MS = 330 * 60_000;
const today = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
type Vix = { value: number; change: number | null; percent: number | null } | null;
type Summary = { date: string; vix: Vix; indices: Array<{ symbol: string; analysis: OiAnalysis | null }>; notes: string[] };

/** OI in Indian units: 1.2Cr, 35.23L, 98,475. */
export const oiText = (value: number | null | undefined, signed = false) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value); const sign = signed ? (value > 0 ? "+" : value < 0 ? "−" : "") : value < 0 ? "−" : "";
  return abs >= 1e7 ? `${sign}${(abs / 1e7).toFixed(2)}Cr` : abs >= 1e5 ? `${sign}${(abs / 1e5).toFixed(2)}L` : `${sign}${Math.round(abs).toLocaleString("en-IN")}`;
};
const price = (value: number | null | undefined) => (value === null || value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`);
const tone = (value: number | null | undefined) => (!value ? "" : value > 0 ? "gain" : "loss");
const biasTone = (score: number) => (score >= 15 ? "gain" : score <= -15 ? "loss" : "warning");
const clock = (time: string) => { const [h, m] = time.split(":").map(Number); return `${String(((h + 11) % 12) + 1).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };

/** The element's width in CSS pixels, so charts draw at their real size (text stays legible on phones). */
function useWidth(fallback = 1000) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(300, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Strike-wise put / call OI: solid = OI at the base time, hatched = increase since, outline = decrease. */
function StrikeChart({ analysis, showOi, symbol }: { analysis: OiAnalysis; showOi: boolean; symbol: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrap, measured] = useWidth();
  const rows = analysis.rows;
  const W = measured; const H = W < 600 ? 340 : 400; const pad = { top: 16, right: 8, bottom: 56, left: W < 600 ? 48 : 62 };
  const font = W < 600 ? 10 : 12;
  const innerW = W - pad.left - pad.right; const innerH = H - pad.top - pad.bottom;
  const cw = innerW / Math.max(rows.length, 1);
  const hi = showOi ? Math.max(1, ...rows.flatMap((row) => [row.ce_base, row.ce_now, row.pe_base, row.pe_now])) : Math.max(1, ...rows.flatMap((row) => [row.ce_chg, row.pe_chg, 0]));
  const lo = showOi ? 0 : Math.min(0, ...rows.flatMap((row) => [row.ce_chg, row.pe_chg]));
  const top = hi * 1.08; const bottom = lo < 0 ? lo * 1.08 : 0;
  const y = (value: number) => pad.top + ((top - value) / (top - bottom || 1)) * innerH;
  const ticks = Array.from({ length: 6 }, (_, i) => bottom + ((top - bottom) * i) / 5);
  const cx = (i: number) => pad.left + cw * (i + 0.5);
  // Spot between two strikes, on the category axis.
  const spot = analysis.current.spot;
  const spotX = (() => {
    if (spot === null || rows.length < 2) return null;
    for (let i = 0; i < rows.length - 1; i += 1) if (spot >= rows[i].strike && spot <= rows[i + 1].strike) return cx(i) + ((spot - rows[i].strike) / (rows[i + 1].strike - rows[i].strike)) * cw;
    return null;
  })();
  const labelEvery = Math.max(1, Math.ceil(rows.length / Math.max(3, Math.floor(W / 80))));

  const bar = (row: StrikeRow, side: "pe" | "ce", x: number, width: number) => {
    const color = side === "pe" ? PUT : CALL;
    const base = side === "pe" ? row.pe_base : row.ce_base; const now = side === "pe" ? row.pe_now : row.ce_now; const change = now - base;
    const hatch = `url(#oi-hatch-${side})`;
    if (!showOi) {
      const y0 = y(0); const y1 = y(change);
      return change >= 0
        ? <rect x={x} y={y1} width={width} height={Math.max(0, y0 - y1)} fill={hatch} stroke={color} strokeWidth={0.6} />
        : <rect x={x + 0.5} y={y0} width={width - 1} height={Math.max(0, y1 - y0)} fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth={1.2} />;
    }
    const solid = Math.min(base, now);
    return (
      <g>
        <rect x={x} y={y(solid)} width={width} height={Math.max(0, y(0) - y(solid))} fill={color} />
        {change > 0 ? <rect x={x} y={y(now)} width={width} height={Math.max(0, y(base) - y(now))} fill={hatch} stroke={color} strokeWidth={0.6} /> : null}
        {change < 0 ? <rect x={x + 0.5} y={y(base)} width={width - 1} height={Math.max(0, y(now) - y(base))} fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth={1.2} /> : null}
      </g>
    );
  };

  const shown = hover === null ? null : rows[hover];
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const i = Math.floor((px - pad.left) / cw);
    setHover(i >= 0 && i < rows.length ? i : null);
  };
  const tipLeft = hover === null ? 0 : cx(hover) > W / 2 ? Math.max(cx(hover) - 262, 0) : Math.min(cx(hover) + 14, W - 250);

  return (
    <div className="oi-strike" ref={wrap}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${symbol} strike-wise put and call open interest`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          {(["pe", "ce"] as const).map((side) => (
            <pattern key={side} id={`oi-hatch-${side}`} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
              <rect width="7" height="7" fill={side === "pe" ? PUT : CALL} fillOpacity="0.35" />
              <line x1="0" y1="0" x2="0" y2="7" stroke={side === "pe" ? PUT : CALL} strokeWidth="3.2" />
            </pattern>
          ))}
        </defs>
        {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={W - pad.right} y1={y(tick)} y2={y(tick)} stroke="#1c3442" /><text x={pad.left - 6} y={y(tick) + 4} fill="#8aa1a8" fontSize={font} textAnchor="end">{oiText(tick)}</text></g>)}
        {rows.map((row, i) => <line key={`v${row.strike}`} x1={cx(i)} x2={cx(i)} y1={pad.top} y2={pad.top + innerH} stroke="#132733" />)}
        {hover !== null ? <rect x={pad.left + cw * hover} y={pad.top} width={cw} height={innerH} fill="rgba(90,169,255,0.07)" /> : null}
        {rows.map((row, i) => (
          <g key={row.strike}>
            {bar(row, "pe", pad.left + cw * i + cw * 0.14, cw * 0.34)}
            {bar(row, "ce", pad.left + cw * i + cw * 0.52, cw * 0.34)}
            {i % labelEvery === 0 ? <text x={cx(i)} y={pad.top + innerH + 16} fill="#c5d6da" fontSize={font} textAnchor="middle">{row.strike}</text> : null}
          </g>
        ))}
        {!showOi ? <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} stroke="#4b6772" /> : null}
        {spotX !== null ? (() => {
          const text = `${symbol} ${price(spot)}`; const boxW = text.length * font * 0.62 + 16;
          const left = Math.min(Math.max(spotX - boxW / 2, 2), W - boxW - 2);
          return <><line x1={spotX} x2={spotX} y1={pad.top} y2={pad.top + innerH} stroke="#aab8bd" strokeDasharray="5 4" /><rect x={left} y={H - 26} width={boxW} height={20} rx="4" fill="#1d3542" /><text x={left + boxW / 2} y={H - 12} fill="#d8e3e6" fontSize={font} textAnchor="middle">{text}</text></>;
        })() : null}
        {analysis.atm !== null && rows.findIndex((row) => row.strike === analysis.atm) >= 0 ? <circle cx={cx(rows.findIndex((row) => row.strike === analysis.atm))} cy={pad.top + innerH} r="5" fill="none" stroke={PUT} strokeWidth="2" /> : null}
      </svg>
      {shown ? (
        <div className="oi-tip" style={{ left: tipLeft }} role="status">
          <b>Strike {shown.strike}</b>
          <span><i style={{ background: PUT }} />Put OI at {clock(analysis.base.time)}<em>{oiText(shown.pe_base)}</em></span>
          <span><i className="oi-hatch-swatch oi-hatch-put" />Put OI chg<em className={tone(shown.pe_chg)}>{oiText(shown.pe_chg, true)}</em></span>
          <span className="oi-tip-now oi-tip-put">Put OI at {clock(analysis.current.time)}<em>{oiText(shown.pe_now)}</em></span>
          <hr />
          <span><i style={{ background: CALL }} />Call OI at {clock(analysis.base.time)}<em>{oiText(shown.ce_base)}</em></span>
          <span><i className="oi-hatch-swatch oi-hatch-call" />Call OI chg<em className={tone(-shown.ce_chg)}>{oiText(shown.ce_chg, true)}</em></span>
          <span className="oi-tip-now oi-tip-call">Call OI at {clock(analysis.current.time)}<em>{oiText(shown.ce_now)}</em></span>
        </div>
      ) : null}
      <div className="oi-legend">
        <span><i style={{ background: PUT }} />Put OI</span><span><i className="oi-hatch-swatch oi-hatch-put" />Increase</span><span><i className="oi-outline" style={{ borderColor: PUT }} />Decrease</span>
        <span><i style={{ background: CALL }} />Call OI</span><span><i className="oi-hatch-swatch oi-hatch-call" />Increase</span><span><i className="oi-outline" style={{ borderColor: CALL }} />Decrease</span>
      </div>
    </div>
  );
}

/** Index price (top) against the change in call / put writers' OI since the base (bottom), per 3-minute sample. */
function PriceVsOi({ analysis, symbol }: { analysis: OiAnalysis; symbol: string }) {
  const points = analysis.series.filter((point) => point.spot !== null);
  const [hover, setHover] = useState<number | null>(null);
  const [wrap, measured] = useWidth();
  if (points.length < 2) return <div ref={wrap}><p className="isa-muted">The price vs OI chart fills in as the day&apos;s 3-minute samples are stored.</p></div>;
  const W = measured; const H = 320; const pad = { left: W < 600 ? 58 : 70, right: 10 }; const priceTop = 14; const priceH = 110; const oiTop = 158; const oiH = 120;
  const t0 = Date.parse(points[0].at); const t1 = Date.parse(points[points.length - 1].at);
  const x = (at: string) => pad.left + ((Date.parse(at) - t0) / (t1 - t0 || 1)) * (W - pad.left - pad.right);
  const spots = points.map((point) => point.spot as number); const pLo = Math.min(...spots); const pHi = Math.max(...spots); const pPad = (pHi - pLo || pHi * 0.001) * 0.1;
  const py = (value: number) => priceTop + ((pHi + pPad - value) / (pHi - pLo + 2 * pPad)) * priceH;
  const changes = points.flatMap((point) => [point.ce_chg, point.pe_chg, 0]); const cLo = Math.min(...changes); const cHi = Math.max(...changes); const cPad = (cHi - cLo || 1) * 0.1;
  const cy = (value: number) => oiTop + ((cHi + cPad - value) / (cHi - cLo + 2 * cPad)) * oiH;
  const line = (pick: (point: (typeof points)[number]) => number, yy: (value: number) => number) => points.map((point, i) => `${i ? "L" : "M"}${x(point.at).toFixed(1)},${yy(pick(point)).toFixed(1)}`).join("");
  const labels = points.filter((_, i) => i % Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(W / 95)))) === 0);
  const shown = hover === null ? null : points[hover];
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0; points.forEach((point, i) => { if (Math.abs(x(point.at) - px) < Math.abs(x(points[best].at) - px)) best = i; });
    setHover(best);
  };
  return (
    <div className="oi-pvo" ref={wrap}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${symbol} price against call and put OI change`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {[pLo, (pLo + pHi) / 2, pHi].map((value) => <g key={`p${value}`}><line x1={pad.left} x2={W - pad.right} y1={py(value)} y2={py(value)} stroke="#1c3442" /><text x={pad.left - 8} y={py(value) + 4} fill="#8aa1a8" fontSize="11" textAnchor="end">{price(Math.round(value))}</text></g>)}
        {[cLo, 0, cHi].map((value) => <g key={`c${value}`}><line x1={pad.left} x2={W - pad.right} y1={cy(value)} y2={cy(value)} stroke={value === 0 ? "#4b6772" : "#1c3442"} /><text x={pad.left - 8} y={cy(value) + 4} fill="#8aa1a8" fontSize="11" textAnchor="end">{oiText(value, true)}</text></g>)}
        <text x={pad.left} y={oiTop - 8} fill="#8aa1a8" fontSize="11">OI change since {analysis.base.time}: call writers (red), put writers (green)</text>
        <path d={line((point) => point.spot as number, py)} fill="none" stroke="#5aa9ff" strokeWidth="2" />
        <path d={line((point) => point.ce_chg, cy)} fill="none" stroke={CALL} strokeWidth="2" />
        <path d={line((point) => point.pe_chg, cy)} fill="none" stroke={PUT} strokeWidth="2" />
        {labels.map((point) => <text key={point.at} x={x(point.at)} y={H - 6} fill="#8aa1a8" fontSize="11" textAnchor="middle">{point.time}</text>)}
        {shown ? <line x1={x(shown.at)} x2={x(shown.at)} y1={priceTop} y2={oiTop + oiH} stroke="#5aa9ff" strokeDasharray="3 3" /> : null}
      </svg>
      <p className="oi-pvo-readout">{shown ? <>{shown.time} · {symbol} <b>{price(shown.spot)}</b> · call OI <b className={tone(-shown.ce_chg)}>{oiText(shown.ce_chg, true)}</b> · put OI <b className={tone(shown.pe_chg)}>{oiText(shown.pe_chg, true)}</b> · PCR <b>{shown.pcr?.toFixed(2) ?? "--"}</b></> : <span className="isa-muted">Blue: {symbol} price. Hover to read each 3-minute sample.</span>}</p>
    </div>
  );
}

function StrikeList({ title, rows, side }: { title: string; rows: StrikeRow[]; side: "ce" | "pe" }) {
  return (
    <div className="oi-list">
      <small>{title}</small>
      {rows.length ? rows.map((row) => <span key={row.strike}><b>{row.strike}</b><em className={side === "pe" ? tone(row.pe_chg) : tone(-row.ce_chg)}>{oiText(side === "pe" ? row.pe_chg : row.ce_chg, true)}</em></span>) : <span className="isa-muted">none</span>}
    </div>
  );
}

function Analysis({ analysis, symbol }: { analysis: OiAnalysis; symbol: string }) {
  const wall = (now: OiAnalysis["support"], before: OiAnalysis["support"]) => (now ? `${now.strike} (${oiText(now.oi)})${before && before.strike !== now.strike ? ` · was ${before.strike}` : ""}` : "--");
  return (
    <div className="oi-analysis">
      <div className={`oi-bias oi-bias-${biasTone(analysis.bias.score)}`}>
        <span><small>OI read</small><b className={biasTone(analysis.bias.score)}>{analysis.bias.label}</b><em>score {analysis.bias.score > 0 ? "+" : ""}{analysis.bias.score}</em></span>
        <ul>{analysis.bias.lines.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>
      <div className="ost-factors">
        <span><small>Support (most put OI)</small><b className="gain">{wall(analysis.support, analysis.support_base)}</b><em>at or below spot</em></span>
        <span><small>Resistance (most call OI)</small><b className="loss">{wall(analysis.resistance, analysis.resistance_base)}</b><em>at or above spot</em></span>
        <span><small>Max pain</small><b>{analysis.max_pain ?? "--"}</b><em>expiry {analysis.expiry}</em></span>
        <span><small>PCR · near ATM</small><b>{analysis.totals.pcr_now?.toFixed(2) ?? "--"} · {analysis.totals.pcr_atm?.toFixed(2) ?? "--"}</b><em>±3 strikes of {analysis.atm ?? "--"}</em></span>
        <span><small>Call writers</small><b className={tone(-analysis.totals.ce_chg)}>{oiText(analysis.totals.ce_chg, true)}</b><em>{pct(analysis.totals.ce_chg_pct)} since {analysis.base.time}</em></span>
        <span><small>Put writers</small><b className={tone(analysis.totals.pe_chg)}>{oiText(analysis.totals.pe_chg, true)}</b><em>{pct(analysis.totals.pe_chg_pct)} since {analysis.base.time}</em></span>
      </div>
      <div className="oi-lists">
        <StrikeList title="Put writing (support building)" rows={analysis.put_buildup} side="pe" />
        <StrikeList title="Call writing (resistance building)" rows={analysis.call_buildup} side="ce" />
        <StrikeList title="Put unwinding (support giving way)" rows={analysis.put_unwinding} side="pe" />
        <StrikeList title="Call unwinding (short covering)" rows={analysis.call_unwinding} side="ce" />
      </div>
      <h4 className="smh-sub">{symbol} price vs option writers&apos; OI</h4>
      <PriceVsOi analysis={analysis} symbol={symbol} />
    </div>
  );
}

/** One card per index: price, PCR, writer OI change, walls and the OI read. */
function IndexCards({ summary, selected, onSelect }: { summary: Summary | null; selected: string; onSelect: (symbol: string) => void }) {
  return (
    <div className="oi-cards">
      {INDICES.map(([id, name]) => {
        const analysis = summary?.indices.find((item) => item.symbol === id)?.analysis ?? null;
        return (
          <button type="button" key={id} className={`oi-card ${selected === id ? "on" : ""}`} onClick={() => onSelect(id)} aria-pressed={selected === id}>
            <span className="oi-card-head"><b>{name}</b>{analysis ? <em className={biasTone(analysis.bias.score)}>{analysis.bias.label}</em> : null}</span>
            {analysis ? (
              <>
                <span className="oi-card-price"><b>{price(analysis.current.spot)}</b><em className={tone(analysis.spot_chg)}>{analysis.spot_chg === null ? "" : `${analysis.spot_chg > 0 ? "+" : ""}${price(analysis.spot_chg)} (${pct(analysis.spot_chg_pct)})`} since {analysis.base.time}</em></span>
                <span><small>PCR</small><b>{analysis.totals.pcr_now?.toFixed(2) ?? "--"}</b></span>
                <span><small>Call OI chg</small><b className={tone(-analysis.totals.ce_chg)}>{oiText(analysis.totals.ce_chg, true)}</b></span>
                <span><small>Put OI chg</small><b className={tone(analysis.totals.pe_chg)}>{oiText(analysis.totals.pe_chg, true)}</b></span>
                <span><small>Support / resistance</small><b>{analysis.support?.strike ?? "--"} / {analysis.resistance?.strike ?? "--"}</b></span>
                <span><small>Max pain</small><b>{analysis.max_pain ?? "--"}</b></span>
                {analysis.recent ? <small className="oi-card-recent">Last {analysis.recent.minutes} min: {analysis.recent.label}</small> : null}
              </>
            ) : <span className="isa-muted">{summary ? "No OI data yet" : "Loading…"}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const OiDashboard = memo(function OiDashboard() {
  const [symbol, setSymbol] = useState<string>("NIFTY");
  const [date, setDate] = useState<string>(today());
  const [range, setRange] = useState(10);
  const [showOi, setShowOi] = useState(true);
  const [samples, setSamples] = useState<StrikeSample[]>([]);
  const [vix, setVix] = useState<Vix>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [replay, setReplay] = useState<number | null>(null); // null = latest
  const [playing, setPlaying] = useState(false);
  // Phones start with fewer strikes so each bar stays readable (±10 is 21 strikes).
  useEffect(() => { if (window.innerWidth < 600) setRange(5); }, []);
  const key = `${symbol}|${date}`;
  const keyRef = useRef(key);

  const load = useCallback(async (full: boolean) => {
    const current = keyRef.current;
    const [sym, day] = current.split("|");
    try {
      const since = full ? null : samplesRef.current.filter((sample) => !sample.live).at(-1)?.at ?? null;
      const response = await fetch(`/api/oi-analysis?symbol=${sym}&date=${day}${since ? `&since=${encodeURIComponent(since)}` : ""}`, { cache: "no-store" });
      const body = await response.json() as { samples?: StrikeSample[]; vix?: Vix; notes?: string[]; error?: string };
      if (keyRef.current !== current) return;
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      const incoming = body.samples ?? [];
      setSamples((existing) => {
        const kept = full ? [] : existing.filter((sample) => !sample.live);
        const seen = new Set(kept.map((sample) => sample.at));
        return [...kept, ...incoming.filter((sample) => !seen.has(sample.at))].sort((a, b) => a.at.localeCompare(b.at));
      });
      setVix(body.vix ?? null); setNotes(body.notes ?? []); setError(null);
    } catch (failure) { if (keyRef.current === current) setError(failure instanceof Error ? failure.message : "OI data unavailable"); }
  }, []);
  const samplesRef = useRef<StrikeSample[]>([]);
  samplesRef.current = samples;

  const loadSummary = useCallback(async () => {
    try {
      const body = await fetch(`/api/oi-analysis?summary=1&date=${date}`, { cache: "no-store" }).then((response) => response.json()) as Summary;
      if (Array.isArray(body.indices)) setSummary(body);
    } catch { /* keep the last summary */ }
  }, [date]);

  useEffect(() => {
    keyRef.current = key;
    setSamples([]); setReplay(null); setPlaying(false);
    void load(true);
    if (date !== today()) return;
    const timer = setInterval(() => { if (!document.hidden) void load(false); }, 60_000);
    return () => clearInterval(timer);
  }, [date, key, load]);
  useEffect(() => {
    void loadSummary();
    if (date !== today()) return;
    const timer = setInterval(() => { if (!document.hidden) void loadSummary(); }, 90_000);
    return () => clearInterval(timer);
  }, [date, loadSummary]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setReplay((value) => {
      const next = (value ?? 0) + 1;
      if (next >= samplesRef.current.length - 1) { setPlaying(false); return null; }
      return next;
    }), 450);
    return () => clearInterval(timer);
  }, [playing]);

  const analysis = useMemo(() => analyzeOi(samples, { range, at: replay ?? undefined }), [range, replay, samples]);
  const name = INDICES.find(([id]) => id === symbol)?.[1] ?? symbol;

  return (
    <div className="oi-page">
      <section className="mi-card oi-panel" aria-label="Open interest by strike">
        <div className="algo-panel-head">
          <div><span className="algo-kicker">OPEN INTEREST · STRIKE-WISE · STORED EVERY 3 MIN</span><h2>{name} open interest</h2></div>
          <div className="hedge-controls">
            <div className="ost-tabs" role="tablist">{INDICES.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={id === symbol} className={id === symbol ? "active" : ""} onClick={() => setSymbol(id)}>{label}</button>)}</div>
            <label>Day<input type="date" value={date} max={today()} onChange={(event) => event.target.value && setDate(event.target.value)} /></label>
            <label>Strikes<select value={range} onChange={(event) => setRange(Number(event.target.value))}>{RANGES.map((value) => <option key={value} value={value}>±{value}</option>)}</select></label>
          </div>
        </div>
        {error ? <p className="isa-alert">{analysis ? `Couldn't refresh: ${error}. Showing the last data.` : error}</p> : null}
        {notes.map((note) => <p key={note} className="isa-muted">{note}</p>)}
        {!analysis ? <div className="algo-empty">{error ? "No OI data." : `Loading the ${name} option chain…`}</div> : (
          <>
            <div className="oi-stats">
              <span><small>INDIA VIX</small><b>{vix ? price(vix.value) : "--"}</b>{vix?.change !== null && vix?.change !== undefined ? <em className={tone(vix.change)}>{vix.change > 0 ? "+" : ""}{vix.change.toFixed(2)}</em> : null}</span>
              <span><small>PCR</small><b>{analysis.totals.pcr_now?.toFixed(2) ?? "--"}</b><em>from {analysis.totals.pcr_base?.toFixed(2) ?? "--"}</em></span>
              <span><small>Call OI change</small><b className={tone(-analysis.totals.ce_chg)}>{oiText(analysis.totals.ce_chg, true)}</b><em>{pct(analysis.totals.ce_chg_pct)}</em></span>
              <span><small>Put OI change</small><b className={tone(analysis.totals.pe_chg)}>{oiText(analysis.totals.pe_chg, true)}</b><em>{pct(analysis.totals.pe_chg_pct)}</em></span>
              <span><small>{name} at {clock(analysis.base.time)}</small><b>{price(analysis.base.spot)}</b></span>
              <span><small>{name} at {clock(analysis.current.time)}{analysis.current.live ? " (live)" : ""}</small><b>{price(analysis.current.spot)}</b><em className={tone(analysis.spot_chg)}>{analysis.spot_chg === null ? "" : `${analysis.spot_chg > 0 ? "+" : ""}${price(analysis.spot_chg)}`}</em></span>
            </div>
            <StrikeChart analysis={analysis} showOi={showOi} symbol={name} />
            <div className="oi-controls">
              <label className="scalper-switch"><input type="checkbox" checked={showOi} onChange={(event) => setShowOi(event.target.checked)} /><span /> Show OI</label>
              <button type="button" className="oi-replay" disabled={samples.length < 2} onClick={() => { if (playing) { setPlaying(false); return; } setReplay(0); setPlaying(true); }}>{playing ? "⏸ Pause" : "▶ Replay change"}</button>
              <input type="range" min={0} max={Math.max(0, samples.length - 1)} value={replay ?? Math.max(0, samples.length - 1)} disabled={samples.length < 2} aria-label="Replay to a sample time" onChange={(event) => { setPlaying(false); const value = Number(event.target.value); setReplay(value >= samples.length - 1 ? null : value); }} />
              <small className="isa-muted">{analysis.current.time} IST · {samples.length} sample{samples.length === 1 ? "" : "s"} today (every 3 min) · base {analysis.base.time}{replay !== null ? " · replaying" : ""}</small>
            </div>
          </>
        )}
      </section>

      <section className="mi-card oi-panel" aria-label="OI analysis against index prices">
        <div className="algo-panel-head"><div><span className="algo-kicker">ADVANCED OI ANALYSIS · NIFTY · BANK NIFTY · SENSEX</span><h2>Option writers against the index price</h2></div></div>
        <IndexCards summary={summary} selected={symbol} onSelect={setSymbol} />
        {analysis ? <Analysis analysis={analysis} symbol={name} /> : null}
        <p className="mi-note">Call / put OI: nearest expiry, strikes within ±6% of spot, stored every 3 minutes in market hours; changes are against the day&apos;s first sample on the strikes both share. Writers hold the short side: put writing is support, call writing is resistance. Analysis only, not investment advice.</p>
      </section>
    </div>
  );
});
