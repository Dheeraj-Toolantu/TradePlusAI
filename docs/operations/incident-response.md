# Incident Response and Operational Ownership

## Scope

This runbook covers market-data quality failures, risk-service outages, broker authentication failures, unknown order states, protection failures, unexpected positions, notification delivery failures, and accidental mode changes.

## Ownership

- Trading operator: pauses paper or assisted workflows and confirms the visible safe state.
- Risk owner: reviews risk-gate failures, daily-loss breaches, exposure, and kill-switch actions.
- Broker integration owner: investigates Groww authentication, rate limits, order status, protection, and reconciliation failures.
- Platform owner: investigates availability, data quality, observability, audit, and deployment failures.
- Compliance owner: approves or rejects any live-release evidence; technical tests do not replace this approval.

## Immediate response

1. Keep or activate the kill switch and confirm `LIVE_EXECUTION_ENABLED=false` unless a formally approved release is in progress.
2. Stop new entries when data is stale, crossed, outlier, discontinuous, unauthenticated, unreconciled, or missing protection.
3. Preserve existing positions and show the management state; do not retry unknown orders until reconciliation completes.
4. Record the event, correlation ID, mode, instrument, timestamps, failed checks, and operator action in the audit trail.
5. Escalate unresolved broker, protection, security, or compliance events to the named owner before resuming automation.

## Recovery evidence

Recovery requires a healthy data feed, risk service, broker session, reconciled positions, valid protection state, completed notification delivery or retry state, and a documented review of the incident. Live activation additionally requires current broker/exchange/regulatory, consent, suitability, privacy, disclosure, and compliance evidence.
