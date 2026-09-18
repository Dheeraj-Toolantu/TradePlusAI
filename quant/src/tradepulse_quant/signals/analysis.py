from .configuration import StrategyConfiguration
from .chart_patterns import detect_chart_patterns
from .confirmation import score_confirmation
from .indicators import calculate_indicators
from .market_structure import detect_structure
from .models import AnalysisSnapshot, Evidence
from .ohlcv import OHLCVSeries
from .patterns import detect_candlestick_patterns
from .price_zones import detect_price_zones


def evaluate_analysis(series: OHLCVSeries, config: StrategyConfiguration | None = None) -> AnalysisSnapshot:
    configuration = config or StrategyConfiguration()
    if series.quality.status != "VALID":
        return AnalysisSnapshot(series.quality, None, None, (), (), ())
    indicators = calculate_indicators(series, configuration)
    structure = detect_structure(series)
    patterns = detect_candlestick_patterns(series)
    chart_patterns = detect_chart_patterns(series)
    zones = detect_price_zones(series, structure)
    evidence = tuple(Evidence("PATTERN", pattern.name, pattern.state) for pattern in patterns)
    evidence += tuple(Evidence("CHART_PATTERN", pattern.name, pattern.confidence) for pattern in chart_patterns)
    evidence += tuple(Evidence("STRUCTURE", relationship.kind, relationship.current_index) for relationship in structure.relationships)
    return AnalysisSnapshot(series.quality, indicators, structure, zones, evidence, ())
