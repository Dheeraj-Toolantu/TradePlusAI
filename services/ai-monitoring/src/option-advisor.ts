/**
 * AI option advisor: turns the deterministic market-intel read into ONE best CE / PE / WAIT
 * suggestion for an option buyer.
 *
 * The model reasons over a compact brief (smart zones + 1m trigger, SMC structure, trend on
 * 5m/15m, VWAP/EMA/RSI, OI writers, walls, PCR, max pain, VIX, sentiment, global cues,
 * operator footprint, psychology). It may only choose a direction, spot levels and a
 * narrative. Everything that could hurt the trader is decided here in code:
 * - the contract is always the deterministic best liquid ATM/slightly-ITM strike for the side;
 * - hard gates (entry window, extreme VIX, late expiry, missing contract) force WAIT;
 * - spot stop/targets must sit on the correct side within 0.2-3 ATR, else fall back to the
 *   engine's structural levels;
 * - option premiums are computed from spot levels via delta, never taken from the model.
 * - the multi-timeframe engine (1D/15m/5m/1m + candle psychology + option fair value) must agree:
 *   a suggestion against the aligned 15m/1D trend is forced to WAIT, and mixed timeframes cost
 *   confidence;
 * - premium reward/risk is reported honestly from the delta-mapped spot move (never padded to 2R)
 *   and a setup below MIN_PREMIUM_RR is not traded.
 * Suggestions are advisory here; automation (paper) lives in the auto-trade route.
 */
import { mtfBrief, type MtfDecision } from "./mtf-decision-engine";

export type AdvisorAction = "BUY_CE" | "BUY_PE" | "WAIT";
export type AdvisorCandidate = { side: "CE" | "PE"; trading_symbol: string; strike: number; premium: number; delta: number | null; liquidity_score: number; moneyness?: string };
export type OptionAdvice = {
  source: "AI" | "DETERMINISTIC";
  model?: string;
  symbol: string;
  expiry: string | null;
  lotSize: number | null;
  action: AdvisorAction;
  confidence: number;
  headline: string;
  strategy: string;
  marketRead: string;
  psychology: string[];
  reasons: string[];
  risks: string[];
  contract: AdvisorCandidate | null;
  spot: { entryLow: number; entryHigh: number; stop: number; target1: number; target2: number | null } | null;
  premium: { entry: number; stop: number; target1: number; target2: number | null; riskReward: number } | null;
  trigger: string;
  invalidation: string;
  blockedBy: string[];
  notes: string[];
  generatedAt: string;
  /** How to manage the trade once in: partial booking, breakeven, trailing, time stop. */
  exitPlan?: string[];
  /** Multi-timeframe read shown in the AI monitoring panel. */
  mtf?: MtfSummary | null;
};
export type MtfSummary = {
  action: MtfDecision["action"];
  confidence: number;
  alignment: MtfDecision["alignment"];
  headline: string;
  timeframes: Array<{ timeframe: string; trend: string; score: number; rsi14: number | null; patterns: string[] }>;
  valuation: Array<{ side: "CE" | "PE"; tradingSymbol: string; intrinsic: number; extrinsic: number; extrinsicPct: number; fairValue: number | null; verdict: string; note: string }>;
  keyLevels: string[];
};
export type ChatMessage = { role: "system" | "user"; content: string };

type Raw = Record<string, unknown>;
const MIN_CONFIDENCE = 50;
const MAX_BRIEF_CHARS = 9_000;
const PREMIUM_STOP_FLOOR = 0.1;
const PREMIUM_STOP_CAP = 0.35;
/** Minimum honest premium reward/risk (delta-mapped) for an actionable suggestion. */
const MIN_PREMIUM_RR = 1.5;
/** Confidence lost when the 1D/15m/5m/1m timeframes are not aligned. */
const MIXED_TIMEFRAME_PENALTY = 15;

const mtfOf = (intel: Raw): MtfDecision | null => { const value = obj(intel.mtf_decision); return value.timeframes ? value as unknown as MtfDecision : null; };

