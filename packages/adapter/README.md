# @facet-llc/adapter

TypeScript types and reference parser for the Facet agent-commerce protocol.

The wire contract every Facet Terminal speaks: `agents.txt` discovery, payment-rail dispatch, the `FacetPaymentRailAdapter` interface, origination verifiers, and the eight business-archetype primitives (catalog, paywalled-content, subscription, booking, date-bound inventory, auction, RFQ, regulated). Zero runtime dependencies. Apache-2.0.

The spec lives at [`facet-llc/spec`](https://github.com/facet-llc/spec). This package is the runnable reference implementation.

## Install

```bash
npm install @facet-llc/adapter
# or
pnpm add @facet-llc/adapter
```

## Parse an `agents.txt` manifest

```ts
import { parseAgentsTxt } from "@facet-llc/adapter";

const body = await fetch("https://merchant.example.com/.well-known/agents.txt").then((r) =>
  r.text(),
);
const manifest = parseAgentsTxt(body);

console.log(manifest.facetVersion); // "1.2"
console.log(manifest.terminal); // ["https://api.merchant.example.com/v1"]
console.log(manifest.kyaIssuers); // ["https://issuer.skyfire.xyz/.well-known/jwks.json"]
console.log(manifest.capabilities); // ["catalog", "paywalled-content"]
console.log(manifest.openApiUrl); // "https://api.merchant.example.com/v1/openapi.json"
```

Pass `{ strict: false }` for partial manifests (skips required-field validation). The parser accepts v0.2, v1.0, v1.1, and v1.2 documents.

## Build a payment-rail adapter

```ts
import type { FacetPaymentRailAdapter, RailAdapterResult, CaptureOk } from "@facet-llc/adapter";

export class MyRailAdapter implements FacetPaymentRailAdapter {
  async verifyAuthority(req): Promise<RailAdapterResult<{ authority_handle: string }>> {
    /* ... */
  }
  async reserveAuthority(req): Promise<RailAdapterResult<{}>> {
    /* ... */
  }
  async capture(req): Promise<RailAdapterResult<CaptureOk>> {
    /* settlement_id + settled_at */
  }
  async refund(req): Promise<RailAdapterResult<{ refund_id: string }>> {
    /* ... */
  }
  async handleWebhook(req): Promise<RailAdapterResult<{ event_id: string }>> {
    /* ... */
  }
}
```

The `CaptureOk` envelope is rail-symmetric. USDC adapters return `settlement_id` as an on-chain tx hash (`0xabc...`); Stripe adapters return `pi_...`. SDK consumers write rail-agnostic code.

## Exports

| Symbol                               | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `parseAgentsTxt`                     | v0.2 / v1.0 / v1.1 / v1.2 manifest parser                  |
| `FACET_PROTOCOL_VERSION`             | Current wire-protocol version constant                     |
| `SUPPORTED_FACET_VERSIONS`           | Tuple of accepted `Facet-Version` values                   |
| `FacetPaymentRailAdapter`            | Interface payment rails implement                          |
| `FacetOriginationVerifier`           | Interface origination verifiers implement                  |
| `FacetErrorCode`                     | Closed union of every error code Terminal can emit         |
| `FacetErrorEnvelope`                 | Structured error response with `retryable` + `suggest`     |
| Per-primitive request/response types | Catalog, RFQ, booking, subscription, auction, verification |

## License

Apache-2.0. See [`LICENSE`](LICENSE).
