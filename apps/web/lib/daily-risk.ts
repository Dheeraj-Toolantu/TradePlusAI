import type { OrderRecord } from "./firestore-orders";

/** V5 spec section 18 daily risk controls (mirrors quant StrategyConfiguration defaults). */
export const DAILY_RISK_RULES = {
  dailyLossLimitPct: 2,
  maxTradesPerDay: 3,
  maxConsecutiveLosses: 2,
  cooldownMinutesAfterLoss: 15,
  maxOpenPositionsPerUnderlying: 1,
} as const;

export type DailyRiskState = {
  allowed: boolean;
  detail: string;
  tradesToday: number;
  realizedPnl: number;
  consecutiveLosses: number;
  cooldownUntil: string | null;
  openPositions: number;
};

const istDate = (value: Date) => new Date(value.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const istClock = (value: Date) => value.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });
const inr = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
const exitTime = (order: OrderRecord) => new Date(order.exitAt ?? order.updatedAt ?? order.createdAt).getTime();

function belongsTo(order: OrderRecord, underlying: string) {
  const name = String(order.underlying ?? "").toUpperCase();
  if (name) return name === underlying;
  // SENSEX / BANKNIFTY contracts must not be read as NIFTY ones.
  const symbol = String(order.symbol ?? "").toUpperCase();
  return symbol.startsWith(underlying) && !(underlying === "NIFTY" && symbol.startsWith("NIFTYNXT"));
}

/**
 * Paper-book daily risk manager. Previously only the trade count and realised loss were checked,
 * so the consecutive-loss lock, the 15-minute cooldown after a loss and the one-position rule
 * from the spec were never enforced, and the gate never said which rule blocked it.
 */
export function evaluateDailyRisk(orders: OrderRecord[], underlying: string, capital: number, now = new Date()): DailyRiskState {
  const today = istDate(now);
  const todays = orders.filter((order) => order.mode !== "ALGO_LIVE" && order.status !== "CANCELLED" && order.status !== "SIMULATED" && istDate(new Date(order.createdAt)) === today);
  const exited = todays.filter((order) => order.status === "EXITED").sort((left, right) => exitTime(left) - exitTime(right));
  const realizedPnl = exited.reduce((sum, order) => sum + Number(order.realizedPnl ?? 0), 0);
  let consecutiveLosses = 0;
  for (let index = exited.length - 1; index >= 0 && Number(exited[index].realizedPnl ?? 0) < 0; index -= 1) consecutiveLosses += 1;
  const lastLoss = consecutiveLosses ? exited[exited.length - 1] : null;
  const cooldownEnd = lastLoss ? exitTime(lastLoss) + DAILY_RISK_RULES.cooldownMinutesAfterLoss * 60_000 : 0;
  const openPositions = orders.filter((order) => order.mode !== "ALGO_LIVE" && (order.status === "OPEN" || order.status === "FILLED") && belongsTo(order, underlying.toUpperCase())).length;
  const lossLimit = capital * DAILY_RISK_RULES.dailyLossLimitPct / 100;

  const blocks: string[] = [];
  if (todays.length >= DAILY_RISK_RULES.maxTradesPerDay) blocks.push(`${todays.length}/${DAILY_RISK_RULES.maxTradesPerDay} trades already taken today`);
  if (-realizedPnl >= lossLimit) blocks.push(`daily loss ${inr(realizedPnl)} reached the ${inr(-lossLimit)} limit`);
  if (consecutiveLosses >= DAILY_RISK_RULES.maxConsecutiveLosses) blocks.push(`${consecutiveLosses} consecutive losses: entries stopped for the day`);
  else if (cooldownEnd > now.getTime()) blocks.push(`cooling down after a loss until ${istClock(new Date(cooldownEnd))} IST`);
  if (openPositions >= DAILY_RISK_RULES.maxOpenPositionsPerUnderlying) blocks.push(`a ${underlying} position is already open`);

  const summary = `${todays.length}/${DAILY_RISK_RULES.maxTradesPerDay} trades · realised ${inr(realizedPnl)} (limit ${inr(-lossLimit)}) · ${consecutiveLosses} consecutive loss${consecutiveLosses === 1 ? "" : "es"}`;
  return {
    allowed: blocks.length === 0,
    detail: blocks.length ? `Blocked: ${blocks.join("; ")}. ${summary}` : `OK: ${summary}`,
    tradesToday: todays.length,
    realizedPnl,
    consecutiveLosses,
    cooldownUntil: cooldownEnd > now.getTime() ? new Date(cooldownEnd).toISOString() : null,
    openPositions,
  };
}
