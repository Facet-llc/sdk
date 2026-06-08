# Changelog

All notable changes to `@facet-llc/sdk-node` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Typed wire surface generated from
  `openapi/openapi.yaml`.** New exports:
  - `createTerminalClient(opts)` — builds an `openapi-fetch` client
    typed against the canonical spec. `.GET("/v1/health")` etc. return
    `{ data, error, response }` with discriminated-union narrowing for
    routes whose request body uses `oneOf + discriminator` (e.g.
    `POST /v1/payments/dispatch`).
  - Type-only re-exports: `paths`, `components`, `operations`,
    `CreateTerminalClientOptions`, `TypedTerminalClient`.
- New dev script `scripts/regenerate.sh` that re-emits
  `src/generated/schema.d.ts` from the spec. Idempotent — running
  twice produces no diff unless the spec changed.
- Smoke test suite (`test/smoke.test.ts`) that drives the typed client
  against a live Facet Terminal — kept in a separate
  `vitest.smoke.config.ts` so the default run stays offline. Override
  the target with `FACET_SMOKE_BASE_URL`.

### Changed

- **Public API unchanged.** `discoverAndConnect`, `fetchAgentsTxt`,
  `TerminalClient` (the `FacetClient` re-alias), and the typed error
  classes (`NoManifestError`, `InvalidManifestError`,
  `UnsupportedVersionError`, `FetchError`, `CapabilityMismatchError`,
  `SUPPORTED_FACET_VERSIONS`) are all retained with identical shape
  and behavior.
- The hand-written ergonomic helpers stay the recommended entry point;
  the new typed client is exposed for callers that want a thin
  per-route handle without wrapper allocation overhead.

### Dependencies

- Added `openapi-fetch@0.17.0` (runtime, exact-pinned).
- Added `openapi-typescript@7.13.0` (dev, exact-pinned).
- Both deps are exact-pinned per the package's supply-chain policy.
