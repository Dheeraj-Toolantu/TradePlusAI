export type TrailingMethod = "FIXED" | "PERCENTAGE" | "ATR" | "SWING" | "PREVIOUS_CANDLE" | "VWAP";

export function nextStop(method: TrailingMethod, currentStop: number, price: number, value: number): number {
  if (method === "PERCENTAGE") return price * (1 - value / 100);
  if (method === "FIXED") return price - value;
  return Math.max(currentStop, price - value);
}