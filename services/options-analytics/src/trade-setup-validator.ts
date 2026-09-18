export type TradeSetupStatus =
  | "WAIT_FOR_BREAKOUT"
  | "WAIT_FOR_BREAKDOWN"
  | "NO_LONG"
  | "NO_SHORT"
  | "LONG"
  | "SHORT"
  | "BLOCKED_RR"
  | "INSUFFICIENT_DATA";

export type TradeSetupInput = {
  side: "LONG" | "SHORT";
  currentPrice: number;
  resistance?: number;
  support?: number;
  fiveMinuteClose?: number;
  breakoutClose?: number;
  breakdownClose?: number;
  retestHeld?: boolean;
  bullishConfirmation?: boolean;
  bearishConfirmation?: boolean;
  rejection?: boolean;
  swingLow?: number;
  swingHigh?: number;
  retestSupport?: number;
  retestResistance?: number;
  nextResistance?: number;
  nextSupport?: number;
  volatilityProjection?: number;
  stopBuffer?: number;
  minRiskReward?: number;
};

export type TradeSetupResult = {
  status: TradeSetupStatus;
  actionable: boolean;
  side: TradeSetupInput["side"];
  entry?: number;
  stop?: number;
  target?: number;
  riskPoints?: number;
  rewardPoints?: number;
  riskReward?: number;
  confirmation?: "BREAKOUT_CLOSE" | "BREAKOUT_RETEST" | "BREAKDOWN_CLOSE" | "BREAKDOWN_RETEST";
  reason: string;
};

const DEFAULT_MIN_RISK_REWARD = 2;
const DEFAULT_STOP_BUFFER = 0;

function result(input: TradeSetupInput, status: TradeSetupStatus, reason: string, details: Partial<TradeSetupResult> = {}): TradeSetupResult {
  return { status, actionable: status === "LONG" || status === "SHORT", side: input.side, reason, ...details };
}

function hasInvalidNumber(value: number | undefined): boolean {
  return value !== undefined && !Number.isFinite(value);
}

export function validateTradeSetup(input: TradeSetupInput): TradeSetupResult {
  const numericInputs = [
    input.currentPrice,
    input.resistance,
    input.support,
    input.fiveMinuteClose,
    input.breakoutClose,
    input.breakdownClose,
    input.swingLow,
    input.swingHigh,
    input.retestSupport,
    input.retestResistance,
    input.nextResistance,
    input.nextSupport,
    input.volatilityProjection,
    input.stopBuffer,
    input.minRiskReward,
  ];
  if (numericInputs.some((value) => hasInvalidNumber(value)) || input.currentPrice <= 0) {
    return result(input, "INSUFFICIENT_DATA", "Finite market prices are required.");
  }

  if (input.side === "LONG") {
    if (input.rejection) return result(input, "NO_LONG", "Resistance rejection invalidates the long setup.");
    if (input.resistance === undefined || input.fiveMinuteClose === undefined) {
      return result(input, "INSUFFICIENT_DATA", "Resistance and the latest 5-minute close are required.");
    }

    const breakoutCloseConfirmed = input.fiveMinuteClose > input.resistance;
    const retestConfirmed = input.breakoutClose !== undefined
      && input.breakoutClose > input.resistance
      && input.retestHeld === true
      && input.bullishConfirmation === true;
    if (!breakoutCloseConfirmed && !retestConfirmed) {
      return result(input, "WAIT_FOR_BREAKOUT", "Wait for a confirmed 5-minute close above resistance or a bullish breakout-retest hold.");
    }

    const stopReference = retestConfirmed ? input.retestSupport : input.swingLow;
    const target = input.nextResistance ?? input.currentPrice + (input.volatilityProjection ?? 0);
    if (stopReference === undefined || target <= input.currentPrice) {
      return result(input, "INSUFFICIENT_DATA", "A structural stop and validated upside target are required before entry.");
    }

    const stop = stopReference - (input.stopBuffer ?? DEFAULT_STOP_BUFFER);
    const riskPoints = input.currentPrice - stop;
    const rewardPoints = target - input.currentPrice;
    if (riskPoints <= 0 || rewardPoints <= 0) {
      return result(input, "INSUFFICIENT_DATA", "Structural stop and target must define positive risk and reward.");
    }

    const riskReward = rewardPoints / riskPoints;
    const details = {
      entry: input.currentPrice,
      stop,
      target,
      riskPoints,
      rewardPoints,
      riskReward,
      confirmation: retestConfirmed ? "BREAKOUT_RETEST" as const : "BREAKOUT_CLOSE" as const,
    };
    if (riskReward < (input.minRiskReward ?? DEFAULT_MIN_RISK_REWARD)) {
      return result(input, "BLOCKED_RR", "Minimum risk/reward requirement failed before entry display.", details);
    }
    return result(input, "LONG", "Confirmed long setup passed structural and minimum risk/reward validation.", details);
  }

  if (input.rejection) return result(input, "NO_SHORT", "Support rejection is not sufficient bearish confirmation for a short setup.");
  if (input.support === undefined || input.fiveMinuteClose === undefined) {
    return result(input, "INSUFFICIENT_DATA", "Support and the latest 5-minute close are required.");
  }

  const breakdownCloseConfirmed = input.fiveMinuteClose < input.support;
  const retestConfirmed = input.breakdownClose !== undefined
    && input.breakdownClose < input.support
    && input.retestHeld === true
    && input.bearishConfirmation === true;
  if (!breakdownCloseConfirmed && !retestConfirmed) {
    return result(input, "WAIT_FOR_BREAKDOWN", "Wait for a confirmed 5-minute close below support or a bearish breakdown-retest hold.");
  }

  const stopReference = retestConfirmed ? input.retestResistance : input.swingHigh;
  const target = input.nextSupport ?? input.currentPrice - (input.volatilityProjection ?? 0);
  if (stopReference === undefined || target >= input.currentPrice) {
    return result(input, "INSUFFICIENT_DATA", "A structural stop and validated downside target are required before entry.");
  }

  const stop = stopReference + (input.stopBuffer ?? DEFAULT_STOP_BUFFER);
  const riskPoints = stop - input.currentPrice;
  const rewardPoints = input.currentPrice - target;
  if (riskPoints <= 0 || rewardPoints <= 0) {
    return result(input, "INSUFFICIENT_DATA", "Structural stop and target must define positive risk and reward.");
  }

  const riskReward = rewardPoints / riskPoints;
  const details = {
    entry: input.currentPrice,
    stop,
    target,
    riskPoints,
    rewardPoints,
    riskReward,
    confirmation: retestConfirmed ? "BREAKDOWN_RETEST" as const : "BREAKDOWN_CLOSE" as const,
  };
  if (riskReward < (input.minRiskReward ?? DEFAULT_MIN_RISK_REWARD)) {
    return result(input, "BLOCKED_RR", "Minimum risk/reward requirement failed before entry display.", details);
  }
  return result(input, "SHORT", "Confirmed short setup passed structural and minimum risk/reward validation.", details);
}
