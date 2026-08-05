// BosonEscrowAdapter — FacetPaymentRailAdapter for Boson Protocol x402B
// (escrow-backed "secure x402B" settlement on Base). RailId:
// coin/boson-escrow.
//
// Delegates ALL escrow logic to the official `@bosonprotocol/x402-server`
// SDK. We do NOT hand-roll EIP-712 offer signing, the escrow wire format,
// the X-PAYMENT payload schema, or the facilitator HTTP client — the SDK
// owns all of that and tracks the on-chain protocol revisions for us.
//   - decode/validate the X-PAYMENT header → `decodeXPaymentHeader` +
//     `validatePaymentPayload`.
//   - commit / redeem / complete / dispute → `server.handlers.*`.
//
// Lifecycle mapping to FacetPaymentRailAdapter (full two-step escrow):
//   verifyAuthority   — decode + validate the buyer's commit X-PAYMENT
//                       (action boson-createOfferAndCommit, Flow A) against
//                       the seller-signed requirements; no on-chain action,
//                       no money. Returns a self-contained authority handle.
//   reserveAuthority  — server.handlers.commit → COMMITTED. Funds escrowed
//                       in the Boson Diamond. reservation_active = true.
//   capture           — server.handlers.redeem → REDEEMED. Dispute window
//                       opens; funds still escrowed, not yet released. The
//                       buyer's redeem meta-tx (signedPayload) + exchangeId
//                       arrive via `input.authority`.
//   refund            — pre-redeem refund maps to a Boson revoke/cancel,
//                       which requires a seller/buyer action signer the
//                       offer-only signer does not provide; surfaced as
//                       METHOD_NOT_ALLOWED until that signer is wired.
//   dispute           — server.handlers.disputeRaise/Resolve/Retract/Escalate.
//   handleWebhook     — Boson exchange-state webhooks → WebhookOutcome
//                       (final RELEASED → settlement_confirmed, etc.).
//
// ZERO-CUSTODY INVARIANT (locked): funds live in Boson's escrow Diamond,
// never in Facet and never in the facilitator. The seller signer signs
// FullOffers ONLY — it never moves money and never pays gas (the
// facilitator relays + funds gas). There is no destinationAccountId /
// transfer_data.destination anywhere in this path. Do NOT add one.
//
// STATELESS: the adapter opens no DB. The Boson SDK's mandatory persistent
// stores (fulfillmentRecoveryStore + exchangeFulfillmentOptionStore) are
// injected at construction, backed by host-provided persistence handles —
// persistence flows through the host's data layer.
//
// SECRETS: every credential (seller signer, sellerId, disputeResolverId,
// facilitator URL, escrow address, asset) arrives via `merchant_config`,
// which the host hydrates per-merchant from its secret store. The adapter
// reads no env vars and holds no inline secrets.

import type {
  BuildRequirementsInput,
  BuildRequirementsOk,
  CaptureInput,
  CaptureOk,
  DisputeInput,
  DisputeOk,
  FacetPaymentRailAdapter,
  MerchantConfig,
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
} from "@facet-llc/adapter";
import {
  createX402bServer,
  decodeXPaymentHeader,
  mapAsStore,
  validatePaymentPayload,
  type CommitOk,
  type ExchangeReader,
  type FulfillmentRecoveryEntry,
  type HandlerErrorBody,
  type HandlerResult,
  type PerformActionOk,
  type SellerSigner,
  type Store,
  type X402bServer,
  type X402bServerConfig,
} from "@bosonprotocol/x402-server";
import {
  parseEscrowPaymentRequirements,
  type EscrowNextActions,
  type EscrowPaymentRequirements,
  type TokenAuthStrategy,
} from "@bosonprotocol/x402-core/schemes/escrow";
import type { UnsignedFullOffer } from "@bosonprotocol/x402-core/eip712";
import { buildOfferMetadata, type BuiltOfferMetadata, type OfferProductInfo } from "./metadata.ts";
import { bindingMismatchNativeCode, isBindingMismatchError } from "./binding-error.ts";
import { validateCancelPayload } from "./redeem-payload.ts";

const PACKAGE_VERSION = "0.1.0";

/** Default base origin for the offer-metadata serve route when the host server
 *  does not thread `options.metadata_base_uri`. Points at the host's canonical
 *  public origin; a per-merchant subdomain (e.g. https://shop.example.com)
 *  overrides it via options so the URI resolves on the merchant's own origin. */
const DEFAULT_METADATA_BASE_URI = "https://example.com";

/** Default fee ceiling, in basis points of price, stamped onto `offer.feeLimit`.
 *  `feeLimit` is the max total protocol+agent fee the seller will tolerate at
 *  commit — it protects the seller if the protocol fee % is changed by governance
 *  between offer-sign and commit. 100 bps (1%) covers the live Boson protocol fee
 *  (~0.5%) with headroom. The host server can override per-quote via
 *  `options.fee_limit_bps` to match the exact on-chain fee + margin. */
const DEFAULT_FEE_LIMIT_BPS = 100;

/** Budget for re-verifying terminal exchange state when the SDK's in-handler
 *  post-action verify races chain mining. The SDK's verify reads the exchange
 *  with a ~150ms budget (3 attempts × 50ms, not tunable from here), so on a
 *  ~2s+ Base Sepolia mine it can report STATE_VERIFY_* on a payment that
 *  actually settled. We hold the exchangeId, so we re-read the chain ourselves
 *  with a real budget before surfacing the error. */
const REVERIFY_BUDGET_MS = 15_000;
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Flow A commit action id — the only commit action this adapter accepts.
 *  Flow B (atomic commit+redeem, `boson-createOfferCommitAndRedeem`) is
 *  rejected today — NOT because it would forfeit the fair-exchange guarantee
 *  (escrow + the post-redeem dispute window hold for Flow B too), but because
 *  this rail's deferred-redeem option (`rail_metadata.redeem_policy`) needs
 *  redeem to be a SEPARATE later step the host controls, and two-step keeps the
 *  exchange in the pre-redeem cancel/revoke window until the host redeems.
 *  Supporting Flow B (e.g. instant/digital goods, where commit+redeem in one
 *  step is the natural fit) is a deliberate future choice, not a security
 *  boundary. */
const FLOW_A_COMMIT_ACTION = "boson-createOfferAndCommit";

// ─────────────────────────────────────────────────────────────────────────────
// Construction config
// ─────────────────────────────────────────────────────────────────────────────

/** A Boson `Store<V>` factory bound to a host-provided persistence
 *  handle. Returns the option-policy store and the recovery store the
 *  SDK requires in production. Injected at construction so the adapter
 *  owns no DB; tests pass in-memory Maps via `mapAsStore`. */
export interface BosonStores {
  readonly exchangeFulfillmentOptionStore: Store<readonly string[]>;
  readonly fulfillmentRecoveryStore: Store<FulfillmentRecoveryEntry>;
}

/** One rejected-webhook audit record. Emitted whenever an inbound
 *  webhook fails signature verification (bad/forged signature or a
 *  missing header while a secret is configured) so operators can alarm
 *  on it. Carries the Facet trace id but never the secret or raw body. */
export interface WebhookRejection {
  readonly rail: string;
  readonly trace_id: string;
  readonly merchant_id: string;
  readonly site_id: string;
  /** Machine-readable cause: which gate rejected the webhook. */
  readonly reason: "missing_signature_header" | "signature_mismatch";
  /** Human-readable detail (safe to log — never includes the secret). */
  readonly detail: string;
}

/** Sink for webhook signature rejections. Injected so the host server can
 *  route these into its structured logger / alerting; defaults to a
 *  single `console.warn` line so a rejection is never silent. */
export type WebhookRejectionLogger = (rejection: WebhookRejection) => void;

