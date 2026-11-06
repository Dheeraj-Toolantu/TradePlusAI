// Hedge builder: option-BUY-only combinations (NIFTY / BANKNIFTY / SENSEX), picked with the OI data
// for the lowest risk and the best reward : risk on the trader's own target.
//
// Every structure only buys options (a CE leg and a PE leg, in a lot ratio), so the most it can
// lose is the premium paid: risk is defined and known before entry. For a target move (e.g. 100
// points, up, down or either way) each combination is valued two ways:
//
//   now              = the move happens right away: every leg repriced (Black-Scholes, its own IV,
//                      the same time left) minus today's value; what an intraday trader books
//   at expiry        = intrinsic value at expiry minus the premium paid
//
//   max loss         = premium paid (lots × premium per leg × lot size)
//   stop             = 40% of the premium (the planned exit)
//   reward : risk    = P&L on the favoured side at the target / premium (weaker side when "either")
//   hedge cover      = share of the premium kept after a wrong-way move of the same size
//   scenarios        = P&L at ±50 / ±100 / the target / 2 × the target, now and at expiry
//
// OI picks the hedge: strikes under 10% of the busiest strike's OI are skipped (poor fills), the
// thinner a leg the lower it ranks, and a bought strike beyond its OI wall (the most call OI above
// spot, the most put OI below) ranks lower, since writers defend those levels. A target running
// through a wall is flagged. The favoured side comes from the trader's choice, or from the bias
// (trend + PCR). Analysis only: nothing here places orders.

import { buildOptionStrategy, normCdf, probabilityAbove, timeToExpiry, type BiasLabel, type ChainRow, type Factors, type TrendInput } from "./option-strategy";

