// X402CoinbaseAdapter — FacetPaymentRailAdapter implementation for x402
// USDC settlement on Base via the Coinbase facilitator.
//
// Delegates verification and settlement to the official `x402` SDK
// (verify + settle from `x402/verify`) routed through `@coinbase/x402`'s
// preconfigured facilitator. We do NOT reimplement EIP-3009 verification,
// nonce dedup, or facilitator HTTP — the SDK handles all of that and
// will continue to handle protocol revisions without us tracking the
// wire format manually.
//
// This adapter handles ALL agents that settle over x402 — agents
// provisioned by AWS Bedrock AgentCore Payments AND agents provisioned
// by Coinbase AgentKit AND any other platform that produces a valid
// x402 PaymentPayload. The agent-side platform difference is at the
// attestation layer, handled by a separate FacetOriginationVerifier.

import type {
  CaptureInput,
  CaptureOk,
  FacetPaymentRailAdapter,
  RailAdapterMetadata,
  RailAdapterResult,
  RefundInput,
  RefundOk,
  ReserveAuthorityInput,
  ReserveAuthorityOk,
  VerifyAuthorityInput,
  VerifyAuthorityOk,
  WebhookOutcome,
  WebhookRequest,
} from "@facet-llc/protocol";
import { facilitator as defaultCoinbaseFacilitator } from "@coinbase/x402";
import type { FacilitatorConfig } from "x402/types";
import {
  ExactEvmPayloadSchema,
  PaymentPayloadSchema,
  type ExactEvmPayload,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
} from "x402/types";
import { useFacilitator } from "x402/verify";

import { decodePaymentHeader } from "./payment-header.ts";

const PACKAGE_VERSION = "0.1.0";

/** USDC contract addresses per x402 network. Sourced from
 *  https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
 *  and the USDC GitHub repo. Pinning here keeps the adapter
 *  network-bounded and auditable. */
const USDC_ADDRESSES: Readonly<Record<X402SupportedNetwork, `0x${string}`>> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

/** EIP-712 domain (name + version) of USDC per network. The x402 "exact" EVM
 *  scheme carries this in PaymentRequirements `extra` so the facilitator can
 *  reconstruct the domain and verify the EIP-3009 transferWithAuthorization
 *  signature; omitting it fails verify with
 *  `invalid_exact_evm_missing_eip712_domain`. base-sepolia verified on-chain
 *  (USDC.name()="USDC", version()="2"). base VERIFIED on-chain 2026-06-03
 *  against Base mainnet USDC 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:
 *  name()="USD Coin", version()="2" — matches the constant below. */
const USDC_EIP712_DOMAIN: Readonly<
  Record<X402SupportedNetwork, { readonly name: string; readonly version: string }>
> = {
  base: { name: "USD Coin", version: "2" },
  "base-sepolia": { name: "USDC", version: "2" },
};

export type X402SupportedNetwork = Extract<Network, "base" | "base-sepolia">;

/** Independent on-chain settlement confirmation.
 *  The adapter delegates verify/settle to the facilitator; without this,
 *  `capture` trusts the facilitator's `settleResponse.success` with no
 *  on-chain proof a real, full-value Transfer landed. When a confirmer is
 *  injected, capture re-checks the settlement tx on a Facet-controlled RPC
 *  before returning ok — removing the facilitator from the settlement-
 *  integrity TCB. The Boson rail already does this (`confirmExchangeReleased`).
 *  Implemented by the Terminal (viem `getTransactionReceipt` + Transfer-log
 *  assertion) and injected here so this package stays free of an RPC dep. */
export type SettlementConfirmer = (params: {
  readonly txHash: string;
  readonly network: X402SupportedNetwork;
  /** USDC contract the Transfer must originate from. */
  readonly asset: `0x${string}`;
  /** Server-resolved merchant payout address the Transfer must credit. */
  readonly payTo: `0x${string}`;
  /** Server-derived amount (atomic) the on-chain Transfer value must be ≥. */
  readonly minValueAtomic: string;
}) => Promise<{ readonly ok: boolean; readonly reason?: string }>;

