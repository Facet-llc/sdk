// Scoped vitest config for live-sandbox-spt-verify.ts ONLY. Kept separate
// from the package's default config (which does not exist; vitest's
// default include glob is **/*.{test,spec}.ts) so this live-network,
// real-secret-dependent script is NEVER picked up by a bare `pnpm test`
// or `pnpm --filter @facet-llc/payment-adapter-stripe run test`. It is
// only ever run by explicitly passing this file via --config.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/live-sandbox-spt-verify.ts"],
  },
});