export type HedgeLeg = { type: "CE" | "PE"; strike: number; lots: number; premium: number; delta: number | null; theta: number | null; iv: number | null; openInterest: number; oiShare: number };
export type HedgeId = "LONG_STRADDLE" | "LONG_STRANGLE" | "STRAP" | "STRIP" | "HEDGED_CALL" | "HEDGED_PUT" | "GUTS";
export type Horizon = "NOW" | "EXPIRY";
export type Direction = "AUTO" | "UP" | "DOWN" | "BOTH";
export type Scenario = { move: number; price: number; now: number; expiry: number };
export type HedgePlan = {
  id: HedgeId; name: string; view: string; legs: HedgeLeg[]; lotSize: number;
  /** Premium paid for the whole combination (all lots, × lot size): also the maximum loss. */
  debit: number; maxLoss: number;
  /** P&L for the target move up / down, on the chosen horizon (now = repriced at today's IV, or at expiry). */
  targetPoints: number; horizon: Horizon; rewardUp: number; rewardDown: number; reward: number; wrongWay: number;
  riskReward: number; rewardToStop: number;
  /** Share of the premium kept after a wrong-way move of the target size (1 = fully covered). */
  hedgeCover: number;
  breakevens: number[]; probabilityOfProfit: number; netDelta: number | null; thetaPerDay: number | null;
  scenarios: Scenario[]; payoff: Array<{ price: number; pnl: number; now: number }>;
  /** OI read: the thinnest leg's OI as a share of the busiest strike on its side, and strikes past an OI wall. */
  oi: { minShare: number; beyondWall: string[]; factor: number }; score: number;
  target: number; stop: number; rationale: string[]; exit: string[];
};
export type HedgeInput = {
  symbol: string; spot: number; expiry: string; chain: ChainRow[]; vix?: number | null; trend?: TrendInput | null; maxRisk?: number | null; now?: Date;
  /** Index points the trader expects (e.g. 100). Default: 1.5 × the expected move. */
  targetPoints?: number | null; direction?: Direction; horizon?: Horizon;
};
export type HedgeRecommendation = {
  factors: Factors; side: "BOTH" | "UP" | "DOWN"; bias: BiasLabel; direction: Direction; targetPoints: number; horizon: Horizon;
  walls: { call: number | null; put: number | null; callOi: number; putOi: number };
  primary: HedgePlan | null; alternatives: HedgePlan[]; considered: number; withinBudget: number; notes: string[];
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const rupees = (value: number) => `${value < 0 ? "−" : "+"}₹${fmt(Math.abs(value))}`;
/** Black-Scholes (r ≈ 0) price of one option; intrinsic value at expiry. */
export function bsPrice(type: "CE" | "PE", spot: number, strike: number, years: number, sigma: number) {
  if (years <= 0 || sigma <= 0) return Math.max(0, type === "CE" ? spot - strike : strike - spot);
  const sd = sigma * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  const call = spot * normCdf(d1) - strike * normCdf(d1 - sd);
  return type === "CE" ? call : call - spot + strike;
}

/** P&L per unit of the lot size if the index moves to `price` right now (same IV, same time left). */
export function pnlNow(legs: HedgeLeg[], spot: number, price: number, years: number, fallbackSigma: number) {
  return legs.reduce((sum, leg) => {
    const sigma = (leg.iv ?? 0) > 0 ? (leg.iv as number) / 100 : fallbackSigma;
    return sum + leg.lots * (bsPrice(leg.type, price, leg.strike, years, sigma) - bsPrice(leg.type, spot, leg.strike, years, sigma));
  }, 0);
}

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
  const direction: Direction = input.direction ?? "AUTO";
  const side: HedgeRecommendation["side"] = direction === "UP" || direction === "DOWN" || direction === "BOTH" ? direction : f.bias.score >= 15 ? "UP" : f.bias.score <= -15 ? "DOWN" : "BOTH";
  const lotSize = f.lotSize || 1;
  const em = f.expectedMove;
  const horizon: Horizon = input.horizon ?? (input.targetPoints ? "NOW" : "EXPIRY");
  const targetPoints = round2(input.targetPoints && input.targetPoints > 0 ? input.targetPoints : em * BREAKOUT_MULTIPLE);
  const time = timeToExpiry(input.expiry, now);
  const sigma = (f.atmIv ?? f.vix ?? 14) / 100;
  const ce = new Map<number, ChainRow>(); const pe = new Map<number, ChainRow>();
  for (const row of input.chain) if (row.premium >= MIN_PREMIUM && row.strike > 0 && (row.openInterest ?? 1) > 0) (row.contract === "CALL" ? ce : pe).set(row.strike, row);

  // OI: the busiest strike on each side, and the walls writers defend (call OI above spot, put OI below).
  const maxOi = (side: Map<number, ChainRow>) => Math.max(1, ...[...side.values()].map((row) => row.openInterest ?? 0));
  const ceMax = maxOi(ce); const peMax = maxOi(pe);
  const wallOf = (side: Map<number, ChainRow>, accept: (strike: number) => boolean) => {
    let best: number | null = null; let oi = 0;
    for (const [strike, row] of side) if (accept(strike) && (row.openInterest ?? 0) > oi) { oi = row.openInterest ?? 0; best = strike; }
    return { strike: best, oi };
  };
  const callWall = wallOf(ce, (strike) => strike > f.spot); const putWall = wallOf(pe, (strike) => strike < f.spot);
  const leg = (type: "CE" | "PE", row: ChainRow, lots: number): HedgeLeg => ({
    type, strike: row.strike, lots, premium: row.premium, delta: typeof row.delta === "number" ? row.delta : null, theta: typeof row.theta === "number" ? row.theta : null,
    iv: typeof row.iv === "number" && row.iv > 0 ? row.iv : null, openInterest: row.openInterest ?? 0, oiShare: round2((row.openInterest ?? 0) / (type === "CE" ? ceMax : peMax)),
  });
  const valueAt = (legs: HedgeLeg[], move: number) => (horizon === "NOW" ? pnlNow(legs, f.spot, f.spot + move, time.years, sigma) : payoffAt(legs, f.spot + move)) * lotSize;
  const moves = [...new Set([-2 * targetPoints, -targetPoints, -100, -targetPoints / 2, 0, targetPoints / 2, 100, targetPoints, 2 * targetPoints].map(round2))].sort((a, b) => a - b);

  const plans: HedgePlan[] = [];
  for (const co of CE_OFFSETS) for (const po of PE_OFFSETS) {
    if (co < 0 && po > 0) continue; // both legs in the money: paying for intrinsic twice
    const call = ce.get(f.atmStrike + co * f.strikeStep); const put = pe.get(f.atmStrike + po * f.strikeStep);
    if (!call || !put) continue;
    for (const [cl, pl] of RATIOS) {
      const legs = [leg("CE", call, cl), leg("PE", put, pl)];
      // Illiquid strikes (under 10% of the busiest strike's OI) fill badly and are skipped.
      const minShare = Math.min(...legs.map((item) => item.oiShare));
      if (minShare < 0.1) continue;
      const debit = round2(legs.reduce((sum, item) => sum + item.lots * item.premium, 0) * lotSize);
      const up = valueAt(legs, targetPoints); const down = valueAt(legs, -targetPoints);
      const favoured = side === "UP" ? up : side === "DOWN" ? down : Math.min(up, down);
      const adverse = side === "UP" ? down : side === "DOWN" ? up : Math.min(up, down);
      const hedgeCover = debit > 0 ? Math.max(0, (adverse + debit) / debit) : 0;
      // A bought strike beyond its OI wall needs the index through the level writers defend.
      const beyondWall: string[] = [];
      if (callWall.strike !== null && call.strike > callWall.strike) beyondWall.push(`${call.strike} CE is above the ${callWall.strike} call wall`);
      if (putWall.strike !== null && put.strike < putWall.strike) beyondWall.push(`${put.strike} PE is below the ${putWall.strike} put wall`);
      const oiFactor = round2((0.85 + 0.15 * Math.min(1, minShare / 0.5)) * (beyondWall.length ? 0.75 ** beyondWall.length : 1));
      const riskReward = debit > 0 ? round2(favoured / debit) : 0;
      const breakevens = breakevensOf(legs, f.spot);
      const netDelta = legs.every((item) => item.delta !== null) ? round2(legs.reduce((sum, item) => sum + item.lots * (item.delta as number), 0)) : null;
      const thetaPerDay = legs.every((item) => item.theta !== null) ? round2(legs.reduce((sum, item) => sum + item.lots * (item.theta as number), 0) * lotSize) : null;
      const span = Math.max(2 * targetPoints, 2 * em);
      const payoff = Array.from({ length: 41 }, (_, index) => { const price = f.spot - span + (index * 2 * span) / 40; return { price: round2(price), pnl: round2(payoffAt(legs, price) * lotSize), now: round2(pnlNow(legs, f.spot, price, time.years, sigma) * lotSize) }; });
      const scenarios = moves.map((move) => ({ move, price: round2(f.spot + move), now: round2(pnlNow(legs, f.spot, f.spot + move, time.years, sigma) * lotSize), expiry: round2(payoffAt(legs, f.spot + move) * lotSize) }));
      plans.push({
        ...nameOf(legs[0], legs[1], f.atmStrike), legs, lotSize, debit, maxLoss: debit, targetPoints, horizon,
        rewardUp: round2(up), rewardDown: round2(down), reward: round2(favoured), wrongWay: round2(adverse),
        riskReward, rewardToStop: debit > 0 ? round2(favoured / (debit * STOP_SHARE)) : 0, hedgeCover: round2(hedgeCover), breakevens,
        probabilityOfProfit: round2(profitProbability(legs, f.spot, breakevens, sigma, time.years) * 100), netDelta, thetaPerDay, scenarios, payoff,
        oi: { minShare: round2(minShare), beyondWall, factor: oiFactor }, score: round2(riskReward * (riskReward >= 0 ? oiFactor : 1 / oiFactor)),
        target: round2(debit + Math.max(favoured, debit * 0.5)), stop: round2(debit * (1 - STOP_SHARE)), rationale: [], exit: [],
      });
    }
  }

  const budget = input.maxRisk && input.maxRisk > 0 ? input.maxRisk : null;
  const hedged = plans.filter((plan) => side === "BOTH" || plan.hedgeCover >= MIN_HEDGE_COVER);
  const candidates = hedged.length ? hedged : plans;
  const affordable = budget === null ? candidates : candidates.filter((plan) => plan.debit <= budget);
  const pool = affordable.length ? affordable : candidates;
  // Best OI-adjusted reward : risk first; on a tie (within 0.05) the smaller premium at risk wins.
  const ranked = [...pool].sort((a, b) => (Math.abs(b.score - a.score) > 0.05 ? b.score - a.score : a.debit - b.debit));
  // The best of each kind (straddle, strangle, strap, hedged call, ...), so the alternatives differ.
  const seen = new Set<HedgeId>();
  const picks = ranked.filter((plan) => (seen.has(plan.id) ? false : (seen.add(plan.id), true))).slice(0, 5);
  const horizonText = horizon === "NOW" ? "if it moves now (repriced at today's IV)" : "at expiry";
  for (const plan of picks) {
    const [c, p] = plan.legs;
    const sideWord = side === "UP" ? "up" : side === "DOWN" ? "down" : "either way";
    plan.rationale = [
      `Only buys options: the most it can lose is the ₹${fmt(plan.debit)} premium (${c.lots} × ${c.strike} CE @ ₹${fmt(c.premium)} + ${p.lots} × ${p.strike} PE @ ₹${fmt(p.premium)}, lot ${lotSize}).`,
      `A ${fmt(plan.targetPoints)}-pt move ${horizonText}: ${rupees(plan.rewardUp)} up / ${rupees(plan.rewardDown)} down, ${plan.riskReward}R on the premium ${sideWord} (${plan.rewardToStop}R on the 40% stop).`,
      side === "BOTH" ? "Ranked on its weaker side: it has to pay whichever way the index breaks." : `Favoured side ${side === "UP" ? "up" : "down"} (${direction === "AUTO" ? `bias ${f.bias.label.replaceAll("_", " ").toLowerCase()}, trend + PCR` : "your choice"}); on a wrong-way ${fmt(plan.targetPoints)}-pt move it ends ${rupees(plan.wrongWay)} and keeps ${Math.round(plan.hedgeCover * 100)}% of the premium.`,
      `OI: both strikes trade with at least ${Math.round(plan.oi.minShare * 100)}% of the busiest strike's open interest${plan.oi.beyondWall.length ? `; ${plan.oi.beyondWall.join(", ")} (writers defend it, so it is ranked lower)` : `; both strikes sit inside the OI walls${callWall.strike ? ` (call ${callWall.strike}` : ""}${putWall.strike ? `${callWall.strike ? ", " : " ("}put ${putWall.strike})` : callWall.strike ? ")" : ""}`}.`,
      `Profitable at expiry ${plan.breakevens.length === 2 ? `below ${fmt(plan.breakevens[0])} or above ${fmt(plan.breakevens[1])}` : plan.breakevens.map(fmt).join(" / ")}: ${plan.probabilityOfProfit}% by ATM IV.`,
    ];
    plan.exit = [
      `Book it at your ${fmt(plan.targetPoints)}-pt target (about ${rupees(plan.reward)}), or trail the stop once the combined premium is +50%.`,
      `Cut it if the combined premium falls 40% (a ₹${fmt(plan.debit - plan.stop)} loss), well before the ₹${fmt(plan.debit)} maximum.`,
      plan.thetaPerDay !== null ? `Time decay costs about ₹${fmt(Math.abs(plan.thetaPerDay))} a day: a buyer needs the move soon, so do not sit in it through a flat session.` : "Bought options lose time value every day: a buyer needs the move soon.",
    ];
  }
  const notes: string[] = [];
  if (budget !== null && !affordable.length && candidates.length) notes.push(`No hedge fits a ₹${fmt(budget)} risk budget at this lot size: showing the best ones anyway; the cheapest costs ₹${fmt(Math.min(...candidates.map((plan) => plan.debit)))}.`);
  if ((side === "UP" || side === "BOTH") && callWall.strike !== null && f.spot + targetPoints > callWall.strike) notes.push(`An up-move of ${fmt(targetPoints)} pts runs through the ${callWall.strike} call wall (the most call OI above spot): call writers defend it, so the upside target is ambitious.`);
  if ((side === "DOWN" || side === "BOTH") && putWall.strike !== null && f.spot - targetPoints < putWall.strike) notes.push(`A down-move of ${fmt(targetPoints)} pts runs through the ${putWall.strike} put wall (the most put OI below spot): put writers defend it, so the downside target is ambitious.`);
  if (horizon === "EXPIRY" && targetPoints < em) notes.push(`Your ${fmt(targetPoints)}-pt target is smaller than the ${fmt(em)}-pt move the options already price: held to expiry, bought hedges rarely pay on it. Switch the horizon to "now" for an intraday move.`);
  if (f.ivRegime === "HIGH" || f.ivRegime === "EXTREME") notes.push(`Volatility is ${f.ivRegime.toLowerCase()} (ATM IV ${f.atmIv ?? "--"}): buyers pay up for options now, so the move has to happen for any combination to pay.`);
  if (f.phase === "EXPIRY_DAY") notes.push("Expiry day: time value melts by the hour. Bought hedges need the move today.");
  return {
    factors: f, side, bias: f.bias.label, direction, targetPoints, horizon,
    walls: { call: callWall.strike, put: putWall.strike, callOi: callWall.oi, putOi: putWall.oi },
    primary: picks[0] ?? null, alternatives: picks.slice(1), considered: plans.length, withinBudget: affordable.length, notes,
  };
}
