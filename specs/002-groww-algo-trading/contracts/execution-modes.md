# Execution Modes Contract

| Mode | Destination | Provider calls | Required approval |
|---|---|---:|---|
| PAPER | Paper Broker simulator | 0 Groww calls | None |
| ASSISTED | Groww Broker after user confirmation | Allowed after gates | User confirmation, health, risk |
| ALGO LIVE | Groww Broker automatically | Allowed after gates | Promotion, consent, health, compliance, live flags |

## Safety invariants

- Paper mode cannot construct or receive a Groww transport.
- Assisted and live modes cannot bypass the flow gate.
- Live flags are false by default.
- Broker credentials are never returned to the browser.