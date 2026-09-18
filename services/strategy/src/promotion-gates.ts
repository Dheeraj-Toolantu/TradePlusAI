export type PromotionEvidence = { outOfSample: boolean; walkForward: boolean; paperValidated: boolean; assistedApproved: boolean; cappedLive: boolean; consent: boolean };
const order: Array<keyof PromotionEvidence> = ["outOfSample", "walkForward", "paperValidated", "assistedApproved", "cappedLive", "consent"];

export function nextPromotionState(evidence: PromotionEvidence): string {
  const index = order.findIndex((gate) => !evidence[gate]);
  return index === -1 ? "ALGO_LIVE_CAPPED" : ["DRAFT", "BACKTESTED", "WALK_FORWARD_VALIDATED", "PAPER_VALIDATED", "ASSISTED_APPROVED", "ALGO_LIVE_CAPPED"][index];
}