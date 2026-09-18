export function entryAllowedDuringEvent(severity: "LOW" | "MEDIUM" | "HIGH" | "EXTREME", corroborated: boolean, blackout: boolean): boolean {
  if (blackout) return false;
  if ((severity === "HIGH" || severity === "EXTREME") && !corroborated) return false;
  return true;
}