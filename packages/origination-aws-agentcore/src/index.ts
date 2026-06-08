// `@facet-llc/origination-aws-agentcore` — AgentCore-Payments helpers.
//
// This package used to expose a merchant-side
// `AgentCoreOriginationVerifier` that parsed a hypothetical AgentCore JWT.
// We removed that class after confirming against the canonical AWS Bedrock
// AgentCore SDK (github.com/aws/bedrock-agentcore-sdk-python) that
// AgentCore's actual agent→merchant rail is the x402 `X-PAYMENT` header,
// not a separate JWT, and that AWS does not publish the JWKS endpoint the
// verifier assumed.
//
// What's here now:
//   * `PaymentManager` — TS port of the canonical Python `PaymentManager`
//     class from `bedrock_agentcore.payments.manager`. Agent-side helper
//     for creating instruments, opening sessions, processing payments,
//     and producing x402 X-PAYMENT / PAYMENT-SIGNATURE headers from 402
//     challenges. Spec-faithful: method-by-method mirror of the Python
//     SDK, calling the official `@aws-sdk/client-bedrock-agentcore` v3
//     commands.
//   * `IssuerDirectVerifier` — fallback FacetOriginationVerifier for
//     x402-only flows (unattested wallet → `direct:<wallet>` aid).

export { IssuerDirectVerifier, ISSUER_DIRECT_RAW_RE, FORBIDDEN_AID_PREFIXES } from "./verifier.ts";

export {
  PaymentManager,
  PaymentError,
  PaymentInstrumentNotFound,
  PaymentSessionNotFound,
  InvalidPaymentInstrument,
  InsufficientBudget,
  PaymentSessionExpired,
} from "./payment-manager.ts";

export type {
  CreatePaymentInstrumentInput,
  CreatePaymentSessionInput,
  DeletePaymentInstrumentInput,
  DeletePaymentSessionInput,
  GeneratedPaymentHeader,
  GetPaymentInstrumentBalanceInput,
  GetPaymentInstrumentInput,
  GetPaymentSessionInput,
  ListPaymentInstrumentsInput,
  ListPaymentSessionsInput,
  PaymentManagerOptions,
  PaymentRequiredRequest,
  ProcessPaymentInput,
} from "./payment-manager.ts";

export {
  AGENT_NAME_HEADER,
  DEFAULT_MAX_RESULTS,
  ETHEREUM_NETWORKS,
  NETWORK_PREFERENCES,
  PaymentConnectorType,
  SOLANA_NETWORKS,
} from "./constants.ts";
