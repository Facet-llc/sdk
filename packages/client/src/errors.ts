import type {
  FacetErrorBody,
  FacetErrorCode,
  FacetErrorEnvelope,
  FacetErrorSuggest,
} from "@facet-llc/adapter";

// Client-side counterpart of the server's FacetError. Thrown from every
// FacetClient method on a non-2xx response, carrying the parsed error
// envelope plus the HTTP status + trace-id so callers can branch cleanly.

export class FacetClientError extends Error {
  readonly code: FacetErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly suggest: FacetErrorSuggest | null;
  readonly traceId: string | null;

  constructor(body: FacetErrorBody, opts: { status: number; traceId: string | null }) {
    super(body.message);
    this.name = "FacetClientError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.retryAfterSeconds = body.retry_after_seconds;
    this.suggest = body.suggest;
    this.status = opts.status;
    this.traceId = opts.traceId;
  }
}

// Thrown when the response is non-2xx but the body does NOT match the
// FacetErrorEnvelope shape (e.g. 502 from an upstream proxy, HTML error
// page, etc.). Distinct from FacetClientError so callers can tell apart
// "Facet said no" from "the pipe broke."
export class FacetTransportError extends Error {
  readonly status: number;
  readonly rawBody: string;
  readonly traceId: string | null;

  constructor(message: string, opts: { status: number; rawBody: string; traceId: string | null }) {
    super(message);
    this.name = "FacetTransportError";
    this.status = opts.status;
    this.rawBody = opts.rawBody;
    this.traceId = opts.traceId;
  }
}

export function isFacetErrorEnvelope(v: unknown): v is FacetErrorEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const env = v as { error?: unknown };
  if (typeof env.error !== "object" || env.error === null) return false;
  const body = env.error as Record<string, unknown>;
  return (
    typeof body["code"] === "string" &&
    typeof body["message"] === "string" &&
    typeof body["retryable"] === "boolean"
  );
}
