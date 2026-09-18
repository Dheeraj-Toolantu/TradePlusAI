# Live Readiness Review

Status: BLOCKED pending formal approval.

The application must not enable live execution until the current Groww API capabilities, exchange
requirements, SEBI retail-algo obligations, user consent, suitability, disclosures, credential
handling, audit retention, incident response, and operational ownership have been reviewed and signed.

The release guard requires `LIVE_EXECUTION_ENABLED=true` and `LIVE_COMPLIANCE_APPROVED=true`; both
values are intentionally false or absent in local development.

Feature review scope includes the ordered News -> Regime -> Technical -> Options/OI -> Liquidity ->
R:R -> Risk -> Execution flow, Groww provider permissions and rate limits, Paper/Groww isolation,
unknown-order recovery, OCO protection, reconciliation, audit retention, consent, and disclosure.

## Required evidence before activation

- Current Groww API capability and permission review.
- Current exchange and applicable SEBI retail-algo review.
- User consent, suitability, disclosure, privacy, and credential-handling review.
- Named trading, risk, broker-integration, platform, and compliance owners.
- Incident-response runbook at `docs/operations/incident-response.md`.
- Load, accessibility, paper-isolation, reconciliation, protection, kill-switch, and audit evidence.

Missing evidence must keep `releaseEvidenceComplete` false. Technical test success alone does not authorize live execution.