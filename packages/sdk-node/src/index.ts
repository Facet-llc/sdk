// Agent-side discovery SDK for the Facet protocol.
//
// The one-call entry point an agent needs:
//
//   import { discoverAndConnect } from "@facet-llc/sdk-node";
//   const client = await discoverAndConnect("merchant.com", {
//     capabilityCheck: ["catalog"],
//     kyaToken: () => issuer.mintToken(),
//   });
//   const caps = await client.capabilities();
//
// `discoverAndConnect` chains `fetchAgentsTxt` (which respects HTTP
// `Cache-Control: max-age` with a 1h fallback TTL) and a configured
// `@facet-llc/client` instance pointed at the manifest's `Terminal` URL.
//
// Errors are typed (`NoManifestError`, `InvalidManifestError`,
// `UnsupportedVersionError`, `FetchError`, `CapabilityMismatchError`) so
// callers can branch without sniffing message strings.

import { AgentsTxtError, parseAgentsTxt, type AgentsTxt } from "@facet-llc/protocol";
import { FacetClient, type FacetClientOptions, type KyaTokenProvider } from "@facet-llc/client";

export { AgentsTxtError, parseAgentsTxt } from "@facet-llc/protocol";
export type { AgentsTxt } from "@facet-llc/protocol";
export { FacetClient, FacetClientError, FacetTransportError } from "@facet-llc/client";
export type { FacetClientOptions, KyaTokenProvider, RequestOptions } from "@facet-llc/client";

// `TerminalClient` is the per-merchant Facet Terminal handle returned by
// `discoverAndConnect`. It is the same class exported as `FacetClient`
// from `@facet-llc/client` — re-aliased here because the spec talks about
// "the Terminal" while the client package talks about "the Facet client".
export { FacetClient as TerminalClient } from "@facet-llc/client";

// Typed wire surface generated from the Facet Terminal OpenAPI spec.
// `createTerminalClient` returns an
// `openapi-fetch` client; `paths`, `components`, and `operations` are
// the openapi-typescript-generated namespaces. The hand-written
// helpers above stay on top of this layer; callers may use either
// (or both) depending on whether they want the ergonomic wrapper or
// the raw typed handle.
export { createTerminalClient } from "./typed-client.ts";
export type {
  CreateTerminalClientOptions,
  TerminalClient as TypedTerminalClient,
  paths,
  components,
  operations,
} from "./typed-client.ts";

/**
 * agents.txt spec versions this SDK can consume. v0.2, v1.0, and v1.1
 * coexist indefinitely per spec §10. Documents declaring any other value
 * cause `discoverAndConnect` / `fetchAgentsTxt` to throw
 * `UnsupportedVersionError`.
 */
export const SUPPORTED_FACET_VERSIONS = ["0.2", "1.0", "1.1"] as const;
export type SupportedFacetVersion = (typeof SUPPORTED_FACET_VERSIONS)[number];

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class NoManifestError extends Error {
  override readonly name = "NoManifestError";
  readonly domain: string;
  readonly status: number;
  constructor(domain: string, status: number) {
    super(`No agents.txt manifest at ${domain} (HTTP ${status}).`);
    this.domain = domain;
    this.status = status;
  }
}

export class InvalidManifestError extends Error {
  override readonly name = "InvalidManifestError";
  override readonly cause: unknown;
  readonly domain: string;
  constructor(domain: string, message: string, cause?: unknown) {
    super(`Invalid agents.txt manifest for ${domain}: ${message}`);
    this.domain = domain;
    this.cause = cause;
  }
}

export class UnsupportedVersionError extends Error {
  override readonly name = "UnsupportedVersionError";
  readonly domain: string;
  readonly facetVersion: string;
  readonly supported: readonly string[];
  constructor(domain: string, facetVersion: string) {
    super(
      `Unsupported Facet-Version '${facetVersion}' at ${domain}. Supported: ${SUPPORTED_FACET_VERSIONS.join(
        ", ",
      )}.`,
    );
    this.domain = domain;
    this.facetVersion = facetVersion;
    this.supported = SUPPORTED_FACET_VERSIONS;
  }
}

