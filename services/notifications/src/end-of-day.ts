export function endOfDaySummary(input: { realizedPnl: number; openPositions: number; mode: string }) {
  return { category: "END_OF_DAY", severity: input.openPositions ? "HIGH" : "INFO", message: `${input.mode} session closed with ${input.openPositions} open position(s) and P&L ${input.realizedPnl}`, createdAt: new Date().toISOString() };
}