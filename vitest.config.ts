import { defineConfig } from "vitest/config";

// Next's tsconfig keeps `jsx: "preserve"`; Vite 8's transformer honours it, so compile JSX here
// for tests that import .tsx modules.
export default defineConfig({ oxc: { jsx: { runtime: "automatic" } }, test: { environment: "node", include: ["tests/**/*.{test,spec}.ts"], setupFiles: ["tests/setup/firestore-fake.ts"] } });