export function summarizeMtf(decision: MtfDecision | null): MtfSummary | null {
  if (!decision) return null;
  return {
    action: decision.action, confidence: decision.confidence, alignment: decision.alignment, headline: decision.headline,
    timeframes: (["1D", "15m", "5m", "1m"] as const).map((key) => { const read = decision.timeframes[key]; return { timeframe: key, trend: read?.trend ?? "N/A", score: read?.score ?? 0, rsi14: read?.rsi14 ?? null, patterns: (read?.patterns ?? []).map((pattern) => `${pattern.name}${pattern.atLevel ? ` @ ${pattern.atLevel}` : ""}`) }; }),
    valuation: Object.values(decision.valuation).filter(Boolean).map((value) => ({ side: value!.side, tradingSymbol: value!.tradingSymbol, intrinsic: value!.intrinsic, extrinsic: value!.extrinsic, extrinsicPct: value!.extrinsicPct, fairValue: value!.fairValue, verdict: value!.verdict, note: value!.note })),
    keyLevels: decision.levels.map((level) => `${level.label} ${level.price}`),
  };
}

/**
 * Applies the multi-timeframe verdict to a proposed action. Returns the (possibly downgraded)
 * action and confidence plus notes explaining any change.
 */
function reconcileWithMtf(intel: Raw, action: AdvisorAction, confidence: number): { action: AdvisorAction; confidence: number; notes: string[] } {
  const mtf = mtfOf(intel);
  if (!mtf || action === "WAIT") return { action, confidence, notes: [] };
  const notes: string[] = [];
  const opposes = (action === "BUY_CE" && mtf.alignment === "BEARISH_ALIGNED") || (action === "BUY_PE" && mtf.alignment === "BULLISH_ALIGNED");
  if (opposes) return { action: "WAIT", confidence, notes: [`${action.replace("_", " ")} would trade against the aligned ${mtf.alignment === "BULLISH_ALIGNED" ? "bullish" : "bearish"} 1D/15m/5m trend; treated as WAIT.`] };
  if (mtf.alignment === "MIXED") {
    confidence = Math.max(0, confidence - MIXED_TIMEFRAME_PENALTY);
    notes.push(`Timeframes are mixed (${mtf.headline}); confidence reduced by ${MIXED_TIMEFRAME_PENALTY}.`);
    if (confidence < MIN_CONFIDENCE) { notes.push(`Confidence ${confidence}% after the timeframe check is below ${MIN_CONFIDENCE}%; treated as WAIT.`); return { action: "WAIT", confidence, notes }; }
  } else if (mtf.action === action) {
    confidence = Math.min(95, confidence + 5);
    notes.push(`Multi-timeframe engine independently confirms ${action.replace("_", " ")} (${mtf.confidence}%).`);
  }
  return { action, confidence, notes };
}

/** Rejects plans whose delta-mapped premium reward does not cover the premium risk. */
function premiumPlanAcceptable(premium: OptionAdvice["premium"], notes: string[]): boolean {
  if (!premium) return false;
  if (premium.riskReward >= MIN_PREMIUM_RR) return true;
  notes.push(`Premium reward/risk is only ${premium.riskReward}R after mapping the spot move through delta (minimum ${MIN_PREMIUM_RR}R); treated as WAIT.`);
  return false;
}

const obj = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | null => { const parsed = Number(value); return value !== null && value !== "" && Number.isFinite(parsed) ? parsed : null; };
const round = (value: unknown, digits = 2): number | null => { const parsed = num(value); return parsed === null ? null : Math.round(parsed * 10 ** digits) / 10 ** digits; };
const text = (value: unknown, max = 400): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const texts = (value: unknown, limit: number, max = 300): string[] => arr(value).map((item) => text(item, max)).filter(Boolean).slice(0, limit);
const zone = (item: unknown) => { const z = obj(item); return { dir: z.direction ?? z.side, low: round(z.bottom ?? z.low), high: round(z.top ?? z.high) }; };

/** Only claims a trader can act on responsibly survive; guarantees are rewritten. */
function sanitize(value: string): string {
  return value.replace(/guarantee(d|s)?|risk[- ]free|sure[- ]shot|100% (accurate|certain|profit)/gi, "high-probability (not certain)");
}

function candidate(value: unknown, side: "CE" | "PE"): AdvisorCandidate | null {
  const c = obj(value);
  const premium = num(c.premium);
  if (!premium || premium <= 0) return null;
  return { side, trading_symbol: String(c.trading_symbol ?? ""), strike: num(c.strike) ?? 0, premium, delta: num(c.delta), liquidity_score: num(c.liquidity_score) ?? 0, moneyness: typeof c.moneyness === "string" ? c.moneyness : undefined };
}

