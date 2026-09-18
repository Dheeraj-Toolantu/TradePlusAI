export type PriceActionMarker = { type: "HH_HL" | "LH_LL" | "BREAKOUT" | "BREAKDOWN" | "RETEST" | "REJECTION"; index: number; price: number };

export function detectPriceAction(highs: number[], lows: number[], closes: number[]): PriceActionMarker[] {
  const markers: PriceActionMarker[] = [];
  for (let index = 1; index < Math.min(highs.length, lows.length, closes.length); index += 1) {
    if (highs[index] > highs[index - 1] && lows[index] > lows[index - 1]) markers.push({ type: "HH_HL", index, price: closes[index] });
    if (highs[index] < highs[index - 1] && lows[index] < lows[index - 1]) markers.push({ type: "LH_LL", index, price: closes[index] });
    if (closes[index] > highs[index - 1]) markers.push({ type: "BREAKOUT", index, price: closes[index] });
    if (closes[index] < lows[index - 1]) markers.push({ type: "BREAKDOWN", index, price: closes[index] });
    const rejectedHigh = highs[index] > highs[index - 1] && closes[index] < highs[index - 1];
    const rejectedLow = lows[index] < lows[index - 1] && closes[index] > lows[index - 1];
    if (rejectedHigh || rejectedLow) markers.push({ type: "REJECTION", index, price: closes[index] });
  }
  return markers;
}
