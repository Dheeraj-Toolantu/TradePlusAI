export function liveExecutionEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.LIVE_EXECUTION_ENABLED === "true" && environment.LIVE_COMPLIANCE_APPROVED === "true";
}

export function canActivateLive(input: { allGatesPassed: boolean; brokerHealthy: boolean; reconciled: boolean; consent: boolean; promotionApproved: boolean; releaseEvidenceComplete?: boolean }, environment: NodeJS.ProcessEnv = process.env): boolean { return input.allGatesPassed && input.brokerHealthy && input.reconciled && input.consent && input.promotionApproved && input.releaseEvidenceComplete === true && liveExecutionEnabled(environment); }