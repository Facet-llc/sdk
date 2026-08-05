# @facet-llc/sdk-node

Agent-side discovery SDK for the Facet protocol. Node 20+.

The one-call entry point an agent needs to connect to any Facet-protected merchant. Fetches `/.well-known/agents.txt`, validates the v1.1 / v1.2 manifest, optionally verifies the advertised capability set, and returns a configured Facet Terminal client.

For the Deno port see [`@facet-llc/sdk-deno`](https://www.npmjs.com/package/@facet-llc/sdk-deno).

## Install

```bash
npm install @facet-llc/sdk-node
# pulls @facet-llc/client and @facet-llc/adapter as runtime deps
```

## Quick start

```ts
import { discoverAndConnect } from "@facet-llc/sdk-node";

const client = await discoverAndConnect("merchant.example.com", {
  capabilityCheck: ["catalog"],
  kyaToken: async () => issuer.mintToken(),
});

const caps = await client.capabilities();
const results = await client.search({ query: "vanilla", limit: 10 });
```

The returned `client` is a `FacetClient` from [`@facet-llc/client`](https://www.npmjs.com/package/@facet-llc/client). Same surface, same headers, same error envelope. The only difference vs constructing one manually is that `terminalUrl` is read from the manifest instead of hard-coded.

## API

### `fetchAgentsTxt(domain, opts?)`

```ts
import { fetchAgentsTxt, type AgentsTxt } from "@facet-llc/sdk-node";

const manifest: AgentsTxt = await fetchAgentsTxt("merchant.example.com");
console.log(manifest.terminal); // "https://api.merchant.example.com/v1"
console.log(manifest.capabilities); // ["catalog", "paywalled-content"]
```

Fetches `https://<domain>/.well-known/agents.txt`, runs it through the v1.2 parser in `@facet-llc/adapter`, and returns the typed manifest. The response is cached in-process.

Cache semantics:

- Honors `Cache-Control: max-age=N` from the response.
- Honors `Cache-Control: no-cache` / `no-store` (bypass cache).
- Falls back to `opts.ttlMs` (default 1h) when no `Cache-Control` is set.
- `clearAgentsTxtCache(domain?)` clears the cache (all entries, or one).

Options:

| Option    | Type           | Notes                                                                   |
| --------- | -------------- | ----------------------------------------------------------------------- |
| `ttlMs`   | `number`       | Fallback TTL when `Cache-Control` is absent. Default: `3_600_000` (1h). |
| `signal`  | `AbortSignal`  | Aborts the in-flight fetch.                                             |
| `fetch`   | `typeof fetch` | Override (defaults to `globalThis.fetch`).                              |
| `noCache` | `boolean`      | Bypass cache for this call (still writes to cache afterwards).          |
| `now`     | `() => number` | Timestamp source (testing).                                             |

### `discoverAndConnect(domain, opts?)`

```ts
import { discoverAndConnect } from "@facet-llc/sdk-node";

const client = await discoverAndConnect("merchant.example.com", {
  capabilityCheck: ["catalog", "paywalled-content"],
  kyaToken: "<kya-token-jwt>",
});
```

Chains `fetchAgentsTxt` with a configured Terminal client.

Options:

| Option            | Type                              | Notes                                                                                   |
| ----------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| `ttlMs`           | `number`                          | Same as `fetchAgentsTxt`.                                                               |
| `capabilityCheck` | `readonly string[]`               | Every entry must appear in `manifest.capabilities` or `CapabilityMismatchError` throws. |
| `signal`          | `AbortSignal`                     | Threaded into the manifest fetch.                                                       |
| `fetch`           | `typeof fetch`                    | Passed to both the manifest fetch and the returned client.                              |
| `kyaToken`        | `string \| () => Promise<string>` | Passed to the returned client.                                                          |
| `timeoutMs`       | `number`                          | Per-request timeout on the returned client.                                             |
| `userAgent`       | `string`                          | User-Agent on the returned client.                                                      |

## Errors

Every failure throws a named, typed error:

| Error                     | Cause                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `NoManifestError`         | HTTP 404 on `/.well-known/agents.txt`.                                   |
| `InvalidManifestError`    | Parser rejected the body (malformed, missing required fields).           |
| `UnsupportedVersionError` | `Facet-Version` is not one of `0.2`, `1.0`, `1.1`, `1.2`.                |
| `FetchError`              | Non-2xx response (other than 404), DNS / TLS / abort.                    |
| `CapabilityMismatchError` | `capabilityCheck` includes a capability the manifest does not advertise. |

```ts
import {
  CapabilityMismatchError,
  NoManifestError,
  UnsupportedVersionError,
  discoverAndConnect,
} from "@facet-llc/sdk-node";

try {
  const client = await discoverAndConnect("merchant.example.com", {
    capabilityCheck: ["auction"],
  });
} catch (e) {
  if (e instanceof NoManifestError) {
    // Site is not Facet-enabled. Fall back to direct HTTP scraping.
  } else if (e instanceof UnsupportedVersionError) {
    // Manifest predates v0.2. Site needs to upgrade.
  } else if (e instanceof CapabilityMismatchError) {
    console.log("advertised:", e.advertised, "missing:", e.missing);
  }
}
```

## Supported `Facet-Version` values

v0.2, v1.0, v1.1, and v1.2 documents are all accepted. The parser handles the additive evolution. Anything outside that set throws `UnsupportedVersionError`.

The constant `SUPPORTED_FACET_VERSIONS` is exported for callers that want to surface it.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