export interface X402CoinbaseAdapterConfig {
  /** The x402 network this adapter instance handles. One adapter per
   *  network — the Terminal dispatcher picks the right instance based
   *  on the inbound payload's `network` field. */
  readonly network: X402SupportedNetwork;
  /** Optional facilitator override. Defaults to the Coinbase facilitator
   *  exported from `@coinbase/x402`. Pass `createFacilitatorConfig(id,
   *  secret)` from `@coinbase/x402` to use authenticated rate-limit
   *  tiers, or a custom URL for testnet / self-hosted facilitators. */
  readonly facilitator?: FacilitatorConfig;
  /** Default resource URL used in PaymentRequirements when the Terminal
   *  doesn't supply one. Should be the merchant's canonical origin. */
  readonly defaultResourceUrl?: string;
  /** Default merchant-readable description used in PaymentRequirements
   *  when the Terminal doesn't supply one. */
  readonly defaultDescription?: string;
  /** the base-mainnet USDC EIP-712 domain `name`
   *  ("USD Coin") is unverified-on-chain. A `base` adapter refuses to
   *  construct unless this is explicitly true, forcing the operator to
   *  confirm `USDC.name()`/`version()` on Base mainnet before the flip.
   *  Ignored for base-sepolia (verified). Default: false. */
  readonly baseEip712Verified?: boolean;
  /** reject EIP-3009 authorizations whose
   *  `validBefore` is more than this many seconds in the future, bounding
   *  long-lived replay windows. Undefined = no bound (preserves current
   *  behavior; prod SHOULD set ~600). */
  readonly maxAuthWindowSeconds?: number;
  /** independent on-chain settlement confirmation.
   *  Undefined = facilitator-trust only (current testnet behavior). MUST be
   *  set before `FACET_X402_NETWORK=base` (mainnet). */
  readonly confirmSettlement?: SettlementConfirmer;
  /** Clock injection for deterministic validity-window tests. */
  readonly now?: () => number;
}

export class X402CoinbaseAdapter implements FacetPaymentRailAdapter {
  public readonly metadata: RailAdapterMetadata;

  private readonly network: X402SupportedNetwork;
  private readonly facilitatorClient: ReturnType<typeof useFacilitator>;
  private readonly defaultResourceUrl: string;
  private readonly defaultDescription: string;
  private readonly maxAuthWindowSeconds: number | undefined;
  private readonly confirmSettlement: SettlementConfirmer | undefined;
  private readonly now: () => number;

  constructor(cfg: X402CoinbaseAdapterConfig) {
    this.network = cfg.network;
    // refuse to construct a base-mainnet adapter until
    // the operator has confirmed the USDC EIP-712 domain on-chain. A wrong
    // domain fails closed (verify rejects), but constructing on an unverified
    // constant invites a silent mainnet-day-1 breakage; make it explicit.
    if (cfg.network === "base" && cfg.baseEip712Verified !== true) {
      throw new Error(
        "x402 base-mainnet adapter requires baseEip712Verified=true — confirm USDC.name()/version() " +
          'on Base mainnet (cast call 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 "name()(string)") ' +
          "and set the flag before enabling FACET_X402_NETWORK=base.",
      );
    }
    // @coinbase/x402 and x402 ship structurally-identical FacilitatorConfig
    // types from different package versions (@x402/core re-export vs x402's
    // own re-export). TypeScript sees them as distinct under strict mode;
    // the shapes are identical so a cast is safe and avoids forcing
    // consumers to know about the dependency split.
    const facilitatorConfig =
      cfg.facilitator ?? (defaultCoinbaseFacilitator as unknown as FacilitatorConfig);
    this.facilitatorClient = useFacilitator(facilitatorConfig);
    this.defaultResourceUrl = cfg.defaultResourceUrl ?? "https://facet.example/terminal";
    this.defaultDescription = cfg.defaultDescription ?? "Facet Terminal x402 payment";
    this.maxAuthWindowSeconds = cfg.maxAuthWindowSeconds;
    this.confirmSettlement = cfg.confirmSettlement;
    this.now = cfg.now ?? (() => Date.now());

    const facilitatorUrl: string = facilitatorConfig.url;
    this.metadata = {
      id: cfg.network === "base" ? "coin/usdc-base" : "coin/usdc-base-sepolia",
      display_name:
        cfg.network === "base"
          ? "USDC on Base (x402, Coinbase facilitator)"
          : "USDC on Base Sepolia (x402, Coinbase facilitator)",
      version: PACKAGE_VERSION,
      supports_reserve_capture: false,
      supports_refund: true,
      supports_dispute: false,
      networks: [cfg.network],
      currencies: ["USDC"],
      egress_allowlist: [facilitatorUrl],
    };
  }