export function candidatesOf(intel: Raw): Record<"CE" | "PE", AdvisorCandidate | null> {
  const candidates = obj(intel.contract_candidates);
  return { CE: candidate(candidates.CE, "CE"), PE: candidate(candidates.PE, "PE") };
}

/** Deterministic reasons the trader must not buy an option right now. */
export function hardGates(intel: Raw): string[] {
  const blocked: string[] = [];
  const session = obj(intel.session);
  if (session.market_open === false) blocked.push("Market is closed");
  else if (session.entry_permitted === false) blocked.push("Outside the entry window (09:35-14:45 IST)");
  if (obj(intel.volatility).regime === "EXTREME") blocked.push("India VIX is in the EXTREME regime");
  const generated = typeof intel.generated_at === "string" ? intel.generated_at : "";
  const clock = /T(\d{2}):(\d{2})/.exec(generated);
  if (intel.expiry_today === true && clock && Number(clock[1]) * 60 + Number(clock[2]) >= 13 * 60 + 30) blocked.push("Expiry day after 13:30: gamma risk");
  return blocked;
}

/** Compact, number-rounded brief of everything the deterministic engines computed. */
export function buildAdvisorBrief(intel: Raw): Raw {
  const tech = obj(intel.technicals);
  const verdict = obj(intel.verdict);
  const smc = obj(intel.smart_money);
  const flow = obj(intel.options_flow);
  const vol = obj(intel.volatility);
  const smart = obj(intel.smart_entry);
  const operator = obj(intel.operator);
  const plan = obj(intel.trade_plan);
  const macro = obj(operator.macro);
  const brief: Raw = {
    symbol: intel.symbol,
    time_ist: intel.generated_at,
    session: intel.session,
    expiry_today: intel.expiry_today,
    spot: round(intel.spot),
    technicals_5m: { price: round(tech.last_price), vwap: round(tech.vwap), ema20: round(tech.ema20), ema50: round(tech.ema50), rsi14: round(tech.rsi14, 1), atr14: round(tech.atr14), trend_15m: tech.trend_15m, session_open: round(tech.session_open), session_high: round(tech.session_high), session_low: round(tech.session_low), prev_high: round(tech.previous_high), prev_low: round(tech.previous_low), prev_close: round(tech.previous_close) },
    confluence_verdict: { bias: verdict.bias, score: verdict.score, factors: arr(verdict.factors).map((f) => { const x = obj(f); return `${x.name}: ${x.points} (${text(x.detail, 140)})`; }) },
    smart_money_5m: {
      structure: smc.trend, swings: smc.swing_sequence, last_event: smc.last_event,
      order_blocks: arr(smc.order_blocks).slice(0, 4).map(zone), fair_value_gaps: arr(smc.fair_value_gaps).slice(0, 4).map(zone),
      sweeps: arr(smc.sweeps).slice(-2), dealing_range: smc.dealing_range, liquidity: smc.liquidity,
    },
    smart_zone_entry_1m: {
      status: smart.status, read: smart.headline ?? smart.reason, zone: smart.zone, trigger: smart.trigger, score: smart.score, spot_plan: smart.spot,
      failed_gates: arr(smart.gates).filter((g) => obj(g).passed === false).map((g) => obj(g).label), psychology: texts(smart.psychology, 6),
      nearest_zones: arr(smart.zones).slice(0, 4).map((z) => { const x = obj(z); return `${x.side} ${x.low}-${x.high} (${x.strength} src: ${arr(x.sources).join(", ")}; ${x.distance} pts)`; }),
    },
    option_flow: {
      pcr_oi: round(flow.pcr_oi), pcr_change_5m: round(flow.pcr_change_5m, 3), max_pain: flow.max_pain, writers: flow.oi_direction_label, writer_score: flow.oi_direction_score,
      put_walls: arr(flow.support).slice(0, 3).map((w) => obj(w).strike), call_walls: arr(flow.resistance).slice(0, 3).map((w) => obj(w).strike),
      fresh_call_writing: arr(flow.call_writing).slice(0, 2), fresh_put_writing: arr(flow.put_writing).slice(0, 2), atm_iv: round(flow.atm_iv),
    },
    volatility: { india_vix: round(vol.value), regime: vol.regime, trend: vol.trend, expected_range: vol.expected_range },
    operator_footprint: { stance: operator.stance, headline: text(operator.headline, 300), writer_comfort_zone: operator.writer_comfort_zone },
    global_macro: macro.label ? { label: macro.label, score: macro.score, notes: texts(macro.notes, 3) } : null,
    desk_plan: { status: plan.status, headline: plan.headline, direction: plan.direction, failed_checks: arr(plan.checklist).filter((c) => obj(c).passed === false).map((c) => obj(c).label) },
    candidates: candidatesOf(intel),
    multi_timeframe: mtfOf(intel) ? mtfBrief(mtfOf(intel)!) : null,
    hard_gates: hardGates(intel),
  };
  let json = JSON.stringify(brief);
  if (json.length > MAX_BRIEF_CHARS) {
    delete (brief.smart_money_5m as Raw).liquidity;
    delete (brief.option_flow as Raw).fresh_call_writing;
    delete (brief.option_flow as Raw).fresh_put_writing;
    json = JSON.stringify(brief);
    if (json.length > MAX_BRIEF_CHARS) (brief.confluence_verdict as Raw).factors = arr((brief.confluence_verdict as Raw).factors).slice(0, 6);
    json = JSON.stringify(brief);
    const mtf = obj(brief.multi_timeframe);
    if (json.length > MAX_BRIEF_CHARS && mtf.key_levels) mtf.key_levels = arr(mtf.key_levels).slice(0, 10);
  }
  return brief;
}

