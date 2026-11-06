// Hedge builder: option-BUY-only combinations (NIFTY / BANKNIFTY / SENSEX), ranked for the lowest
// risk and the highest reward : risk.
//
// Every structure only buys options (a CE leg and a PE leg, in a lot ratio), so the most it can
// lose is the premium paid: risk is defined and known before entry. Each combination is priced on
// the live chain and judged at expiry on the move the market itself prices (the expected move
// from the ATM straddle / IV). Options are priced so that an ordinary (1×) expected move roughly
// pays for the premium, so a bought combination only earns on a breakout; reward is measured there:
//
//   max loss         = premium paid (lots × premium per leg × lot size)
//   stop             = 40% of the premium (the planned exit; the risk actually taken)
//   reward           = payoff at spot ± 1.5 × expected move (a breakout), minus the premium paid
//   reward : risk    = reward on the favoured side / premium paid (both sides when neutral);
//                      reward : stop is the same reward over the planned 40% stop
//   hedge            = what the other leg gets back on a wrong-way breakout of the same size
//   prob. of profit  = lognormal probability (ATM IV) that expiry lands beyond the breakevens
//
// The market bias (trend + PCR, as the strategy selector) decides the favoured side: neutral →
// straddles and strangles that pay both ways; bullish → call-heavy hedges (strap, hedged call);
// bearish → put-heavy hedges (strip, hedged put). Analysis only: nothing here places orders.

import { buildOptionStrategy, probabilityAbove, timeToExpiry, type BiasLabel, type ChainRow, type Factors, type TrendInput } from "./option-strategy";

export type HedgeLeg = { type: "CE" | "PE"; strike: number; lots: number; premium: number; delta: number | null; theta: number | null; openInterest: number };
export type HedgeId = "LONG_STRADDLE" | "LONG_STRANGLE" | "STRAP" | "STRIP" | "HEDGED_CALL" | "HEDGED_PUT" | "GUTS";
export type HedgePlan = {
  id: HedgeId; name: string; view: string; legs: HedgeLeg[]; lotSize: number;
  /** Premium paid for the whole combination (all lots, × lot size): also the maximum loss. */
  debit: number; maxLoss: number;
  rewardUp: number; rewardDown: number; reward: number; riskReward: number; rewardToStop: number;
  /** Index points of the breakout the reward is measured at (1.5 × expected move). */
  breakoutPoints: number;
  /** P&L at an ordinary ±1× expected move: what the trade does when no breakout comes. */
  atExpectedUp: number; atExpectedDown: number;
  /** Share of the premium the hedge leg recovers on a wrong-way expected move (1 = fully covered). */
  hedgeCover: number;
  breakevens: number[]; probabilityOfProfit: number; netDelta: number | null; thetaPerDay: number | null;
  payoff: Array<{ price: number; pnl: number }>;
  target: number; stop: number; rationale: string[]; exit: string[];
};
export type HedgeInput = { symbol: string; spot: number; expiry: string; chain: ChainRow[]; vix?: number | null; trend?: TrendInput | null; maxRisk?: number | null; now?: Date };
export type HedgeRecommendation = {
  factors: Factors; side: "BOTH" | "UP" | "DOWN"; bias: BiasLabel; primary: HedgePlan | null; alternatives: HedgePlan[];
  considered: number; withinBudget: number; notes: string[];
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const rupees = (value: number) => `${value < 0 ? "−" : "+"}₹${fmt(Math.abs(value))}`;
const RATIOS: Array<[number, number]> = [[1, 1], [2, 1], [1, 2], [3, 2], [2, 3]];
const CE_OFFSETS = [-1, 0, 1, 2, 3];
const PE_OFFSETS = [1, 0, -1, -2, -3];
const MIN_PREMIUM = 2;
/** A hedge must give back at least this share of the premium on a wrong-way expected move. */
const MIN_HEDGE_COVER = 0.4;
/** Reward is measured at a breakout of this many expected moves. */
export const BREAKOUT_MULTIPLE = 1.5;
const STOP_SHARE = 0.4;

/** P&L at expiry per unit of the lot size (premium paid already subtracted). */
export function payoffAt(legs: HedgeLeg[], price: number) {
  return legs.reduce((sum, leg) => sum + leg.lots * (Math.max(0, leg.type === "CE" ? price - leg.strike : leg.strike - price) - leg.premium), 0);
}

/** Breakevens at expiry, by scanning ±25% around spot. */
export function breakevensOf(legs: HedgeLeg[], spot: number) {
  const out: number[] = [];
  const step = spot * 0.0005;
  let previousPrice = spot * 0.75;
  let previous = payoffAt(legs, previousPrice);
  for (let price = previousPrice + step; price <= spot * 1.25; price += step) {
    const value = payoffAt(legs, price);
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) out.push(round2(previousPrice + (price - previousPrice) * (0 - previous) / (value - previous)));
    previous = value; previousPrice = price;
  }
  return out;
}

