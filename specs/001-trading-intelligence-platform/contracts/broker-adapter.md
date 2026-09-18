# Broker Adapter Contract

The execution service depends on this broker-neutral contract. Strategy, signal, risk, paper, and
UI code must not import a provider-specific adapter.

## Operations

- `authenticate(connection)` -> provider session state without returning secrets
- `healthCheck()` -> connectivity, authentication, permissions, and capability state
- `getQuotes(instruments)` -> normalized quote and freshness state
- `getHistoricalCandles(request)` -> normalized candles and quality state
- `getFunds()` -> available, used, and blocked funds
- `getPositions()` -> normalized positions with broker timestamp
- `getOrders(filter)` -> normalized orders and pagination state
- `placeOrder(order, idempotencyReference)` -> accepted/rejected response with broker ID
- `modifyOrder(order)` -> normalized resulting order state
- `cancelOrder(order)` -> normalized cancellation state
- `getOrderStatus(orderReference)` -> status, filled quantity, remaining quantity, and reason
- `getTrades(order)` -> one or more normalized fills
- `createProtectiveOrder(protection)` -> normalized protection state
- `modifyProtectiveOrder(protection)` -> normalized protection state
- `cancelProtectiveOrder(protection)` -> normalized cancellation state
- `reconcile(scope)` -> broker snapshot and detected discrepancies

## Invariants

- Every new order includes a unique internal reference suitable for provider idempotency limits.
- Unknown status requires status or reference lookup before retry.
- Partial fills emit cumulative and delta quantities.
- OCO quantity must be no greater than the absolute net position quantity.
- Provider credentials never cross the adapter boundary into client or ordinary logs.
- Adapter errors include retryability and safe-state impact.