export const ADVISOR_SYSTEM_PROMPT = `You are a senior NIFTY/BANKNIFTY/SENSEX intraday options trader who BUYS options (CE or PE). You read market structure the way institutions do: order blocks, fair value gaps, liquidity sweeps/stop hunts, support/resistance, VWAP, 5m/15m trend, option-writer positioning (fresh writing, OI walls, PCR, max pain), India VIX, India sentiment and global cues. You think about market psychology: who is trapped, who is defending a level, where stop-losses rest, and whether the move has fuel.

Decide the single best action for the next 5-30 minutes: BUY_CE, BUY_PE or WAIT.
Rules:
- Use ONLY numbers present in the brief. Never invent prices, strikes, OI or news.
- An option buyer loses to time decay: prefer WAIT in chop, low-conviction or conflicting evidence, or when price is mid-range between zones.
- The best entries are at a demand zone (for CE) or supply zone (for PE) after a stop hunt and a 1-minute change of character. A confirmed smart_zone_entry_1m (status ENTRY) is strong evidence; status ARMED means "wait for the trigger"; tell the trader the exact trigger.
- With-trend pullbacks beat counter-trend reversals. Do not buy against both the 15m trend and the option writers.
- Read multi_timeframe TOP-DOWN: 1D gives context (trend, previous-day high/low/close, pivots), 15m gives the direction you may trade, 5m gives the setup (pullback into EMA20/VWAP/a key level, or a break-and-hold of the last swing), 1m gives the trigger (a closed confirming candle or a 1m break of structure). Never BUY_CE when multi_timeframe.alignment is BEARISH_ALIGNED or BUY_PE when it is BULLISH_ALIGNED; when it is MIXED prefer WAIT.
- Read candlestick patterns for their psychology, and only trust them AT a key level (engulfing / hammer / pin bar / morning star at support for CE, the bearish mirror at resistance for PE). A pattern in the middle of nowhere is noise. Do not chase price that is extended more than 2 ATR from the 5m EMA20.
- Respect option value: intrinsic vs time value and fair value are in multi_timeframe.option_value. Prefer contracts that are not OVERPRICED; when most of the premium is time value the trade must work fast.
- If hard_gates is non-empty, the action must be WAIT.
- Stop goes beyond the structure that invalidates the idea (zone edge / sweep extreme / 1m trigger low or high), target at the next liquidity (opposing zone, OI wall, PDH/PDL, pivot). Reward must be at least 2x risk AND there must be room to the next opposing level.
- Never promise profit or certainty.

Reply with ONE JSON object only, no markdown:
{"action":"BUY_CE|BUY_PE|WAIT","confidence":0-100,"strategy":"short setup name","headline":"one line","market_read":"2-3 sentences","psychology":["who is trapped/defending, 2-4 short bullets"],"reasons":["evidence for, 3-6 bullets"],"risks":["evidence against, 1-4 bullets"],"entry_zone_low":number,"entry_zone_high":number,"stop":number,"target1":number,"target2":number,"trigger":"exact condition to enter","invalidation":"what kills the idea"}
For WAIT still fill trigger (what would turn it into a trade) and the levels you are watching, or null.`;

