import { describe, expect, it, vi } from "vitest";
import { FacetClient, FacetClientError, FacetTransportError } from "../src/index.ts";

const TERMINAL = "https://facet.acme-ingredients.com/v1";

// Build a fake fetch that returns a scripted response. `capture` records
// every call so assertions can inspect the outgoing request shape.
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(script: (call: Captured) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (headers[k] = v));
    else if (h !== undefined) Object.assign(headers, h as Record<string, string>);
    const body = typeof init?.body === "string" ? init.body : null;
    const call: Captured = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body,
    };
    calls.push(call);
    return await script(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const merged = { "content-type": "application/json", ...headers };
  return new Response(JSON.stringify(body), { status, headers: merged });
}

// ── discovery endpoints (no auth) ───────────────────────────────────────────

describe("FacetClient discovery endpoints", () => {
  it("GET /v1/version parses response + echoes trace-id", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(
        200,
        { facet: "0.1.0", mcp_protocol_version: "2025-06-18", terminal: "@facet/terminal@0.2.0" },
        { "x-agent-trace-id": "trace-server-side" },
      ),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch });
    const got = await client.version();
    expect(got.facet).toBe("0.1.0");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/version`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(client.lastTraceId).toBe("trace-server-side");
  });

  it("GET /v1/schema (authenticated) returns the YAML body as a string", async () => {
    const yaml = "facet: 0.1.0\nsite:\n  id: acme\n";
    const { fetch, calls } = fakeFetch(
      () => new Response(yaml, { status: 200, headers: { "content-type": "application/yaml" } }),
    );
    // The manifest now requires identity, so the client must carry a token.
    const client = new FacetClient({
      terminalUrl: TERMINAL,
      fetch,
      kyaToken: () => "test.kya.token",
    });
    const got = await client.schema();
    expect(got).toBe(yaml);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer test.kya.token");
  });

  it("GET /v1/capabilities exposes nothing when the server omits rate-limit headers", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(200, {
        facet: "0.1.0",
        tools: ["search_products"],
        commerce: { search: true, quote: false, reserve: false, settle: false },
        webhooks: false,
        content_licensing: false,
        response_signing: false,
        rate_limits: { default: { requests_per_hour: 1000 } },
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch });
    await client.capabilities();
    expect(client.lastRateLimit).toBeNull();
  });
});

// ── UBI directory discovery ─────────────────────────────────────────────────

describe("FacetClient.discover (UBI directory)", () => {
  it("POST /v1/discover attaches the bearer when a token is configured, and parses featured + results", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        featured: [{ ubi_id: "ubi_1", name: "Featured Co", featured: true, terminal_url: null }],
        results: [{ ubi_id: "ubi_2", name: "Also Co", terminal_url: "https://also.example/v1" }],
        total_estimate: 2,
        next_offset: null,
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "kya.dir.token" });
    const got = await client.discover({ query: "coffee", limit: 2 });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/discover`);
    // The edge WAF gates every /v1/* path, so a token-carrying client MUST send
    // the bearer for a directory query to reach the Terminal.
    expect(calls[0]!.headers["authorization"]).toBe("Bearer kya.dir.token");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: "coffee", limit: 2 });
    expect(got.featured[0]!.name).toBe("Featured Co");
    expect(got.featured[0]!.featured).toBe(true);
    expect(got.results[0]!.ubi_id).toBe("ubi_2");
    expect(got.next_offset).toBeNull();
  });

  it("POST /v1/discover sends no Authorization when no token is configured (in-process caller)", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, { featured: [], results: [], total_estimate: 0, next_offset: null }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch });
    const got = await client.discover({ query: "coffee" });
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(got.featured).toEqual([]);
    expect(got.results).toEqual([]);
  });
});

// ── authenticated tools ─────────────────────────────────────────────────────

