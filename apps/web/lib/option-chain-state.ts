export function formatConfidenceText(confidence?: number | null): string {
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    return `${Math.round(confidence)}/100`;
  }

  return "No confidence";
}

export function formatExpectedMoveText(expectedMove?: number | null): string {
  if (typeof expectedMove === "number" && Number.isFinite(expectedMove)) {
    return Number.isInteger(expectedMove) ? String(expectedMove) : expectedMove.toFixed(2);
  }

  return "No expected move";
}

export function formatMarketCalculationValue(value: number | string | null | undefined, options: { percent?: boolean; currency?: boolean } = {}): string {
  const { percent = false, currency = false } = options;

  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    const normalized = value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    if (currency) return `₹${normalized}`;
    return percent ? `${normalized}x` : normalized;
  }

  const normalized = String(value).replaceAll("_", " ").trim();
  return normalized || "—";
}

export function getOrderExitState(order: {
  price?: number | null;
  target?: number | null;
  stopLoss?: number | null;
  highWaterMark?: number | null;
  trailingStop?: number | null;
  trailingDistance?: number | null;
  trailingActivatedAt?: string | null;
}, premium?: number | null): { effectiveStop: number; hitStop: boolean; hitTarget: boolean; exitReason: "AUTO_TARGET" | "AUTO_TRAILING_STOP" | "AUTO_STOP_LOSS" | null } {
  const entry = Number(order.price ?? 0);
  const target = Number(order.target ?? entry);
  const baseStop = Number(order.stopLoss ?? 0);
  const currentPremium = Number(premium ?? order.price ?? 0);
  const highWaterMark = Number(order.highWaterMark ?? entry);
  const trailDistance = Number(order.trailingDistance ?? (entry > 0 && baseStop > 0 ? Math.max(entry - baseStop, 0) : 0));
  const effectiveStop = order.trailingActivatedAt || highWaterMark > entry
    ? Math.max(baseStop, highWaterMark - trailDistance)
    : baseStop;

  const hitTarget = currentPremium >= target;
  const hitStop = currentPremium <= effectiveStop;

  return {
    effectiveStop,
    hitStop,
    hitTarget,
    exitReason: hitTarget ? "AUTO_TARGET" : hitStop ? (order.trailingActivatedAt || highWaterMark > entry ? "AUTO_TRAILING_STOP" : "AUTO_STOP_LOSS") : null,
  };
}

export function getOptionChainEmptyState(title: string, chainError?: string): { title: string; detail: string } {
  const normalizedTitle = title?.trim() || "No actionable option candidates";
  const normalizedDetail = (chainError ?? "").trim();

  return {
    title: normalizedTitle,
    detail: normalizedDetail
      ? `Rate limited or incomplete market data: ${normalizedDetail}. The option-chain engine is intentionally waiting for fresh evidence before suggesting a trade.`
      : "The option-chain engine is intentionally waiting for fresh evidence before suggesting a trade. Market data is temporarily unavailable or incomplete.",
  };
}
