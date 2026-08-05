import { describe, expect, it } from "vitest";
import { FacetClient } from "../src/index.ts";

// Live smoke against production discovery. OFF by default: the Facet edge WAF
// gates /v1/discover behind a bearer, so this needs a real KYA token and is only
// meaningful with network access. Run with:
//   FACET_E2E=1 FACET_KYA_TOKEN=<token> pnpm --filter @facet-llc/client test
// Absent either env var, the whole block is skipped so CI stays hermetic.
const DIRECTORY_URL = process.env.FACET_DIRECTORY_URL ?? "https://terminal.facet.llc/v1";
const KYA = process.env.FACET_KYA_TOKEN;
const ENABLED = process.env.FACET_E2E === "1" && typeof KYA === "string" && KYA.length > 0;

describe.skipIf(!ENABLED)("FacetClient.discover live smoke", () => {
  it("returns featured + results arrays for a keyword query", async () => {
    const client = new FacetClient({ terminalUrl: DIRECTORY_URL, kyaToken: KYA as string });
    const res = await client.discover({ query: "flowers", limit: 5 });
    expect(Array.isArray(res.featured)).toBe(true);
    expect(Array.isArray(res.results)).toBe(true);
    expect(typeof res.total_estimate).toBe("number");
    // Featured entries, when present, are stamped with `featured: true` and carry
    // a terminal_url that discoverAndConnect can resolve in one hop.
    for (const entry of res.featured) {
      expect(entry.featured).toBe(true);
      expect(typeof entry.ubi_id).toBe("string");
    }
  });
});
