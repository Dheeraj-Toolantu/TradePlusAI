export type GrowwConfig = {
  baseUrl: string;
  apiVersion: string;
  executionMode: "PAPER" | "ALGO_LIVE";
  accessTokenConfigured: boolean;
  apiKeySecretConfigured: boolean;
  liveExecutionEnabled: boolean;
  complianceApproved: boolean;
};

function executionMode(value: string | undefined): "PAPER" | "ALGO_LIVE" {
  return value === "ALGO_LIVE" ? "ALGO_LIVE" : "PAPER";
}

export function readGrowwConfig(environment: NodeJS.ProcessEnv = process.env): GrowwConfig {
  return {
    baseUrl: environment.GROWW_API_BASE_URL ?? "https://api.groww.in",
    apiVersion: environment.GROWW_API_VERSION ?? "1.0",
    executionMode: executionMode(environment.EXECUTION_MODE),
    accessTokenConfigured: Boolean(environment.GROWW_ACCESS_TOKEN),
    apiKeySecretConfigured: Boolean(environment.GROWW_API_KEY && environment.GROWW_API_SECRET),
    liveExecutionEnabled: environment.LIVE_EXECUTION_ENABLED === "true",
    complianceApproved: environment.LIVE_COMPLIANCE_APPROVED === "true",
  };
}

export function assertServerOnlyConfig(environment: NodeJS.ProcessEnv = process.env): GrowwConfig {
  if (Object.keys(environment).some((key) => key.startsWith("NEXT_PUBLIC_GROWW"))) throw new Error("Groww credentials cannot use public environment variables");
  return readGrowwConfig(environment);
}