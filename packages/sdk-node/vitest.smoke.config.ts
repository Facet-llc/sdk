import { defineConfig } from "vitest/config";

// Smoke-only config. `pnpm test:smoke` hits the production
// `terminal.facet.llc` Terminal — kept out of the default `pnpm test`
// run (see `vitest.config.ts`) so CI tier 1 stays offline.

export default defineConfig({
  test: {
    include: ["test/smoke.test.ts"],
    testTimeout: 30_000,
  },
});
