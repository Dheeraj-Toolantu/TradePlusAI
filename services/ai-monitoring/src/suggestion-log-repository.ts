import type { AISuggestionLogEntry, AITradingLogFilter } from "../../../packages/domain-contracts/src/ai-trading";

export interface SuggestionLogRepository {
  append(entry: AISuggestionLogEntry): AISuggestionLogEntry;
  replace(id: string, entry: AISuggestionLogEntry): never;
  list(filter?: AITradingLogFilter): AISuggestionLogEntry[];
  get(id: string): AISuggestionLogEntry | undefined;
}

export class InMemorySuggestionLogRepository implements SuggestionLogRepository {
  private readonly entries: AISuggestionLogEntry[] = [];

  append(entry: AISuggestionLogEntry): AISuggestionLogEntry {
    if (this.entries.some((candidate) => candidate.id === entry.id)) throw new Error("Duplicate log entry");
    this.entries.push(structuredClone(entry));
    return structuredClone(entry);
  }

  replace(_id: string, _entry: AISuggestionLogEntry): never {
    throw new Error("AI suggestion log entries are append-only");
  }

  list(filter: AITradingLogFilter = {}): AISuggestionLogEntry[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 200);
    return this.entries
      .filter((entry) => !filter.subjectId || entry.subjectId === filter.subjectId)
      .filter((entry) => !filter.symbol || entry.summary.symbol === filter.symbol)
      .filter((entry) => !filter.direction || entry.summary.direction === filter.direction)
      .filter((entry) => !filter.outcome || entry.summary.status === filter.outcome || entry.summary.decision === filter.outcome)
      .filter((entry) => !filter.from || entry.occurredAt >= filter.from)
      .filter((entry) => !filter.to || entry.occurredAt <= filter.to)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  get(id: string): AISuggestionLogEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === id);
    return entry ? structuredClone(entry) : undefined;
  }
}