describe("FacetClient authenticated tools", () => {
  it("POST /v1/search sends Bearer + trace-id and captures rate-limit headers", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(
        200,
        { results: [{ id: "sku-0001" }], next_cursor: null },
        {
          "x-facet-ratelimit-limit": "1000",
          "x-facet-ratelimit-remaining": "997",
          "x-facet-ratelimit-reset": "1777000000",
          "x-agent-trace-id": "trace-xyz",
        },
      ),
    );
    const client = new FacetClient({
      terminalUrl: TERMINAL,
      fetch,
      kyaToken: "my-kya-token",
    });
    const got = await client.search({ query: "sugar" }, { traceId: "trace-xyz" });
    expect(got.results.length).toBe(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/search`);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer my-kya-token");
    expect(calls[0]!.headers["x-agent-trace-id"]).toBe("trace-xyz");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: "sugar" });
    expect(client.lastRateLimit).toEqual({
      limit: 1000,
      remaining: 997,
      reset: 1777000000,
    });
    expect(client.lastTraceId).toBe("trace-xyz");
  });

  it("dynamic kyaToken provider is awaited per-call", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { hello: "x", verified_at: "t" }));
    const tokens = ["token-1", "token-2"];
    const getKyaToken = vi.fn(async () => tokens.shift()!);
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: getKyaToken });
    await client.hello();
    await client.hello();
    expect(calls[0]!.headers["authorization"]).toBe("Bearer token-1");
    expect(calls[1]!.headers["authorization"]).toBe("Bearer token-2");
    expect(getKyaToken).toHaveBeenCalledTimes(2);
  });

  it("authenticated call without a kyaToken throws before firing fetch", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, {}));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch });
    await expect(client.whoami()).rejects.toThrow(/no kyaToken/);
    expect(calls.length).toBe(0);
  });

  it("Idempotency-Key header is forwarded when supplied", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        reservation_id: "r-1",
        product_id: "sku-0001",
        qty: 1,
        unit_price: 48.5,
        total: 48.5,
        currency: "USD",
        status: "reserved",
        expires_at: "2026-04-19T00:00:00.000Z",
        kya_charge_url: null,
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    await client.reserve({ quote_token: "abc.def" }, { idempotencyKey: "my-idem-key-1" });
    expect(calls[0]!.headers["idempotency-key"]).toBe("my-idem-key-1");
  });
});

// ── error handling ──────────────────────────────────────────────────────────

describe("FacetClient error handling", () => {
  it("non-2xx with a valid envelope throws FacetClientError with parsed fields", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        409,
        {
          error: {
            code: "INVENTORY_UNAVAILABLE",
            message: "sku-0002: 9999 requested, 64 available.",
            retryable: false,
            retry_after_seconds: null,
            suggest: { tool: "search_products", args: { category: "flavor" } },
          },
        },
        { "x-agent-trace-id": "trace-inv-1" },
      ),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.quote({ product_id: "sku-0002", qty: 9999 });
      expect.fail("expected FacetClientError");
    } catch (e) {
      expect(e).toBeInstanceOf(FacetClientError);
      const err = e as FacetClientError;
      expect(err.code).toBe("INVENTORY_UNAVAILABLE");
      expect(err.status).toBe(409);
      expect(err.retryable).toBe(false);
      expect(err.suggest?.tool).toBe("search_products");
      expect(err.traceId).toBe("trace-inv-1");
    }
  });

  it("FacetClientError surfaces suggest.signup (issuer onboarding pointer)", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Missing Authorization: Bearer <kya-token> header.",
          retryable: false,
          retry_after_seconds: null,
          suggest: { signup: "https://issuer.skyfire.xyz/register?ref=facet" },
        },
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.search({ query: "sugar" });
      expect.fail("expected FacetClientError");
    } catch (e) {
      expect(e).toBeInstanceOf(FacetClientError);
      const err = e as FacetClientError;
      expect(err.code).toBe("UNAUTHORIZED");
      expect(err.status).toBe(401);
      expect(err.suggest?.signup).toBe("https://issuer.skyfire.xyz/register?ref=facet");
    }
  });

  it("rate-limit 429 → FacetClientError with retryable=true + retryAfterSeconds", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        429,
        {
          error: {
            code: "RATE_LIMITED",
            message: "Rate limit exceeded. Retry in 42s.",
            retryable: true,
            retry_after_seconds: 42,
            suggest: null,
          },
        },
        { "retry-after": "42" },
      ),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.search({ query: "sugar" });
      expect.fail("expected FacetClientError");
    } catch (e) {
      const err = e as FacetClientError;
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.retryable).toBe(true);
      expect(err.retryAfterSeconds).toBe(42);
    }
  });

  it("non-2xx with non-JSON body throws FacetTransportError", async () => {
    const { fetch } = fakeFetch(
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.search({});
      expect.fail("expected FacetTransportError");
    } catch (e) {
      expect(e).toBeInstanceOf(FacetTransportError);
      const err = e as FacetTransportError;
      expect(err.status).toBe(502);
      expect(err.rawBody).toContain("502 Bad Gateway");
    }
  });

  it("non-2xx with JSON body that's not an envelope throws FacetTransportError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(500, { oops: "internal" }));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    await expect(client.search({})).rejects.toBeInstanceOf(FacetTransportError);
  });
});

// ── terminalUrl normalization ────────────────────────────────────────────────

describe("FacetClient url handling", () => {
  it("strips trailing slash from terminalUrl", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { status: "ok", timestamp: "t" }));
    const client = new FacetClient({ terminalUrl: TERMINAL + "/", fetch });
    await client.health();
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/health`);
  });
});

