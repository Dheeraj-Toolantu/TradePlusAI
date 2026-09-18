// Explicit, server-only SAFE_MODE / KILL_SWITCH state for the V5 no-trade gate.
// These flags are read directly from the process environment so they cannot be
// set or cleared by a UI request or any client-supplied payload.
export type SafeModeState = {
  safeMode: boolean;
  safeModeReason: string | null;
  killSwitch: boolean;
  killSwitchReason: string | null;
};

export function readSafeModeState(environment: NodeJS.ProcessEnv = process.env): SafeModeState {
  const safeMode = environment.ALGO_SAFE_MODE === "true";
  const killSwitch = environment.ALGO_KILL_SWITCH === "true";
  return {
    safeMode,
    safeModeReason: safeMode ? (environment.ALGO_SAFE_MODE_REASON ?? "SAFE_MODE enabled by operator") : null,
    killSwitch,
    killSwitchReason: killSwitch ? (environment.ALGO_KILL_SWITCH_REASON ?? "KILL_SWITCH enabled by operator") : null,
  };
}
