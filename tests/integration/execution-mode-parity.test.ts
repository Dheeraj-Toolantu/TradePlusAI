import { describe, expect, it } from "vitest";
import { PaperBrokerAdapter } from "../../services/paper-trading/src/paper-broker-adapter";
import { selectExecutionTarget } from "../../services/execution/src/execution-target";

describe("execution mode parity", () => { it("selects Paper Broker without live flags", () => { const paper = new PaperBrokerAdapter({ id: "p", capital: 100000, balance: 100000, realizedPnl: 0, orders: [] }); const groww = paper; expect(selectExecutionTarget("PAPER", paper, groww)).toBe(paper); }); });