export function buildAdvisorMessages(intel: Raw): ChatMessage[] {
  return [
    { role: "system", content: ADVISOR_SYSTEM_PROMPT },
    { role: "user", content: `Market brief (deterministic engines, Groww live data):\n${JSON.stringify(buildAdvisorBrief(intel))}` },
  ];
}

function extractJson(content: string): Raw | null {
  const cleaned = content.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return obj(JSON.parse(cleaned.slice(start, end + 1))); } catch { return null; }
}

function premiumPlan(contract: AdvisorCandidate, spot: number, stop: number, target1: number, target2: number | null) {
  const delta = Math.abs(contract.delta ?? 0.5) || 0.5;
  const premium = contract.premium;
  const risk = Math.min(Math.max(delta * Math.abs(spot - stop), premium * PREMIUM_STOP_FLOOR), premium * PREMIUM_STOP_CAP);
  // Honest mapping: the premium target is what the spot target is worth through delta. It is
  // never padded to 2R, so riskReward shows what the trade can really pay.
  const reward1 = delta * Math.abs(target1 - spot);
  const reward2 = target2 !== null ? Math.max(delta * Math.abs(target2 - spot), reward1) : null;
  const r2 = (value: number) => Math.round(value * 20) / 20;
  return { entry: r2(premium), stop: r2(Math.max(premium - risk, 0.05)), target1: r2(premium + reward1), target2: reward2 !== null ? r2(premium + reward2) : null, riskReward: Math.round((reward1 / risk) * 100) / 100 };
}

/** Spot levels on the correct side and inside 0.2-3 ATR; otherwise the engine's own structure. */
function spotLevels(intel: Raw, direction: 1 | -1, proposal: Raw): { levels: OptionAdvice["spot"]; note?: string } {
  const spot = num(intel.spot) ?? 0;
  const atr = num(obj(intel.technicals).atr14) ?? spot * 0.002;
  const stop = num(proposal.stop);
  const target1 = num(proposal.target1);
  const target2 = num(proposal.target2);
  const valid = stop !== null && target1 !== null
    && (spot - stop) * direction >= 0.2 * atr && (spot - stop) * direction <= 3 * atr
    && (target1 - spot) * direction >= 1.5 * Math.abs(spot - stop);
  const low = num(proposal.entry_zone_low) ?? spot;
  const high = num(proposal.entry_zone_high) ?? spot;
  if (valid) {
    return { levels: { entryLow: round(Math.min(low, high))!, entryHigh: round(Math.max(low, high))!, stop: round(stop)!, target1: round(target1)!, target2: target2 !== null && (target2 - target1) * direction > 0 ? round(target2) : null } };
  }
  const smart = obj(intel.smart_entry);
  const plan = obj(intel.trade_plan);
  const wanted = direction > 0 ? "CE" : "PE";
  const fallback = smart.side === wanted ? obj(smart.spot) : plan.direction === wanted ? obj(plan.spot) : {};
  const fbStop = num(fallback.stop) ?? spot - atr * direction;
  const fbT1 = num(fallback.target1) ?? spot + 2 * Math.abs(spot - fbStop) * direction;
  return { levels: { entryLow: round(spot)!, entryHigh: round(spot)!, stop: round(fbStop)!, target1: round(fbT1)!, target2: round(fallback.target2) }, note: "Model levels were missing or on the wrong side of price; using the engine's structural stop/target." };
}

