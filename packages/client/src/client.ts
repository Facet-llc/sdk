import {
  HEADER_IDEMPOTENCY_KEY,
  HEADER_RATE_LIMIT_LIMIT,
  HEADER_RATE_LIMIT_REMAINING,
  HEADER_RATE_LIMIT_RESET,
  HEADER_TRACE_ID,
  type CancelReservationRequest,
  type CancelReservationResponse,
  type CapabilitiesResponse,
  type CatalogChangesSinceRequest,
  type CatalogChangesSinceResponse,
  type DeleteWebhookRequest,
  type DeleteWebhookResponse,
  type FacetRateLimitState,
  type GetDocumentRequest,
  type GetDocumentResponse,
  type GetOrderRequest,
  type GetOrderResponse,
  type GetProductRequest,
  type GetProductResponse,
  type HealthResponse,
  type IdentifyResponse,
  type ListWebhooksResponse,
  type ConsumeLicenseRequest,
  type ConsumeLicenseResponse,
  type OrderHistoryRequest,
  type OrderHistoryResponse,
  type PurchaseLicenseRequest,
  type PurchaseLicenseResponse,
  type QuoteRequest,
  type QuoteResponse,
  type RefundRequestRequest,
  type RefundRequestResponse,
  type ReputationRequest,
  type ReputationResponse,
  type RequestHumanRequest,
  type RequestHumanResponse,
  type ReserveRequest,
  type ReserveResponse,
  type SearchRequest,
  type SearchResponse,
  type SessionExtendRequest,
  type SettleRequest,
  type SettleResponse,
  type SubscribeWebhookRequest,
  type SubscribeWebhookResponse,
  type TermsResponse,
  type VersionResponse,
  type WhoamiResponse,
} from "@facet-llc/protocol";
import { FacetClientError, FacetTransportError, isFacetErrorEnvelope } from "./errors.ts";

export type KyaTokenProvider = string | (() => string | Promise<string>);

export interface FacetClientOptions {
  readonly terminalUrl: string;
  readonly kyaToken?: KyaTokenProvider;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
}

