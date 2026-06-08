# Facet SDK

[![license](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![npm @facet-llc/protocol](https://img.shields.io/npm/v/@facet-llc/protocol?label=%40facet-llc%2Fprotocol)](https://www.npmjs.com/package/@facet-llc/protocol)
[![npm @facet-llc/client](https://img.shields.io/npm/v/@facet-llc/client?label=%40facet-llc%2Fclient)](https://www.npmjs.com/package/@facet-llc/client)
[![spec](https://img.shields.io/badge/spec-facet--llc%2Fspec-green.svg)](https://github.com/facet-llc/spec)

Open-source TypeScript packages for the Facet agent-commerce protocol: `agents.txt` parser, agent-side Terminal client, payment-rail adapters, and origination verifiers.

The wire protocol lives at [`facet-llc/spec`](https://github.com/facet-llc/spec). This repository is the runnable reference implementation. Every package here is published to npm under the `@facet-llc/*` scope and is what powers the hosted Terminal at `api.facet.llc`.

## Packages

| Package                                                                                | Version                                                                                                                                                 | Purpose                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@facet-llc/protocol`](./packages/protocol)                                           | [![npm](https://img.shields.io/npm/v/@facet-llc/protocol)](https://www.npmjs.com/package/@facet-llc/protocol)                                           | `agents.txt` v1.2 parser, Facet Terminal protocol types, payment-dispatch, RFQ, booking, subscription, verification, rail-adapter interface. Zero deps.                                                  |
| [`@facet-llc/client`](./packages/client)                                               | [![npm](https://img.shields.io/npm/v/@facet-llc/client)](https://www.npmjs.com/package/@facet-llc/client)                                               | Agent-side Terminal client for Node, Bun, Deno. KYA token handling, error envelope, trace-id propagation, rate-limit awareness.                                                                          |
| [`@facet-llc/sdk-node`](./packages/sdk-node)                                           | [![npm](https://img.shields.io/npm/v/@facet-llc/sdk-node)](https://www.npmjs.com/package/@facet-llc/sdk-node)                                           | One-call agent entry point. `discoverAndConnect('merchant.com')` fetches `/.well-known/agents.txt`, validates the manifest, returns a configured client.                                                 |
| [`@facet-llc/payment-adapter-x402-coinbase`](./packages/payment-adapter-x402-coinbase) | [![npm](https://img.shields.io/npm/v/@facet-llc/payment-adapter-x402-coinbase)](https://www.npmjs.com/package/@facet-llc/payment-adapter-x402-coinbase) | `FacetPaymentRailAdapter` for x402 USDC settlement on Base via the Coinbase facilitator. Handles AWS AgentCore, Coinbase AgentKit, or any x402-native origination.                                       |
| [`@facet-llc/payment-adapter-stripe`](./packages/payment-adapter-stripe)               | [![npm](https://img.shields.io/npm/v/@facet-llc/payment-adapter-stripe)](https://www.npmjs.com/package/@facet-llc/payment-adapter-stripe)               | `FacetPaymentRailAdapter` for Stripe. PaymentIntents with reserve-capture, refunds, disputes, webhook signature verification.                                                                            |
| [`@facet-llc/payment-adapter-boson-escrow`](./packages/payment-adapter-boson-escrow)   | [![npm](https://img.shields.io/npm/v/@facet-llc/payment-adapter-boson-escrow)](https://www.npmjs.com/package/@facet-llc/payment-adapter-boson-escrow)   | `FacetPaymentRailAdapter` for Boson Protocol x402B. Escrow-backed settlement on Base: funds held non-custodially in the Boson Diamond, commit / redeem / release mapped to reserve / capture / finalize. |
| [`@facet-llc/origination-aws-agentcore`](./packages/origination-aws-agentcore)         | [![npm](https://img.shields.io/npm/v/@facet-llc/origination-aws-agentcore)](https://www.npmjs.com/package/@facet-llc/origination-aws-agentcore)         | Helpers for AWS Bedrock AgentCore Payments. TypeScript port of the canonical Python `PaymentManager` plus `IssuerDirectVerifier` fallback.                                                               |
| [`@facet-llc/origination-coinbase-cdp`](./packages/origination-coinbase-cdp)           | [![npm](https://img.shields.io/npm/v/@facet-llc/origination-coinbase-cdp)](https://www.npmjs.com/package/@facet-llc/origination-coinbase-cdp)           | Origination verifier for Coinbase Developer Platform AgentKit credentials. Verifies wallet-signed attestations, emits scoped `AgentPrincipal`.                                                           |

## Quickstart

### Agent side: talk to a Facet merchant

```bash
npm install @facet-llc/sdk-node
```

```ts
import { discoverAndConnect } from "@facet-llc/sdk-node";

// Fetches /.well-known/agents.txt, validates the manifest, returns a typed client.
const client = await discoverAndConnect("merchant.example.com");

const results = await client.search({ q: "wholesale tomatoes" });
const quote = await client.quote({ listing_id: results[0].id, qty: 50 });
// ...reserve, then settle via x402 or Stripe per the merchant's manifest.
```

### Merchant side: verify an incoming agent

```bash
npm install @facet-llc/origination-coinbase-cdp
# or @facet-llc/origination-aws-agentcore for AgentCore-originated agents
```

```ts
import { CoinbaseCdpVerifier } from "@facet-llc/origination-coinbase-cdp";

const verifier = new CoinbaseCdpVerifier();
const principal = await verifier.verify(request.headers);
// principal.agentWalletAddress is scoped to this AgentKit agent
```

### Payment-rail adapter: settle a quote

```bash
npm install @facet-llc/payment-adapter-x402-coinbase
```

```ts
import { X402CoinbaseAdapter } from "@facet-llc/payment-adapter-x402-coinbase";

const adapter = new X402CoinbaseAdapter({ network: "base" });
const intent = await adapter.createPaymentIntent({ amount_usd: 12.50, ... });
// Returns x402 challenge headers. Agent satisfies, you capture.
```

## What is open vs proprietary

This SDK is the open-source surface. The hosted Terminal at `api.facet.llc` (vertical knowledge graph, schema generator, reputation registry, agent WAF, managed wallet) is closed. The wire protocol the Terminal speaks is open. Implement against the spec at [`facet-llc/spec`](https://github.com/facet-llc/spec) and any adapter here works against any Facet-compliant merchant.

## Local development

```bash
git clone https://github.com/facet-llc/sdk.git
cd sdk
pnpm install
pnpm typecheck && pnpm test
```

Requirements: Node 20+, pnpm 10+.

## License

[Apache-2.0](./LICENSE). © 2026 Facet, LLC.
