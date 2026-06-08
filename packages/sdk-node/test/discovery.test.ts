import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CapabilityMismatchError,
  FetchError,
  InvalidManifestError,
  NoManifestError,
  SUPPORTED_FACET_VERSIONS,
  UnsupportedVersionError,
  clearAgentsTxtCache,
  discoverAndConnect,
  fetchAgentsTxt,
} from "../src/index.ts";

// ── fake fetch helper ─────────────────────────────────────────────────────

interface ScriptedResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: unknown;
}

function fakeFetch(script: (url: string) => ScriptedResponse | Promise<ScriptedResponse>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const resp = await script(url);
    if (resp.throws !== undefined) throw resp.throws;
    return new Response(resp.body ?? "", {
      status: resp.status ?? 200,
      headers: resp.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const VALID_V11 = [
  "Facet-Version: 1.1",
  "Terminal: https://api.merchant.example.com/v1",
  "KYA-Issuers: https://issuer.example.com",
  "Capabilities: catalog, paywalled-content",
  "",
].join("\n");

beforeEach(() => {
  clearAgentsTxtCache();
});

describe("fetchAgentsTxt", () => {
  it("returns the parsed manifest on 200 + valid v1.1", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: VALID_V11 }));
    const manifest = await fetchAgentsTxt("merchant.example.com", { fetch });
    expect(manifest.facetVersion).toBe("1.1");
    expect(manifest.terminal).toBe("https://api.merchant.example.com/v1");
    expect(manifest.kyaIssuers).toEqual(["https://issuer.example.com"]);
    expect(manifest.capabilities).toEqual(["catalog", "paywalled-content"]);
  });

  it("requests /.well-known/agents.txt at the given domain via https", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: VALID_V11 }));
    await fetchAgentsTxt("merchant.example.com", { fetch });
    expect(calls).toEqual(["https://merchant.example.com/.well-known/agents.txt"]);
  });

  it("accepts a fully-qualified origin in the domain arg", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: VALID_V11 }));
    await fetchAgentsTxt("https://merchant.example.com:8443", { fetch });
    expect(calls).toEqual(["https://merchant.example.com:8443/.well-known/agents.txt"]);
  });

  it("throws NoManifestError on HTTP 404", async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: "not found" }));
    await expect(fetchAgentsTxt("merchant.example.com", { fetch })).rejects.toMatchObject({
      name: "NoManifestError",
      domain: "merchant.example.com",
      status: 404,
    });
  });

  it("throws FetchError on other non-2xx (e.g. 500)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, body: "kaboom" }));
    await expect(fetchAgentsTxt("merchant.example.com", { fetch })).rejects.toBeInstanceOf(
      FetchError,
    );
  });

  it("throws FetchError when the network layer fails", async () => {
    const { fetch } = fakeFetch(() => ({ throws: new Error("ECONNREFUSED") }));
    const err = await fetchAgentsTxt("merchant.example.com", { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).cause).toBeInstanceOf(Error);
  });

  it("throws InvalidManifestError when the body fails parsing", async () => {
    const malformed = "this is not\nan agents.txt\n";
    const { fetch } = fakeFetch(() => ({ status: 200, body: malformed }));
    await expect(fetchAgentsTxt("merchant.example.com", { fetch })).rejects.toBeInstanceOf(
      InvalidManifestError,
    );
  });

  it("throws UnsupportedVersionError on Facet-Version: 0.1", async () => {
    const body = [
      "Facet-Version: 0.1",
      "Terminal: https://api.merchant.example.com/v1",
      "KYA-Issuers: https://issuer.example.com",
      "",
    ].join("\n");
    const { fetch } = fakeFetch(() => ({ status: 200, body }));
    const err = await fetchAgentsTxt("merchant.example.com", { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedVersionError);
    expect((err as UnsupportedVersionError).facetVersion).toBe("0.1");
    expect((err as UnsupportedVersionError).supported).toEqual(SUPPORTED_FACET_VERSIONS);
  });

  it("accepts all supported versions (0.2 + 1.0 + 1.1)", async () => {
    for (const v of SUPPORTED_FACET_VERSIONS) {
      const body = [
        `Facet-Version: ${v}`,
        "Terminal: https://api.merchant.example.com/v1",
        "KYA-Issuers: https://issuer.example.com",
        "",
      ].join("\n");
      const { fetch } = fakeFetch(() => ({ status: 200, body }));
      const manifest = await fetchAgentsTxt(`merchant-${v}.example.com`, { fetch });
      expect(manifest.facetVersion).toBe(v);
    }
  });

  it("caches the manifest using the response's Cache-Control: max-age", async () => {
    let hits = 0;
    const { fetch } = fakeFetch(() => {
      hits += 1;
      return {
        status: 200,
        body: VALID_V11,
        headers: { "cache-control": "public, max-age=600" },
      };
    });
    const t0 = 1_000_000;
    await fetchAgentsTxt("merchant.example.com", { fetch, now: () => t0 });
    expect(hits).toBe(1);
    // Inside the 600s window → cache hit.
    await fetchAgentsTxt("merchant.example.com", { fetch, now: () => t0 + 599_000 });
    expect(hits).toBe(1);
    // Past the window → re-fetch.
    await fetchAgentsTxt("merchant.example.com", { fetch, now: () => t0 + 601_000 });
    expect(hits).toBe(2);
  });

  it("falls back to opts.ttlMs when Cache-Control is absent", async () => {
    let hits = 0;
    const { fetch } = fakeFetch(() => {
      hits += 1;
      return { status: 200, body: VALID_V11 };
    });
    const t0 = 2_000_000;
    await fetchAgentsTxt("merchant.example.com", { fetch, ttlMs: 60_000, now: () => t0 });
    await fetchAgentsTxt("merchant.example.com", { fetch, ttlMs: 60_000, now: () => t0 + 30_000 });
    expect(hits).toBe(1);
    await fetchAgentsTxt("merchant.example.com", { fetch, ttlMs: 60_000, now: () => t0 + 70_000 });
    expect(hits).toBe(2);
  });

  it("Cache-Control: no-store disables caching", async () => {
    let hits = 0;
    const { fetch } = fakeFetch(() => {
      hits += 1;
      return {
        status: 200,
        body: VALID_V11,
        headers: { "cache-control": "no-store" },
      };
    });
    await fetchAgentsTxt("merchant.example.com", { fetch });
    await fetchAgentsTxt("merchant.example.com", { fetch });
    expect(hits).toBe(2);
  });

  it("noCache forces a re-fetch even when an entry is still fresh", async () => {
    let hits = 0;
    const { fetch } = fakeFetch(() => {
      hits += 1;
      return { status: 200, body: VALID_V11 };
    });
    await fetchAgentsTxt("merchant.example.com", { fetch });
    await fetchAgentsTxt("merchant.example.com", { fetch, noCache: true });
    expect(hits).toBe(2);
  });
});