/** Probability (lognormal, ATM IV) that the expiry price lands where the combination is in profit. */
export function profitProbability(legs: HedgeLeg[], spot: number, breakevens: number[], sigma: number, years: number) {
  const edges = [0, ...breakevens, Infinity];
  let probability = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const low = edges[index]; const high = edges[index + 1];
    const mid = high === Infinity ? low * 1.1 + 1 : low === 0 ? high * 0.9 : (low + high) / 2;
    if (payoffAt(legs, mid) <= 0) continue;
    probability += probabilityAbove(spot, low, sigma, years) - (high === Infinity ? 0 : probabilityAbove(spot, high, sigma, years));
  }
  return Math.max(0, Math.min(1, probability));
}

function nameOf(ce: HedgeLeg, pe: HedgeLeg, atm: number): { id: HedgeId; name: string; view: string } {
  const ceItm = ce.strike < atm; const peItm = pe.strike > atm;
  if (ce.lots > pe.lots) return ce.strike === atm && pe.strike === atm ? { id: "STRAP", name: `Strap ${ce.lots}:${pe.lots}`, view: "Bullish, hedged: extra calls for the up-move, a put pays if it falls" } : { id: "HEDGED_CALL", name: `Hedged call ${ce.lots}:${pe.lots}`, view: "Bullish: calls carry the trade, a cheaper put is the insurance" };
  if (pe.lots > ce.lots) return ce.strike === atm && pe.strike === atm ? { id: "STRIP", name: `Strip ${ce.lots}:${pe.lots}`, view: "Bearish, hedged: extra puts for the down-move, a call pays if it rallies" } : { id: "HEDGED_PUT", name: `Hedged put ${ce.lots}:${pe.lots}`, view: "Bearish: puts carry the trade, a cheaper call is the insurance" };
  if (ce.strike === atm && pe.strike === atm) return { id: "LONG_STRADDLE", name: "Long straddle", view: "Big move either way: both ATM options" };
  if (ceItm && peItm) return { id: "GUTS", name: "Long guts", view: "Big move either way, with in-the-money legs" };
  return { id: "LONG_STRANGLE", name: "Long strangle", view: "Big move either way, cheaper out-of-the-money legs" };
}

