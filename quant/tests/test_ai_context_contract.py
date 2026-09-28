import json
from pathlib import Path

from tradepulse_quant.algo_engine.engine import analyze_payload


def test_ai_context_fixture_preserves_deterministic_input_shape():
    fixture = json.loads(Path(__file__).parent.joinpath("fixtures", "ai_context.json").read_text())
    assert fixture["schemaVersion"] == "ai-trading-context.v1"
    assert fixture["freshness"] == "FRESH"
    assert fixture["quality"] == "VALID"
    assert fixture["candles"]
    assert set(fixture["candles"][0]) == {"timestamp", "open", "high", "low", "close", "volume"}
    assert fixture["deterministicAnalysis"]["status"] == "CONFIRMED"


def test_algo_payload_accepts_missing_volume():
    candles = [{"timestamp": "2026-09-21T09:15:00+05:30", "open": 100, "high": 101, "low": 99, "close": 100, "volume": None}] * 20
    result = analyze_payload({"symbol": "NIFTY", "strategy": "ORB_RETEST", "candles": candles})
    assert result["calculations"]["underlying"]["relative_volume"] is None
