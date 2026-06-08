// Unit tests for the openapi-fetch-backed `createTerminalClient`. The
// smoke test against `terminal.facet.llc` lives in `smoke.test.ts` and
// runs in a separate CI tier.

import { describe, expect, it } from "vitest";
import { createTerminalClient } from "../src/index.ts";

interface ScriptedResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function fakeFetch(script: (input: Request) => ScriptedResponse | Promise<ScriptedResponse>): {
  fetch: (input: Request) => Promise<Response>;
  calls: Request[];
} {
  const calls: Request[] = [];
  const fetchImpl = async (input: Request): Promise<Response> => {
    calls.push(input);
    const resp = await script(input);
    const body = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    return new Response(body, {
      status: resp.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(resp.headers ?? {}),
      },
    });
  };
  return { fetch: fetchImpl, calls };
}

describe("createTerminalClient", () => {
  it("returns a typed openapi-fetch client whose GET /v1/health resolves to a HealthResponse", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { status: "ok", timestamp: "2026-05-25T00:00:00Z" },
    }));
    const client = createTerminalClient({
      baseUrl: "https://terminal.facet.llc",
      fetch,
    });
    const { data, error } = await client.GET("/v1/health");
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    // Generated `HealthResponse` narrows `status` to the literal "ok".
    expect(data?.status).toBe("ok");
    expect(data?.timestamp).toBe("2026-05-25T00:00:00Z");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://terminal.facet.llc/v1/health");
    expect(calls[0]!.method).toBe("GET");
  });

  it("strips trailing slashes from baseUrl so request URLs stay canonical", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { status: "ok", timestamp: "2026-05-25T00:00:00Z" },
    }));
    const client = createTerminalClient({
      baseUrl: "https://terminal.facet.llc///",
      fetch,
    });
    await client.GET("/v1/health");
    expect(calls[0]!.url).toBe("https://terminal.facet.llc/v1/health");
  });

  it("sends Authorization: Bearer <token> when kyaToken is a string", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { status: "ok", timestamp: "2026-05-25T00:00:00Z" },
    }));
    const client = createTerminalClient({
      baseUrl: "https://terminal.facet.llc",
      kyaToken: "kya-test-token",
      fetch,
    });
    await client.GET("/v1/health");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer kya-test-token");
  });

  it("resolves async kyaToken providers lazily on each request", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { status: "ok", timestamp: "2026-05-25T00:00:00Z" },
    }));
    let counter = 0;
    const client = createTerminalClient({
      baseUrl: "https://terminal.facet.llc",
      kyaToken: async () => `kya-${++counter}`,
      fetch,
    });
    await client.GET("/v1/health");
    await client.GET("/v1/health");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer kya-1");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer kya-2");
  });

  it("threads custom headers without overwriting the openapi-fetch defaults", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { status: "ok", timestamp: "2026-05-25T00:00:00Z" },
    }));
    const client = createTerminalClient({
      baseUrl: "https://terminal.facet.llc",
      headers: { "x-tenant-id": "acme" },
      userAgent: "test-agent/1.0",
      fetch,
    });
    await client.GET("/v1/health");
    expect(calls[0]!.headers.get("x-tenant-id")).toBe("acme");
    expect(calls[0]!.headers.get("user-agent")).toBe("test-agent/1.0");
  });

  it("exposes the FacetErrorEnvelope on non-2xx as `error` (per openapi-fetch contract)", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 401,
      body: {
        error: {
          code: "UNAUTHORIZED",
          message: "missing KYA token",
        },
      },
    }));
    const client = createTerminalClient({
      baseUrl: "https://terminal.facet.llc",
      fetch,
    });
    const { data, error, response } = await client.GET("/v1/health");
    expect(data).toBeUndefined();
    expect(response.status).toBe(401);
    // openapi-fetch hands back the raw parsed body in `error`. The
    // FacetErrorCode closed union narrows callers' branching.
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });
});