export function buildHedgeStrategies(input: HedgeInput): HedgeRecommendation {
  const now = input.now ?? new Date();
  const base = buildOptionStrategy({ symbol: input.symbol, spot: input.spot, expiry: input.expiry, chain: input.chain, vix: input.vix ?? null, sentiment: null, trend: input.trend ?? null, now });
  const f = base.factors;
  const side: HedgeRecommendation["side"] = f.bias.score >= 15 ? "UP" : f.bias.score <= -15 ? "DOWN" : "BOTH";
  const lotSize = f.lotSize || 1;
  const em = f.expectedMove;
  const time = timeToExpiry(input.expiry, now);
  const sigma = (f.atmIv ?? f.vix ?? 14) / 100;
  const ce = new Map<number, ChainRow>(); const pe = new Map<number, ChainRow>();
  for (const row of input.chain) if (row.premium >= MIN_PREMIUM && row.strike > 0 && (row.openInterest ?? 1) > 0) (row.contract === "CALL" ? ce : pe).set(row.strike, row);
  const leg = (type: "CE" | "PE", row: ChainRow, lots: number): HedgeLeg => ({ type, strike: row.strike, lots, premium: row.premium, delta: typeof row.delta === "number" ? row.delta : null, theta: typeof row.theta === "number" ? row.theta : null, openInterest: row.openInterest ?? 0 });

  const plans: HedgePlan[] = [];
  for (const co of CE_OFFSETS) for (const po of PE_OFFSETS) {
    if (co < 0 && po > 0) continue; // both legs in the money: paying for intrinsic twice
    const call = ce.get(f.atmStrike + co * f.strikeStep); const put = pe.get(f.atmStrike + po * f.strikeStep);
    if (!call || !put) continue;
    for (const [cl, pl] of RATIOS) {
      const legs = [leg("CE", call, cl), leg("PE", put, pl)];
      const debitUnit = legs.reduce((sum, item) => sum + item.lots * item.premium, 0);
      const debit = round2(debitUnit * lotSize);
      const move = em * BREAKOUT_MULTIPLE;
      const up = payoffAt(legs, f.spot + move) * lotSize; const down = payoffAt(legs, f.spot - move) * lotSize;
      const favoured = side === "UP" ? up : side === "DOWN" ? down : Math.min(up, down);
      const adverse = side === "UP" ? down : side === "DOWN" ? up : Math.min(up, down);
      // Hedge cover: the share of the premium still in hand after a wrong-way expected move.
      const hedgeCover = debit > 0 ? Math.max(0, (adverse + debit) / debit) : 0;
      const breakevens = breakevensOf(legs, f.spot);
      const netDelta = legs.every((item) => item.delta !== null) ? round2(legs.reduce((sum, item) => sum + item.lots * (item.delta as number), 0)) : null;
      const thetaPerDay = legs.every((item) => item.theta !== null) ? round2(legs.reduce((sum, item) => sum + item.lots * (item.theta as number), 0) * lotSize) : null;
      const payoff = Array.from({ length: 41 }, (_, index) => { const price = f.spot - 2 * em + (index * 4 * em) / 40; return { price: round2(price), pnl: round2(payoffAt(legs, price) * lotSize) }; });
      const kind = nameOf(legs[0], legs[1], f.atmStrike);
      plans.push({
        ...kind, legs, lotSize, debit, maxLoss: debit, rewardUp: round2(up), rewardDown: round2(down), reward: round2(favoured),
        riskReward: debit > 0 ? round2(favoured / debit) : 0, rewardToStop: debit > 0 ? round2(favoured / (debit * STOP_SHARE)) : 0, breakoutPoints: round2(move),
        atExpectedUp: round2(payoffAt(legs, f.spot + em) * lotSize), atExpectedDown: round2(payoffAt(legs, f.spot - em) * lotSize), hedgeCover: round2(hedgeCover), breakevens,
        probabilityOfProfit: round2(profitProbability(legs, f.spot, breakevens, sigma, time.years) * 100), netDelta, thetaPerDay, payoff,
        target: round2(debit + Math.max(favoured, debit * 0.5)), stop: round2(debit * (1 - STOP_SHARE)), rationale: [], exit: [],
      });
    }
  }

  const budget = input.maxRisk && input.maxRisk > 0 ? input.maxRisk : null;
  const hedged = plans.filter((plan) => side === "BOTH" || plan.hedgeCover >= MIN_HEDGE_COVER);
  const affordable = budget === null ? hedged : hedged.filter((plan) => plan.debit <= budget);
  const pool = affordable.length ? affordable : hedged;
  // Highest reward : risk first; on a tie (within 0.05R) the smaller premium at risk wins.
  const ranked = [...pool].sort((a, b) => (Math.abs(b.riskReward - a.riskReward) > 0.05 ? b.riskReward - a.riskReward : a.debit - b.debit));
  // The best of each kind (straddle, strangle, strap, hedged call, ...), so the alternatives differ.
  const seen = new Set<HedgeId>();
  const picks = ranked.filter((plan) => (seen.has(plan.id) ? false : (seen.add(plan.id), true))).slice(0, 5);
  for (const plan of picks) {
    const [c, p] = plan.legs;
    const sideWord = side === "UP" ? "up" : side === "DOWN" ? "down" : "either way";
    plan.rationale = [
      `Only buys options: the most it can lose is the ₹${fmt(plan.debit)} premium (${c.lots} × ${c.strike} CE @ ₹${fmt(c.premium)} + ${p.lots} × ${p.strike} PE @ ₹${fmt(p.premium)}, lot ${lotSize}).`,
      `A breakout of ±${fmt(plan.breakoutPoints)} pts (1.5 × the ${fmt(em)}-pt move the straddle prices) pays ${rupees(plan.rewardUp)} up / ${rupees(plan.rewardDown)} down: ${plan.riskReward}R on the full premium ${sideWord}, ${plan.rewardToStop}R on the 40% stop.`,
      `If only an ordinary ±${fmt(em)}-pt move comes, it ends ${rupees(plan.atExpectedUp)} up / ${rupees(plan.atExpectedDown)} down at expiry: buyers are paid for breakouts, not for drift.`,
      side === "BOTH" ? "Market bias is neutral, so the combination is ranked on its weaker side: it has to pay whichever way the index breaks." : `Bias is ${f.bias.label.replaceAll("_", " ").toLowerCase()} (trend + PCR): the ${side === "UP" ? "calls" : "puts"} carry the trade, and on a wrong-way breakout the ${side === "UP" ? "put" : "call"} hedge keeps ${Math.round(plan.hedgeCover * 100)}% of the premium.`,
      `Profitable at expiry ${plan.breakevens.length === 2 ? `below ${fmt(plan.breakevens[0])} or above ${fmt(plan.breakevens[1])}` : plan.breakevens.map(fmt).join(" / ")}: ${plan.probabilityOfProfit}% by ATM IV.`,
    ];
    plan.exit = [
      `Book the trade at +₹${fmt(plan.target - plan.debit)} on the combined premium (the breakout payoff), or trail the stop once it is +50%.`,
      `Cut it if the combined premium falls 40% (a ₹${fmt(plan.debit - plan.stop)} loss), well before the ₹${fmt(plan.debit)} maximum.`,
      plan.thetaPerDay !== null ? `Time decay costs about ₹${fmt(Math.abs(plan.thetaPerDay))} a day: a buyer needs the move soon, so do not sit in it through a flat session.` : "Bought options lose time value every day: a buyer needs the move soon.",
    ];
  }
  const notes: string[] = [];
  if (budget !== null && !affordable.length && hedged.length) notes.push(`No hedge fits a ₹${fmt(budget)} risk budget at this lot size: showing the best ones anyway; the cheapest costs ₹${fmt(Math.min(...hedged.map((plan) => plan.debit)))}.`);
  if (f.ivRegime === "HIGH" || f.ivRegime === "EXTREME") notes.push(`Volatility is ${f.ivRegime.toLowerCase()} (ATM IV ${f.atmIv ?? "--"}): buyers pay up for options now, so the expected move has to happen for any combination to pay.`);
  if (f.phase === "EXPIRY_DAY") notes.push("Expiry day: time value melts by the hour. Bought hedges need the move today.");
  return { factors: f, side, bias: f.bias.label, primary: picks[0] ?? null, alternatives: picks.slice(1), considered: plans.length, withinBudget: affordable.length, notes };
}
