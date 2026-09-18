import { assertPaperIsolation } from "./mode-policy";

export function assertPaperDestination() { assertPaperIsolation("PAPER", "SIMULATOR"); return "SIMULATOR" as const; }