describe("discoverAndConnect", () => {
  it("returns a TerminalClient pointed at the manifest's Terminal URL", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.endsWith("/.well-known/agents.txt")) {
        return new Response(VALID_V11, { status: 200 });
      }
      // Capabilities probe through the returned client.
      return new Response(JSON.stringify({ tools: [], webhook_events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = await discoverAndConnect("merchant.example.com", { fetch: fetchImpl });
    await client.capabilities();
    expect(
      calls.some((u) => u.startsWith("https://api.merchant.example.com/v1/v1/capabilities")),
    ).toBe(true);
  });

  it("passes the capability check when every required cap is advertised", async () => {
    const fetchImpl = (async () =>
      new Response(VALID_V11, { status: 200 })) as unknown as typeof fetch;
    const client = await discoverAndConnect("merchant.example.com", {
      fetch: fetchImpl,
      capabilityCheck: ["catalog"],
    });
    expect(client).toBeDefined();
  });

  it("throws CapabilityMismatchError when a required cap is missing", async () => {
    const fetchImpl = (async () =>
      new Response(VALID_V11, { status: 200 })) as unknown as typeof fetch;
    const err = await discoverAndConnect("merchant.example.com", {
      fetch: fetchImpl,
      capabilityCheck: ["catalog", "auction"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityMismatchError);
    expect((err as CapabilityMismatchError).missing).toEqual(["auction"]);
    expect((err as CapabilityMismatchError).advertised).toEqual(["catalog", "paywalled-content"]);
  });

  it("throws CapabilityMismatchError when the manifest declares no capabilities", async () => {
    const body = [
      "Facet-Version: 1.0",
      "Terminal: https://api.merchant.example.com/v1",
      "KYA-Issuers: https://issuer.example.com",
      "",
    ].join("\n");
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const err = await discoverAndConnect("merchant.example.com", {
      fetch: fetchImpl,
      capabilityCheck: ["catalog"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityMismatchError);
    expect((err as CapabilityMismatchError).advertised).toEqual([]);
  });

  it("propagates NoManifestError up from the manifest fetch", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(
      discoverAndConnect("merchant.example.com", { fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(NoManifestError);
  });
});

// ── happy path against a local HTTP fixture server ────────────────────────

describe("discoverAndConnect (HTTP fixture server)", () => {
  let server: Server;
  let origin: string;
  const calls: string[] = [];

  beforeEach(async () => {
    calls.length = 0;
    server = createServer((req, res) => {
      calls.push(req.url ?? "");
      if (req.url === "/.well-known/agents.txt") {
        const body = [
          "Facet-Version: 1.1",
          `Terminal: ${origin}/v1`,
          "KYA-Issuers: https://issuer.example.com",
          "Capabilities: catalog",
          "",
        ].join("\n");
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        });
        res.end(body);
        return;
      }
      if (req.url === "/v1/v1/capabilities") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tools: [{ name: "search" }], webhook_events: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches a real manifest and lets the returned client call capabilities()", async () => {
    const client = await discoverAndConnect(origin, { capabilityCheck: ["catalog"] });
    const caps = await client.capabilities();
    expect(caps).toMatchObject({ tools: [{ name: "search" }] });
    expect(calls).toContain("/.well-known/agents.txt");
    expect(calls).toContain("/v1/v1/capabilities");
  });
});