/** Validate the model's JSON against the hard gates and real contracts. */
export function adviceFromModel(intel: Raw, content: string, model?: string): OptionAdvice | null {
  const parsed = extractJson(content);
  if (!parsed) return null;
  const rawAction = String(parsed.action ?? "").toUpperCase().replace(/\s+/g, "_");
  if (!["BUY_CE", "BUY_PE", "WAIT"].includes(rawAction)) return null;
  let action = rawAction as AdvisorAction;
  let confidence = num(parsed.confidence) ?? 0;
  if (confidence > 0 && confidence <= 1) confidence *= 100;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  const blockedBy = hardGates(intel);
  const notes: string[] = [];
  const candidates = candidatesOf(intel);
  if (action !== "WAIT" && blockedBy.length) { notes.push(`Model suggested ${action}; forced to WAIT by: ${blockedBy.join("; ")}.`); action = "WAIT"; }
  if (action !== "WAIT" && confidence < MIN_CONFIDENCE) { notes.push(`Model confidence ${confidence}% is below ${MIN_CONFIDENCE}%; treated as WAIT.`); action = "WAIT"; }
  const reconciled = reconcileWithMtf(intel, action, confidence);
  action = reconciled.action; confidence = reconciled.confidence; notes.push(...reconciled.notes);
  const side = action === "BUY_CE" ? "CE" : action === "BUY_PE" ? "PE" : null;
  let contract = side ? candidates[side] : null;
  if (side && !contract) { notes.push(`No liquid ${side} near ATM on the chain; treated as WAIT.`); action = "WAIT"; }
  let spot: OptionAdvice["spot"] = null;
  let premium: OptionAdvice["premium"] = null;
  if (action !== "WAIT" && contract) {
    const direction = action === "BUY_CE" ? 1 : -1;
    const levels = spotLevels(intel, direction, parsed);
    if (levels.note) notes.push(levels.note);
    spot = levels.levels;
    premium = spot ? premiumPlan(contract, num(intel.spot) ?? 0, spot.stop, spot.target1, spot.target2) : null;
    if (!premiumPlanAcceptable(premium, notes)) { action = "WAIT"; spot = null; premium = null; contract = null; }
  }
  const mtf = mtfOf(intel);
  return {
    source: "AI",
    model,
    symbol: String(intel.symbol ?? ""),
    expiry: typeof intel.expiry === "string" ? intel.expiry : null,
    lotSize: num(intel.lot_size),
    action,
    confidence,
    headline: sanitize(text(parsed.headline, 200)) || (action === "WAIT" ? "Wait for a cleaner setup" : `${action.replace("_", " ")} ${contract?.trading_symbol ?? ""}`),
    strategy: sanitize(text(parsed.strategy, 80)) || "Discretionary read",
    marketRead: sanitize(text(parsed.market_read, 700)),
    psychology: texts(parsed.psychology, 4).map(sanitize),
    reasons: texts(parsed.reasons, 6).map(sanitize),
    risks: texts(parsed.risks, 4).map(sanitize),
    contract: action === "WAIT" ? null : contract,
    spot,
    premium,
    trigger: sanitize(text(parsed.trigger, 300)),
    invalidation: sanitize(text(parsed.invalidation, 300)),
    blockedBy,
    notes,
    generatedAt: new Date().toISOString(),
    exitPlan: action === "WAIT" ? [] : exitPlanFor(mtf),
    mtf: summarizeMtf(mtf),
  };
}

function exitPlanFor(mtf: MtfDecision | null): string[] {
  if (mtf?.exitPlan.length) return mtf.exitPlan;
  return [
    "Exit on a spot candle close beyond the stop; never average down a losing option.",
    "Book half at target 1 and move the stop on the rest to entry.",
    "Time stop: exit if the trade is not working within 15 minutes.",
    "Square off everything by 15:15 IST.",
  ];
}

