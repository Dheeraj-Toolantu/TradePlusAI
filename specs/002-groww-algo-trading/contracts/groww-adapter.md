# Groww Adapter Contract

The adapter is server-side and implements the shared broker contract.

## Operations

- `healthCheck()` -> authenticated state, permissions, API version, timestamp
- `getQuotes(symbols)` -> normalized symbol, price, change, percentage, timestamp
- `getPositions()` -> normalized symbol, quantity, average price
- `placeOrder(request)` -> provider order ID, status, filled and remaining quantities
- `getOrderStatus(reference)` -> normalized status and fill quantities
- `cancelOrder(providerOrderId)` -> normalized cancellation state
- `reconcile()` -> unexpected positions and discrepancy state
- `createProtection(plan)` -> OCO/SL/target state where provider capability permits

## Transport rules

- Add bearer token and API version only in the server-side transport.
- Never log authorization headers or raw credentials.
- Convert non-2xx responses to structured domain errors.
- Use `order_reference_id` for idempotency and reconcile before retry.
- Provider-specific payloads do not cross into strategy or UI code.