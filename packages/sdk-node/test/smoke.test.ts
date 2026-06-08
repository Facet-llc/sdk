// Phase 8 smoke test — drives the typed `createTerminalClient` against
// a real Facet Terminal. Runs in its own CI tier (`sdk-smoke-test`); the
// default `pnpm test` run scopes to offline unit tests via
// `vitest.config.ts`.
//
// The smoke assertion is intentionally narrow: the SDK can dispatch a
// real request, parse the response envelope, and surface either the
// success body OR the structured `FacetErrorEnvelope` to the caller.
// We do NOT assert the Terminal returns 200 — the production Terminal
// classifies unauthenticated traffic as `PAYMENT_REQUIRED` (HTTP 402)
// per spec, which is itself a load-bearing signal that the SDK round-
// trip works end-to-end against the live wire contract.
//
// `FACET_SMOKE_BASE_URL` overrides the target; it defaults to the
// production base URL listed in the spec's `servers:` block.

import { describe, expect, it } from "vitest";
import { createTerminalClient } from "../src/index.ts";

const SMOKE_BASE_URL = process.env["FACET_SMOKE_BASE_URL"] ?? "https://api.facet.llc";

describe("sdk-node smoke against a live Facet Terminal", () => {
  it("createTerminalClient builds a working typed client (network round-trip)", async () => {
    const client = createTerminalClient({ baseUrl: SMOKE_BASE_URL });
    const { data, error, response } = await client.GET("/v1/version");
    // Either the success body (VersionResponse) or a structured
    // FacetErrorEnvelope MUST surface. Anything else (network failure,
    // non-JSON body, undefined response) fails the smoke.
    expect(response).toBeDefined();
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(600);
    if (response.ok) {
      expect(data).toBeDefined();
    } else {
      expect(error).toBeDefined();
      const envelope = error as { error?: { code?: string } } | undefined;
      // Production Terminal returns PAYMENT_REQUIRED for unauthenticated
      // calls — verify the envelope decodes through openapi-fetch.
      expect(envelope?.error?.code).toBeDefined();
    }
  });

  it("openapi-fetch headers + URL composition reach the live Terminal", async () => {
    const client = createTerminalClient({
      baseUrl: SMOKE_BASE_URL,
      userAgent: "@facet-llc/sdk-node smoke-test",
    });
    const { response } = await client.GET("/v1/version");
    // The Terminal sets a trace-id header on every response. We accept
    // either `x-facet-trace-id` or `x-agent-trace-id`; either confirms
    // we are actually hitting the Facet stack and not a proxy that ate
    // the request.
    const traceId =
      response.headers.get("x-facet-trace-id") ?? response.headers.get("x-agent-trace-id");
    expect(traceId).toBeTruthy();
  });
});
