import { afterEach, describe, expect, it, vi } from "vitest";

const python = vi.hoisted(() => ({ calls: [] as Array<{ module: string; payload: Record<string, unknown> }> }));
vi.mock("../../apps/web/lib/python", () => ({
  runPythonModule: async (module: string, payload: Record<string, unknown>) => {
    python.calls.push({ module, payload });
    return { status: "READY", estimate: 183 };
  },
}));

import { POST } from "../../apps/web/app/api/algo-trading/premium-estimate/route";

const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/algo-trading/premium-estimate", { method: "POST", body: JSON.stringify(body) }));

describe("premium estimate route", () => {
  afterEach(() => { vi.unstubAllGlobals(); python.calls.length = 0; });

  it("rejects a request without a contract and key level", async () => {
    expect((await post({ symbol: "NIFTY", option_type: "PE" })).status).toBe(400);
    expect((await post({ symbol: "RELIANCE", option_type: "PE", strike: 100, key_level: 90 })).status).toBe(400);
  });

  it("passes the chain and the user's overrides to the model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ spot: 25000, contracts: [{ strike: 24900 }] }), { status: 200 })));
    const response = await post({ symbol: "nifty", option_type: "pe", strike: 24900, key_level: 24800, premium: 95, spot: "", iv_change: -3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ estimate: 183 });
    const call = python.calls.at(-1)!;
    expect(call.module).toBe("tradepulse_quant.algo_engine.open_premium");
    expect(call.payload).toMatchObject({ symbol: "NIFTY", option_type: "PE", strike: 24900, key_level: 24800, premium: 95, iv_change: -3, option_chain: { spot: 25000 } });
    expect(call.payload).not.toHaveProperty("spot");
  });
});
