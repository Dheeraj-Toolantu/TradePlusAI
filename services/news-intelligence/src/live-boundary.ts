export function newsOutputCapabilities() { return ["CONTEXT", "REGIME_INPUT", "RISK_GATE_INPUT"] as const; }

export function assertNoOrderCapability(capability: string): void { if (capability === "SUBMIT_ORDER") throw new Error("News intelligence cannot submit live orders"); }