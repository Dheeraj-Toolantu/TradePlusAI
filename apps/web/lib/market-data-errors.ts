import { isRateLimitError } from "../../../adapters/groww/src/groww-rate-limiter";

export function safeMarketDataError(error: unknown, fallback: string): string {
  if (isRateLimitError(error)) return "Market data is temporarily rate limited. Please try again shortly.";
  return fallback;
}