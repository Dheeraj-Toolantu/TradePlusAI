export type OptionLeg = { strike: number; ltp: number; oi: number; oiChange: number; iv?: number; volume?: number };

export type OiClassification = "LONG_BUILD_UP" | "SHORT_BUILD_UP" | "LONG_UNWINDING" | "SHORT_COVERING" | "UNKNOWN";

export function classifyOiChange(input: { priceChange?: number; oiChange?: number; volume?: number }) {
  if (![input.priceChange, input.oiChange, input.volume].every((value) => value !== undefined && Number.isFinite(value)) || input.volume! <= 0) return { classification: "UNKNOWN" as const, evidence: ["price, OI change, and positive volume are required"] };
  if (input.oiChange! > 0 && input.priceChange! > 0) return { classification: "LONG_BUILD_UP" as const, evidence: ["price increased", "open interest increased"] };
  if (input.oiChange! > 0 && input.priceChange! < 0) return { classification: "SHORT_BUILD_UP" as const, evidence: ["price decreased", "open interest increased"] };
  if (input.oiChange! < 0 && input.priceChange! > 0) return { classification: "SHORT_COVERING" as const, evidence: ["price increased", "open interest decreased"] };
  if (input.oiChange! < 0 && input.priceChange! < 0) return { classification: "LONG_UNWINDING" as const, evidence: ["price decreased", "open interest decreased"] };
  return { classification: "UNKNOWN" as const, evidence: ["price and OI change do not establish a directional classification"] };
}

export function summarizeOptions(calls: OptionLeg[], puts: OptionLeg[]) {
  const callOi = calls.reduce((sum, leg) => sum + leg.oi, 0);
  const putOi = puts.reduce((sum, leg) => sum + leg.oi, 0);
  return { callOi, putOi, pcr: callOi === 0 ? null : putOi / callOi, callSupport: calls.at(-1)?.strike ?? null, putSupport: puts.at(-1)?.strike ?? null };
}