export function SignalExplanation({ rationale, strategyVersion, riskState }: { rationale: string; strategyVersion: string; riskState: string }) {
  return <section aria-label="Signal explanation"><strong>Why this setup</strong><p>{rationale}</p><small>{strategyVersion} · Risk: {riskState}</small></section>;
}