export interface BosonEscrowAdapterConfig {
  /** Boson hosted facilitator base URL — declared in
   *  `metadata.egress_allowlist`. The per-merchant `merchant_config`
   *  facilitator URL MUST match this origin (defense in depth). */
  readonly facilitatorUrl: string;
  /** Base RPC URL used by the on-chain `ExchangeReader`. Declared in
   *  `metadata.egress_allowlist`. */
  readonly rpcUrl: string;
  /** Optional Boson subgraph URL — enables withdraw / available-funds
   *  read handlers and production mode. Declared in egress when set. */
  readonly subgraphUrl?: string;
  /** Persistent stores backed by host-provided persistence handles. Required for
   *  the write handlers (commit/redeem); absent → in-memory fallback
   *  (single-process / unit tests only). */
  readonly stores?: BosonStores;
  /** Factory for the post-settle `ExchangeReader`. Required for the
   *  write handlers — without it a valid X-PAYMENT would settle on-chain
   *  before any state verification. Injected so the adapter does not pin
   *  a viem client / Diamond ABI into its constructor. Tests inject a
   *  stub reader. */
  readonly exchangeReaderFactory?: (cfg: BosonMerchantConfig) => ExchangeReader;
  /** Operational mode passed to `createX402bServer`. Defaults to
   *  "production" when a subgraph URL is configured (so the boot-time
   *  superRefine can assert the read client), else "development". The
   *  injected stores + reader make the two modes behaviourally
   *  equivalent for the commit/redeem path. */
  readonly mode?: "development" | "production";
  /** Override Date.now() for deterministic tests. */
  readonly now?: () => number;
  /** Sink for webhook signature rejections (logged with the trace id).
   *  Defaults to a `console.warn` JSON line. */
  readonly webhookRejectionLogger?: WebhookRejectionLogger;
  /** When true (DEFAULT — secure), `handleWebhook` REFUSES to act on a webhook
   *  it cannot cryptographically verify: if no `merchant_config.webhook_secret`
   *  is present it returns UNAUTHORIZED instead of trusting the parsed body.
   *
   *  Set FALSE only when the HOST verifies the signature at its own webhook
   *  route BEFORE delegating with an empty merchant_config (the Facet Terminal
   *  does exactly this) — in that mode a secret-less webhook is trusted as
   *  already-verified (the back-compat path). Defaulting to true means a
   *  third-party host that integrates this package directly and forgets to
   *  configure a secret (or to verify upstream) cannot be fed forged
   *  exchange-state webhooks — it fails closed instead. */
  readonly requireWebhookSignature?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merchant config — hydrated by the host server from the site row + secret store
// ─────────────────────────────────────────────────────────────────────────────

/** Per-merchant Boson configuration. The host server builds this in-process
 *  from the authenticated site row + securely-stored secrets and passes it
 *  on every call. `signer` is a live `SellerSigner` (address +
 *  signTypedData) — never a raw key. */
export interface BosonMerchantConfig {
  /** CAIP-2 EVM network, e.g. `eip155:84532` (Base Sepolia) / `eip155:8453` (Base). */
  readonly network: string;
  /** EVM chain id matching `network`. */
  readonly chainId: number;
  /** Boson escrow Diamond address — the custodian + EIP-712 verifyingContract. */
  readonly escrow: string;
  /** Routing-only seller identifier (numeric sellerId / did:boson / address). */
  readonly sellerId: string;
  /** Boson dispute-resolver id stamped into the FullOffer. */
  readonly disputeResolverId: string;
  /** ERC-20 the buyer pays in (exchangeToken on the FullOffer). */
  readonly asset: string;
  /** Boson facilitator base URL — must match the adapter's egress allowlist. */
  readonly facilitatorUrl: string;
  /** Optional Boson subgraph URL. */
  readonly subgraphUrl?: string;
  /** Live seller signer — signs FullOffer EIP-712 typed-data ONLY. KMS /
   *  HSM / ERC-1271 compatible. Never moves money, never pays gas. */
  readonly signer: SellerSigner;
  /** Shared secret for verifying inbound exchange-state webhooks
   *  (HMAC-SHA256 over the raw body). When set, `handleWebhook` rejects
   *  any webhook whose signature does not match. When absent, the
   *  adapter trusts the parsed body (back-compat: a host that verifies
   *  the signature at its own webhook route before delegating). */
  readonly webhook_secret?: string;
  /** Previous webhook secret, honored during a zero-downtime rotation.
   *  When set, a signature matching EITHER `webhook_secret` or this is
   *  accepted; drop it once the new secret is fully rolled out. */
  readonly webhook_secret_previous?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class BosonEscrowAdapter implements FacetPaymentRailAdapter {
  public readonly metadata: RailAdapterMetadata;

  private readonly facilitatorUrl: string;
  private readonly rpcUrl: string;
  private readonly subgraphUrl: string | undefined;
  private readonly stores: BosonStores | undefined;
  private readonly exchangeReaderFactory:
    ((cfg: BosonMerchantConfig) => ExchangeReader) | undefined;
  private readonly mode: "development" | "production";
  private readonly now: () => number;
  private readonly logWebhookRejection: WebhookRejectionLogger;
  private readonly requireWebhookSignature: boolean;

  constructor(cfg: BosonEscrowAdapterConfig) {
    this.facilitatorUrl = cfg.facilitatorUrl;
    this.rpcUrl = cfg.rpcUrl;
    this.subgraphUrl = cfg.subgraphUrl;
    this.stores = cfg.stores;
    this.exchangeReaderFactory = cfg.exchangeReaderFactory;
    this.mode = cfg.mode ?? (cfg.subgraphUrl !== undefined ? "production" : "development");
    this.now = cfg.now ?? (() => Date.now());
    this.logWebhookRejection = cfg.webhookRejectionLogger ?? defaultWebhookRejectionLogger;
    // Secure by default: refuse webhooks we cannot verify unless the host
    // explicitly opts into the already-verified-upstream path.
    this.requireWebhookSignature = cfg.requireWebhookSignature ?? true;

    // egress_allowlist: only the outbound destinations this adapter
    // touches — the Boson facilitator (meta-tx relay), the Base RPC (the
    // ExchangeReader's post-settle state reads), and the subgraph (funds
    // read handlers) when configured. Normalised to origins + deduped.
    const egress = new Set<string>();
    for (const u of [cfg.facilitatorUrl, cfg.rpcUrl, cfg.subgraphUrl]) {
      const origin = safeOrigin(u);
      if (origin !== null) egress.add(origin);
    }

    this.metadata = {
      id: "coin/boson-escrow",
      display_name: "Boson Protocol escrow (secure x402B) on Base",
      version: PACKAGE_VERSION,
      // Two-step escrow: reserve = commit (COMMITTED), capture = redeem
      // (REDEEMED). Final RELEASED is surfaced via handleWebhook.
      supports_reserve_capture: true,
      // A pre-redeem refund maps to a Boson cancel (buyer) / revoke (seller)
      // meta-tx. x402-server exposes no cancel/revoke handler, so refund()
      // relays the buyer's boson-cancelVoucher via the FacilitatorClient
      // directly. BUYER-CANCEL is wired (authority.signed_payload); seller
      // REVOKE (which needs a founder-gated seller action-signer) is not yet.
      supports_refund: true,
      // Boson exposes a full dispute lifecycle (raise/resolve/retract/escalate).
      supports_dispute: true,
      networks: ["base", "base-sepolia"],
      currencies: ["USDC"],
      egress_allowlist: Array.from(egress),
    };
  }

  // ─── verify_authority ──────────────────────────────────────────────────────
  //
  // Decode + validate the buyer's commit X-PAYMENT against the
  // seller-signed requirements they responded to. No server, no on-chain
  // action — pure validation. The standalone SDK validators
  // (decodeXPaymentHeader + validatePaymentPayload) own the EIP-712 +
  // schema checks; we add the merchant-config binding gate on top.

  async verifyAuthority(
    input: VerifyAuthorityInput,
  ): Promise<RailAdapterResult<VerifyAuthorityOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    if (input.amount.currency !== "USDC") {
      return errResult(
        "INVALID_REQUEST",
        `Currency "${input.amount.currency}" not supported (USDC only)`,
      );
    }

    const xPayment = readString(input.authority, "x_payment");
    if (xPayment === null) {
      return errResult(
        "INVALID_REQUEST",
        "authority.x_payment (base64 X-PAYMENT header for the commit) is required",
      );
    }

    // Parse the buyer-echoed requirements (the seller-signed 402 the buyer
    // is responding to). The SDK schema validates wire shape; the gate
    // below binds it to THIS merchant.
    let requirements: EscrowPaymentRequirements;
    try {
      requirements = parseEscrowPaymentRequirements(readUnknown(input.authority, "requirements"));
    } catch (e) {
      return errResult(
        "INVALID_REQUEST",
        `authority.requirements failed Boson escrow schema validation: ${asMessage(e)}`,
      );
    }

    // SECURITY GATE — the offer must have been signed by OUR seller and
    // target OUR escrow / asset / amount. Without this an attacker could
    // present a self-dealing offer signed by a wallet they control: the
    // SDK validators only check the payload is internally consistent with
    // the requirements, not that the requirements are ours. This is the
    // Boson analogue of the x402 adapter's "payTo must come from
    // merchant_config, never the payload" gate.
    const gate = gateRequirements(requirements, cfg.value, input.amount.amount);
    if (gate !== null) return gate;

    const decoded = decodeXPaymentHeader(xPayment);
    if (!decoded.ok) {
      return errResult(
        "INVALID_REQUEST",
        `X-PAYMENT decode failed (${decoded.code}): ${decoded.reason}`,
      );
    }

    // Two-step rail: only the deferred-redeem commit action is accepted.
    if (decoded.payload.payload.action !== FLOW_A_COMMIT_ACTION) {
      return errResult(
        "INVALID_REQUEST",
        `Only ${FLOW_A_COMMIT_ACTION} (two-step escrow) is accepted; got "${decoded.payload.payload.action}"`,
      );
    }

    const validation = await validatePaymentPayload({
      payload: decoded.payload,
      requirements,
      chainId: cfg.value.chainId,
      now: Math.floor(this.now() / 1000),
    });
    if (!validation.ok) {
      return makeError(
        "UNAUTHORIZED",
        `X-PAYMENT failed Boson validation rule ${validation.rule} (${validation.code})${validation.field ? ` at ${validation.field}` : ""}`,
        false,
        validation.code,
      );
    }

    // Self-contained handle: reserveAuthority re-presents the commit
    // header + requirements without a store read (no exchange exists yet —
    // commit creates it). The host server stores this opaque handle on the
    // order row and re-presents it at reserve time.
    const handle = encodeHandle({ x_payment: xPayment, requirements });
    return {
      kind: "ok",
      value: {
        authority_handle: handle,
        expires_at: new Date(
          (Math.floor(this.now() / 1000) + requirements.maxTimeoutSeconds) * 1000,
        ).toISOString(),
      },
    };
  }

  // ─── reserve_authority (commit) ──────────────────────────────────────────────
  //
  // server.handlers.commit (Flow A boson-createOfferAndCommit). Settles
  // the commit via the facilitator and verifies the exchange reached
  // COMMITTED. Funds are now escrowed in the Diamond.

  /** Re-verify an exchange reached its expected terminal state (`expectedUpper`
   *  = "COMMITTED" | "REDEEMED") against the chain, with a real budget, after
   *  the SDK's in-handler post-action verify raced mining and returned a
   *  STATE_VERIFY_* error. Returns the confirmed rail_metadata (same shape as
   *  `withRailMetadata`), or null when it is not a recoverable timing error, no
   *  reader is wired, or the state was never reached within the budget. A reader
   *  throw (seller/asset binding mismatch, hard RPC error) is never masked. */
  /** Core post-action re-verify: after a 502/STATE_VERIFY_ false-fail (the
   *  facilitator relays the meta-tx, but the SDK's post-action verify reads a
   *  LAGGING subgraph before it reflects the new state), poll the on-chain
   *  ExchangeReader within a budget and, once `landed(snapshot)` holds, return the
   *  recovery rail_metadata instead of surfacing the false failure. Returns null
   *  (surface the original error) if the guard doesn't match, no reader is wired,
   *  the read throws (never mask a hard error), or the budget elapses. Shared by
   *  commit/redeem (EXCHANGE-state moves) and dispute (DISPUTE sub-state moves). */
  private async reverifyLanded(
    cfg: BosonMerchantConfig,
    exchangeId: string,
    failed: { readonly status: number; readonly body: HandlerErrorBody },
    landed: (snapshot: NonNullable<Awaited<ReturnType<ExchangeReader["read"]>>>) => boolean,
  ): Promise<{ readonly rail_metadata: Readonly<Record<string, unknown>> } | null> {
    if (failed.status !== 502 || !failed.body.code.startsWith("STATE_VERIFY_")) return null;
    if (this.exchangeReaderFactory === undefined) return null;
    const reader = this.exchangeReaderFactory(cfg);
    const deadline = this.now() + REVERIFY_BUDGET_MS;
    for (;;) {
      let snapshot: Awaited<ReturnType<ExchangeReader["read"]>>;
      try {
        snapshot = await reader.read(exchangeId);
      } catch {
        return null; // binding mismatch / hard RPC error — never mask it
      }
      if (snapshot !== null && landed(snapshot)) {
        const details = (failed.body.details ?? {}) as Record<string, unknown>;
        const txHash = typeof details.txHash === "string" ? details.txHash : "";
        return {
          rail_metadata: {
            escrow_state: {
              exchange_id: exchangeId,
              exchange_state: snapshot.state,
              dispute_state: snapshot.disputeState ?? null,
            },
            tx_hash: txHash,
          },
        };
      }
      if (this.now() >= deadline) return null;
      await sleepMs(2000);
    }
  }

