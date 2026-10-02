import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { smcSignalSource } from "./smc-strategy";
import { aggregate, istDay, istMinute, listSignalSource, mtfSignalSource, type Signal } from "./strategy-backtest";
import { trendPullbackSignalSource } from "./trend-pullback-strategy";

/**
 * Smart combo: one decision-maker over the four playbooks, the way a discretionary trader uses them.
 *
 * The edge of each playbook depends on the KIND OF DAY, so the first question is always "what is
 * today?" (regime), and only the playbooks that fit the regime may trade:
 *
 *   regime          | allowed                                                        | blocked
 *   ----------------+----------------------------------------------------------------+----------------------------
 *   TREND (up/down) | trend pullbacks; ORB break in the trend's direction;           | anything against the trend
 *                   | SMC sweeps in the trend's direction (sweep of a pullback low)  |
 *   RANGE           | SMC sweep reversals from the outer 30% of the day's range,     | ORB and trend continuation;
 *                   | re-targeted to value: T1 = VWAP (≥ 1R away), T2 just beyond    | fades from mid-range
 *   UNDECIDED       | SMC sweeps of daily levels; ORB breaks agreeing with the open  | trend pullbacks (no trend);
 *                   | AND confirmed by the AI multi-timeframe read                   | unconfirmed opening breakouts
 *
 * Regime (from closed 5m bars): TREND when the session's efficiency ≥ 0.30 and it is ≥ 0.35 ADR from
 * the open; RANGE after 10:15 when efficiency < 0.20 and it is < 0.30 ADR from the open.
 *
 * The AI multi-timeframe engine does not originate trades here (on its own it overtrades chop); it
 * VOTES: an opposite AI read vetoes the trade, an agreeing one adds confidence. Two playbooks pointing
 * the same way within 15 minutes add confidence too. Stops/targets come from the playbook that fired.
 */

export type SmartFunnel = {
  regimeBars: { TREND: number; RANGE: number; UNDECIDED: number };
  candidates: Record<"TREND" | "SMC" | "ORB", number>;
  accepted: Record<"TREND" | "SMC" | "ORB", number>;
  rejectedByRegime: number;
  rangeFadesRetargeted: number;
  vetoedByAi: number;
  confirmedByAi: number;
  confluence: number;
};

type Component = "TREND" | "SMC" | "ORB";
type Regime = { kind: "TREND" | "RANGE" | "UNDECIDED"; dir: 1 | -1 | 0; efficiency: number; progress: number };

const LABEL: Record<Component, string> = { TREND: "trend pullback", SMC: "liquidity sweep", ORB: "ORB retest" };

