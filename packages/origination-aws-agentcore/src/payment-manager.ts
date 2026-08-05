// PaymentManager — TypeScript port of the canonical Python class from the
// AgentCore SDK (github.com/aws/bedrock-agentcore-sdk-python). Wraps the AWS
// SDK JS `@aws-sdk/client-bedrock-agentcore` client with the same
// workflow logic the Python SDK provides: auto-inject paymentManagerArn
// on every data-plane call, agent-name header on every request, optional
// bearer-token auth override, plus the orchestrated `generatePaymentHeader`
// flow that produces an x402 `X-PAYMENT` header from a 402 challenge.
//
// Spec fidelity: every method here mirrors a Python method on the
// upstream `PaymentManager` class. Method signatures use camelCase
// (TS idiom) where Python used snake_case, but argument names, semantics,
// and request shapes match 1:1. When the upstream SDK adds a method,
// add the same one here.
//
// Why this matters for Facet: AgentCore Payments produces an x402
// X-PAYMENT header that the merchant's Terminal verifies via the
// `X402CoinbaseAdapter` in `packages/payment-adapter-x402-coinbase/`.
// PaymentManager is the agent-side counterpart — Facet customers who run
// agents (not just merchants) can use this directly, and Facet's own
// agent-provisioning surface can call it when minting AgentCore-backed
// agents.

import {
  type BedrockAgentCoreClient,
  type BlockchainChainId,
  type CreatePaymentInstrumentCommandOutput,
  type CreatePaymentSessionCommandOutput,
  type CryptoX402PaymentInput,
  type CryptoX402PaymentOutput,
  type DeletePaymentInstrumentCommandOutput,
  type InstrumentBalanceToken,
  type DeletePaymentSessionCommandOutput,
  type GetPaymentInstrumentBalanceCommandOutput,
  type GetPaymentInstrumentCommandOutput,
  type GetPaymentSessionCommandOutput,
  type ListPaymentInstrumentsCommandOutput,
  type ListPaymentSessionsCommandOutput,
  type PaymentInput,
  type PaymentInstrument,
  type PaymentInstrumentDetails,
  type PaymentInstrumentSummary,
  type PaymentInstrumentType,
  type PaymentSession,
  type ProcessPaymentCommandOutput,
  type SessionLimits,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  CreatePaymentInstrumentCommand,
  CreatePaymentSessionCommand,
  DeletePaymentInstrumentCommand,
  DeletePaymentSessionCommand,
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  GetPaymentSessionCommand,
  ListPaymentInstrumentsCommand,
  ListPaymentSessionsCommand,
  ProcessPaymentCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_MAX_RESULTS,
  ETHEREUM_NETWORKS,
  NETWORK_PREFERENCES,
  SOLANA_NETWORKS,
} from "./constants.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Errors — mirror the Python SDK's exception class hierarchy. Keep these
// 1:1 so any code that translates errors across runtimes can switch on
// the same `name`/class identity.
// ─────────────────────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentError";
  }
}
export class PaymentInstrumentNotFound extends PaymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentInstrumentNotFound";
  }
}
export class PaymentSessionNotFound extends PaymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentSessionNotFound";
  }
}
export class InvalidPaymentInstrument extends PaymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPaymentInstrument";
  }
}
export class InsufficientBudget extends PaymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InsufficientBudget";
  }
}
export class PaymentSessionExpired extends PaymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentSessionExpired";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public input shapes — narrowed versions of the SDK's `Request` types
// that omit the per-request boilerplate (paymentManagerArn,
// agentName, clientToken). The manager injects all three automatically.
// ─────────────────────────────────────────────────────────────────────────────

/** Constructor options. `client` is the already-built AWS SDK JS client,
 *  passed in for testability (callers can inject a mock). `paymentManagerArn`
 *  is required — mirrors the Python constructor's mandatory positional. */
export interface PaymentManagerOptions {
  readonly paymentManagerArn: string;
  readonly client: BedrockAgentCoreClient;
  /** Forwarded as `X-Amzn-Bedrock-AgentCore-Payments-Agent-Name` on every
   *  data-plane call. Used for AWS-side observability. */
  readonly agentName?: string;
  /** Optional clientToken generator. Defaults to `crypto.randomUUID()`.
   *  Tests can pass a deterministic generator. */
  readonly clientTokenFactory?: () => string;
}

