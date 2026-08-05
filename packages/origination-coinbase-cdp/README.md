# @facet-llc/origination-coinbase-cdp

Facet Terminal origination verifier for Coinbase Developer Platform (CDP) AgentKit-provisioned agents. Implements `FacetOriginationVerifier` from [`@facet-llc/adapter`](https://www.npmjs.com/package/@facet-llc/adapter).

## What this is

AgentKit-provisioned agents are server-managed wallets issued by CDP. The agent proves its identity to a merchant by signing a canonical attestation envelope with its CDP wallet. The merchant verifies the ECDSA signature against the claimed address using [viem's `verifyMessage`](https://viem.sh/docs/utilities/verifyMessage).

The CDP SDK's role on the agent side is wallet management. Merchant-side acceptance is plain ECDSA verification. We do not reimplement that. [viem](https://github.com/wevm/viem) is the authoritative tool.

The verifier fails closed: replay cache (rejects duplicate `bind_to` within `maxEnvelopeAgeSeconds`), 8 KB attestation cap, character-set sanitization, and a configurable cross-check against the issuer's registered account list.

## Install

```bash
npm install @facet-llc/origination-coinbase-cdp
# or
pnpm add @facet-llc/origination-coinbase-cdp
```

## Envelope shape

The agent encodes the following JSON as base64 in the `X-Agent-Attestation` header:

```json
{
  "wallet": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  "issued_at": "2026-05-24T18:00:00Z",
  "expires_at": "2026-05-24T18:05:00Z",
  "bind_to": "<idempotency-key>",
  "scopes": ["payments:write"],
  "signature": "0x..."
}
```

The signature is taken over `canonicalMessage(envelope)` (see `verifier.ts`). A stable multi-line text format, not JSON canonicalization.

## Usage

```ts
import { CoinbaseCdpOriginationVerifier } from "@facet-llc/origination-coinbase-cdp";

const verifier = new CoinbaseCdpOriginationVerifier({
  maxEnvelopeAgeSeconds: 600,
});

const result = await verifier.verify({
  raw_attestation: req.headers["x-agent-attestation"],
  trace_id: traceId,
  bind_to: idempotencyKey,
});

if (result.kind === "ok") {
  // result.principal.aid === "cdp:0x71c7..."
}
```

## Optional: registered-account cross-check

Pass a configured `CdpClient` from `@coinbase/cdp-sdk` to additionally verify that the claimed wallet is a registered CDP-managed account, not just any EOA with a valid signature:

```ts
import { CdpClient } from "@coinbase/cdp-sdk";

const cdpClient = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });

const verifier = new CoinbaseCdpOriginationVerifier({ cdpClient });
```

When wired this way the verifier returns `issuer_unknown` for wallets the CDP project does not know about.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
