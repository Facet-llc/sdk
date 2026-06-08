import { defineConfig } from "vitest/config";

// Phase 8 of openapi-as-contract: separate the offline unit tests from
// the smoke test that hits `terminal.facet.llc`. The smoke test runs
// in its own CI tier (`sdk-smoke-test`); the unit tests run in the
// default `pnpm test` flow.
//
// `pnpm --filter @facet-llc/sdk-node test` → unit tests only.
// `pnpm --filter @facet-llc/sdk-node test:smoke` → smoke against the
// production Terminal.

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke.test.ts", "node_modules/**", "dist/**"],
  },
});