export interface CreatePaymentInstrumentInput {
  readonly paymentConnectorId: string;
  /** AWS-defined string-literal union (currently just `"EMBEDDED_CRYPTO_WALLET"`).
   *  Imported from `@aws-sdk/client-bedrock-agentcore` so consumers get
   *  autocompletion and changes to AWS's enum propagate automatically. */
  readonly paymentInstrumentType: PaymentInstrumentType;
  /** AWS-defined tagged union — currently
   *  `{ embeddedCryptoWallet: { network: "ETHEREUM" | "SOLANA"; ... } }`.
   *  Imported from the SDK so the shape stays in sync. */
  readonly paymentInstrumentDetails: PaymentInstrumentDetails;
  readonly userId?: string;
  readonly clientToken?: string;
}

export interface GetPaymentInstrumentInput {
  readonly paymentInstrumentId: string;
  readonly userId?: string;
  readonly paymentConnectorId?: string;
}

export interface ListPaymentInstrumentsInput {
  readonly userId?: string;
  readonly paymentConnectorId?: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
}

export interface GetPaymentInstrumentBalanceInput {
  readonly paymentConnectorId: string;
  readonly paymentInstrumentId: string;
  /** AWS-defined `BlockchainChainId` enum (BASE | BASE_SEPOLIA | ETHEREUM | SOLANA | SOLANA_DEVNET). */
  readonly chain: BlockchainChainId;
  /** AWS-defined `InstrumentBalanceToken` enum (currently `"USDC"`).
   *  Note: this is a separate enum from `Currency` — `Currency` ("USD")
   *  is the Amount.currency display unit, while InstrumentBalanceToken
   *  is the on-chain token symbol queryable via this API. */
  readonly token: InstrumentBalanceToken;
  readonly userId?: string;
}

export interface DeletePaymentInstrumentInput {
  readonly paymentInstrumentId: string;
  readonly paymentConnectorId: string;
  readonly userId?: string;
}

export interface CreatePaymentSessionInput {
  readonly expiryTimeInMinutes: number;
  readonly userId?: string;
  readonly limits?: SessionLimits;
  readonly clientToken?: string;
}

export interface GetPaymentSessionInput {
  readonly paymentSessionId: string;
  readonly userId?: string;
}

export interface ListPaymentSessionsInput {
  readonly userId?: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
}

export interface DeletePaymentSessionInput {
  readonly paymentSessionId: string;
  readonly userId?: string;
}

export interface ProcessPaymentInput {
  readonly paymentSessionId: string;
  readonly paymentInstrumentId: string;
  readonly paymentType: "CRYPTO_X402";
  readonly paymentInput: PaymentInput;
  readonly userId?: string;
  readonly clientToken?: string;
  /** Accepted for backward compatibility but NOT forwarded — the Python
   *  SDK explicitly omits this field on the wire because the service
   *  rejects unknown parameters. Resolved server-side from the instrument. */
  readonly paymentConnectorId?: string;
}

/** A subset of an HTTP 402 response — what the agent needs to feed to
 *  `generatePaymentHeader`. Mirrors the `payment_required_request` arg
 *  shape in the Python SDK. */
export interface PaymentRequiredRequest {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Readonly<Record<string, unknown>>;
}

/** Return shape of `generatePaymentHeader`. One of two keys depending on
 *  x402 version: `X-PAYMENT` for v1, `PAYMENT-SIGNATURE` for v2. */
export type GeneratedPaymentHeader =
  { readonly "X-PAYMENT": string } | { readonly "PAYMENT-SIGNATURE": string };

// ─────────────────────────────────────────────────────────────────────────────
// PaymentManager
// ─────────────────────────────────────────────────────────────────────────────

export class PaymentManager {
  private readonly client: BedrockAgentCoreClient;
  private readonly paymentManagerArn: string;
  private readonly agentName: string | undefined;
  private readonly clientTokenFactory: () => string;

  constructor(opts: PaymentManagerOptions) {
    if (typeof opts.paymentManagerArn !== "string" || opts.paymentManagerArn.length === 0) {
      throw new TypeError(
        `paymentManagerArn is required and must be a non-empty string. Received: ${JSON.stringify(opts.paymentManagerArn)}`,
      );
    }
    this.paymentManagerArn = opts.paymentManagerArn;
    this.client = opts.client;
    this.agentName = opts.agentName;
    this.clientTokenFactory = opts.clientTokenFactory ?? (() => randomUUID());
  }

