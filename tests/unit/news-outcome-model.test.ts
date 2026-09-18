import { describe, expect, it } from "vitest";
import { NewsOutcomeRepository } from "../../services/news-intelligence/src/news-outcome-repository";

describe("news outcome model", () => { it("keeps predictions append-only", () => { const repository = new NewsOutcomeRepository(); repository.save({ eventId: "e", predictionId: "p", predictedDirection: "BEARISH", predictedImpact: 80, confidence: 70, horizon: "1m" }); expect(repository.list()[0].predictedImpact).toBe(80); }); });