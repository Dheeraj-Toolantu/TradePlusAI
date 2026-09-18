# UI Safety Contract

The desktop console must expose safety state as a persistent information layer across all primary
views, following the supplied dark trading-console reference.

## Persistent indicators

- Active mode: PAPER, ASSISTED, or ALGO LIVE
- Broker/session health and permission state
- Market-data freshness and safe-state status
- Risk gate state, current exposure, daily loss, and remaining limits
- Kill-switch state
- Active trade blockers and their reasons

## Required interaction behavior

- A blocked action explains the failed rule and current observed value.
- Live activation shows connection, permissions, exposure, risk limits, and confirmation together.
- No status color is the only communication; state includes text or an accessible label.
- Responsive layouts preserve safety indicators and do not overlap charts, controls, or alerts.
- Paper and simulated results are visibly distinct from assisted and live results.