  // ───────── Payment Instruments ─────────

  async createPaymentInstrument(input: CreatePaymentInstrumentInput): Promise<PaymentInstrument> {
    const userId = normalizeUserId(input.userId);
    const cmd = new CreatePaymentInstrumentCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentConnectorId: input.paymentConnectorId,
      paymentInstrumentType: input.paymentInstrumentType,
      paymentInstrumentDetails: input.paymentInstrumentDetails,
      clientToken: input.clientToken ?? this.clientTokenFactory(),
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    const result = await sendCommand<CreatePaymentInstrumentCommandOutput>(this.client, cmd);
    if (result.paymentInstrument === undefined) {
      throw new PaymentError(
        "createPaymentInstrument: service returned empty paymentInstrument field",
      );
    }
    return result.paymentInstrument;
  }

  async getPaymentInstrument(input: GetPaymentInstrumentInput): Promise<PaymentInstrument> {
    const userId = normalizeUserId(input.userId);
    const cmd = new GetPaymentInstrumentCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentInstrumentId: input.paymentInstrumentId,
      ...(input.paymentConnectorId !== undefined
        ? { paymentConnectorId: input.paymentConnectorId }
        : {}),
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    const result = await sendCommandWithNotFound<GetPaymentInstrumentCommandOutput>(
      this.client,
      cmd,
      (m) =>
        new PaymentInstrumentNotFound(`Instrument not found: ${input.paymentInstrumentId}: ${m}`),
    );
    if (result.paymentInstrument === undefined) {
      throw new PaymentInstrumentNotFound(`Instrument not found: ${input.paymentInstrumentId}`);
    }
    return result.paymentInstrument;
  }

  async listPaymentInstruments(input: ListPaymentInstrumentsInput = {}): Promise<{
    /** AWS returns `PaymentInstrumentSummary[]` (a slimmer shape than the
     *  full `PaymentInstrument` returned by `getPaymentInstrument`). Use
     *  `getPaymentInstrument` to hydrate any summary into the full shape. */
    readonly paymentInstruments: readonly PaymentInstrumentSummary[];
    readonly nextToken: string | undefined;
  }> {
    const userId = normalizeUserId(input.userId);
    const cmd = new ListPaymentInstrumentsCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      maxResults: input.maxResults ?? DEFAULT_MAX_RESULTS,
      ...(input.paymentConnectorId !== undefined
        ? { paymentConnectorId: input.paymentConnectorId }
        : {}),
      ...(input.nextToken !== undefined ? { nextToken: input.nextToken } : {}),
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    const result = await sendCommand<ListPaymentInstrumentsCommandOutput>(this.client, cmd);
    return {
      paymentInstruments: result.paymentInstruments ?? [],
      nextToken: result.nextToken,
    };
  }

  async getPaymentInstrumentBalance(
    input: GetPaymentInstrumentBalanceInput,
  ): Promise<GetPaymentInstrumentBalanceCommandOutput> {
    const userId = normalizeUserId(input.userId);
    const cmd = new GetPaymentInstrumentBalanceCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentConnectorId: input.paymentConnectorId,
      paymentInstrumentId: input.paymentInstrumentId,
      chain: input.chain,
      token: input.token,
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    return sendCommandWithNotFound<GetPaymentInstrumentBalanceCommandOutput>(
      this.client,
      cmd,
      (m) =>
        new PaymentInstrumentNotFound(`Instrument not found: ${input.paymentInstrumentId}: ${m}`),
    );
  }

  async deletePaymentInstrument(
    input: DeletePaymentInstrumentInput,
  ): Promise<DeletePaymentInstrumentCommandOutput> {
    const userId = normalizeUserId(input.userId);
    const cmd = new DeletePaymentInstrumentCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentConnectorId: input.paymentConnectorId,
      paymentInstrumentId: input.paymentInstrumentId,
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    return sendCommandWithNotFound<DeletePaymentInstrumentCommandOutput>(
      this.client,
      cmd,
      (m) =>
        new PaymentInstrumentNotFound(`Instrument not found: ${input.paymentInstrumentId}: ${m}`),
    );
  }

