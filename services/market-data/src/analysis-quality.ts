import type { AnalysisQuality, AnalysisResponse, NoTradeStatus } from "../../../packages/domain-contracts/src/analysis";

export type AnalysisQualityResult = {
  status: AnalysisQuality;
  reasons: string[];
};

export function noTradeStatusForQuality(quality: AnalysisQualityResult): NoTradeStatus {
  if (quality.status === "STALE" || quality.status === "INVALID" || quality.status === "DISCONTINUOUS") return "NO_TRADE";
  if (quality.status === "INSUFFICIENT_DATA") return "WAIT_FOR_CONFIRMATION";
  return "WAIT_FOR_CONFIRMATION";
}

export function applyQualityBlock<T extends Pick<AnalysisResponse, "quality" | "dataQuality" | "tradeSetup" | "annotations">>(response: T, quality: AnalysisQualityResult): T {
  if (quality.status === "VALID") return response;
  return {
    ...response,
    quality: quality.status,
    dataQuality: quality,
    tradeSetup: null,
    annotations: [],
  };
}
