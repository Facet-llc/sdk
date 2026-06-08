# @facet-llc/origination-aws-agentcore

Helpers for integrating Facet with [AWS Bedrock AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/).

## What this is

Two complementary surfaces.

### 1. `PaymentManager`: agent-side x402 orchestration

A TypeScript port of the canonical Python `PaymentManager` class from [`bedrock-agentcore-sdk-python`](https://github.com/aws/bedrock-agentcore-sdk-python) (`bedrock_agentcore.payments.manager`). It wraps the official [`@aws-sdk/client-bedrock-agentcore`](https://www.npmjs.com/package/@aws-sdk/client-bedrock-agentcore) v3 client with the same workflow logic the Python SDK provides:

- Auto-injects `paymentManagerArn` on every data-plane call.
- Generates idempotency `clientToken`s automatically.
- Mirrors the Python method surface 1:1. `createPaymentInstrument`, `createPaymentSession`, `processPayment`, `getPaymentInstrumentBalance`, list / get / delete helpers, and the orchestrated `generatePaymentHeader` that produces an x402 `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header from a 402 challenge.

```ts
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { PaymentManager } from "@facet-llc/origination-aws-agentcore";

const client = new BedrockAgentCoreClient({ region: "us-east-1" });
const manager = new PaymentManager({
  paymentManagerArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:payment-manager/PM-A",
  client,
  agentName: "my-procurement-agent",
});

const session = await manager.createPaymentSession({
  expiryTimeInMinutes: 60,
  userId: "user-42",
  limits: { maxSpendAmount: { value: "100.00", currency: "USD" } },
});

// Hit a merchant endpoint, get a 402 back, then have the manager
// build the X-PAYMENT header for the follow-up request:
const challenge = await fetch("https://merchant.example.com/v1/checkout");
if (challenge.status === 402) {
  const header = await manager.generatePaymentHeader({
    paymentInstrumentId: "pi-1",
    paymentSessionId: session.paymentSessionId!,
    userId: "user-42",
    paymentRequiredRequest: {
      statusCode: 402,
      headers: Object.fromEntries(challenge.headers),
      body: await challenge.text(),
    },
  });
  // header is either { "X-PAYMENT": "<base64>" } (v1) or
  // { "PAYMENT-SIGNATURE": "<base64>" } (v2)
  await fetch("https://merchant.example.com/v1/checkout", { headers: header });
}
```

The merchant on the other side verifies the x402 header via [`@facet-llc/payment-adapter-x402-coinbase`](https://www.npmjs.com/package/@facet-llc/payment-adapter-x402-coinbase). There is no AgentCore-specific verification on the merchant side because AWS does not publish an attestation endpoint for these payments. That is intentional. AgentCore's contract with merchants is x402.

### 2. `IssuerDirectVerifier`: fallback for unattested x402 flows

A `FacetOriginationVerifier` that maps a raw wallet attestation string to a `direct:<wallet>` aid. The Terminal registers it as the default fallback for traffic that does not carry a platform-specific attestation.

The verifier fails closed on attestations larger than 8 KB and sanitizes input character sets before parsing.

## Install

```bash
npm install @facet-llc/origination-aws-agentcore @aws-sdk/client-bedrock-agentcore
# or
pnpm add @facet-llc/origination-aws-agentcore @aws-sdk/client-bedrock-agentcore
```

## Spec fidelity

`PaymentManager` is a method-for-method port of the canonical Python class. When the upstream Python SDK adds, removes, or changes a method, mirror the change here. The Python source the port tracks is at `bedrock_agentcore/payments/manager.py` in [`bedrock-agentcore-sdk-python`](https://github.com/aws/bedrock-agentcore-sdk-python).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
