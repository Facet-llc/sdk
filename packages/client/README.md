# @facet-llc/client

Agent-side client SDK for the Facet Terminal protocol. Handles KYA bearer tokens, structured error envelopes, `X-Agent-Trace-Id` propagation, `X-Facet-RateLimit-*` capture, and idempotency-key forwarding so agent operators do not write the boilerplate.

Runs on Node 20+, Bun, and Deno. Native `fetch` plus `AbortController` on all three. Zero polyfills.

## Install

```bash
npm install @facet-llc/client @facet-llc/adapter
# or
pnpm add @facet-llc/client @facet-llc/adapter
# or
bun add @facet-llc/client @facet-llc/adapter
```

`@facet-llc/client` declares `@facet-llc/adapter` as a runtime dependency. Package managers pull it in automatically.

## Quick start

```ts
import { FacetClient, FacetClientError } from "@facet-llc/client";

const client = new FacetClient({
  terminalUrl: "https://api.merchant.example.com/v1",
  kyaToken: "<kya-token-jwt>", // or a function returning a fresh token
});

// Discovery (no auth)
const caps = await client.capabilities();
const terms = await client.terms();

// Commerce loop
const results = await client.search({ query: "vanilla", limit: 10 });
const quote = await client.quote({ product_id: results.results[0].id, qty: 3 });
const reservation = await client.reserve({ quote_token: quote.quote_token });
await client.cancelReservation({ reservation_id: reservation.reservation_id });

// Sessions
const session = await client.identify();
await client.sessionExtend({ session_id: session.session_id });
const me = await client.whoami();

// Every call updates last-seen state
console.log(client.lastRateLimit); // { limit, remaining, reset } | null
console.log(client.lastTraceId);
```

## Dynamic token refresh

Pass a function for `kyaToken` when you need per-call token minting (rotating JWTs, refresh-flow callbacks). The client awaits it on every authenticated request.

```ts
const client = new FacetClient({
  terminalUrl: "https://api.merchant.example.com/v1",
  kyaToken: async () => myIssuer.mintToken(),
});
```

## Error handling

Every non-2xx response with a valid Facet error envelope becomes a `FacetClientError`. Other non-2xx responses (HTML 502s, raw strings, non-envelope JSON) become `FacetTransportError`.

```ts
try {
  const quote = await client.quote({ product_id: "sku-0002", qty: 9999 });
} catch (e) {
  if (e instanceof FacetClientError) {
    switch (e.code) {
      case "INVENTORY_UNAVAILABLE":
        if (e.suggest?.tool === "search_products") {
          await client.search(e.suggest.args);
        }
        break;
      case "RATE_LIMITED":
        await sleep((e.retryAfterSeconds ?? 1) * 1000);
        break;
      case "QUOTE_EXPIRED":
        break;
      default:
        if (e.retryable) {
          // exponential backoff
        }
    }
  }
}
```

## Idempotency

Pass `idempotencyKey` on state-mutating calls (`reserve`, `cancelReservation`, `settle`, `refundRequest`). The Terminal dedups by `(agent, key)` plus body hash. A retry with the same key returns the cached response. A retry with the same key and a different body returns `409 IDEMPOTENCY_CONFLICT`.

```ts
const id = crypto.randomUUID();
try {
  await client.reserve({ quote_token }, { idempotencyKey: id });
} catch (e) {
  if (e instanceof FacetClientError && e.retryable) {
    await client.reserve({ quote_token }, { idempotencyKey: id });
  }
}
```

## Cancellation and timeouts

Default per-call timeout is 30s. Override via `timeoutMs`. Pass an `AbortSignal` to compose with external cancellation.

```ts
const client = new FacetClient({
  terminalUrl: "...",
  kyaToken: "...",
  timeoutMs: 5_000,
});

const ac = new AbortController();
setTimeout(() => ac.abort(), 2_000);

await client.search({ query: "sugar" }, { signal: ac.signal });
```

## Methods

| Method                   | Route                         | Auth | Purpose                                            |
| ------------------------ | ----------------------------- | ---- | -------------------------------------------------- |
| `schema()`               | `GET /v1/schema`              | no   | The `facet.yaml` manifest (YAML string).           |
| `version()`              | `GET /v1/version`             | no   | Protocol and terminal versions.                    |
| `health()`               | `GET /v1/health`              | no   | Liveness probe.                                    |
| `capabilities()`         | `GET /v1/capabilities`        | no   | Which tools and features this tenant exposes.      |
| `terms()`                | `GET /v1/terms`               | no   | Pricing, rate limits, SLA, data-use advertisement. |
| `hello()`                | `POST /v1/hello`              | yes  | Echo agent identity (sanity endpoint).             |
| `search(req)`            | `POST /v1/search`             | yes  | `search_products` tool.                            |
| `quote(req)`             | `POST /v1/quote`              | yes  | `quote_product` tool.                              |
| `reserve(req)`           | `POST /v1/reserve`            | yes  | Verify quote token, hold inventory (TTL 300s).     |
| `cancelReservation(req)` | `POST /v1/cancel_reservation` | yes  | Release a held reservation.                        |
| `identify()`             | `POST /v1/identify`           | yes  | Mint a session (TTL 24h) for the calling agent.    |
| `sessionExtend(req)`     | `POST /v1/session_extend`     | yes  | Extend a session's `expires_at`.                   |
| `whoami()`               | `POST /v1/whoami`             | yes  | Return the caller's `aid` and `apd`.               |

## License

Apache-2.0. Same as [`@facet-llc/adapter`](https://www.npmjs.com/package/@facet-llc/adapter). The hosted Terminal service, schema generator, and admin app remain proprietary. The client contract is an open protocol.
