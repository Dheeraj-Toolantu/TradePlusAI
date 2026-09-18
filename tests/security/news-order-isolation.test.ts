import { describe, expect, it } from "vitest";
import { assertNoOrderCapability, newsOutputCapabilities } from "../../services/news-intelligence/src/live-boundary";

describe("news order isolation", () => { it("only exposes context and gate inputs", () => { expect(newsOutputCapabilities()).not.toContain("SUBMIT_ORDER"); expect(() => assertNoOrderCapability("SUBMIT_ORDER")).toThrow(); }); });