/** Rule-based suggestion from the smart zone engine / desk plan when no model is reachable. */
export function deterministicAdvice(intel: Raw, reason?: string): OptionAdvice {
  const smart = obj(intel.smart_entry);
  const plan = obj(intel.trade_plan);
  const verdict = obj(intel.verdict);
  const blockedBy = hardGates(intel);
  const candidates = candidatesOf(intel);
  const notes = reason ? [reason] : [];
  const mtf = mtfOf(intel);
  const base = { source: "DETERMINISTIC" as const, symbol: String(intel.symbol ?? ""), expiry: typeof intel.expiry === "string" ? intel.expiry : null, lotSize: num(intel.lot_size), blockedBy, notes, generatedAt: new Date().toISOString(), risks: [] as string[], mtf: summarizeMtf(mtf) };
  const fromSetup = (side: "CE" | "PE", levels: Raw, strategy: string, headline: string, confidence: number, psychology: string[], reasons: string[]): OptionAdvice | null => {
    const contract = candidates[side];
    const stop = num(levels.stop); const target1 = num(levels.target1); const entry = num(levels.entry) ?? num(intel.spot);
    if (!contract || stop === null || target1 === null || entry === null || blockedBy.length) return null;
    const reconciled = reconcileWithMtf(intel, side === "CE" ? "BUY_CE" : "BUY_PE", confidence);
    if (reconciled.action === "WAIT") { notes.push(...reconciled.notes); return null; }
    const spot = { entryLow: round(entry)!, entryHigh: round(entry)!, stop: round(stop)!, target1: round(target1)!, target2: round(levels.target2) };
    const premium = premiumPlan(contract, num(intel.spot) ?? entry, spot.stop, spot.target1, spot.target2);
    const localNotes: string[] = [];
    if (!premiumPlanAcceptable(premium, localNotes)) { notes.push(...localNotes); return null; }
    return { ...base, notes: [...notes, ...reconciled.notes], action: side === "CE" ? "BUY_CE" : "BUY_PE", confidence: reconciled.confidence, headline, strategy, marketRead: text(verdict.bias ? `Confluence verdict ${verdict.bias} (${verdict.score}/10).` : "", 200), psychology, reasons, contract, spot, premium, trigger: "Setup already confirmed; enter near the entry price, not after a large move.", invalidation: `Spot closes beyond ${spot.stop}`, exitPlan: exitPlanFor(mtf) };
  };
  if (smart.status === "ENTRY" && (smart.side === "CE" || smart.side === "PE")) {
    const trigger = obj(smart.trigger);
    const advice = fromSetup(smart.side, obj(smart.spot), "Smart zone reversal (5m zone + 1m CHoCH)", text(smart.headline, 200), Math.round((num(smart.score) ?? 6) * 10), texts(smart.psychology, 4), arr(smart.factors).map((f) => { const x = obj(f); return `${x.name} ${x.points}/${x.max}: ${text(x.detail, 140)}`; }));
    if (advice) return { ...advice, trigger: `1m CHoCH through ${trigger.level} at ${trigger.time} already confirmed` };
  }
  if (plan.status === "READY" && (plan.direction === "CE" || plan.direction === "PE")) {
    const advice = fromSetup(plan.direction, obj(plan.spot), "Trend confluence (desk plan READY)", text(plan.headline, 200), Math.min(90, Math.round(Math.abs(num(verdict.score) ?? 5) * 10)), [], texts(plan.reasons_for, 5));
    if (advice) return advice;
  }
  if (mtf && mtf.spot && (mtf.action === "BUY_CE" || mtf.action === "BUY_PE")) {
    const side = mtf.action === "BUY_CE" ? "CE" : "PE";
    const advice = fromSetup(side, { entry: mtf.spot.entry, stop: mtf.spot.stop, target1: mtf.spot.target1, target2: mtf.spot.target2 }, "Multi-timeframe pullback (1D/15m/5m aligned + 1m trigger)", mtf.headline, mtf.confidence, mtf.psychology, mtf.reasons);
    if (advice) return { ...advice, risks: mtf.risks, trigger: mtf.trigger, invalidation: mtf.invalidation };
  }
  const smartRead = text(smart.headline ?? smart.reason, 300);
  return {
    ...base,
    action: "WAIT",
    confidence: 0,
    headline: blockedBy.length ? `Wait: ${blockedBy[0]}` : "Wait: no confirmed zone reversal or READY plan",
    strategy: "Stand aside",
    marketRead: [verdict.bias ? `Confluence verdict ${verdict.bias} (${verdict.score}/10).` : "", smartRead, mtf ? `Multi-timeframe: ${mtf.headline}.` : ""].filter(Boolean).join(" "),
    psychology: texts(smart.psychology, 3),
    reasons: [],
    contract: null,
    spot: null,
    premium: null,
    trigger: smart.status === "ARMED" ? smartRead : mtf?.trigger || "Price reaching a demand/supply zone and a 1-minute change of character",
    invalidation: "",
    exitPlan: [],
  };
}
