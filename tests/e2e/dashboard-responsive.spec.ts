import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("dashboard responsive safety", () => { it("keeps a narrow-screen media rule", () => { expect(readFileSync("apps/web/app/globals.css", "utf8")).toContain("@media (max-width: 760px)"); }); });