// FacetClient is the single entry point. Construct once per terminal and
// reuse — the instance caches the last-seen rate-limit state and trace id,
// which agents can consult between calls.
export class FacetClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: KyaTokenProvider | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  lastRateLimit: FacetRateLimitState | null = null;
  lastTraceId: string | null = null;

  constructor(opts: FacetClientOptions) {
    this.baseUrl = opts.terminalUrl.replace(/\/+$/, "");
    this.tokenProvider = opts.kyaToken;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? `@facet-llc/client/0.2.0`;
  }

  // ── discovery ────────────────────────────────────────────────────────────

  async schema(opts?: RequestOptions): Promise<string> {
    return this.request<string>("GET", "/v1/schema", {
      auth: false,
      parse: "text",
      ...(opts ?? {}),
    });
  }

  async version(opts?: RequestOptions): Promise<VersionResponse> {
    return this.request<VersionResponse>("GET", "/v1/version", { auth: false, ...(opts ?? {}) });
  }

  async health(opts?: RequestOptions): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/health", { auth: false, ...(opts ?? {}) });
  }

  async capabilities(opts?: RequestOptions): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>("GET", "/v1/capabilities", {
      auth: false,
      ...(opts ?? {}),
    });
  }

  async terms(opts?: RequestOptions): Promise<TermsResponse> {
    return this.request<TermsResponse>("GET", "/v1/terms", { auth: false, ...(opts ?? {}) });
  }

  // ── tools ────────────────────────────────────────────────────────────────

  async search(req: SearchRequest, opts?: RequestOptions): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/v1/search", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async quote(req: QuoteRequest, opts?: RequestOptions): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/v1/quote", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async reserve(req: ReserveRequest, opts?: RequestOptions): Promise<ReserveResponse> {
    return this.request<ReserveResponse>("POST", "/v1/reserve", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async cancelReservation(
    req: CancelReservationRequest,
    opts?: RequestOptions,
  ): Promise<CancelReservationResponse> {
    return this.request<CancelReservationResponse>("POST", "/v1/cancel_reservation", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async settle(req: SettleRequest, opts?: RequestOptions): Promise<SettleResponse> {
    return this.request<SettleResponse>("POST", "/v1/settle", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async getOrder(req: GetOrderRequest, opts?: RequestOptions): Promise<GetOrderResponse> {
    return this.request<GetOrderResponse>("POST", "/v1/get_order", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async orderHistory(
    req: OrderHistoryRequest = {},
    opts?: RequestOptions,
  ): Promise<OrderHistoryResponse> {
    return this.request<OrderHistoryResponse>("POST", "/v1/order_history", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async refundRequest(
    req: RefundRequestRequest,
    opts?: RequestOptions,
  ): Promise<RefundRequestResponse> {
    return this.request<RefundRequestResponse>("POST", "/v1/refund_request", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async getProduct(req: GetProductRequest, opts?: RequestOptions): Promise<GetProductResponse> {
    return this.request<GetProductResponse>("POST", "/v1/get_product", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async getDocument(req: GetDocumentRequest, opts?: RequestOptions): Promise<GetDocumentResponse> {
    return this.request<GetDocumentResponse>("POST", "/v1/get_document", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async requestHuman(
    req: RequestHumanRequest,
    opts?: RequestOptions,
  ): Promise<RequestHumanResponse> {
    return this.request<RequestHumanResponse>("POST", "/v1/request_human", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async catalogChangesSince(
    req: CatalogChangesSinceRequest = {},
    opts?: RequestOptions,
  ): Promise<CatalogChangesSinceResponse> {
    return this.request<CatalogChangesSinceResponse>("POST", "/v1/catalog_changes_since", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async subscribeWebhook(
    req: SubscribeWebhookRequest,
    opts?: RequestOptions,
  ): Promise<SubscribeWebhookResponse> {
    return this.request<SubscribeWebhookResponse>("POST", "/v1/subscribe_webhook", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async listWebhooks(opts?: RequestOptions): Promise<ListWebhooksResponse> {
    return this.request<ListWebhooksResponse>("POST", "/v1/list_webhooks", {
      auth: true,
      body: {},
      ...(opts ?? {}),
    });
  }

  async deleteWebhook(
    req: DeleteWebhookRequest,
    opts?: RequestOptions,
  ): Promise<DeleteWebhookResponse> {
    return this.request<DeleteWebhookResponse>("POST", "/v1/delete_webhook", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async identify(opts?: RequestOptions): Promise<IdentifyResponse> {
    return this.request<IdentifyResponse>("POST", "/v1/identify", {
      auth: true,
      body: {},
      ...(opts ?? {}),
    });
  }

  async sessionExtend(req: SessionExtendRequest, opts?: RequestOptions): Promise<IdentifyResponse> {
    return this.request<IdentifyResponse>("POST", "/v1/session_extend", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async whoami(opts?: RequestOptions): Promise<WhoamiResponse> {
    return this.request<WhoamiResponse>("POST", "/v1/whoami", {
      auth: true,
      body: {},
      ...(opts ?? {}),
    });
  }

  async purchaseLicense(
    req: PurchaseLicenseRequest,
    opts?: RequestOptions,
  ): Promise<PurchaseLicenseResponse> {
    return this.request<PurchaseLicenseResponse>("POST", "/v1/purchase_license", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async consumeLicense(
    req: ConsumeLicenseRequest,
    opts?: RequestOptions,
  ): Promise<ConsumeLicenseResponse> {
    return this.request<ConsumeLicenseResponse>("POST", "/v1/consume_license", {
      auth: true,
      body: req,
      ...(opts ?? {}),
    });
  }

  async hello(opts?: RequestOptions): Promise<{ hello: string; verified_at: string }> {
    return this.request<{ hello: string; verified_at: string }>("POST", "/v1/hello", {
      auth: true,
      body: {},
      ...(opts ?? {}),
    });
  }

  // Public agent reputation lookup. No KYA token required (the endpoint
  // is unauthenticated + rate-limited by Origin header).
  // Unknown agents return `tier: "unknown"` with zero counters rather
  // than 404 so callers can treat missing + unseen identically.
  async reputation(req: ReputationRequest, opts?: RequestOptions): Promise<ReputationResponse> {
    return this.request<ReputationResponse>("POST", "/v1/reputation", {
      auth: false,
      body: req,
      ...(opts ?? {}),
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async resolveToken(): Promise<string> {
    if (this.tokenProvider === undefined) {
      throw new Error(
        "FacetClient: this call requires authentication but no kyaToken was provided to the constructor.",
      );
    }
    if (typeof this.tokenProvider === "string") return this.tokenProvider;
    return await this.tokenProvider();
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      auth: boolean;
      body?: unknown;
      parse?: "json" | "text";
      signal?: AbortSignal;
      traceId?: string;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    const headers = new Headers({
      accept: opts.parse === "text" ? "application/yaml, text/*" : "application/json",
      "user-agent": this.userAgent,
    });
    const traceId = opts.traceId ?? crypto.randomUUID();
    headers.set(HEADER_TRACE_ID, traceId);

    if (opts.auth) {
      const token = await this.resolveToken();
      headers.set("authorization", `Bearer ${token}`);
    }
    if (opts.idempotencyKey !== undefined) {
      headers.set(HEADER_IDEMPOTENCY_KEY, opts.idempotencyKey);
    }
    if (opts.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const signal = mergeSignals(controller.signal, opts.signal);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal,
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      });
    } finally {
      clearTimeout(timer);
    }

    this.lastTraceId = res.headers.get(HEADER_TRACE_ID) ?? traceId;
    this.lastRateLimit = parseRateLimit(res);

    if (res.ok) {
      if (opts.parse === "text") return (await res.text()) as unknown as T;
      return (await res.json()) as T;
    }

    // Non-2xx — try to parse as the structured envelope; fall back to transport error.
    const rawBody = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new FacetTransportError(
        `Non-JSON error response from Facet Terminal (HTTP ${res.status}).`,
        { status: res.status, rawBody, traceId: this.lastTraceId },
      );
    }
    if (!isFacetErrorEnvelope(parsed)) {
      throw new FacetTransportError(`Unexpected error body shape (HTTP ${res.status}).`, {
        status: res.status,
        rawBody,
        traceId: this.lastTraceId,
      });
    }
    throw new FacetClientError(parsed.error, {
      status: res.status,
      traceId: this.lastTraceId,
    });
  }
}

function parseRateLimit(res: Response): FacetRateLimitState | null {
  const limit = res.headers.get(HEADER_RATE_LIMIT_LIMIT);
  const remaining = res.headers.get(HEADER_RATE_LIMIT_REMAINING);
  const reset = res.headers.get(HEADER_RATE_LIMIT_RESET);
  if (limit === null || remaining === null || reset === null) return null;
  const l = Number.parseInt(limit, 10);
  const r = Number.parseInt(remaining, 10);
  const t = Number.parseInt(reset, 10);
  if (!Number.isFinite(l) || !Number.isFinite(r) || !Number.isFinite(t)) return null;
  return { limit: l, remaining: r, reset: t };
}

function mergeSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (b === undefined) return a;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener("abort", onAbort);
  b.addEventListener("abort", onAbort);
  return controller.signal;
}
