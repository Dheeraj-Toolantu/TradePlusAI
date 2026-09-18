import type { NewsOutcome } from "../../../packages/domain-contracts/src/groww-algo-entities";

export class NewsOutcomeRepository {
  private readonly outcomes: NewsOutcome[] = [];
  save(outcome: NewsOutcome) { if (this.outcomes.some((item) => item.eventId === outcome.eventId && item.predictionId === outcome.predictionId && item.horizon === outcome.horizon)) throw new Error("News outcome already exists"); this.outcomes.push({ ...outcome }); return outcome; }
  list() { return this.outcomes.map((outcome) => ({ ...outcome })); }
}