  /** Re-verify the EXCHANGE reached `expectedUpper` on-chain after a 502
   *  post-action false-fail (commit → COMMITTED, redeem → REDEEMED). */
  private reverifyExchangeState(
    cfg: BosonMerchantConfig,
    exchangeId: string,
    expectedUpper: string,
    failed: { readonly status: number; readonly body: HandlerErrorBody },
  ): Promise<{ readonly rail_metadata: Readonly<Record<string, unknown>> } | null> {
    return this.reverifyLanded(
      cfg,
      exchangeId,
      failed,
      (snapshot) => String(snapshot.state).toUpperCase() === expectedUpper,
    );
  }

  /** Bind the on-chain exchange to THIS merchant before redeem, reading the
   *  snapshot via the configured `ExchangeReader`. Returns an UNAUTHORIZED
   *  error result IFF a snapshot field is known and does NOT match what this
   *  server committed:
   *    - `seller` ≠ this merchant's offer signer — the case x402B #115
   *      flags: the SDK's `redeem` handler takes only exchangeId + signedPayload
   *      and does NOT check that the voucher belongs to this server's seller, so
   *      a buyer-owned voucher from ANOTHER seller's offer would otherwise
   *      redeem here (valid on-chain, unrelated to us → gas-sponsored relay
   *      abuse or a cross-seller mix-up). The offer creator is gated to this
   *      same address at commit (`gateRequirements`); this re-asserts it at
   *      redeem. Seller identity — not price — is the load-bearing binding when
   *      one buyer commits to several offers on this server.
   *    - `exchangeToken` ≠ the merchant asset — defense-in-depth (USDC was also
   *      constrained upstream + at commit).
   *    - `price` ≠ `amount` — the original gate (commit a cheap offer, redeem
   *      against an expensive reservation). A snapshot that IS readable but whose
   *      `price` is missing / non-string also fails CLOSED (escrow_price_
   *      unverifiable, L1-UCP-BSN-002): once seller + token bind to this merchant
   *      the exchange is ours, so an unverifiable amount is a refusal, not a pass.
   *    - `state` ≠ COMMITTED (a deferred-redeem hardening gate): redeem is only
   *      valid from Committed, so a voucher that moved off Committed on-chain
   *      (cancelled / revoked / already redeemed / window elapsed) is refused
   *      locally (escrow_state_not_committed) instead of relaying a redeem the
   *      Diamond would revert. Funds are never at risk either way.
   *  None of these is ever legitimate traffic, so failing closed cannot break a
   *  real settlement. When the whole snapshot cannot be read (no reader wired,
   *  exchange not yet readable, or a hard RPC error) this returns null and lets the
   *  existing redeem + post-settle verify proceed, tightening a real mismatch
   *  without newly breaking settlements whose chain state is momentarily
   *  unreadable. Currency was already constrained to USDC upstream. */
  private async assertExchangeBinding(
    cfg: BosonMerchantConfig,
    exchangeId: string,
    amount: CaptureInput["amount"],
    opts?: { readonly failClosedOnUnreadable?: boolean },
  ): Promise<RailAdapterResult<never> | null> {
    // The three "unreadable escrow" branches below FAIL OPEN (return null → the
    // caller proceeds) for capture/redeem, where a transient read miss must not
    // block a settlement the merchant is OWED. A REFUND moves money OUT of the
    // escrow, so an unverifiable escrow must NOT be actioned: refund() passes
    // failClosedOnUnreadable, flipping these to a retryable refusal (the refund
    // simply retries once the chain read recovers — harmless to defer).
    const unreadable = (): RailAdapterResult<never> | null =>
      opts?.failClosedOnUnreadable === true
        ? makeError(
            "SETTLEMENT_FAILED",
            "cannot verify the escrow on-chain before refunding (reader unavailable); " +
              "retry once the chain read succeeds",
            true,
            "escrow_unreadable",
          )
        : null;

    if (amount.currency !== "USDC") {
      return errResult(
        "INVALID_REQUEST",
        `Currency "${amount.currency}" not supported (USDC only)`,
      );
    }
    if (!Number.isInteger(amount.amount) || amount.amount <= 0) {
      return errResult(
        "INVALID_REQUEST",
        "amount.amount must be a positive integer (USDC atomic units)",
      );
    }
    if (this.exchangeReaderFactory === undefined) return unreadable();

    let snapshot: Awaited<ReturnType<ExchangeReader["read"]>>;
    try {
      snapshot = await this.exchangeReaderFactory(cfg).read(exchangeId);
    } catch (e) {
      // A reader that ASSERTS the merchant binding (the host's production reader
      // does) THROWS a BosonBindingMismatchError on a seller/asset mismatch. That
      // is the authoritative on-chain mismatch signal and is PERMANENT, so we
      // FAIL CLOSED with a non-retryable UNAUTHORIZED — distinct from a transient
      // RPC / not-yet-indexed read error, which we still swallow and FAIL OPEN
      // (returning null) so a momentary chain blip cannot block a real settlement
      // (the redeem path's own verify still applies). Without this discrimination
      // the in-gate seller/token checks below would be dead code behind an
      // asserting reader (x402B #115 review).
      if (isBindingMismatchError(e)) {
        return makeError("UNAUTHORIZED", e.message, false, bindingMismatchNativeCode(e.kind));
      }
      return unreadable();
    }
    if (snapshot === null) return unreadable();

    // SELLER BINDING (x402B #115 review) — the on-chain seller must be
    // this merchant's offer signer. Without it, a buyer could have the server
    // relay a redeem for a voucher they own but that was committed against a
    // DIFFERENT seller's offer. Fail-closed is safe: an exchange we committed is
    // always sold by our signer (`gateRequirements` binds `offer.creator` to it
    // at commit). These in-gate comparisons cover a reader that RETURNS a
    // mismatching snapshot rather than throwing; an asserting reader is handled
    // by the binding-mismatch branch in the catch above.
    const escrowedSeller = typeof snapshot.seller === "string" ? snapshot.seller : null;
    if (escrowedSeller !== null && !eqAddress(escrowedSeller, cfg.signer.address)) {
      return makeError(
        "UNAUTHORIZED",
        `escrowed seller (${escrowedSeller}) is not this merchant's seller signer (${cfg.signer.address}); ` +
          "refusing to redeem an exchange that was not committed against this server's offer",
        false,
        "escrow_seller_mismatch",
      );
    }

    // TOKEN BINDING — the escrow settlement token must be the merchant asset.
    const escrowedToken =
      typeof snapshot.exchangeToken === "string" ? snapshot.exchangeToken : null;
    if (escrowedToken !== null && !eqAddress(escrowedToken, cfg.asset)) {
      return makeError(
        "UNAUTHORIZED",
        `escrowed token (${escrowedToken}) does not match the merchant asset (${cfg.asset})`,
        false,
        "escrow_token_mismatch",
      );
    }

    // PRICE BINDING: fail CLOSED (L1-UCP-BSN-002). The seller + token gates above
    // have already passed, so this snapshot is genuinely this merchant's exchange;
    // a missing / non-string on-chain price is then an UNVERIFIABLE amount, not a
    // transient read miss. Redeeming would skip the price binding (the "commit a
    // cheap offer, redeem against an expensive reservation" defense), so we refuse
    // with a non-retryable UNAUTHORIZED rather than passing (the prior fail-open).
    const escrowedPrice = typeof snapshot.price === "string" ? snapshot.price : null;
    if (escrowedPrice === null) {
      return makeError(
        "UNAUTHORIZED",
        "escrowed on-chain price is missing or not a string; refusing to redeem an escrow whose " +
          "price cannot be bound to this reservation",
        false,
        "escrow_price_unverifiable",
      );
    }

    if (escrowedPrice !== String(amount.amount)) {
      return makeError(
        "UNAUTHORIZED",
        `escrowed amount (${escrowedPrice}) does not match the amount being captured (${amount.amount}); ` +
          "refusing to redeem an escrow whose on-chain price was not bound to this reservation",
        false,
        "escrow_amount_mismatch",
      );
    }

    // STATE BINDING (deferred-redeem hardening). Redeem is valid ONLY from the
    // COMMITTED state. Between the buyer pre-signing the redeem (deferred-redeem
    // stores the signed payload) and the fulfillment webhook later firing it, the
    // exchange can move OFF Committed on-chain (buyer cancelled, seller revoked,
    // the redeem window elapsed, or it already redeemed). The Boson Diamond's
    // redeemVoucher reverts for a non-Committed exchange, so funds are never at
    // risk. But that revert is a wasted facilitator-gas relay whose failure is
    // only logged, and nothing local stops it. Gate it here and FAIL CLOSED so we
    // never relay a doomed redeem and never advance a Facet order on an exchange
    // that is no longer redeemable. FAIL OPEN (null) only when the state is
    // unreadable, matching the seller/token gates above (price instead fails
    // closed on an unverifiable value): a transient read miss must not block a
    // real settlement. (Boson DD review, 2026-07-06: assertExchangeBinding gated
    // seller/token/price but never state.)
    const escrowedState = typeof snapshot.state === "string" ? snapshot.state.toUpperCase() : null;
    if (escrowedState !== null && escrowedState !== "COMMITTED") {
      return makeError(
        "UNAUTHORIZED",
        `escrowed exchange state (${snapshot.state}) is not COMMITTED; refusing to redeem an ` +
          "exchange that is no longer redeemable",
        false,
        "escrow_state_not_committed",
      );
    }
    return null;
  }

  async reserveAuthority(
    input: ReserveAuthorityInput,
  ): Promise<RailAdapterResult<ReserveAuthorityOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    const handle = decodeHandle(input.authority_handle);
    if (handle === null) {
      return errResult(
        "INVALID_REQUEST",
        "authority_handle is not a valid Boson commit handle (re-run verify_authority)",
      );
    }

    const built = this.buildServer(cfg.value);
    if (built.kind === "error") return built.error;

    let result: HandlerResult<CommitOk>;
    try {
      result = await built.server.handlers.commit({
        paymentHeader: handle.x_payment,
        requirements: handle.requirements,
      });
    } catch (e) {
      return makeError("SETTLEMENT_FAILED", `Boson commit failed: ${asMessage(e)}`, true, null);
    }

