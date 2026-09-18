import { describe, expect, it } from "vitest";
import { calibrationReport } from "../../services/news-intelligence/src/calibration-service";

describe("news calibration", () => { it("reports bias without mutating predictions", () => { const report = calibrationReport([{ eventId: "e", predictionId: "p", predictedDirection: "BULLISH", predictedImpact: 90, confidence: 80, horizon: "1d", accuracy: 0.2 }]); expect(report.bias).toBe("UNDERPERFORMS"); expect(report.originalPredictionsImmutable).toBe(true); }); });