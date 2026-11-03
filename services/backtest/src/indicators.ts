/** Pure indicator maths shared by the strategies and the browser chart (no imports). */

type Hlc = { high: number; low: number; close: number };

/** Wilder ADX with +DI / −DI per bar (null until 2 x period bars), as scalp_strategy.adx_series. */
export function adxSeries(bars: Hlc[], period: number): Array<[number, number, number] | null> {
  const out: Array<[number, number, number] | null> = bars.map(() => null);
  if (period <= 0 || bars.length < 2 * period) return out;
  let tr = 0; let pdm = 0; let mdm = 0; let adx: number | null = null;
  const dx: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const cur = bars[i]; const prev = bars[i - 1];
    const up = cur.high - prev.high; const down = prev.low - cur.low;
    const t = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    const p = up > down && up > 0 ? up : 0;
    const m = down > up && down > 0 ? down : 0;
    if (i <= period) { tr += t; pdm += p; mdm += m; if (i < period) continue; }
    else { tr = tr - tr / period + t; pdm = pdm - pdm / period + p; mdm = mdm - mdm / period + m; }
    const plus = tr > 0 ? 100 * pdm / tr : 0;
    const minus = tr > 0 ? 100 * mdm / tr : 0;
    dx.push(plus + minus > 0 ? 100 * Math.abs(plus - minus) / (plus + minus) : 0);
    if (adx === null) { if (dx.length < period) continue; adx = dx.reduce((sum, value) => sum + value, 0) / period; }
    else adx = (adx * (period - 1) + dx[dx.length - 1]) / period;
    out[i] = [adx, plus, minus];
  }
  return out;
}