    if (!result.ok) {
      // The commit landed on-chain but the SDK's post-settle verify may have
      // read the exchange before it mined. The error detail carries the
      // exchangeId — re-verify COMMITTED ourselves before surfacing a false fail.
      const exId = (result.body.details as Record<string, unknown> | undefined)?.exchangeId;
      if (typeof exId === "string") {
        const recovered = await this.reverifyExchangeState(cfg.value, exId, "COMMITTED", result);
        if (recovered !== null) {
          const reservedUntil =
            handle.requirements.maxTimeoutSeconds > 0
              ? new Date(this.now() + handle.requirements.maxTimeoutSeconds * 1000).toISOString()
              : null;
          return {
            kind: "ok",
            value: { reservation_active: true, reserved_until: reservedUntil, ...recovered },
          };
        }
      }
      return mapHandlerError(result.body, result.status, "commit");
    }

    const reservedUntil = redeemDeadline(handle.requirements, result.body.nextActions);
    return {
      kind: "ok",
      value: withRailMetadata(
        {
          reservation_active: true,
          reserved_until: reservedUntil,
        },
        result.body.nextActions,
        result.body.txHash,
      ),
    };
  }

  // ─── capture (redeem) ─────────────────────────────────────────────────────────
  //
  // server.handlers.redeem. The buyer's redeem meta-tx (signedPayload) +
  // the exchangeId (learned from the reserve receipt's escrow_state) arrive
  // via `input.authority` — redeem is buyer-authorised and can only be
  // signed AFTER commit assigns the exchangeId, so it cannot ride the
  // verify-time handle.
  //
  // REDEEM TIMING. commit (reserve) and redeem (capture) are SEPARATE steps:
  // funds escrow at commit, and redeem burns the buyer's rNFT and opens the
  // dispute window — it does NOT release funds (release is the later complete
  // step). In the CANONICAL Boson flow the buyer redeems to signal the purchase,
  // which opens the dispute window and is the cue for the seller to ship; that
  // window is the buyer's protection COVERING delivery (dispute if the goods
  // never arrive or are not as described). Before redeem the buyer can cancel
  // and the seller can revoke; after redeem only the dispute path remains.
  //
  // This rail can DIVERGE from that ordering via `rail_metadata.redeem_policy`:
  // a merchant may advertise `deferred`, where the host holds the buyer's signed
  // redeem and submits it on the fulfilment signal (e.g. Shopify
  // `fulfillments/create`) rather than up front — keeping the exchange in the
  // pre-redeem cancel/revoke window during shipping instead of the dispute
  // window. That is a deliberate Facet choice, not the protocol default. The
  // adapter does not force timing — it settles whatever redeem the caller
  // submits, whenever submitted.

  async capture(input: CaptureInput): Promise<RailAdapterResult<CaptureOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    const authority = readAuthority(input);
    const exchangeId = readString(authority, "exchange_id");
    const signedPayload = readHex(authority, "signed_payload");
    if (exchangeId === null || signedPayload === null) {
      return errResult(
        "INVALID_REQUEST",
        "capture requires authority.exchange_id + authority.signed_payload (the buyer's boson-redeem meta-tx)",
      );
    }
    const fulfillment = readFulfillment(authority);

    // EXCHANGE BINDING (fail-closed) — `server.handlers.redeem` settles whatever
    // was escrowed at commit; it takes only exchangeId + signedPayload and never
    // checks that the exchange belongs to this server's seller, nor that its
    // token/price match the reservation. Without this gate a buyer could relay a
    // redeem for a voucher from another seller's offer (x402B #115), or commit a
    // ~$0 offer and redeem it to "settle" an expensive reservation. We read the
    // on-chain snapshot (the same ExchangeReader the post-settle verify uses)
    // and bind seller + token + price to this merchant before redeeming.
    const bindingGate = await this.assertExchangeBinding(cfg.value, exchangeId, input.amount);
    if (bindingGate !== null) return bindingGate;

    const built = this.buildServer(cfg.value);
    if (built.kind === "error") return built.error;

    let result: HandlerResult<PerformActionOk>;
    try {
      result = await built.server.handlers.redeem({
        exchangeId,
        signedPayload,
        ...(fulfillment !== null ? { fulfillment } : {}),
      });
    } catch (e) {
      // A binding mismatch surfaced by the SDK's own pre-action read is permanent
      // (the same voucher will fail identically) — return a non-retryable
      // UNAUTHORIZED, not a retryable SETTLEMENT_FAILED that invites resubmission.
      // (Belt-and-suspenders: assertExchangeBinding above already catches this
      // before redeem; this covers a reader that throws only on the SDK's read.)
      if (isBindingMismatchError(e)) {
        return makeError("UNAUTHORIZED", e.message, false, bindingMismatchNativeCode(e.kind));
      }
      return makeError("SETTLEMENT_FAILED", `Boson redeem failed: ${asMessage(e)}`, true, null);
    }

    if (!result.ok) {
      // The redeem meta-tx lands but the SDK's post-action verify may read the
      // exchange before it shows REDEEMED. We hold the exchangeId — re-verify
      // REDEEMED ourselves with a real budget before surfacing a false fail.
      const recovered = await this.reverifyExchangeState(cfg.value, exchangeId, "REDEEMED", result);
      if (recovered !== null) {
        return {
          kind: "ok",
          value: {
            settlement_id: exchangeId,
            settled_at: new Date(this.now()).toISOString(),
            ...recovered,
          },
        };
      }
      return mapHandlerError(result.body, result.status, "redeem");
    }