// ── Phase 2 commerce ─────────────────────────────────────────────────────────

describe("FacetClient Phase 2 commerce", () => {
  const sampleOrder = {
    order_id: "order-abc",
    reservation_id: "res-xyz",
    status: "settled",
    amount: 97,
    currency: "USD",
    rail: "coin/usdc-base",
    kya_charge_id: "dev_charge_123",
    line_items: [{ product_id: "sku-0001", qty: 2, unit_price: 48.5, subtotal: 97 }],
    created_at: "2026-04-19T00:00:00.000Z",
    settled_at: "2026-04-19T00:00:00.000Z",
  };

  it("settle() posts to /v1/settle with body + auth + optional idempotency key", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, sampleOrder));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "kya-bearer" });
    const order = await client.settle(
      { reservation_id: "res-xyz", rail: "coin/usdc-base" },
      { idempotencyKey: "ik-42" },
    );
    expect(order.order_id).toBe("order-abc");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/settle`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer kya-bearer");
    expect(calls[0]!.headers["idempotency-key"]).toBe("ik-42");
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      reservation_id: "res-xyz",
      rail: "coin/usdc-base",
    });
  });

  it("settle() surfaces SETTLEMENT_FAILED as FacetClientError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(402, {
        error: {
          code: "SETTLEMENT_FAILED",
          message: "payment rail rejected",
          retryable: false,
          retry_after_seconds: null,
          suggest: null,
        },
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.settle({ reservation_id: "res-xyz" });
      expect.fail("expected FacetClientError");
    } catch (e) {
      const err = e as FacetClientError;
      expect(err.code).toBe("SETTLEMENT_FAILED");
      expect(err.status).toBe(402);
    }
  });

  it("getOrder() posts to /v1/get_order with body.order_id", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, sampleOrder));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const out = await client.getOrder({ order_id: "order-abc" });
    expect(out.order_id).toBe("order-abc");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/get_order`);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ order_id: "order-abc" });
  });

  it("orderHistory() defaults to an empty body + parses next_cursor", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        orders: [sampleOrder],
        next_cursor: "abc",
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const page = await client.orderHistory();
    expect(page.orders.length).toBe(1);
    expect(page.next_cursor).toBe("abc");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/order_history`);
    expect(calls[0]!.body).toBe("{}");
  });

  it("orderHistory() threads `since`, `limit`, and `cursor` into the body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { orders: [], next_cursor: null }));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    await client.orderHistory({
      since: "2026-04-01T00:00:00.000Z",
      limit: 10,
      cursor: "b64cursor",
    });
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      since: "2026-04-01T00:00:00.000Z",
      limit: 10,
      cursor: "b64cursor",
    });
  });

  it("refundRequest() posts to /v1/refund_request with body + idempotency key", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        refund_id: "refund-1",
        order_id: "order-abc",
        status: "requested",
        reason: "damaged",
        decision: null,
        created_at: "2026-04-19T00:00:00.000Z",
        resolved_at: null,
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "kya-bearer" });
    const ticket = await client.refundRequest(
      { order_id: "order-abc", reason: "damaged" },
      { idempotencyKey: "ik-r1" },
    );
    expect(ticket.status).toBe("requested");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/refund_request`);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer kya-bearer");
    expect(calls[0]!.headers["idempotency-key"]).toBe("ik-r1");
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      order_id: "order-abc",
      reason: "damaged",
    });
  });

  it("refundRequest() surfaces IDEMPOTENCY_CONFLICT for unsettled orders", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(409, {
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Order xyz is 'refunded' — only settled orders can be refunded.",
          retryable: false,
          retry_after_seconds: null,
          suggest: null,
        },
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.refundRequest({ order_id: "xyz", reason: "late" });
      expect.fail("expected FacetClientError");
    } catch (e) {
      const err = e as FacetClientError;
      expect(err.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(err.status).toBe(409);
    }
  });

  it("getProduct() posts to /v1/get_product with body.product_id", async () => {
    const sampleProduct = {
      id: "sku-0001",
      name: "Cane Sugar",
      category: "sweetener",
      description: "organic",
      origin: "PY",
      hts_code: "1701.14",
      allergens: [],
      tags: ["organic"],
      pricing: { currency: "USD", per_case: 48.5 },
      pack: { case_pack: 50, uom: "lb" },
      in_stock: true,
      inventory: 240,
      coa_available: true,
      document_ids: ["doc-0001-coa"],
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, sampleProduct));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const out = await client.getProduct({ product_id: "sku-0001" });
    expect(out.origin).toBe("PY");
    expect(out.document_ids.length).toBe(1);
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/get_product`);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ product_id: "sku-0001" });
  });

  it("getDocument() posts to /v1/get_document and surfaces NOT_FOUND with suggest", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(404, {
        error: {
          code: "NOT_FOUND",
          message: "Unknown document_id: doc-nope",
          retryable: false,
          retry_after_seconds: null,
          suggest: { tool: "get_product" },
        },
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.getDocument({ document_id: "doc-nope" });
      expect.fail("expected FacetClientError");
    } catch (e) {
      const err = e as FacetClientError;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.suggest?.tool).toBe("get_product");
    }
  });

  it("requestHuman() posts to /v1/request_human + returns the opened ticket", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        ticket_id: "t-1",
        status: "open",
        reason: "bulk quote needed",
        sla_hours: 24,
        created_at: "2026-04-19T00:00:00.000Z",
        resolved_at: null,
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const got = await client.requestHuman({
      reason: "bulk quote needed",
      context: { po: "PO-1" },
    });
    expect(got.ticket_id).toBe("t-1");
    expect(got.status).toBe("open");
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/request_human`);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      reason: "bulk quote needed",
      context: { po: "PO-1" },
    });
  });

  it("catalogChangesSince() posts to /v1/catalog_changes_since + walks cursor pages", async () => {
    const pages: Array<{ next_cursor: string | null; changes: unknown[] }> = [
      {
        changes: [
          {
            kind: "document",
            action: "updated",
            id: "d1",
            product_id: "p1",
            updated_at: "2026-04-19T00:00:00.000Z",
          },
        ],
        next_cursor: "cur-1",
      },
      { changes: [], next_cursor: null },
    ];
    let i = 0;
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, pages[i++]!));
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });

    const first = await client.catalogChangesSince();
    expect(first.changes.length).toBe(1);
    expect(first.next_cursor).toBe("cur-1");
    const second = await client.catalogChangesSince({ cursor: first.next_cursor! });
    expect(second.changes.length).toBe(0);
    expect(second.next_cursor).toBeNull();
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/catalog_changes_since`);
    expect(JSON.parse(calls[1]!.body ?? "{}")).toEqual({ cursor: "cur-1" });
  });

  it("subscribeWebhook() round-trips — secret is returned at create time only", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        webhook_id: "wh-1",
        events: ["order.settled"],
        callback_url: "https://agent.example/hook",
        active: true,
        secret: "a".repeat(64),
        created_at: "2026-04-19T00:00:00.000Z",
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const got = await client.subscribeWebhook({
      events: ["order.settled"],
      callback_url: "https://agent.example/hook",
    });
    expect(got.webhook_id).toBe("wh-1");
    expect(got.secret.length).toBe(64);
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/subscribe_webhook`);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      events: ["order.settled"],
      callback_url: "https://agent.example/hook",
    });
  });

  it("listWebhooks() posts to /v1/list_webhooks and returns entries without secrets", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        webhooks: [
          {
            webhook_id: "wh-1",
            events: ["order.settled"],
            callback_url: "https://agent.example/hook",
            active: true,
            created_at: "2026-04-19T00:00:00.000Z",
          },
        ],
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const got = await client.listWebhooks();
    expect(got.webhooks.length).toBe(1);
    expect(got.webhooks[0]!.webhook_id).toBe("wh-1");
    // The client type does not even expose `secret` on ListWebhooks entries.
    expect(calls[0]!.url).toBe(`${TERMINAL}/v1/list_webhooks`);
    expect(calls[0]!.method).toBe("POST");
  });

  it("deleteWebhook() posts the id + surfaces FORBIDDEN for cross-agent attempts", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(403, {
        error: {
          code: "FORBIDDEN",
          message: "Webhook belongs to a different agent.",
          retryable: false,
          retry_after_seconds: null,
          suggest: null,
        },
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    try {
      await client.deleteWebhook({ webhook_id: "wh-other" });
      expect.fail("expected FacetClientError");
    } catch (e) {
      const err = e as FacetClientError;
      expect(err.code).toBe("FORBIDDEN");
    }
  });
});

