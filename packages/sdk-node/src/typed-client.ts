// Typed wire-surface entry point.
//
// `createTerminalClient` returns an `openapi-fetch` client typed against
// the Facet Terminal OpenAPI spec. The shape is exactly what `openapi-fetch`
// emits — `{ data, error, response }` per call, with discriminated-
// union narrowing for routes whose request body uses
// `oneOf + discriminator` (e.g. `POST /v1/payments/dispatch`).
//
// The hand-written ergonomic helpers (`discoverAndConnect`,
// `fetchAgentsTxt`, the `FacetClient` from `@facet-llc/client`) stay
// on top of this typed client. They remain the recommended path for
// callers; the typed client is exposed for callers that want a thin
// per-route handle without any wrapper allocation overhead.
//
// `paths`, `components`, and `operations` are the openapi-typescript-
// generated namespaces. Re-exported from `index.ts` so consumers can
// `import type { components } from "@facet-llc/sdk-node"` and pluck
// schemas without referencing the internal `./generated/schema.d.ts`
// path.

import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "./generated/schema.d.ts";

export type { paths, components, operations } from "./generated/schema.d.ts";

export type TerminalClient = Client<paths>;

export interface CreateTerminalClientOptions {
  /**
   * Base URL of the Facet Terminal (e.g.
   * `https://terminal.facet.llc`). Trailing slashes are tolerated.
   */
  readonly baseUrl: string;
  /**
   * Optional KYA bearer token or async provider. When provided, every
   * request is sent with `Authorization: Bearer <token>`. Endpoints
   * marked `security: [{}]` (the meta + discovery surface) ignore the
   * header; the rest require it.
   */
  readonly kyaToken?: string | (() => string | Promise<string>);
  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`. Useful
   * for tests and for agents that route through a proxy / mTLS pool.
   */
  readonly fetch?: (input: Request) => Promise<Response>;
  /**
   * `User-Agent` header value. Defaults to `@facet-llc/sdk-node`.
   */
  readonly userAgent?: string;
  /**
   * Extra headers merged into every request. Useful for callers that
   * need to thread a tenant header, an attestation, or a custom
   * `X-Facet-Trace-Id` upstream.
   */
  readonly headers?: Record<string, string>;
}

/**
 * Build a typed `openapi-fetch` client pointed at a Facet Terminal.
 *
 * ```ts
 * import { createTerminalClient } from "@facet-llc/sdk-node";
 * const c = createTerminalClient({ baseUrl: "https://terminal.facet.llc" });
 * const { data, error } = await c.GET("/v1/health");
 * if (error) throw error;
 * console.log(data.status); // "ok"
 * ```
 *
 * Per-call init shape (params, body, headers, signal) matches the
 * `openapi-fetch` contract; see the .d.ts shipped with openapi-fetch
 * for the full type surface.
 */
export function createTerminalClient(opts: CreateTerminalClientOptions): TerminalClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const userAgent = opts.userAgent ?? "@facet-llc/sdk-node";

  // openapi-fetch's `fetch` option takes a `(input: Request) => …`
  // signature, which differs from the spec-fetch `(input: RequestInfo |
  // URL, init?) => …` overload. We resolve the KYA token lazily inside
  // a custom fetch so callers can pass an async provider without
  // having to await before each call.
  const tokenProvider = opts.kyaToken;
  const userFetch = opts.fetch;
  const extraHeaders = opts.headers ?? {};

  const fetchImpl: (input: Request) => Promise<Response> = async (input) => {
    const headers = new Headers(input.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    if (tokenProvider !== undefined && !headers.has("authorization")) {
      const token = typeof tokenProvider === "string" ? tokenProvider : await tokenProvider();
      headers.set("authorization", `Bearer ${token}`);
    }
    const next = new Request(input, { headers });
    return userFetch !== undefined ? userFetch(next) : fetch(next);
  };

  const clientOptions: ClientOptions = {
    baseUrl,
    fetch: fetchImpl,
  };
  return createClient<paths>(clientOptions);
}