    // settlement_id = exchangeId (the durable Boson handle dispute/refund
    // key off), not the redeem tx hash. The tx hash + escrow_state ride
    // rail_metadata into the receipt + dispatch log.
    return {
      kind: "ok",
      value: withRailMetadata(
        {
          settlement_id: exchangeId,
          settled_at: new Date(this.now()).toISOString(),
        },
        result.body.nextActions,
        result.body.txHash,
      ),
    };
  }

  // ─── refund (pre-redeem revoke/cancel) ────────────────────────────────────────
  //
  // A pre-redeem Boson refund is a `boson-revokeVoucher` (seller) or
  // `boson-cancelVoucher` (buyer) meta-tx. Neither is exposed by
  // `server.handlers`, and revoke is a seller-authorised action the
  // offer-only signer is explicitly forbidden from producing (it signs
  // FullOffers, never moves money). Until a dedicated seller action-signer
  // is wired (founder-gated), the adapter surfaces this honestly rather
  // than silently no-op'ing a money movement.

  async refund(input: RefundInput): Promise<RailAdapterResult<RefundOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    const exchangeId = input.settlement_id;

    // The buyer's pre-signed boson-cancelVoucher meta-tx rides in `authority`
    // (a cancel can only be signed by the voucher holder). Seller-initiated
    // revoke is a separate, founder-gated leg not wired here (v1 = buyer-cancel).
    const signedPayload = readHex(input.authority ?? null, "signed_payload");
    if (signedPayload === null) {
      return errResult(
        "INVALID_REQUEST",
        "Boson refund requires authority.signed_payload (the buyer-signed boson-cancelVoucher meta-tx)",
      );
    }

    // 1) INTEGRITY (offline): a well-formed cancelVoucher for EXACTLY this exchange.
    const valid = await validateCancelPayload({
      signedPayload,
      exchangeId,
      chainId: cfg.value.chainId,
      verifyingContract: cfg.value.escrow,
    });
    if (!valid.ok) {
      return errResult(
        "INVALID_REQUEST",
        `refund payload rejected (${valid.reason}): ${valid.message}`,
      );
    }

    // 2) AUTHORIZATION + BINDING: this exchange is THIS merchant's (seller/token
    //    bound), on-chain COMMITTED, and its escrowed price == the refund amount.
    //    Boson cancel is FULL-only, so a partial refund amount is refused by the
    //    price binding (escrow_amount_mismatch). Same proven gate as redeem, but
    //    with failClosedOnUnreadable: a refund moves money OUT of the escrow, so an
    //    unverifiable escrow is REFUSED (retryable) rather than relayed unbound —
    //    unlike capture/redeem, which fail open so a transient read miss cannot
    //    block a settlement the merchant is owed.
    const bindingGate = await this.assertExchangeBinding(cfg.value, exchangeId, input.amount, {
      failClosedOnUnreadable: true,
    });
    if (bindingGate !== null) return bindingGate;

    // 3) RELAY the gasless cancel. x402-server 0.3.1 exposes no cancel handler, so
    //    call the FacilitatorClient directly (the same egress-allowlisted client the
    //    built-in handlers use). Its response is authoritative — it submits the
    //    on-chain tx and reports the new state — so there is no subgraph post-verify
    //    to lag (unlike the dispute path).
    const built = this.buildServer(cfg.value);
    if (built.kind === "error") return built.error;

    let relay;
    try {
      relay = await built.server.facilitator.performAction({
        network: cfg.value.network,
        escrowAddress: cfg.value.escrow,
        exchangeId,
        action: "boson-cancelVoucher",
        signedPayload,
      });
    } catch (e) {
      // Network / timeout / 5xx from the facilitator — transient, retryable.
      return makeError(
        "SETTLEMENT_FAILED",
        `Boson cancel relay failed: ${asMessage(e)}`,
        true,
        null,
      );
    }
    if (!relay.ok) {
      // A 400 known-failure branch (UNSUPPORTED_ACTION, SIMULATION_REVERT, …). The
      // payload was validated + bound locally, so re-relaying the same bytes will
      // not help — non-retryable.
      return makeError(
        "SETTLEMENT_FAILED",
        `Boson cancel rejected by facilitator (${relay.code}): ${relay.reason}`,
        false,
        relay.code,
      );
    }

    const newExchangeState =
      "newExchangeState" in relay && typeof relay.newExchangeState === "string"
        ? relay.newExchangeState
        : "CANCELLED";
    return {
      kind: "ok",
      value: {
        refund_id: exchangeId,
        refunded_at: new Date(this.now()).toISOString(),
        rail_metadata: {
          escrow_state: {
            exchange_id: exchangeId,
            exchange_state: newExchangeState,
            dispute_state: null,
          },
          tx_hash: relay.txHash,
        },
      },
    };
  }

  // ─── dispute ──────────────────────────────────────────────────────────────────
  //
  // server.handlers.disputeRaise / disputeResolve / disputeRetract /
  // disputeEscalate. settlement_id is the exchangeId. The signed meta-tx +
  // the specific sub-action arrive via `evidence`.

  async dispute(input: DisputeInput): Promise<RailAdapterResult<DisputeOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    const exchangeId = input.settlement_id;
    const signedPayload = readHex(input.evidence ?? null, "signed_payload");
    if (signedPayload === null) {
      return errResult(
        "INVALID_REQUEST",
        "dispute requires evidence.signed_payload (the signed Boson dispute meta-tx)",
      );
    }
    const kind = resolveDisputeKind(input);

    const built = this.buildServer(cfg.value);
    if (built.kind === "error") return built.error;

    let result: HandlerResult<PerformActionOk>;
    try {
      const performInput = { exchangeId, signedPayload };
      switch (kind) {
        case "raise":
          result = await built.server.handlers.disputeRaise(performInput);
          break;
        case "resolve":
          result = await built.server.handlers.disputeResolve(performInput);
          break;
        case "escalate":
          result = await built.server.handlers.disputeEscalate(performInput);
          break;
        case "retract":
          result = await built.server.handlers.disputeRetract(performInput);
          break;
      }
    } catch (e) {
      return makeError(
        "SETTLEMENT_FAILED",
        `Boson dispute (${kind}) failed: ${asMessage(e)}`,
        true,
        null,
      );
    }

    if (!result.ok) {
      // The dispute meta-tx lands but the SDK's post-action verify may read a
      // LAGGING subgraph before it reflects the new state — a 502/STATE_VERIFY_
      // false-fail even though the transition already happened on-chain (proven on
      // mainnet 2026-07-17: raise + resolve both 502'd yet landed). Re-verify the
      // expected on-chain state ourselves before surfacing the false fail, mirroring
      // redeem/commit. `raise` moves the EXCHANGE to DISPUTED; `resolve`/`retract`/
      // `escalate` move the DISPUTE sub-state (the exchange stays DISPUTED), so we
      // match the right field per kind (see `disputeLanded`).
      const recovered = await this.reverifyLanded(cfg.value, exchangeId, result, (snapshot) =>
        disputeLanded(kind, snapshot),
      );
      if (recovered !== null) {
        return {
          kind: "ok",
          value: { dispute_id: exchangeId, status: disputeStatusFor(kind), ...recovered },
        };
      }
      return mapHandlerError(result.body, result.status, `dispute_${kind}`);
    }

    // Surface the tx hash + escrow_state as rail_metadata (as commit/redeem do), so
    // the dispatch envelope + signed receipt carry the dispute's on-chain evidence.
    return {
      kind: "ok",
      value: withRailMetadata(
        { dispute_id: exchangeId, status: disputeStatusFor(kind) },
        result.body.nextActions,
        result.body.txHash,
      ),
    };
  }

  // ─── build_requirements (the seller-signed 402 producer) ────────────────────
  //
  // Sign a FullOffer with the merchant's seller signer and assemble the
  // EscrowPaymentRequirements (the 402 "accepts" entry) the agent commits
  // against. This is the producer half the agent CANNOT do for itself —
  // verifyAuthority gates `offer.creator == seller signer`, so the offer must
  // be signed server-side here. Delegates to `server.buildPaymentRequirements`
  // (which calls `signFullOffer` with config.signer); the adapter only builds
  // the offer template from merchant_config + the per-quote windows.
  //
  // The dispute / redeem / offer-validity windows arrive via `input.options`
  // (the host server supplies them per quote). NOTE: the on-chain protocol
  // enforces a minimum dispute period (`InvalidDisputePeriod`); a window below
  // that floor reverts at commit.

  async quoteRequirements(
    input: BuildRequirementsInput,
  ): Promise<RailAdapterResult<BuildRequirementsOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    if (input.amount.currency !== "USDC") {
      return errResult(
        "INVALID_REQUEST",
        `Currency "${input.amount.currency}" not supported (USDC only)`,
      );
    }
    if (!Number.isInteger(input.amount.amount) || input.amount.amount <= 0) {
      return errResult(
        "INVALID_REQUEST",
        "amount.amount must be a positive integer (USDC atomic units)",
      );
    }

    const opts = readQuoteOptions(input.options);
    const built = this.buildServer(cfg.value);
    if (built.kind === "error") return built.error;

    const nowMs = this.now();
    const amountAtomic = String(input.amount.amount);

    // Build a real BPIP-1 BASE metadata document for this offer. The host server
    // serves the exact bytes back at metadata.metadataUri so the on-chain
    // metadataHash can be verified by any resolver.
    const metadata = buildOfferMetadata({
      product: opts.product,
      exchangeToken: cfg.value.asset,
      network: cfg.value.network,
      metadataBaseUri: opts.metadataBaseUri,
      // Per-quote nonce → unique offer per quote; see metadata.ts offerNonce.
      nonce: crypto.randomUUID(),
    });

    const unsigned = buildUnsignedOffer(cfg.value, amountAtomic, opts, nowMs, metadata);

    let requirements: EscrowPaymentRequirements;
    try {
      requirements = await built.server.buildPaymentRequirements({
        offer: { unsigned },
        asset: cfg.value.asset,
        amount: amountAtomic,
        tokenAuthStrategies: opts.tokenAuthStrategies,
        recipientId: cfg.value.sellerId,
        maxTimeoutSeconds: opts.maxTimeoutSeconds,
      });
    } catch (e) {
      return makeError(
        "INTERNAL_ERROR",
        `Boson buildPaymentRequirements failed: ${asMessage(e)}`,
        false,
        null,
      );
    }

    // Advertise the "server" channel on each commit action so the x402-client's
    // pickAction resolves — it requires the commit action on the "server"
    // channel, but the Boson SDK's deriveNextActions only emits
    // facilitator/onchain. These channels are UNSIGNED advertising metadata (the
    // seller signs only the FullOffer — see boson-seller-signer.ts), so stamping
    // here is signature-safe. Buyers submit the X-PAYMENT to the host server's
    // /v1/payments/dispatch (the server channel); facilitator/onchain stay as
    // direct fallbacks.
    if (requirements.actions?.next !== undefined) {
      requirements = {
        ...requirements,
        actions: {
          ...requirements.actions,
          next: requirements.actions.next.map((a) => ({
            ...a,
            channels: a.channels.includes("server")
              ? a.channels
              : (["server", ...a.channels] as typeof a.channels),
            endpoints: { ...(a.endpoints ?? {}), server: "/v1/payments/dispatch" },
          })),
        },
      } as EscrowPaymentRequirements;
    }

    // Quote expiry = the token-auth deadline horizon (the buyer's commit
    // authorization is bounded by maxTimeoutSeconds). The commit must land
    // before this; the redeem window is separate (carried in the offer).
    const expiresAt = new Date(
      (Math.floor(nowMs / 1000) + opts.maxTimeoutSeconds) * 1000,
    ).toISOString();

    return {
      kind: "ok",
      value: {
        requirements: requirements as unknown as Readonly<Record<string, unknown>>,
        expires_at: expiresAt,
        rail_metadata: {
          offer_validity_seconds: opts.offerValiditySeconds,
          redeem_window_seconds: opts.redeemWindowSeconds,
          dispute_window_seconds: opts.disputeWindowSeconds,
          resolution_window_seconds: opts.resolutionWindowSeconds,
          max_timeout_seconds: opts.maxTimeoutSeconds,
          // The host server serves the canonical bytes at `metadata_uri`; they hash
          // to `metadata_hash` (= on-chain offer.metadataHash). Emitted so the
          // host can pin/index the document; `metadata` is the full BPIP-1 BASE
          // document for inspection/audit.
          metadata_uri: metadata.metadataUri,
          metadata_hash: metadata.metadataHash,
          metadata: metadata.metadata,
          // Advisory redeem-timing preference. The agent reads this to decide
          // WHEN to submit `capture` (= the buyer's redeem): now, or after it
          // confirms delivery. "deferred" keeps the dispute window from opening
          // before the goods ship.
          redeem_policy: opts.redeemPolicy,
        },
      },
    };
  }

  // ─── handle_webhook ─────────────────────────────────────────────────────────
  //
  // Boson exchange-state webhooks (delivered by the host's webhook sink).
  // Maps the final-release + dispute transitions onto WebhookOutcome so the
  // the host server can advance the order row. The buyer-completes / timeout path
  // (REDEEMED → COMPLETED, funds RELEASED to the seller) surfaces as
  // settlement_confirmed.
  //
  // Signature verification: when `merchant_config.webhook_secret` is set the
  // adapter verifies an HMAC-SHA256 over the raw body (accepting the current
  // OR the previous secret, so a secret rotates with no downtime) and rejects
  // anything that does not match — every rejection is logged with the trace
  // id. When NO secret is configured the behaviour depends on
  // `requireWebhookSignature` (constructor): the default (true) REFUSES the
  // webhook UNAUTHORIZED (fail closed — secure for third-party reuse); set
  // false (the Facet Terminal does) only when the host already verified the
  // signature at its own route and delegates with an empty merchant_config, in
  // which case the parsed body is trusted as already-verified.

  async handleWebhook(input: WebhookRequest): Promise<RailAdapterResult<WebhookOutcome>> {
    // Lenient by default: when no webhook secret is configured the adapter
    // trusts the parsed body (back-compat for a host — the host server —
    // that verifies the signature at its OWN webhook route before delegating
    // with an empty merchant_config). Only when a secret is actually present
    // do we enforce the full merchant_config + verify the signature; reading
    // the config unconditionally here would 4xx every webhook the live
    // handler delegates with merchant_config: {}.
    const secrets = webhookSecrets(input.merchant_config);
    if (secrets.length > 0) {
      const sigHeader = firstHeader(input.headers, [
        "x-boson-signature",
        "x-webhook-signature",
        "boson-signature",
      ]);
      if (sigHeader === null) {
        this.rejectWebhook(
          input,
          "missing_signature_header",
          "no webhook signature header present",
        );
        return makeError(
          "UNAUTHORIZED",
          "Boson webhook signature header is missing",
          false,
          "signature_verification_failed",
        );
      }
      const rawBody = decodeRawBody(input.raw_body);
      const verified = await verifyVersionedWebhookSignature(
        secrets,
        rawBody,
        sigHeader,
        this.now(),
      );
      if (!verified) {
        this.rejectWebhook(
          input,
          "signature_mismatch",
          "signature did not match any configured secret",
        );
        return makeError(
          "UNAUTHORIZED",
          "Boson webhook signature verification failed",
          false,
          "signature_verification_failed",
        );
      }
    } else if (this.requireWebhookSignature) {
      // No webhook secret is configured AND we are in the secure-default mode:
      // we have no key to verify against, so we REFUSE to act on the body rather
      // than trust an unauthenticated webhook. A host that verifies the signature
      // at its OWN webhook route delegates with an empty merchant_config and sets
      // requireWebhookSignature:false to opt into the lenient path below.
      this.rejectWebhook(
        input,
        "missing_signature_header",
        "no webhook_secret configured and requireWebhookSignature is set — refusing to trust an unverified webhook",
      );
      return makeError(
        "UNAUTHORIZED",
        "Boson webhook cannot be verified: no webhook_secret configured (requireWebhookSignature is set)",
        false,
        "signature_verification_failed",
      );
    }

    return { kind: "ok", value: mapWebhookOutcome(input, this.now()) };
  }

  /** Emit a structured rejection record (with the trace id) and never let a
   *  logger throw bubble into the request path. */
  private rejectWebhook(
    input: WebhookRequest,
    reason: WebhookRejection["reason"],
    detail: string,
  ): void {
    try {
      this.logWebhookRejection({
        rail: this.metadata.id,
        trace_id: input.ctx.trace_id,
        merchant_id: input.ctx.merchant_id,
        site_id: input.ctx.site_id,
        reason,
        detail,
      });
    } catch {
      // a misbehaving logger must not turn a rejected webhook into a 500
    }
  }

  // ─── internal ───────────────────────────────────────────────────────────────

  /** Build a per-merchant `X402bServer`. Validates the merchant facilitator
   *  URL against the egress allowlist, requires the injected
   *  ExchangeReader for the write handlers, and wires the persistent
   *  stores. */
  private buildServer(
    cfg: BosonMerchantConfig,
  ): { kind: "ok"; server: X402bServer } | { kind: "error"; error: RailAdapterResult<never> } {
    // Defense in depth: a per-merchant facilitator that escapes the
    // declared egress allowlist must not be silently dialed.
    const facilitatorOrigin = safeOrigin(cfg.facilitatorUrl);
    if (facilitatorOrigin === null || !this.metadata.egress_allowlist.includes(facilitatorOrigin)) {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          `merchant_config.facilitatorUrl origin is not in the adapter egress allowlist`,
        ),
      };
    }

    if (this.exchangeReaderFactory === undefined) {
      return {
        kind: "error",
        error: errResult(
          "INTERNAL_ERROR",
          "Boson rail not fully configured: no ExchangeReader factory wired (post-settle state verification is mandatory)",
        ),
      };
    }

    const optionStore =
      this.stores?.exchangeFulfillmentOptionStore ??
      mapAsStore(new Map<string, readonly string[]>());
    const recoveryStore =
      this.stores?.fulfillmentRecoveryStore ??
      mapAsStore(new Map<string, FulfillmentRecoveryEntry>());

    const serverConfig: X402bServerConfig = {
      network: cfg.network,
      chainId: cfg.chainId,
      escrow: cfg.escrow,
      signer: cfg.signer,
      facilitator: { url: cfg.facilitatorUrl },
      // No server-channel endpoints: buyers reach this rail through the
      // the host server, not Boson HTTP routes. nextActions still advertise
      // the facilitator + on-chain fallbacks so the buyer can act directly
      // if needed. escrow must match config.escrow (asserted by the SDK).
      channelRegistry: { channels: ["facilitator", "onchain"], escrow: cfg.escrow },
      exchangeReader: this.exchangeReaderFactory(cfg),
      exchangeFulfillmentOptionStore: optionStore,
      fulfillmentRecoveryStore: recoveryStore,
      mode: this.mode,
      ...(cfg.subgraphUrl !== undefined ? { subgraphUrl: cfg.subgraphUrl } : {}),
    };

    try {
      return { kind: "ok", server: createX402bServer(serverConfig) };
    } catch (e) {
      return {
        kind: "error",
        error: errResult("INTERNAL_ERROR", `Boson server construction failed: ${asMessage(e)}`),
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — kept in this file so the adapter is one self-contained unit.
// ─────────────────────────────────────────────────────────────────────────────

type ErrCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "SETTLEMENT_FAILED"
  | "METHOD_NOT_ALLOWED"
  | "CAPABILITY_NOT_GRANTED"
  | "INTERNAL_ERROR";

function errResult<T>(code: ErrCode, message: string): RailAdapterResult<T> {
  return { kind: "error", code, message, retryable: false };
}

function makeError<T>(
  code: ErrCode,
  message: string,
  retryable: boolean,
  nativeCode: string | null | undefined,
): RailAdapterResult<T> {
  return nativeCode
    ? { kind: "error", code, message, retryable, native_code: nativeCode }
    : { kind: "error", code, message, retryable };
}

interface MerchantConfigOk {
  readonly kind: "ok";
  readonly value: BosonMerchantConfig;
}
interface MerchantConfigError {
  readonly kind: "error";
  readonly error: RailAdapterResult<never>;
}

function readMerchantConfig(cfg: MerchantConfig): MerchantConfigOk | MerchantConfigError {
  const network = cfg.network;
  const chainId = cfg.chainId;
  const escrow = cfg.escrow;
  const sellerId = cfg.sellerId;
  const disputeResolverId = cfg.disputeResolverId;
  const asset = cfg.asset;
  const facilitatorUrl = cfg.facilitatorUrl;
  const signer = cfg.signer as unknown;

  if (typeof network !== "string" || network === "") {
    return cfgErr("merchant_config.network (CAIP-2, e.g. eip155:84532) is required");
  }
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
    return cfgErr("merchant_config.chainId (integer) is required");
  }
  if (!isAddress(escrow)) return cfgErr("merchant_config.escrow (Diamond address) is required");
  if (typeof sellerId !== "string" || sellerId === "") {
    return cfgErr("merchant_config.sellerId is required");
  }
  if (typeof disputeResolverId !== "string" || disputeResolverId === "") {
    return cfgErr("merchant_config.disputeResolverId is required");
  }
  if (!isAddress(asset)) return cfgErr("merchant_config.asset (ERC-20 address) is required");
  if (typeof facilitatorUrl !== "string" || safeOrigin(facilitatorUrl) === null) {
    return cfgErr("merchant_config.facilitatorUrl (http[s] URL) is required");
  }
  if (!isSellerSigner(signer)) {
    return cfgErr(
      "merchant_config.signer must be a SellerSigner ({ address, signTypedData }) hydrated by the host server",
    );
  }

  const subgraphUrl = typeof cfg.subgraphUrl === "string" ? cfg.subgraphUrl : undefined;
  const webhookSecret = typeof cfg.webhook_secret === "string" ? cfg.webhook_secret : undefined;
  const webhookSecretPrevious =
    typeof cfg.webhook_secret_previous === "string" ? cfg.webhook_secret_previous : undefined;
  return {
    kind: "ok",
    value: {
      network,
      chainId,
      escrow,
      sellerId,
      disputeResolverId,
      asset,
      facilitatorUrl,
      signer,
      ...(subgraphUrl !== undefined ? { subgraphUrl } : {}),
      ...(webhookSecret !== undefined ? { webhook_secret: webhookSecret } : {}),
      ...(webhookSecretPrevious !== undefined
        ? { webhook_secret_previous: webhookSecretPrevious }
        : {}),
    },
  };
}

function cfgErr(message: string): MerchantConfigError {
  return { kind: "error", error: errResult("INVALID_REQUEST", message) };
}

/** Bind buyer-echoed requirements to THIS merchant. Returns an error
 *  result on any mismatch, or null when the requirements are ours. */
function gateRequirements(
  req: EscrowPaymentRequirements,
  cfg: BosonMerchantConfig,
  amountAtomic: number,
): RailAdapterResult<never> | null {
  if (!eqAddress(req.offer.creator, cfg.signer.address)) {
    return makeError(
      "UNAUTHORIZED",
      `requirements.offer.creator (${req.offer.creator}) is not this merchant's seller signer`,
      false,
      "offer_creator_mismatch",
    );
  }
  if (!eqAddress(req.escrowAddress, cfg.escrow)) {
    return makeError(
      "UNAUTHORIZED",
      `requirements.escrowAddress does not match merchant escrow Diamond`,
      false,
      "escrow_mismatch",
    );
  }
  if (!eqAddress(req.asset, cfg.asset)) {
    return makeError(
      "UNAUTHORIZED",
      `requirements.asset does not match merchant asset`,
      false,
      "asset_mismatch",
    );
  }
  if (req.network !== cfg.network) {
    return errResult(
      "INVALID_REQUEST",
      `requirements.network (${req.network}) does not match merchant network (${cfg.network})`,
    );
  }
  if (req.recipientId !== cfg.sellerId) {
    return makeError(
      "UNAUTHORIZED",
      `requirements.recipientId does not match merchant sellerId`,
      false,
      "seller_mismatch",
    );
  }
  if (req.amount !== String(amountAtomic)) {
    return errResult(
      "INVALID_REQUEST",
      `requirements.amount (${req.amount}) does not match requested amount (${amountAtomic})`,
    );
  }
  return null;
}

/** Map a Boson `HandlerErrorBody` + HTTP status onto a Facet result. */
function mapHandlerError(
  body: HandlerErrorBody,
  status: number,
  op: string,
): RailAdapterResult<never> {
  // 402/409/404/400 are client-actionable (bad/insufficient payment,
  // wrong state, unknown exchange, malformed) — non-retryable. 5xx /
  // facilitator (502) are transient — retryable.
  const retryable = status >= 500;
  const code: ErrCode =
    status === 402 || status === 409
      ? "SETTLEMENT_FAILED"
      : status === 404
        ? "NOT_FOUND"
        : status === 400
          ? "INVALID_REQUEST"
          : "SETTLEMENT_FAILED";
  return makeError(
    code,
    `Boson ${op} rejected (${status}/${body.code}): ${body.reason}`,
    retryable,
    body.code,
  );
}

/** Attach Boson escrow_state (+ tx hash) as rail_metadata so the host server
 *  can thread it into the signed receipt envelope + dispatch log. */
function withRailMetadata<T extends object>(
  value: T,
  nextActions: EscrowNextActions,
  txHash: string,
): T & { readonly rail_metadata: Readonly<Record<string, unknown>> } {
  return {
    ...value,
    rail_metadata: {
      escrow_state: escrowStateView(nextActions),
      tx_hash: txHash,
    },
  };
}

/** The receipt/audit view of escrow state — the three EscrowNextActions
 *  fields the plan threads into the signed receipt envelope. */
function escrowStateView(na: EscrowNextActions): Readonly<Record<string, unknown>> {
  const disputeState = (na as { disputeState?: unknown }).disputeState;
  return {
    exchange_id: na.exchangeId,
    exchange_state: na.exchangeState,
    dispute_state: disputeState !== undefined ? disputeState : null,
  };
}

/** Redeem-window deadline for `reserved_until`. Prefer the on-chain
 *  redeem action's advertised deadline; fall back to the offer's
 *  maxTimeoutSeconds-derived bound. */
function redeemDeadline(req: EscrowPaymentRequirements, na: EscrowNextActions): string | null {
  const redeem = na.next.find((a) => a.id === "boson-redeem");
  if (redeem?.deadline !== undefined) return redeem.deadline;
  if (req.maxTimeoutSeconds > 0) {
    return new Date(Date.now() + req.maxTimeoutSeconds * 1000).toISOString();
  }
  return null;
}

// ─── quote / offer-template helpers (build_requirements) ──────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

interface QuoteOptions {
  readonly offerValiditySeconds: number;
  readonly redeemWindowSeconds: number;
  readonly disputeWindowSeconds: number;
  readonly resolutionWindowSeconds: number;
  readonly maxTimeoutSeconds: number;
  readonly quantity: string;
  readonly tokenAuthStrategies: readonly TokenAuthStrategy[];
  /** Max protocol+agent fee the seller tolerates, in bps of price → feeLimit.
   *  Default DEFAULT_FEE_LIMIT_BPS. */
  readonly feeLimitBps: number;
  /** Seller deposit in atomic units → offer.sellerDeposit. Default "0". A
   *  non-zero value gives the seller skin in the fair-exchange game; the
   *  protocol holds it in escrow alongside the buyer's price. */
  readonly sellerDeposit: string;
  /** Boson protocol agent id → offer.agentId. Default "0". When the merchant
   *  is registered as a Boson agent, this captures the agent-fee rev-share the
   *  partnership exposes. */
  readonly agentId: string;
  /** Product facts used to build the BPIP-1 offer metadata. */
  readonly product: OfferProductInfo | undefined;
  /** Public base origin the metadata serve route lives on. */
  readonly metadataBaseUri: string;
  /** Merchant's advisory redeem-timing preference, surfaced to the agent in the
   *  quote. "immediate" (default) = redeem right after commit; "deferred" = the
   *  agent should HOLD its signed redeem and submit `capture` only AFTER it
   *  confirms delivery, so Boson's dispute window starts post-fulfillment instead
   *  of pre-shipment. This is advisory: redeem is buyer-authorized and the
   *  host server accepts the buyer's signed redeem via `capture` at ANY time
   *  (commit and redeem are separate steps), so the agent already controls
   *  timing — this field communicates what the merchant prefers. */
  readonly redeemPolicy: "immediate" | "deferred";
}

/** Read per-quote window options with wide, protocol-safe defaults. The
 *  host server passes a per-quote dispute window in
 *  `options.dispute_window_seconds`; everything else defaults to the x402B
 *  example's wide windows. */
function readQuoteOptions(o: Readonly<Record<string, unknown>> | undefined): QuoteOptions {
  const num = (k: string, d: number): number => {
    const v = o?.[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
  };
  const strategies = Array.isArray(o?.["token_auth_strategies"])
    ? (o["token_auth_strategies"] as unknown[]).filter(
        (s): s is TokenAuthStrategy =>
          s === "none" || s === "erc3009" || s === "permit" || s === "permit2",
      )
    : [];
  const quantityRaw = o?.["quantity"];
  return {
    offerValiditySeconds: num("offer_validity_seconds", THIRTY_DAYS_S),
    redeemWindowSeconds: num("redeem_window_seconds", THIRTY_DAYS_S),
    disputeWindowSeconds: num("dispute_window_seconds", SEVEN_DAYS_S),
    resolutionWindowSeconds: num("resolution_window_seconds", SEVEN_DAYS_S),
    maxTimeoutSeconds: num("max_timeout_seconds", 3600),
    quantity:
      typeof quantityRaw === "number" && Number.isInteger(quantityRaw) && quantityRaw > 0
        ? String(quantityRaw)
        : "1",
    tokenAuthStrategies: strategies.length > 0 ? strategies : ["erc3009"],
    feeLimitBps: num("fee_limit_bps", DEFAULT_FEE_LIMIT_BPS),
    sellerDeposit: atomicString(o?.["seller_deposit_atomic"]),
    agentId: atomicString(o?.["agent_id"]),
    product: readProductInfo(o?.["product"]),
    metadataBaseUri: readBaseUri(o?.["metadata_base_uri"]),
    redeemPolicy: o?.["redeem_policy"] === "deferred" ? "deferred" : "immediate",
  };
}

/** Coerce an atomic-unit option (string or non-negative integer) to a decimal
 *  string; anything else → "0". Used for sellerDeposit + agentId. */
function atomicString(v: unknown): string {
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v);
  return "0";
}

/** Resolve the metadata serve-route base origin from options, falling back to
 *  the default host server. A non-http(s) / unparseable value is ignored. */
function readBaseUri(v: unknown): string {
  if (typeof v === "string" && safeOrigin(v) !== null) return v;
  return DEFAULT_METADATA_BASE_URI;
}

/** Read the optional product facts the host server threads for metadata. Tolerant:
 *  every field is optional and silently dropped if the wrong type. Builds the
 *  object mutably (each value bound once) so it satisfies
 *  exactOptionalPropertyTypes without re-narrowing. */
function readProductInfo(v: unknown): OfferProductInfo | undefined {
  if (!isRecord(v)) return undefined;
  const str = (k: string): string | undefined =>
    typeof v[k] === "string" && v[k] !== "" ? (v[k] as string) : undefined;
  const strArr = (k: string): readonly string[] | undefined => {
    const raw = v[k];
    if (!Array.isArray(raw)) return undefined;
    return (raw as unknown[]).filter((x): x is string => typeof x === "string");
  };
  const info: {
    -readonly [K in keyof OfferProductInfo]: OfferProductInfo[K];
  } = {};
  const id = str("id");
  if (id !== undefined) info.id = id;
  const name = str("name");
  if (name !== undefined) info.name = name;
  const description = str("description");
  if (description !== undefined) info.description = description;
  const category = str("category");
  if (category !== undefined) info.category = category;
  const origin = str("origin");
  if (origin !== undefined) info.origin = origin;
  const htsCode = str("hts_code");
  if (htsCode !== undefined) info.htsCode = htsCode;
  const allergens = strArr("allergens");
  if (allergens !== undefined) info.allergens = allergens;
  const tags = strArr("tags");
  if (tags !== undefined) info.tags = tags;
  const image = str("image");
  if (image !== undefined) info.image = image;
  const externalUrl = str("external_url");
  if (externalUrl !== undefined) info.externalUrl = externalUrl;
  return info;
}

/** Compute `offer.feeLimit` from price + a bps ceiling. The protocol enforces
 *  `fee <= feeLimit` at commit; we set the ceiling to a small multiple of the
 *  real fee, not the whole price. Rounds UP so a fee at exactly the bps never
 *  trips the limit, and floors at 1 atomic unit for a non-zero price. */
function computeFeeLimit(priceAtomic: string, feeLimitBps: number): string {
  const price = BigInt(priceAtomic);
  const bps = BigInt(Math.max(0, Math.floor(feeLimitBps)));
  const limit = (price * bps + 9999n) / 10000n; // ceil(price * bps / 10000)
  if (price > 0n && limit === 0n) return "1";
  return limit.toString();
}

/** Build an `UnsignedFullOffer` from merchant_config + the quote windows + the
 *  pre-built BPIP-1 metadata. Mirrors the x402B resource-server example's
 *  BPIP-10 FullOffer template. All `*InMS` fields are milliseconds (core-sdk
 *  wire convention). Per-offer uniqueness comes from the metadata's `offerNonce`
 *  (folded into metadataUri/Hash), so every quote produces a distinct offer. */
function buildUnsignedOffer(
  cfg: BosonMerchantConfig,
  priceAtomic: string,
  opts: QuoteOptions,
  nowMs: number,
  metadata: BuiltOfferMetadata,
): UnsignedFullOffer {
  const oneDayMs = 24 * 60 * 60 * 1000;
  return {
    price: priceAtomic,
    // Non-zero sellerDeposit gives the seller stake in the fair-exchange game;
    // the protocol holds it in escrow alongside the buyer's price.
    sellerDeposit: opts.sellerDeposit,
    // When the merchant is a registered Boson agent, agentId captures the
    // agent-fee rev-share; defaults to "0" (no agent fee).
    agentId: opts.agentId,
    buyerCancelPenalty: "0",
    quantityAvailable: opts.quantity,
    validFromDateInMS: String(nowMs - oneDayMs),
    validUntilDateInMS: String(nowMs + opts.offerValiditySeconds * 1000),
    voucherRedeemableFromDateInMS: String(nowMs - oneDayMs),
    voucherRedeemableUntilDateInMS: String(nowMs + opts.redeemWindowSeconds * 1000),
    disputePeriodDurationInMS: String(opts.disputeWindowSeconds * 1000),
    voucherValidDurationInMS: "0",
    resolutionPeriodDurationInMS: String(opts.resolutionWindowSeconds * 1000),
    exchangeToken: cfg.asset,
    disputeResolverId: cfg.disputeResolverId,
    // Resolvable BPIP-1 URI + real keccak-256 hash over the served bytes.
    metadataUri: metadata.metadataUri,
    metadataHash: metadata.metadataHash,
    collectionIndex: "0",
    // Fee ceiling = small bps of price, protecting the seller from protocol fee
    // governance changes between offer-sign and commit.
    feeLimit: computeFeeLimit(priceAtomic, opts.feeLimitBps),
    offerCreator: cfg.signer.address,
    committer: ZERO_ADDRESS,
    condition: {
      method: 0,
      tokenType: 0,
      tokenAddress: ZERO_ADDRESS,
      gatingType: 0,
      minTokenId: "0",
      threshold: "0",
      maxCommits: "0",
      maxTokenId: "0",
    },
    useDepositedFunds: false,
    sellerId: cfg.sellerId,
    buyerId: "0",
    sellerOfferParams: {
      collectionIndex: "0",
      royaltyInfo: { recipients: [], bps: [] },
      mutualizerAddress: ZERO_ADDRESS,
    },
  } satisfies UnsignedFullOffer;
}

type DisputeKind = "raise" | "resolve" | "retract" | "escalate";

function resolveDisputeKind(input: DisputeInput): DisputeKind {
  const explicit = readString(input.evidence ?? null, "boson_action");
  if (
    explicit === "raise" ||
    explicit === "resolve" ||
    explicit === "retract" ||
    explicit === "escalate"
  ) {
    return explicit;
  }
  // action "challenge" → open/raise the dispute; "accept" → retract it.
  return input.action === "challenge" ? "raise" : "retract";
}

/** Whether the on-chain snapshot shows the given dispute sub-action LANDED — used to
 *  recover a 502/STATE_VERIFY_ subgraph-lag false-fail. `raise` moves the EXCHANGE to
 *  DISPUTED; `resolve`/`retract`/`escalate` move the DISPUTE sub-state (the exchange
 *  stays DISPUTED), so each matches the field that actually changes. Comparisons are
 *  case-insensitive (the reader emits SDK enum values like "Resolved"/"RESOLVED"). */
function disputeLanded(
  kind: DisputeKind,
  snapshot: NonNullable<Awaited<ReturnType<ExchangeReader["read"]>>>,
): boolean {
  const exchangeUpper = String(snapshot.state).toUpperCase();
  const disputeUpper =
    snapshot.disputeState !== undefined && snapshot.disputeState !== null
      ? String(snapshot.disputeState).toUpperCase()
      : null;
  switch (kind) {
    case "raise":
      return exchangeUpper === "DISPUTED";
    case "resolve":
      return disputeUpper === "RESOLVED";
    case "retract":
      return disputeUpper === "RETRACTED";
    case "escalate":
      return disputeUpper === "ESCALATED";
  }
}

function disputeStatusFor(kind: DisputeKind): DisputeOk["status"] {
  switch (kind) {
    case "raise":
    case "escalate":
      return "open";
    case "resolve":
      return "won";
    case "retract":
      return "withdrawn";
  }
}

/** Best-effort Boson webhook → WebhookOutcome mapper. Boson webhook bodies
 *  carry the exchange id + the post-transition state; the host's webhook
 *  sink delivers them. Unknown shapes map to `ignored` so an unrecognised
 *  event never crashes dispatch. NOTE: signature verification of the
 *  inbound webhook is the host server's rail-native webhook route's job (it
 *  holds the shared secret); this mapper trusts the parsed body. */
function mapWebhookOutcome(input: WebhookRequest, nowMs: number): WebhookOutcome {
  const body = input.parsed_body;
  if (body === null) return { kind: "ignored", reason: "webhook body not parsed as JSON" };

  const exchangeId = firstString(body, ["exchangeId", "exchange_id"]);
  const exchangeState = firstString(body, ["exchangeState", "exchange_state", "state"]);
  const disputeState = firstString(body, ["disputeState", "dispute_state"]);
  const at = firstString(body, ["timestamp", "at", "occurredAt"]) ?? new Date(nowMs).toISOString();
  if (exchangeId === null) return { kind: "ignored", reason: "webhook missing exchangeId" };

  // Final release: the buyer completed (or the dispute window lapsed) and
  // funds are RELEASED to the seller's availableFunds. Surfaced as
  // settlement_confirmed — the order's money is now the merchant's.
  if (matches(exchangeState, ["COMPLETED", "RELEASED", "FINALIZED"])) {
    return { kind: "settlement_confirmed", settlement_id: exchangeId, confirmed_at: at };
  }
  if (matches(exchangeState, ["REVOKED", "CANCELLED", "CANCELED"])) {
    return {
      kind: "refund_completed",
      refund_id: exchangeId,
      settlement_id: exchangeId,
      refunded_at: at,
    };
  }
  if (
    matches(exchangeState, ["DISPUTED"]) &&
    !matches(disputeState, ["RESOLVED", "RETRACTED", "DECIDED", "REFUSED"])
  ) {
    return {
      kind: "dispute_opened",
      dispute_id: exchangeId,
      settlement_id: exchangeId,
      opened_at: at,
      amount: { amount: 0, currency: "USDC" },
      reason_code: disputeState ?? "DISPUTED",
    };
  }
  if (matches(disputeState, ["RESOLVED", "RETRACTED", "DECIDED", "REFUSED"])) {
    return {
      kind: "dispute_resolved",
      dispute_id: exchangeId,
      resolution: matches(disputeState, ["RETRACTED"]) ? "withdrawn" : "won",
      resolved_at: at,
    };
  }
  return { kind: "ignored", reason: `unmapped exchangeState=${exchangeState ?? "?"}` };
}

// ─── webhook signature verification (versioned secret + rejection logging) ────

/** Default rejection sink: a single structured `console.warn` line so a
 *  rejected webhook is never silently dropped even when the host does not
 *  inject its own logger. Never logs the secret or the raw body. */
const defaultWebhookRejectionLogger: WebhookRejectionLogger = (rejection) => {
  console.warn(JSON.stringify({ event: "webhook_signature_rejected", ...rejection }));
};

/** The configured webhook secrets, current first, in the order they should be
 *  tried. Empty when verification is not enabled for this merchant. Reads the
 *  RAW merchant_config (not the fully-parsed BosonMerchantConfig) so the
 *  no-secret back-compat path never requires a complete config — the live
 *  handler delegates with merchant_config: {} after verifying at its own route. */
function webhookSecrets(cfg: MerchantConfig): readonly string[] {
  const out: string[] = [];
  const current = cfg.webhook_secret;
  const previous = cfg.webhook_secret_previous;
  if (typeof current === "string" && current !== "") out.push(current);
  if (typeof previous === "string" && previous !== "") out.push(previous);
  return out;
}

/** First present, non-empty header among `names` (case-insensitive on the
 *  lookup keys — the host server lower-cases header names before delegating). */
function firstHeader(
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): string | null {
  for (const n of names) {
    const v = headers[n] ?? headers[n.toLowerCase()];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** Decode the raw webhook body bytes to the UTF-8 string the HMAC was
 *  computed over. */
function decodeRawBody(raw: Uint8Array): string {
  return new TextDecoder().decode(raw);
}

/** Max clock skew tolerated on a Stripe-style `t=,v1=` webhook signature, in
 *  milliseconds (300s, matching Stripe's default). A `t=` outside this window
 *  is rejected as a replay even when the HMAC is valid. */
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 300_000;

/** Verify a Boson webhook HMAC against the current OR previous secret.
 *  Accepts a Stripe-style `t=<unix-seconds>,v1=<hex>` signature (signed
 *  material `${t}.${rawBody}`) or a plain hex HMAC over the raw body
 *  (optional `sha256=` prefix). For the `t=,v1=` form the timestamp must be
 *  within ±300s of `nowMs` (Stripe-style replay protection) — a stale or
 *  future-dated `t` is rejected even if the HMAC matches. Constant-time on
 *  each hex compare; fails closed. Returns true as soon as any secret
 *  matches. */
async function verifyVersionedWebhookSignature(
  secrets: readonly string[],
  rawBody: string,
  sigHeader: string,
  nowMs: number,
): Promise<boolean> {
  if (sigHeader === "") return false;
  const tv1 = sigHeader.match(/(?:^|,)\s*t=(\d{1,15})\s*,\s*v1=([0-9a-fA-F]+)/);
  if (tv1 !== null) {
    // Reject a stale/future `t=` before doing any HMAC work — bounds replay
    // of an old (but validly-signed) webhook to a 300s window.
    const tMs = Number(tv1[1]) * 1000;
    if (Math.abs(nowMs - tMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) return false;
    for (const secret of secrets) {
      if (await verifyHmacSha256Hex(secret, `${Number(tv1[1])}.${rawBody}`, tv1[2]!)) return true;
    }
    return false;
  }
  for (const secret of secrets) {
    if (await verifyHmacSha256Hex(secret, rawBody, sigHeader)) return true;
  }
  return false;
}

/** HMAC-SHA256 (hex) verification of a raw webhook body, constant-time on the
 *  hex compare. Accepts an optional `sha256=` prefix. */
async function verifyHmacSha256Hex(
  secret: string,
  body: string,
  providedHex: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    hmacBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, hmacBytes(body)));
  const expected = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const provided = providedHex
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/** TextEncoder.encode → ArrayBuffer-backed Uint8Array (TS BufferSource fit). */
function hmacBytes(s: string): Uint8Array<ArrayBuffer> {
  const raw = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(raw.byteLength);
  const out = new Uint8Array(buf);
  out.set(raw);
  return out;
}

// ─── small typed readers (no `any`, exactOptionalPropertyTypes-safe) ──────────

function readAuthority(input: CaptureInput): Readonly<Record<string, unknown>> | null {
  const a = (input as { authority?: unknown }).authority;
  return isRecord(a) ? a : null;
}

function readString(rec: Readonly<Record<string, unknown>> | null, key: string): string | null {
  if (rec === null) return null;
  const v = rec[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function readHex(rec: Readonly<Record<string, unknown>> | null, key: string): `0x${string}` | null {
  const v = readString(rec, key);
  return v !== null && /^0x[0-9a-fA-F]*$/.test(v) ? (v as `0x${string}`) : null;
}

function readUnknown(rec: Readonly<Record<string, unknown>>, key: string): unknown {
  return rec[key];
}

function readFulfillment(
  rec: Readonly<Record<string, unknown>> | null,
): { option: string; data: Record<string, unknown> | null } | null {
  if (rec === null) return null;
  const f = rec["fulfillment"];
  if (!isRecord(f)) return null;
  const option = typeof f["option"] === "string" ? (f["option"] as string) : null;
  if (option === null) return null;
  const data = isRecord(f["data"]) ? (f["data"] as Record<string, unknown>) : null;
  return { option, data };
}

function firstString(
  rec: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

function matches(value: string | null, candidates: readonly string[]): boolean {
  if (value === null) return false;
  const up = value.toUpperCase();
  return candidates.some((c) => c.toUpperCase() === up);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function eqAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isSellerSigner(v: unknown): v is SellerSigner {
  if (!isRecord(v)) return false;
  return typeof v["address"] === "string" && typeof v["signTypedData"] === "function";
}

function safeOrigin(u: string | undefined): string | null {
  if (typeof u !== "string" || u === "") return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── opaque authority handle (commit header + requirements) ───────────────────

interface BosonAuthorityHandle {
  readonly x_payment: string;
  readonly requirements: EscrowPaymentRequirements;
}

const HANDLE_PREFIX = "bosonv1:";

function encodeHandle(h: BosonAuthorityHandle): string {
  // btoa over UTF-8-escaped JSON — the handle is opaque to the host server,
  // which stores it on the order row and re-presents it at reserve time.
  // btoa/atob are available across the adapter's runtimes (Deno,
  // Node/vitest tests).
  return HANDLE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(h))));
}

function decodeHandle(handle: string): BosonAuthorityHandle | null {
  if (!handle.startsWith(HANDLE_PREFIX)) return null;
  try {
    const json = decodeURIComponent(escape(atob(handle.slice(HANDLE_PREFIX.length))));
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed)) return null;
    const xPayment =
      typeof parsed["x_payment"] === "string" ? (parsed["x_payment"] as string) : null;
    if (xPayment === null) return null;
    const requirements = parseEscrowPaymentRequirements(parsed["requirements"]);
    return { x_payment: xPayment, requirements };
  } catch {
    return null;
  }
}
