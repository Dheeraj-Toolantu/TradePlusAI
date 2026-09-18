export function calculateRisk(entry: number, stop: number, target: number, capital: number, riskPercent: number, candidateQuantity: number, lotSize: number) {
  const riskPerUnit = Math.abs(entry - stop);
  const rewardPerUnit = Math.abs(target - entry);
  const maxLoss = capital * (riskPercent / 100);
  const quantityByRisk = riskPerUnit === 0 ? 0 : Math.floor(maxLoss / riskPerUnit);
  const normalizedQuantity = lotSize > 0 ? Math.floor(Math.min(candidateQuantity, quantityByRisk) / lotSize) * lotSize : 0;
  return { riskPerUnit, rewardPerUnit, maxLoss, expectedReward: rewardPerUnit * normalizedQuantity, normalizedQuantity, riskReward: riskPerUnit === 0 ? null : rewardPerUnit / riskPerUnit };
}