export function smartSignalSource(symbol: string, minute: Bar[], daily: Bar[], options: { orbSignals?: Signal[] | null } = {}) {
  const trend = trendPullbackSignalSource(symbol, minute, daily);
  const smc = smcSignalSource(symbol, minute, daily);
  const orb = options.orbSignals ? listSignalSource(options.orbSignals) : null;
  const mtf = mtfSignalSource(symbol, minute, daily);
  const m5 = aggregate(minute, 5);
  const funnel: SmartFunnel = { regimeBars: { TREND: 0, RANGE: 0, UNDECIDED: 0 }, candidates: { TREND: 0, SMC: 0, ORB: 0 }, accepted: { TREND: 0, SMC: 0, ORB: 0 }, rejectedByRegime: 0, rangeFadesRetargeted: 0, vetoedByAi: 0, confirmedByAi: 0, confluence: 0 };

  // Regime tracker over closed 5m bars.
  let next5 = 0;
  let day = "";
  let dayOpen = NaN;
  let travel = 0;
  let lastClose = NaN;
  let ranges: number[] = [];
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let regime: Regime = { kind: "UNDECIDED", dir: 0, efficiency: 0, progress: 0 };
  // Session VWAP and range from 1m bars (equal-weight when the index has no volume).
  let next1 = 0;
  let vwapDay = ""; let pv = 0; let vol = 0; let tpSum = 0; let tpN = 0; let vwap = NaN; let sessionHigh = -Infinity; let sessionLow = Infinity;
  const recent: Array<{ time: number; side: 1 | -1; component: Component }> = [];
  let processed = -1;

  function adr() {
    const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000 - 330 * 60;
    const fromDaily = daily.filter((bar) => bar.time < dayStart && istDay(bar.time) < day).slice(-10).map((bar) => bar.high - bar.low);
    const all = [...fromDaily.slice(0, Math.max(0, 10 - ranges.length)), ...ranges].filter((range) => range > 0);
    return all.length >= 3 ? all.reduce((sum, range) => sum + range, 0) / all.length : NaN;
  }

  function advanceMinute(index: number) {
    while (next1 <= index) {
      const bar = minute[next1++];
      const barDay = istDay(bar.time);
      if (barDay !== vwapDay) { vwapDay = barDay; pv = 0; vol = 0; tpSum = 0; tpN = 0; sessionHigh = -Infinity; sessionLow = Infinity; }
      const typical = (bar.high + bar.low + bar.close) / 3;
      pv += typical * (bar.volume ?? 0); vol += bar.volume ?? 0; tpSum += typical; tpN += 1;
      vwap = vol > 0 ? pv / vol : tpSum / tpN;
      sessionHigh = Math.max(sessionHigh, bar.high); sessionLow = Math.min(sessionLow, bar.low);
    }
  }

  /** Range-day fade: only from the outer 30% of the day's range, aimed back at value (VWAP). */
  function rangeFade(signal: Signal, entry: number): Signal | string {
    const range = sessionHigh - sessionLow;
    if (!(range > 0) || !Number.isFinite(vwap)) return "no session range yet";
    const fromEdge = signal.side > 0 ? (entry - sessionLow) / range : (sessionHigh - entry) / range;
    if (fromEdge > 0.3) return "range day: fade is not at the range extreme";
    const risk = (entry - signal.stop) * signal.side;
    const toValue = (vwap - entry) * signal.side;
    if (!(risk > 0) || toValue < risk) return "range day: VWAP is less than 1R away";
    funnel.rangeFadesRetargeted += 1;
    const round = (value: number) => Math.round(value * 100) / 100;
    return { ...signal, target1: round(vwap), target2: round(vwap + signal.side * 0.5 * toValue), reason: `${signal.reason} Range-day fade: T1 at VWAP ${round(vwap)}, T2 just beyond.` };
  }

  function advance(t: number) {
    while (next5 < m5.length && m5[next5].time + 300 <= t) {
      const bar = m5[next5++];
      const barDay = istDay(bar.time);
      if (barDay !== day) {
        if (day && Number.isFinite(dayHigh)) ranges = [...ranges, dayHigh - dayLow].slice(-10);
        day = barDay; dayOpen = bar.open; travel = Math.abs(bar.close - bar.open); lastClose = bar.close; dayHigh = bar.high; dayLow = bar.low;
      } else {
        travel += Math.abs(bar.close - lastClose); lastClose = bar.close; dayHigh = Math.max(dayHigh, bar.high); dayLow = Math.min(dayLow, bar.low);
      }
      const net = lastClose - dayOpen;
      const efficiency = travel > 0 ? Math.abs(net) / travel : 0;
      const average = adr();
      const progress = Number.isFinite(average) && average > 0 ? Math.abs(net) / average : 0;
      const clock = istMinute(bar.time + 300);
      const dir = (Math.sign(net) || 0) as 1 | -1 | 0;
      regime = efficiency >= 0.3 && progress >= 0.35 && clock >= 10 * 60
        ? { kind: "TREND", dir, efficiency, progress }
        : clock >= 10 * 60 + 15 && efficiency < 0.2 && progress < 0.3
          ? { kind: "RANGE", dir: 0, efficiency, progress }
          : { kind: "UNDECIDED", dir, efficiency, progress };
    }
  }

  function allowed(component: Component, signal: Signal): string | null {
    const side = signal.side;
    if (regime.kind === "TREND") {
      if (side !== regime.dir) return `against the ${regime.dir > 0 ? "up" : "down"}-trend day`;
      return null;
    }
    if (regime.kind === "RANGE") return component === "SMC" ? null : "range day: breakouts and continuation fail here";
    // UNDECIDED: no trend pullbacks; ORB only with the day's direction; SMC only off daily levels.
    if (component === "TREND") return "trend not confirmed";
    if (component === "ORB") return regime.dir !== 0 && side !== regime.dir ? "ORB against the day's direction" : null;
    return /previous-day (high|low)|equal highs/.test(signal.reason) ? null : "undecided day: only sweeps of daily levels / equal highs-lows";
  }

  const source = (index: number): Signal | null => {
    if (index <= processed) return null; // sequential use only (the route precomputes signals)
    processed = index;
    const t = minute[index].time + 60;
    advance(t);
    advanceMinute(index);
    funnel.regimeBars[regime.kind] += 1;
    const candidates: Array<{ component: Component; signal: Signal }> = [];
    const pushIf = (component: Component, signal: Signal | null) => { if (signal) { funnel.candidates[component] += 1; candidates.push({ component, signal }); } };
    pushIf("TREND", trend(index));
    pushIf("SMC", smc(index));
    if (orb) pushIf("ORB", orb(index, minute));
    if (!candidates.length) return null;

    const scored: Array<{ component: Component; signal: Signal; confidence: number; notes: string[] }> = [];
    for (const candidate of candidates) {
      const { component } = candidate;
      let { signal } = candidate;
      recent.push({ time: t, side: signal.side, component });
      const blocked = allowed(component, signal);
      if (blocked) { funnel.rejectedByRegime += 1; continue; }
      if (regime.kind === "RANGE" && component === "SMC") {
        const faded = rangeFade(signal, minute[index].close);
        if (typeof faded === "string") { funnel.rejectedByRegime += 1; continue; }
        signal = faded;
      }
      const notes: string[] = [];
      let confidence = signal.confidence ?? 70;
      // The AI multi-timeframe vote.
      const ai = mtf(index);
      if (ai && ai.side !== signal.side && (ai.confidence ?? 0) >= 65) { funnel.vetoedByAi += 1; continue; }
      // Before the day type is known, an opening-range break is a coin flip that eats the day's risk
      // budget: take it only when the top-down read agrees.
      if (component === "ORB" && regime.kind === "UNDECIDED" && !(ai && ai.side === signal.side)) { funnel.rejectedByRegime += 1; continue; }
      if (ai && ai.side === signal.side) { confidence += 8; funnel.confirmedByAi += 1; notes.push(`AI multi-timeframe confirms (${ai.confidence ?? "?"}%)`); }
      // Confluence: another playbook pointed the same way in the last 15 minutes.
      const partners = [...new Set(recent.filter((item) => item.component !== component && item.side === signal.side && t - item.time <= 15 * 60).map((item) => LABEL[item.component]))];
      if (partners.length) { confidence += 7; funnel.confluence += 1; notes.push(`confluence with ${partners.join(" + ")}`); }
      scored.push({ component, signal, confidence: Math.min(100, confidence), notes });
    }
    while (recent.length && t - recent[0].time > 30 * 60) recent.shift();
    if (!scored.length) return null;
    const best = scored.sort((a, b) => b.confidence - a.confidence)[0];
    funnel.accepted[best.component] += 1;
    const regimeText = regime.kind === "TREND" ? `trend day ${regime.dir > 0 ? "↑" : "↓"} (efficiency ${regime.efficiency.toFixed(2)}, ${regime.progress.toFixed(1)}× ADR)` : regime.kind === "RANGE" ? `range day (efficiency ${regime.efficiency.toFixed(2)})` : "undecided day";
    return {
      ...best.signal,
      confidence: best.confidence,
      strategy: `Smart combo · ${LABEL[best.component]}`,
      reason: `[${regimeText} → ${LABEL[best.component]}${best.notes.length ? `; ${best.notes.join("; ")}` : ""}] ${best.signal.reason}`,
    };
  };
  return Object.assign(source, { funnel });
}
