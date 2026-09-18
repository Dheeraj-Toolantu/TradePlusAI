from __future__ import annotations

import json
import sys
from dataclasses import asdict
from typing import Any

from .no_trade_engine import NoTradeEngine, PipelineEvidence


def evaluate_pipeline(evidence: PipelineEvidence) -> dict[str, Any]:
    decision = NoTradeEngine().evaluate(evidence)
    return decision.to_dict()


def evaluate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    fields = {field: payload.get(field) for field in PipelineEvidence.__dataclass_fields__}
    return evaluate_pipeline(PipelineEvidence(**fields))


def main() -> None:
    payload = json.load(sys.stdin)
    print(json.dumps(evaluate_payload(payload), sort_keys=True))


if __name__ == "__main__":
    main()
