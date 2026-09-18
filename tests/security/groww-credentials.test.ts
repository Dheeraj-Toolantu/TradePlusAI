import { describe, expect, it } from "vitest";
import { createGrowwTransport } from "../../adapters/groww/src/groww-adapter";
import { assertServerOnlyConfig, readGrowwConfig } from "../../services/execution/src/groww-config";

describe("Groww credential boundary", () => { it("reports missing token without exposing a secret", async () => { const transport = createGrowwTransport({}); await expect(transport.request("/health", { method: "GET" })).rejects.toThrow("GROWW_ACCESS_TOKEN is not configured"); expect(readGrowwConfig({}).accessTokenConfigured).toBe(false); }); it("rejects public token configuration", () => { expect(() => assertServerOnlyConfig({ NEXT_PUBLIC_GROWW_ACCESS_TOKEN: "secret" })).toThrow(); }); });

it("refreshes an expired access token before requesting live data", async () => {
	const originalFetch = globalThis.fetch;
	const calls: Array<{ url: string; authorization: string | null }> = [];
	const expiredToken = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
	globalThis.fetch = (async (input, init) => {
		const headers = new Headers(init?.headers);
		calls.push({ url: String(input), authorization: headers.get("authorization") });
		if (String(input).includes("/v1/token/api/access")) return new Response(JSON.stringify({ payload: { token: "fresh-token" } }), { status: 200 });
		return new Response(JSON.stringify({ payload: { ltp: 24000, last_price: 24000 } }), { status: 200 });
	}) as typeof fetch;
	try {
		const transport = createGrowwTransport({ GROWW_ACCESS_TOKEN: expiredToken, GROWW_API_KEY: "api-key", GROWW_API_SECRET: "api-secret", GROWW_API_BASE_URL: "https://groww.test" });
		await expect(transport.request("/v1/live-data/quote", { method: "GET" })).resolves.toMatchObject({ payload: { ltp: 24000 } });
		expect(calls.some((call) => call.url.includes("/v1/token/api/access"))).toBe(true);
		expect(calls.at(-1)?.authorization).toBe("Bearer fresh-token");
	} finally {
		globalThis.fetch = originalFetch;
	}
});