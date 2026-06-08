# @facet-llc/payment-adapter-boson-escrow

Facet Terminal payment-rail adapter for Boson Protocol x402B, escrow-backed "secure x402B" settlement on Base. Implements `FacetPaymentRailAdapter` from [`@facet-llc/protocol`](https://www.npmjs.com/package/@facet-llc/protocol).

## What this is

The escrow-rail half of Facet's multi-rail payment-acceptance layer. Where the plain x402 rail settles a buyer's USDC straight to the merchant, this rail routes the same gasless USDC authorization through Boson Protocol's escrow Diamond, so funds are held non-custodially until the exchange completes. Facet never takes custody, and the merchant's seller key only ever signs an offer, it never moves money and never pays gas.

This adapter is a thin wrapper. It delegates the escrow lifecycle to the official Boson SDK:

- Offer + commit: [`@bosonprotocol/x402-server`](https://www.npmjs.com/package/@bosonprotocol/x402-server)'s `createX402bServer` builds the payment requirements and runs the commit handler that escrows the buyer's funds.
- Authorization decode + EIP-712: [`@bosonprotocol/x402-core`](https://www.npmjs.com/package/@bosonprotocol/x402-core) recovers and validates the buyer's `X-PAYMENT` authorization against the signed offer.
- On-chain state: an injected `ExchangeReader` reads exchange state (COMMITTED, REDEEMED, RELEASED) from a Base RPC and, when configured, the Boson subgraph.

It maps Boson's escrow lifecycle onto the Facet reserve / capture / finalize contract:

| Facet contract      | Boson action                  | Resulting state |
| ------------------- | ----------------------------- | --------------- |
| `quoteRequirements` | build + sign the offer        | (402 producer)  |
| `verifyAuthority`   | decode + validate `X-PAYMENT` | (pre-commit)    |
| `reserveAuthority`  | commit                        | COMMITTED       |
| `capture`           | redeem                        | REDEEMED        |
| `refund`            | revoke / cancel (pre-redeem)  | REVOKED         |
| `handleWebhook`     | exchange-state event          | (state sync)    |

The adapter adds:

- `FacetPaymentRailAdapter` shape so Terminal dispatches to it generically alongside the other rails.
- Result normalization into `FacetErrorCode` so failures surface identically across rails.
- Real, resolvable BPIP-1 `BASE` offer metadata. Each offer carries an on-chain `metadataHash` (keccak-256) and a `metadataUri` that resolves to the exact bytes the hash commits to, so any third party (the Boson dApp, an indexer, a counterparty) can fetch the URI and verify offer integrity. The metadata is content-encoded into the URI, so resolution is a pure, stateless decode with no datastore.
- A defensive egress posture: the per-merchant facilitator URL must match the adapter's configured facilitator origin.

## Install

```bash
npm install @facet-llc/payment-adapter-boson-escrow
# or
pnpm add @facet-llc/payment-adapter-boson-escrow
```

## Usage

```ts
import { BosonEscrowAdapter } from "@facet-llc/payment-adapter-boson-escrow";

const adapter = new BosonEscrowAdapter({
  facilitatorUrl: process.env.BOSON_FACILITATOR_URL,
  rpcUrl: process.env.BASE_RPC_URL,
  // subgraphUrl enables withdraw / available-funds reads + production mode.
  subgraphUrl: process.env.BOSON_SUBGRAPH_URL,
  // exchangeReaderFactory + stores are injected by the host so the adapter
  // pins neither a viem client nor a persistence backend.
  exchangeReaderFactory,
  stores,
});

// 1) Produce the 402 challenge: build + sign the Boson offer.
const quote = await adapter.quoteRequirements({
  ctx: { trace_id, idempotency_key, merchant_id, site_id, received_at },
  merchant_config, // network, escrow, sellerId, disputeResolverId, asset, signer, ...
  amount: { amount: 1_230_000, currency: "USDC" }, // 1.23 USDC (6 decimals)
  options: { dispute_window_seconds: 600, max_timeout_seconds: 1800 },
});

// 2) Verify the buyer's X-PAYMENT, then commit (escrow the funds).
const verified = await adapter.verifyAuthority({
  ctx,
  merchant_config,
  authority: { x_payment: req.headers["x-payment"] },
  amount: { amount: 1_230_000, currency: "USDC" },
});

if (verified.kind === "ok") {
  const reserved = await adapter.reserveAuthority({
    ctx,
    merchant_config,
    authority_handle: verified.value.authority_handle,
    amount: { amount: 1_230_000, currency: "USDC" },
  });

  // 3) Redeem to release escrow toward the merchant.
  const captured = await adapter.capture({
    ctx,
    merchant_config,
    authority_handle: reserved.value.authority_handle,
    amount: { amount: 1_230_000, currency: "USDC" },
  });
}
```

## Merchant config

The host server hydrates `BosonMerchantConfig` per request from the authenticated site row plus securely stored secrets. The `signer` is a live `SellerSigner` (an address plus a `signTypedData` function), never a raw key, so it is KMS / HSM / ERC-1271 compatible. It signs the offer's EIP-712 typed data only.

## Networks

| Network                  | Chain ID | CAIP-2         |
| ------------------------ | -------- | -------------- |
| `base` (mainnet)         | 8453     | `eip155:8453`  |
| `base-sepolia` (testnet) | 84532    | `eip155:84532` |

## Refunds

Refunds are supported only before redeem. A pre-redeem refund maps to a Boson revoke / cancel, which returns the escrowed funds to the buyer. Once an exchange is redeemed, settlement has moved on-chain and the rail reports refunds as unsupported, consistent with the other settlement rails.

## Offer metadata

Every offer carries a BPIP-1 `BASE` metadata document built from the product the agent is buying. The on-chain `offer.metadataHash` is a real keccak-256 commitment to the canonical bytes of that document, and `offer.metadataUri` resolves to those exact bytes. The package exports the builder and the resolver codec (`buildOfferMetadata`, `decodeMetadataPath`, `encodeMetadataPath`, `OFFER_METADATA_PATH`) so a host can mount `GET /v1/boson/offer-metadata` as a pure decoder.

## Tests

`pnpm test` runs the conformance and flow suite using deterministic test keys and a stubbed exchange reader. The tests exercise the real `@bosonprotocol/x402-server` and `@bosonprotocol/x402-core` code paths; only the network and persistence boundaries are mocked.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