  async verifyAuthority(
    input: VerifyAuthorityInput,
  ): Promise<RailAdapterResult<VerifyAuthorityOk>> {
    const decoded = this.decodeHeader(input);
    if (decoded.kind === "error") return decoded.error;

    if (input.amount.currency !== "USDC") {
      return errResult(
        "INVALID_REQUEST",
        `Currency "${input.amount.currency}" not supported (USDC only)`,
      );
    }

    const evm = narrowEvmPayload(decoded.payload);
    if (evm === null) {
      return errResult(
        "INVALID_REQUEST",
        "Payload does not contain an EVM authorization (this adapter is EVM-only)",
      );
    }

    const authErr = this.checkAuthorization(evm, input.amount.amount);
    if (authErr !== null) return authErr;

    // SECURITY: payTo MUST come from per-site
    // merchant configuration, NEVER from the inbound payload. Without
    // this gate the adapter would accept attacker-self-paid x402
    // authorizations (attacker signs a transfer from 0xATTACK to
    // 0xATTACK, facilitator confirms the signature is valid, adapter
    // returns ok, merchant ships product against a net-zero payment).
    const expectedPayTo = readMerchantPayTo(input.merchant_config);
    if (expectedPayTo === null) {
      return errResult(
        "INVALID_REQUEST",
        "merchant_config.x402_pay_to_address is required — x402 rail not configured for this site",
      );
    }
    if (evm.authorization.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return makeError(
        "UNAUTHORIZED",
        `Payment authorization pays ${evm.authorization.to}; merchant payTo is ${expectedPayTo}`,
        false,
        "pay_to_mismatch",
      );
    }

    const requirements = this.buildRequirements({
      payTo: expectedPayTo as `0x${string}`,
      amountAtomic: String(input.amount.amount),
      resource: this.defaultResourceUrl,
      description: this.defaultDescription,
    });

    let verifyResponse;
    try {
      verifyResponse = await this.facilitatorClient.verify(decoded.payload, requirements);
    } catch (e) {
      return {
        kind: "error",
        code: "SETTLEMENT_FAILED",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }

    if (!verifyResponse.isValid) {
      return makeError(
        "UNAUTHORIZED",
        verifyResponse.invalidReason ?? "x402 verify rejected payload",
        false,
        verifyResponse.invalidReason,
      );
    }

    return {
      kind: "ok",
      value: {
        authority_handle: evm.authorization.nonce,
        expires_at: new Date(Number(evm.authorization.validBefore) * 1000).toISOString(),
      },
    };
  }

  async reserveAuthority(
    _input: ReserveAuthorityInput,
  ): Promise<RailAdapterResult<ReserveAuthorityOk>> {
    return {
      kind: "ok",
      value: { reservation_active: false, reserved_until: null },
    };
  }

  async capture(input: CaptureInput): Promise<RailAdapterResult<CaptureOk>> {
    const decoded = this.decodeHeader(input);
    if (decoded.kind === "error") return decoded.error;

    const evm = narrowEvmPayload(decoded.payload);
    if (evm === null) {
      return errResult("INVALID_REQUEST", "Payload does not contain an EVM authorization");
    }
    if (evm.authorization.nonce !== input.authority_handle) {
      return errResult(
        "INVALID_REQUEST",
        "authority_handle does not match X-PAYMENT nonce — replay or mismatch",
      );
    }

    const authErr = this.checkAuthorization(evm, input.amount.amount);
    if (authErr !== null) return authErr;

    // SECURITY: same payTo gate as verifyAuthority. Defense-in-
    // depth — if verifyAuthority somehow leaked, capture re-asserts.
    const expectedPayTo = readMerchantPayTo(input.merchant_config);
    if (expectedPayTo === null) {
      return errResult("INVALID_REQUEST", "merchant_config.x402_pay_to_address is required");
    }
    if (evm.authorization.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return makeError(
        "UNAUTHORIZED",
        `Capture payTo mismatch: payload ${evm.authorization.to} vs config ${expectedPayTo}`,
        false,
        "pay_to_mismatch",
      );
    }

    const requirements = this.buildRequirements({
      payTo: expectedPayTo as `0x${string}`,
      amountAtomic: String(input.amount.amount),
      resource: this.defaultResourceUrl,
      description: this.defaultDescription,
    });

    let settleResponse;
    try {
      settleResponse = await this.facilitatorClient.settle(decoded.payload, requirements);
    } catch (e) {
      return {
        kind: "error",
        code: "SETTLEMENT_FAILED",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }

    if (!settleResponse.success) {
      return makeError(
        "SETTLEMENT_FAILED",
        settleResponse.errorReason ?? "Facilitator declined settlement",
        settleResponse.errorReason === "duplicate_settlement",
        settleResponse.errorReason,
      );
    }

    // independently confirm the settlement landed
    // on-chain before reporting captured. Without a confirmer (testnet
    // default) we trust the facilitator's success flag; with one injected
    // (REQUIRED before the mainnet flip) we re-read the tx on a Facet-
    // controlled RPC and assert a full-value Transfer to the merchant payTo,
    // removing the facilitator from the settlement-integrity TCB.
    const txHash = settleResponse.transaction;
    if (this.confirmSettlement !== undefined) {
      if (typeof txHash !== "string" || txHash === "") {
        return makeError(
          "SETTLEMENT_FAILED",
          "Facilitator reported success without a settlement tx hash; cannot confirm on-chain",
          false,
          "settlement_unconfirmed",
        );
      }
      let confirmation: { readonly ok: boolean; readonly reason?: string };
      try {
        confirmation = await this.confirmSettlement({
          txHash,
          network: this.network,
          asset: USDC_ADDRESSES[this.network],
          payTo: expectedPayTo as `0x${string}`,
          minValueAtomic: String(input.amount.amount),
        });
      } catch (e) {
        return {
          kind: "error",
          code: "SETTLEMENT_FAILED",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        };
      }
      if (!confirmation.ok) {
        return makeError(
          "SETTLEMENT_FAILED",
          `On-chain settlement confirmation failed: ${confirmation.reason ?? "unconfirmed"}`,
          false,
          "settlement_unconfirmed",
        );
      }
    }

    return {
      kind: "ok",
      value: {
        settlement_id: txHash ?? input.authority_handle,
        settled_at: new Date(this.now()).toISOString(),
      },
    };
  }

  async refund(_input: RefundInput): Promise<RailAdapterResult<RefundOk>> {
    return {
      kind: "error",
      code: "METHOD_NOT_ALLOWED",
      message: "x402 refund requires a merchant-side signer wired through merchant_config",
      retryable: false,
    };
  }

  async handleWebhook(_input: WebhookRequest): Promise<RailAdapterResult<WebhookOutcome>> {
    return {
      kind: "ok",
      value: { kind: "ignored", reason: "Coinbase x402 facilitator is synchronous" },
    };
  }

  /** independently bind the
   *  signed EIP-3009 authorization to the server-derived amount and bound its
   *  validity window — WITHOUT delegating to the facilitator. Returns an
   *  error result to short-circuit, or null when the authorization passes. */
  private checkAuthorization(
    evm: ExactEvmPayload,
    requiredAmount: number,
  ): RailAdapterResult<never> | null {
    // the signed transfer value MUST equal the server-derived amount.
    // The facilitator also checks this against `requirements`, but Facet must
    // not delegate its own amount-provenance invariant.
    let signedValue: bigint;
    let requiredValue: bigint;
    try {
      signedValue = BigInt(evm.authorization.value);
      requiredValue = BigInt(String(requiredAmount));
    } catch {
      return errResult("INVALID_REQUEST", "authorization value / amount is not an integer");
    }
    if (signedValue !== requiredValue) {
      return makeError(
        "UNAUTHORIZED",
        `Authorized value ${signedValue} does not equal required amount ${requiredValue}`,
        false,
        "amount_mismatch",
      );
    }
    // bound the validity window so a captured authorization is not
    // replay-eligible for an attacker-chosen (possibly multi-year) lifetime.
    const nowS = Math.floor(this.now() / 1000);
    const validAfter = Number(evm.authorization.validAfter);
    const validBefore = Number(evm.authorization.validBefore);
    if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
      return errResult("INVALID_REQUEST", "authorization validAfter/validBefore must be numeric");
    }
    if (validBefore <= nowS) {
      return makeError("UNAUTHORIZED", "authorization expired", false, "expired");
    }
    if (validAfter > nowS + 5) {
      return makeError("UNAUTHORIZED", "authorization not yet valid", false, "not_yet_valid");
    }
    if (this.maxAuthWindowSeconds !== undefined && validBefore - nowS > this.maxAuthWindowSeconds) {
      return makeError(
        "UNAUTHORIZED",
        `authorization window ${validBefore - nowS}s exceeds max ${this.maxAuthWindowSeconds}s`,
        false,
        "auth_window_too_long",
      );
    }
    return null;
  }

  private decodeHeader(
    input: VerifyAuthorityInput | CaptureInput,
  ):
    | { readonly kind: "ok"; readonly payload: PaymentPayload }
    | { readonly kind: "error"; readonly error: RailAdapterResult<never> } {
    const headerValue = (input as { authority?: { x_payment?: unknown } }).authority?.x_payment;
    if (typeof headerValue !== "string") {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          "authority.x_payment (base64-encoded X-PAYMENT header) is required",
        ),
      };
    }
    const decoded = decodePaymentHeader(headerValue);
    if (decoded.kind === "error") {
      return {
        kind: "error",
        error: errResult("INVALID_REQUEST", decoded.reason),
      };
    }
    if (decoded.payload.network !== this.network) {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          `Payment targets network "${decoded.payload.network}" but this adapter handles "${this.network}"`,
        ),
      };
    }
    const parsed = PaymentPayloadSchema.safeParse(decoded.payload);
    if (!parsed.success) {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          `Payload failed x402 schema validation: ${parsed.error.message}`,
        ),
      };
    }
    return { kind: "ok", payload: parsed.data };
  }

  private buildRequirements(opts: {
    payTo: `0x${string}`;
    amountAtomic: string;
    resource: string;
    description: string;
  }): PaymentRequirements {
    // PaymentRequirements.resource is `z.string().url()` per the canonical
    // x402 schema. Pass a plain string — the facilitator validates URL
    // shape server-side.
    return {
      scheme: "exact",
      network: this.network,
      maxAmountRequired: opts.amountAtomic,
      resource: opts.resource,
      description: opts.description,
      mimeType: "application/json",
      payTo: opts.payTo,
      maxTimeoutSeconds: 60,
      asset: USDC_ADDRESSES[this.network],
      // x402 "exact" EVM scheme: the facilitator needs the asset's EIP-712
      // domain to verify the EIP-3009 signature. Omitting it fails verify with
      // `invalid_exact_evm_missing_eip712_domain`.
      extra: USDC_EIP712_DOMAIN[this.network],
    };
  }
}