export class FetchError extends Error {
  override readonly name = "FetchError";
  override readonly cause: unknown;
  readonly domain: string;
  readonly status: number | null;
  constructor(domain: string, message: string, opts: { cause?: unknown; status?: number } = {}) {
    super(`Network error fetching agents.txt for ${domain}: ${message}`);
    this.domain = domain;
    this.cause = opts.cause;
    this.status = opts.status ?? null;
  }
}

export class CapabilityMismatchError extends Error {
  override readonly name = "CapabilityMismatchError";
  readonly domain: string;
  readonly required: readonly string[];
  readonly advertised: readonly string[];
  readonly missing: readonly string[];
  constructor(
    domain: string,
    required: readonly string[],
    advertised: readonly string[],
    missing: readonly string[],
  ) {
    super(
      `Manifest for ${domain} is missing required capabilities: [${missing.join(
        ", ",
      )}]. Advertised: [${advertised.join(", ")}].`,
    );
    this.domain = domain;
    this.required = required;
    this.advertised = advertised;
    this.missing = missing;
  }
}

interface CacheEntry {
  readonly manifest: AgentsTxt;
  readonly expiresAt: number;
}

const manifestCache = new Map<string, CacheEntry>();

/**
 * Clear the in-memory manifest cache. With no argument, clears every
 * entry; with `domain`, clears only the entry for that domain. Tests
 * and long-lived agents that want to force a refresh use this.
 */
export function clearAgentsTxtCache(domain?: string): void {
  if (domain === undefined) {
    manifestCache.clear();
    return;
  }
  manifestCache.delete(manifestUrl(domain));
}