  // ───────── Payment Sessions ─────────

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    const userId = normalizeUserId(input.userId);
    const cmd = new CreatePaymentSessionCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      expiryTimeInMinutes: input.expiryTimeInMinutes,
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
      clientToken: input.clientToken ?? this.clientTokenFactory(),
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    const result = await sendCommand<CreatePaymentSessionCommandOutput>(this.client, cmd);
    if (result.paymentSession === undefined) {
      throw new PaymentError("createPaymentSession: service returned empty paymentSession field");
    }
    return result.paymentSession;
  }

  async getPaymentSession(input: GetPaymentSessionInput): Promise<PaymentSession> {
    const userId = normalizeUserId(input.userId);
    const cmd = new GetPaymentSessionCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentSessionId: input.paymentSessionId,
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    const result = await sendCommandWithNotFound<GetPaymentSessionCommandOutput>(
      this.client,
      cmd,
      (m) => new PaymentSessionNotFound(`Session not found: ${input.paymentSessionId}: ${m}`),
    );
    if (result.paymentSession === undefined) {
      throw new PaymentSessionNotFound(`Session not found: ${input.paymentSessionId}`);
    }
    return result.paymentSession;
  }

  async listPaymentSessions(input: ListPaymentSessionsInput = {}): Promise<{
    readonly paymentSessions: ListPaymentSessionsCommandOutput["paymentSessions"];
    readonly nextToken: string | undefined;
  }> {
    const userId = normalizeUserId(input.userId);
    const cmd = new ListPaymentSessionsCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      maxResults: input.maxResults ?? DEFAULT_MAX_RESULTS,
      ...(input.nextToken !== undefined ? { nextToken: input.nextToken } : {}),
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    const result = await sendCommand<ListPaymentSessionsCommandOutput>(this.client, cmd);
    return {
      paymentSessions: result.paymentSessions ?? [],
      nextToken: result.nextToken,
    };
  }

  async deletePaymentSession(
    input: DeletePaymentSessionInput,
  ): Promise<DeletePaymentSessionCommandOutput> {
    const userId = normalizeUserId(input.userId);
    const cmd = new DeletePaymentSessionCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentSessionId: input.paymentSessionId,
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    return sendCommandWithNotFound<DeletePaymentSessionCommandOutput>(
      this.client,
      cmd,
      (m) => new PaymentSessionNotFound(`Session not found: ${input.paymentSessionId}: ${m}`),
    );
  }

  // ───────── Process Payment ─────────

  async processPayment(input: ProcessPaymentInput): Promise<ProcessPaymentCommandOutput> {
    const userId = normalizeUserId(input.userId);
    const cmd = new ProcessPaymentCommand({
      ...(userId !== undefined ? { userId } : {}),
      paymentManagerArn: this.paymentManagerArn,
      paymentSessionId: input.paymentSessionId,
      paymentInstrumentId: input.paymentInstrumentId,
      paymentType: input.paymentType,
      paymentInput: input.paymentInput,
      clientToken: input.clientToken ?? this.clientTokenFactory(),
      // paymentConnectorId intentionally omitted — mirrors the Python SDK's
      // behavior. The ProcessPayment API rejects unknown parameters, and
      // the connector is resolved server-side from the instrument.
      ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
    });
    try {
      return await sendCommand<ProcessPaymentCommandOutput>(this.client, cmd);
    } catch (e) {
      throw mapProcessPaymentError(e, input);
    }
  }

  // ───────── Header generation (x402 orchestration) ─────────

  /** Generate an x402 `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header
   *  from a 402 challenge. Mirrors the Python SDK's `generate_payment_header`
   *  step-by-step:
   *    1. Validate inputs
   *    2. Check statusCode == 402
   *    3. Extract x402 payload (v2 from base64 `payment-required` header,
   *       v1 from JSON body)
   *    4. Read the instrument's chain (ETHEREUM | SOLANA) via getPaymentInstrument
   *    5. Filter the `accepts` array to the matching chain family
   *    6. Pick the most-preferred network from `accepts`
   *    7. Call processPayment with `CRYPTO_X402`
   *    8. Base64-encode the proof + return as the right header shape */
  async generatePaymentHeader(args: {
    readonly paymentInstrumentId: string;
    readonly paymentSessionId: string;
    readonly paymentRequiredRequest: PaymentRequiredRequest;
    readonly userId?: string;
    readonly networkPreferences?: readonly string[];
    readonly clientToken?: string;
  }): Promise<GeneratedPaymentHeader> {
    validateInputs(args);
    if (args.paymentRequiredRequest.statusCode !== 402) {
      throw new PaymentError(
        `402 Status Validation: Invalid status code - Expected statusCode 402, got ${args.paymentRequiredRequest.statusCode}`,
      );
    }
    const clientToken = args.clientToken ?? this.clientTokenFactory();
    if (typeof clientToken !== "string" || clientToken.trim() === "") {
      throw new PaymentError("client_token is invalid - cannot be empty");
    }

    const { payload, version } = extractX402Payload(args.paymentRequiredRequest);
    const instrument = await this.getPaymentInstrument({
      paymentInstrumentId: args.paymentInstrumentId,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
    });
    const chain = extractInstrumentNetwork(instrument);
    const selectedAccept = selectAcceptForChain(payload, chain, args.networkPreferences);

    // AWS SDK types the `cryptoX402.payload` field as `__DocumentType`,
    // which is an arbitrary JSON value (number, string, array, object).
    // The selected x402 accept IS such an object — narrow via a typed
    // intermediate to avoid casting the whole PaymentInput.
    const cryptoX402: CryptoX402PaymentInput = {
      version: String(version),
      payload: selectedAccept as unknown as CryptoX402PaymentInput["payload"],
    };
    const paymentInput: PaymentInput = { cryptoX402 };

    const processResult = await this.processPayment({
      paymentSessionId: args.paymentSessionId,
      paymentInstrumentId: args.paymentInstrumentId,
      paymentType: "CRYPTO_X402",
      paymentInput,
      clientToken,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
    });

    // PaymentOutput is a tagged union. We narrow via the `cryptoX402`
    // discriminant; if it's the other arm ($UnknownMember) cryptoProof
    // stays undefined and we throw below.
    const proofMember = processResult.paymentOutput as
      { cryptoX402?: CryptoX402PaymentOutput } | undefined;
    const cryptoProof: CryptoX402PaymentOutput | undefined = proofMember?.cryptoX402;
    if (cryptoProof === undefined || cryptoProof.payload === undefined) {
      throw new PaymentError(
        "Payment Processing: Missing cryptoX402 in payment output - " +
          "payment result does not contain cryptoX402 proof",
      );
    }

    return buildPaymentHeader({
      version,
      x402Payload: payload,
      selectedAccept,
      cryptoX402Proof: cryptoProof.payload,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface CommandLike<O> {
  // Minimal structural type matching `@smithy/smithy-client`'s Command interface.
  readonly resolveMiddleware?: unknown;
  readonly input?: unknown;
  readonly _O?: O;
}

async function sendCommand<O>(client: BedrockAgentCoreClient, command: CommandLike<O>): Promise<O> {
  // The AWS SDK JS v3 client's `.send()` is generic; we keep our wrappers
  // typed via the per-command Output interface from the SDK.
  return (await (client.send as (cmd: unknown) => Promise<O>)(command)) as O;
}

async function sendCommandWithNotFound<O>(
  client: BedrockAgentCoreClient,
  command: CommandLike<O>,
  notFound: (message: string) => Error,
): Promise<O> {
  try {
    return await sendCommand<O>(client, command);
  } catch (e) {
    if (isResourceNotFound(e)) {
      throw notFound(extractErrorMessage(e));
    }
    throw wrapAsPaymentError(e);
  }
}

function isResourceNotFound(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const name = (e as { name?: unknown }).name;
  const message = (e as { message?: unknown }).message;
  if (typeof name === "string" && name === "ResourceNotFoundException") return true;
  if (typeof message === "string" && /not found/i.test(message)) return true;
  return false;
}

function extractErrorMessage(e: unknown): string {
  if (e === null || typeof e !== "object") return String(e);
  const m = (e as { message?: unknown }).message;
  return typeof m === "string" ? m : String(e);
}

function wrapAsPaymentError(e: unknown): Error {
  if (e instanceof PaymentError) return e;
  if (e instanceof Error) return new PaymentError(e.message, { cause: e });
  return new PaymentError(String(e));
}

function mapProcessPaymentError(e: unknown, _input: ProcessPaymentInput): Error {
  const m = extractErrorMessage(e).toLowerCase();
  const name = e !== null && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
  if (name === "ValidationException") {
    if (m.includes("budget") || m.includes("insufficient")) {
      return new InsufficientBudget(`Insufficient budget: ${extractErrorMessage(e)}`);
    }
    if (m.includes("expired")) {
      return new PaymentSessionExpired(`Session expired: ${extractErrorMessage(e)}`);
    }
    if (m.includes("instrument") || m.includes("inactive")) {
      return new InvalidPaymentInstrument(`Invalid instrument: ${extractErrorMessage(e)}`);
    }
    if (m.includes("session not found")) {
      return new PaymentSessionNotFound(`Session not found or expired: ${extractErrorMessage(e)}`);
    }
  }
  if (e instanceof Error) return new PaymentError(e.message, { cause: e });
  return new PaymentError(String(e));
}

function normalizeUserId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// x402 payload extraction (mirror Python `_extract_x402_payload`)
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedX402Payload {
  readonly payload: X402Payload;
  readonly version: number;
}

interface X402Payload {
  readonly x402Version: number;
  readonly accepts: readonly X402Accept[];
  readonly resource?: string;
  readonly extension?: Record<string, unknown>;
}

interface X402Accept {
  readonly scheme?: string;
  readonly network?: string;
  readonly [k: string]: unknown;
}

function extractX402Payload(req: PaymentRequiredRequest): ExtractedX402Payload {
  // v2: payment-required header is base64-encoded JSON.
  // v1: body contains the JSON directly (string or already-parsed object).
  const paymentRequiredHeader = findHeaderCaseInsensitive(req.headers, "payment-required");

  let payload: Record<string, unknown>;
  if (paymentRequiredHeader !== undefined) {
    if (paymentRequiredHeader === "") {
      throw new PaymentError("X.402 Extraction: payment-required header is present but empty");
    }
    try {
      const decoded = Buffer.from(paymentRequiredHeader, "base64").toString("utf-8");
      const parsed: unknown = JSON.parse(decoded);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PaymentError(
          `X.402 Extraction: v2 payload decoded to ${typeof parsed}, expected a JSON object`,
        );
      }
      payload = parsed as Record<string, unknown>;
    } catch (e) {
      if (e instanceof PaymentError) throw e;
      throw new PaymentError(
        `X.402 Extraction: Failed to decode v2 payload - payment-required header contains invalid base64 or JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    const body = req.body;
    if (typeof body === "string") {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new PaymentError(
            `X.402 Extraction: v1 payload decoded to ${typeof parsed}, expected a JSON object`,
          );
        }
        payload = parsed as Record<string, unknown>;
      } catch (e) {
        if (e instanceof PaymentError) throw e;
        throw new PaymentError(
          `X.402 Extraction: Failed to parse v1 payload from body - body contains invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else if (body !== null && typeof body === "object") {
      payload = body as Record<string, unknown>;
    } else {
      throw new PaymentError(
        "X.402 Extraction: Invalid body format - body must be a JSON string or dictionary",
      );
    }
  }

  if (!("x402Version" in payload)) {
    throw new PaymentError(
      "X.402 Extraction: Missing x402Version - x402Payload must contain x402Version field",
    );
  }
  const version = Number(payload["x402Version"]);
  if (!Number.isInteger(version)) {
    throw new PaymentError(
      `X.402 Extraction: Invalid x402Version '${payload["x402Version"] as string}' - must be an integer`,
    );
  }
  if (!("accepts" in payload)) {
    throw new PaymentError(
      "X.402 Validation: Missing required fields - x402Payload must contain accepts, x402Version, but missing: accepts",
    );
  }
  if (!Array.isArray(payload["accepts"])) {
    throw new PaymentError(
      "X.402 Validation: Invalid accepts field - accepts must be a list of accept headers",
    );
  }

  return { payload: payload as unknown as X402Payload, version };
}

function findHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  target: string,
): string | undefined {
  const targetLower = target.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === targetLower) return v;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Network selection (mirror Python `_select_accept_for_instrument_network`)
// ─────────────────────────────────────────────────────────────────────────────

function extractInstrumentNetwork(instrument: PaymentInstrument): "ETHEREUM" | "SOLANA" {
  // Instrument shape: paymentInstrumentDetails.embeddedCryptoWallet.network
  // — same path the Python SDK reads.
  const details = (instrument as { paymentInstrumentDetails?: unknown }).paymentInstrumentDetails;
  if (details === null || typeof details !== "object") {
    throw new PaymentError(
      "Instrument Retrieval: Missing network information - instrument details do not contain network information at paymentInstrumentDetails.embeddedCryptoWallet.network",
    );
  }
  const embedded = (details as { embeddedCryptoWallet?: unknown }).embeddedCryptoWallet;
  if (embedded === null || typeof embedded !== "object") {
    throw new PaymentError(
      "Instrument Retrieval: Missing network information - instrument details do not contain network information at paymentInstrumentDetails.embeddedCryptoWallet.network",
    );
  }
  const network = (embedded as { network?: unknown }).network;
  if (typeof network !== "string" || network === "") {
    throw new PaymentError(
      "Instrument Retrieval: Missing network information - instrument details do not contain network information at paymentInstrumentDetails.embeddedCryptoWallet.network",
    );
  }
  const upper = network.toUpperCase();
  if (upper === "ETHEREUM" || upper === "SOLANA") return upper;
  throw new PaymentError(
    `Instrument Network: Unsupported network - instrument network '${network}' is not supported. Supported networks are ETHEREUM and SOLANA.`,
  );
}

function selectAcceptForChain(
  payload: X402Payload,
  chain: "ETHEREUM" | "SOLANA",
  preferences: readonly string[] | undefined,
): X402Accept {
  const family = chain === "ETHEREUM" ? ETHEREUM_NETWORKS : SOLANA_NETWORKS;
  const filtered = payload.accepts.filter((a) => {
    const n = typeof a.network === "string" ? a.network.toLowerCase() : "";
    return family.has(n);
  });
  if (filtered.length === 0) {
    throw new PaymentError(
      `Accept Selection: No matching accept - No accept header found for instrument network '${chain}' in X.402 payload. Instrument does not support the network for header generation.`,
    );
  }
  const order = preferences ?? NETWORK_PREFERENCES;
  for (const pref of order) {
    const prefLower = pref.toLowerCase();
    for (const accept of filtered) {
      const acceptNetwork = typeof accept.network === "string" ? accept.network.toLowerCase() : "";
      if (acceptNetwork === prefLower) return accept;
    }
  }
  // No preference matched — return the first filtered accept.
  return filtered[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header build (mirror Python `_build_payment_header`)
// ─────────────────────────────────────────────────────────────────────────────

function buildPaymentHeader(args: {
  readonly version: number;
  readonly x402Payload: X402Payload;
  readonly selectedAccept: X402Accept;
  readonly cryptoX402Proof: unknown;
}): GeneratedPaymentHeader {
  if (args.version === 1) {
    const header = {
      x402Version: 1,
      scheme: args.selectedAccept.scheme,
      network: args.selectedAccept.network,
      payload: args.cryptoX402Proof,
    };
    const encoded = Buffer.from(JSON.stringify(header), "utf-8").toString("base64");
    return { "X-PAYMENT": encoded };
  }
  if (args.version === 2) {
    const sig = {
      x402Version: 2,
      resource: args.x402Payload.resource,
      accepted: args.selectedAccept,
      extension: args.x402Payload.extension ?? {},
      payload: args.cryptoX402Proof,
    };
    const encoded = Buffer.from(JSON.stringify(sig), "utf-8").toString("base64");
    return { "PAYMENT-SIGNATURE": encoded };
  }
  throw new PaymentError(
    `Header Building: Unsupported X.402 version - x402Version ${args.version} is not supported. Supported versions: 1, 2`,
  );
}

function validateInputs(args: {
  readonly paymentInstrumentId: string;
  readonly paymentSessionId: string;
  readonly paymentRequiredRequest: PaymentRequiredRequest;
}): void {
  if (typeof args.paymentInstrumentId !== "string" || args.paymentInstrumentId.trim() === "") {
    throw new PaymentError(
      "Input Validation: instrument_id is empty - instrument_id must be a non-empty string",
    );
  }
  if (typeof args.paymentSessionId !== "string" || args.paymentSessionId.trim() === "") {
    throw new PaymentError(
      "Input Validation: session_id is empty - session_id must be a non-empty string",
    );
  }
  if (args.paymentRequiredRequest === null || typeof args.paymentRequiredRequest !== "object") {
    throw new PaymentError(
      "Input Validation: payment_required_request is invalid - payment_required_request must be a non-empty dictionary",
    );
  }
  const required: readonly (keyof PaymentRequiredRequest)[] = ["statusCode", "headers", "body"];
  for (const field of required) {
    if (!(field in args.paymentRequiredRequest)) {
      throw new PaymentError(
        "Input Validation: 402 payment required request is missing required fields - 402 payment required request must contain statusCode, headers, and body",
      );
    }
  }
}