function errResult<T>(
  code: "UNAUTHORIZED" | "INVALID_REQUEST" | "SETTLEMENT_FAILED" | "METHOD_NOT_ALLOWED",
  message: string,
): RailAdapterResult<T> {
  return { kind: "error", code, message, retryable: false };
}

/** Build a typed-error result, only attaching native_code when present
 *  (exactOptionalPropertyTypes forbids passing undefined explicitly). */
function makeError<T>(
  code: "UNAUTHORIZED" | "INVALID_REQUEST" | "SETTLEMENT_FAILED" | "METHOD_NOT_ALLOWED",
  message: string,
  retryable: boolean,
  nativeCode: string | null | undefined,
): RailAdapterResult<T> {
  return nativeCode
    ? { kind: "error", code, message, retryable, native_code: nativeCode }
    : { kind: "error", code, message, retryable };
}

/** Narrow PaymentPayload.payload to the EVM variant. EVM payloads carry
 *  the EIP-3009 authorization fields we need; SVM payloads carry a raw
 *  Solana transaction blob this adapter doesn't handle. */
function narrowEvmPayload(payload: PaymentPayload): ExactEvmPayload | null {
  const inner = payload.payload as unknown;
  const parsed = ExactEvmPayloadSchema.safeParse(inner);
  return parsed.success ? parsed.data : null;
}

/** Read the server-side-resolved x402 pay-to address from merchant config.
 *  Returns null if missing or invalid; the caller rejects with the right
 *  error code. The Terminal resolves this from per-site merchant
 *  configuration. */
function readMerchantPayTo(cfg: Readonly<Record<string, unknown>>): string | null {
  const v = cfg["x402_pay_to_address"];
  if (typeof v !== "string") return null;
  return /^0x[a-fA-F0-9]{40}$/.test(v) ? v : null;
}
