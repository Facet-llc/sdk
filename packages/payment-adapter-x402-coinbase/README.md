# @facet-llc/payment-adapter-x402-coinbase

Facet Terminal payment-rail adapter for x402 USDC settlement on Base via the Coinbase facilitator. Implements `FacetPaymentRailAdapter` from [`@facet-llc/protocol`](https://www.npmjs.com/package/@facet-llc/protocol).

## What this is

The settlement-rail half of Facet's multi-rail payment-acceptance layer. Handles agents originated by any platform that settles over x402: AWS Bedrock AgentCore Payments, Coinbase AgentKit, or direct x402 wallets. The platform difference lives at the attestation layer (handled by separate `FacetOriginationVerifier` packages), not at the rail.

This adapter is a thin wrapper. It delegates the heavy lifting to the official x402 SDK:

- Verification: `verify(payload, requirements)` from [`x402/verify`](https://www.npmjs.com/package/x402) does on-chain signature recovery, nonce-availability check, and amount validation.
- Settlement: `settle(payload, requirements)` from the same SDK posts the signed `transferWithAuthorization` through the facilitator and returns the on-chain tx hash.
- Facilitator routing: [`@coinbase/x402`](https://www.npmjs.com/package/@coinbase/x402)'s preconfigured `facilitator` (free tier: 1000 tx/month, then $0.001/tx).

The adapter adds:

- `FacetPaymentRailAdapter` shape (`verifyAuthority`, `reserveAuthority`, `capture`, `refund`, `handleWebhook`) so Terminal dispatches to it generically alongside other rails.
- Result normalization into `FacetErrorCode` so failures surface identically across rails.
- Per-network metadata (`coin/usdc-base` vs `coin/usdc-base-sepolia`) for Terminal's rail dispatcher.
- `CaptureOk` envelope conformance: `settlement_id` is the on-chain tx hash, `settled_at` is the block timestamp.

## Install

```bash
npm install @facet-llc/payment-adapter-x402-coinbase
# or
pnpm add @facet-llc/payment-adapter-x402-coinbase
```

## Usage

```ts
import { X402CoinbaseAdapter } from "@facet-llc/payment-adapter-x402-coinbase";

// Default: Coinbase's hosted facilitator, anonymous (free) tier.
const adapter = new X402CoinbaseAdapter({
  network: "base",
});

// Authenticated higher rate-limit tier:
import { createFacilitatorConfig } from "@facet-llc/payment-adapter-x402-coinbase";

const authenticated = new X402CoinbaseAdapter({
  network: "base",
  facilitator: createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET),
});

const result = await adapter.verifyAuthority({
  ctx: { trace_id, idempotency_key, merchant_id, site_id, received_at },
  merchant_config: {},
  authority: { x_payment: req.headers["x-payment"] },
  amount: { amount: 1_000_000, currency: "USDC" }, // 1.00 USDC (6 decimals)
});

if (result.kind === "ok") {
  const captured = await adapter.capture({
    ctx,
    merchant_config: {},
    authority_handle: result.value.authority_handle,
    amount: { amount: 1_000_000, currency: "USDC" },
  });
  // captured.value.settlement_id === "0xabc..."  (on-chain tx hash)
  // captured.value.settled_at === "2026-05-26T..."  (block timestamp)
}
```

## Networks

Inherits all x402-supported EVM networks from the SDK. This adapter currently exposes the two Base networks:

| Network                  | Chain ID | Rail id                  |
| ------------------------ | -------- | ------------------------ |
| `base` (mainnet)         | 8453     | `coin/usdc-base`         |
| `base-sepolia` (testnet) | 84532    | `coin/usdc-base-sepolia` |

Adding Polygon, Avalanche, etc. is a one-line change once merchant-config UI allows merchants to opt into each.

## Refunds

The Coinbase facilitator does not yet expose programmatic refunds. Calls to `refund()` return `METHOD_NOT_ALLOWED` with a `native_code` of `unsupported_by_facilitator`. Merchants can issue manual refunds against the on-chain settlement tx; the next version of this adapter will wire that path through merchant-side signing once `merchant_config` supports it.

## Tests

`pnpm test` runs 17 conformance and flow tests using deterministic hardhat test keys and a mocked facilitator. The tests exercise the real `x402` and `@coinbase/x402` SDK code paths. Only the network boundary is mocked.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
