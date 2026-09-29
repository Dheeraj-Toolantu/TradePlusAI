from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Decision = Literal["CONFIRMED", "NO_TRADE"]


@dataclass(frozen=True)
class GateEvidence:
    code: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class NoTradeDecision:
    decision: Decision
    reasons: tuple[str, ...]
    gates: tuple[GateEvidence, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "decision": self.decision,
            "reasons": list(self.reasons),
            "gates": [{"code": gate.code, "passed": gate.passed, "detail": gate.detail} for gate in self.gates],
        }


@dataclass(frozen=True)
class PipelineEvidence:
    data_quality_ok: bool | None = None
    session_allowed: bool | None = None
    strategy_decision: str | None = None
    regime: str | None = None
    setup_side: str | None = None
    gap_state: str | None = None
    breakout_valid: bool | None = None
    retest_confirmed: bool | None = None
    ors_confirmed: bool | None = None
    oi_pcr_supportive: bool | None = None
    vix_regime: str | None = None
    score: float | None = None
    minimum_score: float = 8.0
    option_quote_fresh: bool | None = None
    liquidity_score: float | None = None
    risk_reward: float | None = None
    daily_risk_allowed: bool | None = None
    daily_risk_detail: str | None = None
    broker_healthy: bool | None = None
    contract_metadata_available: bool | None = None
    reconciliation_ok: bool | None = None
    safe_mode: bool = False
    kill_switch: bool = False
    execution_ready: bool | None = None
    broker_forced_exit: bool = False


class NoTradeEngine:
    """Authoritative deterministic gate for all algo-page trade decisions."""

    def evaluate(self, evidence: PipelineEvidence) -> NoTradeDecision:
        gates: list[GateEvidence] = []
        reasons: list[str] = []

        def require(code: str, value: bool | None, detail: str) -> None:
            passed = value is True
            gates.append(GateEvidence(code, passed, detail))
            if value is None:
                reasons.append(f"MISSING_{code}")
            elif not passed:
                reasons.append(code)

        require("DATA_QUALITY_BLOCKED", evidence.data_quality_ok, "market and option data must pass quality checks")
        require("SESSION_BLOCKED", evidence.session_allowed, "new entries require an open entry window")
        require("OPTION_QUOTE_STALE", evidence.option_quote_fresh, "option quote must be fresh")
        require("DAILY_RISK_BLOCKED", evidence.daily_risk_allowed, evidence.daily_risk_detail or "daily risk manager must approve the entry")
        require("BROKER_UNHEALTHY", evidence.broker_healthy, "broker/API health must be confirmed")
        require("CONTRACT_METADATA_MISSING", evidence.contract_metadata_available, "live contract metadata is required")
        require("RECONCILIATION_REQUIRED", evidence.reconciliation_ok, "broker state must be reconciled")
        require("EXECUTION_NOT_READY", evidence.execution_ready, "execution state machine must be ready")

        strategy_confirmed = evidence.strategy_decision == "CONFIRMED"
        gates.append(GateEvidence("STRATEGY_NOT_CONFIRMED", strategy_confirmed, "strategy decision must be CONFIRMED"))
        if evidence.strategy_decision is None:
            reasons.append("MISSING_STRATEGY_DECISION")
        elif not strategy_confirmed:
            reasons.append("STRATEGY_NOT_CONFIRMED")

        require("BREAKOUT_INVALID", evidence.breakout_valid, "a valid completed-candle breakout is required")
        require("RETEST_NOT_CONFIRMED", evidence.retest_confirmed, "a confirmed retest is required")
        require("ORS_NOT_CONFIRMED", evidence.ors_confirmed, "option relative strength must confirm direction")
        require("OI_PCR_NOT_SUPPORTIVE", evidence.oi_pcr_supportive, "OI/PCR evidence must support direction")

        valid_vix = evidence.vix_regime in {"LOW", "NORMAL", "HIGH"}
        gates.append(GateEvidence("VIX_BLOCKED", valid_vix, "extreme or missing VIX regime blocks entry"))
        if evidence.vix_regime is None:
            reasons.append("MISSING_VIX_REGIME")
        elif not valid_vix:
            reasons.append("VIX_BLOCKED")

        valid_regime = evidence.regime in {"TRENDING_BULL", "TRENDING_BEAR"}
        # A BUY setup in a bearish trend (or SELL in a bullish one) is a conflicting regime.
        if valid_regime and evidence.setup_side in {"BUY", "SELL"}:
            conflict = (evidence.setup_side == "BUY" and evidence.regime == "TRENDING_BEAR") or (evidence.setup_side == "SELL" and evidence.regime == "TRENDING_BULL")
            if conflict:
                gates.append(GateEvidence("REGIME_CONFLICT", False, f"{evidence.setup_side} setup against a {evidence.regime} regime"))
                reasons.append("REGIME_CONFLICT")
        gates.append(GateEvidence("REGIME_BLOCKED", valid_regime, "CHOP, RANGE, UNKNOWN, and conflicting regimes cannot enter"))
        if evidence.regime is None:
            reasons.append("MISSING_REGIME")
        elif not valid_regime:
            reasons.append("REGIME_BLOCKED")

        valid_gap = evidence.gap_state in {"NORMAL_DAY", "GAP_HOLD_CONFIRMED", "GAP_FILL_CONFIRMED"}
        gates.append(GateEvidence("GAP_UNRESOLVED", valid_gap, "gap state must be normal or confirmed hold/fill"))
        if evidence.gap_state is None:
            reasons.append("MISSING_GAP_STATE")
        elif not valid_gap:
            reasons.append("GAP_UNRESOLVED")

        valid_score = evidence.score is not None and evidence.score >= evidence.minimum_score and evidence.score <= 10
        gates.append(GateEvidence("SCORE_BELOW_MINIMUM", valid_score, "score must be within 0-10 and meet the configured minimum"))
        if evidence.score is None:
            reasons.append("MISSING_SCORE")
        elif not valid_score:
            reasons.append("SCORE_BELOW_MINIMUM")

        valid_liquidity = evidence.liquidity_score is not None and 2 <= evidence.liquidity_score <= 3
        gates.append(GateEvidence("LIQUIDITY_BLOCKED", valid_liquidity, "minimum liquidity score is 2"))
        if evidence.liquidity_score is None:
            reasons.append("MISSING_LIQUIDITY_SCORE")
        elif not valid_liquidity:
            reasons.append("LIQUIDITY_BLOCKED")

        valid_rr = evidence.risk_reward is not None and evidence.risk_reward >= 2.0
        gates.append(GateEvidence("RR_BELOW_MINIMUM", valid_rr, "minimum expected reward/risk is 2.0"))
        if evidence.risk_reward is None:
            reasons.append("MISSING_RISK_REWARD")
        elif not valid_rr:
            reasons.append("RR_BELOW_MINIMUM")

        if evidence.safe_mode:
            gates.append(GateEvidence("SAFE_MODE_ACTIVE", False, "SAFE_MODE blocks new entries"))
            reasons.append("SAFE_MODE_ACTIVE")
        if evidence.kill_switch:
            gates.append(GateEvidence("KILL_SWITCH_ACTIVE", False, "kill switch blocks new entries"))
            reasons.append("KILL_SWITCH_ACTIVE")
        if evidence.broker_forced_exit:
            gates.append(GateEvidence("BROKER_FORCED_EXIT", False, "forced exit halts the remainder of the session"))
            reasons.append("BROKER_FORCED_EXIT")

        return NoTradeDecision("NO_TRADE" if reasons else "CONFIRMED", tuple(reasons), tuple(gates))
