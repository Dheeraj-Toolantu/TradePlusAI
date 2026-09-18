import type { SetupStateEvent } from "../../../packages/event-schemas/src/events";

export type AnalysisAuditRecord = {
  analysisId: string;
  action: "ANALYSIS_EVALUATED" | "SETUP_STATE_CHANGED" | "EXPLANATION_REQUESTED";
  strategyVersion: string;
  calculationVersion: string;
  reason?: string;
  payload: unknown;
  occurredAt: string;
};

export class AnalysisAuditStore {
  private readonly records: AnalysisAuditRecord[] = [];

  append(record: Omit<AnalysisAuditRecord, "occurredAt">): AnalysisAuditRecord {
    const created = { ...record, occurredAt: new Date().toISOString() };
    this.records.push(created);
    return created;
  }

  appendStateEvent(event: SetupStateEvent, analysisId: string): AnalysisAuditRecord {
    return this.append({
      analysisId,
      action: "SETUP_STATE_CHANGED",
      strategyVersion: event.strategyVersion,
      calculationVersion: event.calculationVersion,
      reason: event.reason,
      payload: event,
    });
  }

  list(analysisId?: string): AnalysisAuditRecord[] {
    return this.records.filter((record) => analysisId === undefined || record.analysisId === analysisId);
  }
}