// ── ucp checkout ─────────────────────────────────────────────────────────────

describe("FacetClient UCP checkout", () => {
  it("checkoutCreate() POSTs line_items to /ucp/v1/checkout-sessions and attaches the bearer", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        id: "resv_abc",
        status: "ready_for_complete",
        currency: "USD",
        payment_handlers: {
          "llc.facet.x402": { network: "base", pay_to: "0xabc", amount: "28490000" },
        },
      }),
    );
    const client = new FacetClient({
      terminalUrl: TERMINAL,
      fetch,
      kyaToken: "kya.checkout.token",
    });
    const session = await client.checkoutCreate({
      line_items: [{ item: { id: "sku-1" }, quantity: 2 }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/ucp/v1/checkout-sessions");
    expect(calls[0]!.url).not.toContain("/complete");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer kya.checkout.token");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      line_items: [{ item: { id: "sku-1" }, quantity: 2 }],
    });
    expect(session.id).toBe("resv_abc");
    expect(session.payment_handlers).toBeDefined();
  });

  it("checkoutCreate() sends no Authorization when no token is configured (in-process caller)", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, { id: "resv_x", status: "ready_for_complete" }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch });
    await client.checkoutCreate({ line_items: [{ item: { id: "sku-1" } }] });
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("checkoutComplete() POSTs the checkout_id + signed payment to /complete", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, {
        status: "completed",
        order: { id: "ord_1", permalink_url: "https://shop/o/1" },
        settlement_id: "0xhash",
      }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });
    const res = await client.checkoutComplete({
      checkout_id: "resv_abc",
      payment: { instruments: [{ credential: { type: "x402_authorization", token: "eyJ" } }] },
    });
    expect(calls[0]!.url).toContain("/ucp/v1/checkout-sessions/complete");
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.checkout_id).toBe("resv_abc");
    expect(sent.payment.instruments[0].credential.type).toBe("x402_authorization");
    expect(res.status).toBe("completed");
    expect(res.settlement_id).toBe("0xhash");
  });

  it("checkout() orchestrates create then complete, threading session.id and the signed payment", async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.includes("/complete")) {
        return jsonResponse(200, { status: "completed", settlement_id: "0xdeadbeef" });
      }
      return jsonResponse(200, {
        id: "resv_777",
        status: "ready_for_complete",
        currency: "USD",
        payment_handlers: { "llc.facet.x402": { pay_to: "0xmerchant", amount: "28490000" } },
      });
    });
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch, kyaToken: "t" });

    let sawSession: string | undefined;
    const res = await client.checkout({
      line_items: [{ item: { id: "sku-card" } }, { item: { id: "sku-flowers" } }],
      authorizePayment: (session) => {
        // The callback receives the SERVER-created session (pay_to + amount).
        sawSession = session.id;
        expect(session.payment_handlers).toBeDefined();
        return {
          instruments: [
            { credential: { type: "x402_authorization", token: `signed-for-${session.id}` } },
          ],
        };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/ucp/v1/checkout-sessions");
    expect(calls[0]!.url).not.toContain("/complete");
    expect(calls[1]!.url).toContain("/ucp/v1/checkout-sessions/complete");
    // The created session id is threaded into the complete call's checkout_id...
    const completeBody = JSON.parse(calls[1]!.body!);
    expect(completeBody.checkout_id).toBe("resv_777");
    // ...and the payment the callback produced from THAT session is sent verbatim.
    expect(completeBody.payment.instruments[0].credential.token).toBe("signed-for-resv_777");
    expect(sawSession).toBe("resv_777");
    expect(res.status).toBe("completed");
    expect(res.settlement_id).toBe("0xdeadbeef");
  });

  it("default userAgent advertises the 0.4.0 client line", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, { id: "r", status: "ready_for_complete" }),
    );
    const client = new FacetClient({ terminalUrl: TERMINAL, fetch });
    await client.checkoutCreate({ line_items: [{ item: { id: "sku-1" } }] });
    expect(calls[0]!.headers["user-agent"]).toBe("@facet-llc/client/0.4.0");
  });
});
