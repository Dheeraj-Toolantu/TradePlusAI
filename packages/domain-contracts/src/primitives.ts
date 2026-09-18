export type Mode = "PAPER" | "ASSISTED" | "ALGO_LIVE";
export type Decision = "ALLOW" | "BLOCK" | "REQUIRE_CONFIRMATION";
export type Freshness = "FRESH" | "STALE" | "UNKNOWN" | "NOT_APPLICABLE";
export type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export type Identifier = string;
export type IsoTimestamp = string;

export type Money = {
  amount: number;
  currency: "INR";
};

export type Quantity = number;

export type DomainError = {
  code: string;
  message: string;
  retryable: boolean;
  safeStateImpact?: "NONE" | "BLOCK_NEW_ENTRIES" | "EMERGENCY_PROTECTION";
};