# Analysis API Contract

This contract describes the project-facing boundary for deterministic analysis and chart rendering. Provider-specific market-data details remain behind existing market-data contracts.

## POST `/api/analysis/evaluate`

Evaluates one instrument or an underlying/option pair using a versioned strategy configuration.

### Request

```json
{
  "instrumentId": "sensex-cash",
  "symbol": "SENSEX",
  "timeframe": "5m",
  "candles": [
    { "timestamp": "2026-09-10T09:15:00+05:30", "open": 81000, "high": 81050, "low": 80980, "close": 81030, "volume": 12000 }
  ],
  "strategyVersion": "ai-chart-v1",
  "configuration": {
    "minimumRr": 2,
    "minimumConfidence": 75,
    "requireVolumeConfirmation": true,
    "requireSupportConfirmation": true,
    "requireMtfConfirmation": true
  },
  "higherTimeframe": { "timeframe": "15m", "candles": [] },
  "entryTimeframe": { "timeframe": "1m", "candles": [] },
  "option": null
}
```

### Response: valid or blocked analysis

```json
{
  "analysisId": "analysis-123",
  "status": "CONFIRMED",
  "quality": "VALID",
  "dataQuality": { "status": "VALID", "reasons": [] },
  "indicators": {},
  "marketStructure": {},
  "patterns": [],
  "zones": [],
  "confirmation": { "total": 84, "quality": "CONFIRMED", "components": {}, "blockers": [] },
  "tradeSetup": {
    "symbol": "SENSEX",
    "direction": "LONG",
    "timeframe": "5m",
    "entry": { "min": 81030, "max": 81045 },
    "stopLoss": { "price": 80880 },
    "targets": [ { "label": "T1", "price": 81330 }, { "label": "T2", "price": 81500 }, { "label": "T3", "price": 81800 } ],
    "riskReward": [ { "targetLabel": "T1", "ratio": 2.0 } ],
    "confidence": 84,
    "reasons": [],
    "risks": [],
    "invalidation": "5m close below 80880"
  },
  "annotations": [],
  "explanation": { "status": "AVAILABLE", "whyThisSetup": [], "risks": [] },
  "versions": { "strategy": "ai-chart-v1", "calculation": "analysis-v1" }
}
```

### Response: no-trade or insufficient analysis

The response uses HTTP success for a valid evaluation that reaches a no-trade decision. Invalid request shape uses the existing API error convention. The body MUST preserve reasons and blockers:

```json
{
  "analysisId": "analysis-124",
  "status": "WAIT_FOR_CONFIRMATION",
  "quality": "INSUFFICIENT_DATA",
  "dataQuality": { "status": "STALE", "reasons": ["latest candle exceeds freshness limit"] },
  "confirmation": { "total": 42, "quality": "WEAK", "components": {}, "blockers": ["volume confirmation missing"] },
  "tradeSetup": null,
  "annotations": [],
  "explanation": { "status": "UNAVAILABLE", "whyThisSetup": [], "risks": [] },
  "versions": { "strategy": "ai-chart-v1", "calculation": "analysis-v1" }
}
```

Allowed no-trade statuses: `NO_TRADE`, `WAIT_FOR_CONFIRMATION`, `WAIT_FOR_BREAKOUT`, `INVALIDATED`.

## GET `/api/analysis/{analysisId}/annotations`

Returns annotations derived from the immutable analysis snapshot and current setup lifecycle. It MUST not recalculate prices or accept client-supplied levels.

## POST `/api/backtests`

Accepts `symbol`, `timeframe`, `start`, `end`, `strategyVersion`, `capital`, and `riskPerTrade`. Returns a versioned `BacktestResult` with trade-level evidence and aggregate metrics. The endpoint MUST label the run as historical simulation and preserve a reproducibility key.

## Event Contract: `analysis.setup-state.v1`

Published or persisted for each lifecycle transition:

```json
{
  "eventType": "analysis.setup-state.v1",
  "setupId": "setup-123",
  "from": "WAITING_CONFIRMATION",
  "to": "CONFIRMED",
  "reason": "all configured confirmations passed",
  "strategyVersion": "ai-chart-v1",
  "calculationVersion": "analysis-v1",
  "occurredAt": "2026-09-10T09:25:00+05:30"
}
```

The event is auditable and has no broker side effect. AI explanation requests may reference an analysis ID but cannot change this event or its source setup.