export interface FetchAgentsTxtOptions {
  /**
   * Fallback TTL in milliseconds when the response carries no
   * `Cache-Control: max-age`. Default: 3_600_000 (1h).
   */
  readonly ttlMs?: number;
  /** AbortSignal threaded into the underlying `fetch`. */
  readonly signal?: AbortSignal;
  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`. Useful
   * for tests and for agents that route through a proxy / mTLS pool.
   */
  readonly fetch?: typeof fetch;
  /** Skip the in-memory cache for this call. The fresh response is still cached afterwards. */
  readonly noCache?: boolean;
  /** Timestamp source override (testing). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Fetch `/.well-known/agents.txt` for `domain`, parse it through
 * `@facet-llc/protocol`, and return the typed manifest.
 *
 * Behavior:
 *   - Honors `Cache-Control: max-age` from the response; with no header
 *     the manifest is cached for `opts.ttlMs` (default 1h).
 *   - `Cache-Control: no-cache` / `no-store` disables caching.
 *   - 404 → `NoManifestError`. Any other non-2xx → `FetchError`.
 *   - Parser throw → `InvalidManifestError`.
 *   - Manifest declares an unsupported `Facet-Version` →
 *     `UnsupportedVersionError`.
 *   - Network-layer failure (DNS, TLS, aborted) → `FetchError`.
 */
export async function fetchAgentsTxt(
  domain: string,
  opts: FetchAgentsTxtOptions = {},
): Promise<AgentsTxt> {
  const url = manifestUrl(domain);
  const now = (opts.now ?? Date.now)();

  if (opts.noCache !== true) {
    const cached = manifestCache.get(url);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.manifest;
    }
  }

  const fetchImpl = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "text/plain, */*" },
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    throw new FetchError(domain, errMessage(err), { cause: err });
  }

  if (res.status === 404) {
    throw new NoManifestError(domain, 404);
  }
  if (!res.ok) {
    throw new FetchError(domain, `HTTP ${res.status}`, { status: res.status });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new FetchError(domain, `failed reading response body: ${errMessage(err)}`, {
      cause: err,
    });
  }

  let manifest: AgentsTxt;
  try {
    manifest = parseAgentsTxt(text);
  } catch (err) {
    if (err instanceof AgentsTxtError) {
      throw new InvalidManifestError(domain, err.message, err);
    }
    throw new InvalidManifestError(domain, "parser threw an unexpected error", err);
  }

  if (!isSupportedVersion(manifest.facetVersion)) {
    throw new UnsupportedVersionError(domain, manifest.facetVersion);
  }

  const ttlMs = resolveTtlMs(res.headers.get("cache-control"), opts.ttlMs);
  if (ttlMs > 0) {
    manifestCache.set(url, { manifest, expiresAt: now + ttlMs });
  }

  return manifest;
}

export interface DiscoverAndConnectOptions {
  /** Fallback TTL for the manifest fetch (overridden by `Cache-Control`). Default: 1h. */
  readonly ttlMs?: number;
  /**
   * Capabilities the manifest must advertise. The check is satisfied
   * when every entry in `capabilityCheck` appears in
   * `manifest.capabilities`. Any miss throws `CapabilityMismatchError`.
   * Empty / undefined skips the check.
   */
  readonly capabilityCheck?: readonly string[];
  /** AbortSignal threaded into the manifest fetch. */
  readonly signal?: AbortSignal;
  /**
   * Custom fetch implementation, passed to both the manifest fetch
   * and the returned `FacetClient`. Defaults to `globalThis.fetch`.
   */
  readonly fetch?: typeof fetch;
  /** KYA bearer token (or async provider) for the returned `FacetClient`. */
  readonly kyaToken?: KyaTokenProvider;
  /** Per-request timeout passed to the returned `FacetClient`. */
  readonly timeoutMs?: number;
  /** User-Agent passed to the returned `FacetClient`. */
  readonly userAgent?: string;
}

/**
 * One-call agent entry point: fetch the manifest at `domain`, validate
 * it, optionally verify the advertised capability set, and return a
 * configured `FacetClient` (the per-merchant Terminal handle) pointed at
 * the manifest's `Terminal` URL.
 *
 * The returned client is identical to one constructed manually via
 * `new FacetClient({ terminalUrl: manifest.terminal, ... })`.
 */
export async function discoverAndConnect(
  domain: string,
  opts: DiscoverAndConnectOptions = {},
): Promise<FacetClient> {
  const manifest = await fetchAgentsTxt(domain, {
    ...(opts.ttlMs !== undefined && { ttlMs: opts.ttlMs }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
  });

  if (opts.capabilityCheck !== undefined && opts.capabilityCheck.length > 0) {
    const advertised = manifest.capabilities ?? [];
    const missing = opts.capabilityCheck.filter((cap) => !advertised.includes(cap));
    if (missing.length > 0) {
      throw new CapabilityMismatchError(domain, opts.capabilityCheck, advertised, missing);
    }
  }

  const clientOpts: FacetClientOptions = {
    terminalUrl: manifest.terminal,
    ...(opts.kyaToken !== undefined && { kyaToken: opts.kyaToken }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
    ...(opts.userAgent !== undefined && { userAgent: opts.userAgent }),
  };
  return new FacetClient(clientOpts);
}

// ── internals ──────────────────────────────────────────────────────────────

function manifestUrl(domain: string): string {
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    const u = new URL(domain);
    return `${u.origin}/.well-known/agents.txt`;
  }
  return `https://${domain}/.well-known/agents.txt`;
}

function isSupportedVersion(v: string): v is SupportedFacetVersion {
  return (SUPPORTED_FACET_VERSIONS as readonly string[]).includes(v);
}

function resolveTtlMs(cacheControl: string | null, ttlOverrideMs: number | undefined): number {
  if (cacheControl !== null) {
    if (/(?:^|,)\s*no-(?:cache|store)\b/i.test(cacheControl)) return 0;
    const m = cacheControl.match(/max-age\s*=\s*(\d+)/i);
    if (m !== null) {
      const seconds = Number.parseInt(m[1] as string, 10);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
  }
  return ttlOverrideMs ?? DEFAULT_TTL_MS;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
