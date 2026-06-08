# Contributing to Facet SDK

Thanks for the interest. This repository is the open-source mirror of the Facet SDK monorepo. Production development happens against the canonical source in a private monorepo; this repo is mirrored on each release and accepts PRs that flow back upstream.

## Ground rules

- **Spec changes belong at [`facet-llc/spec`](https://github.com/facet-llc/spec).** This repo is the runnable implementation; the wire protocol is defined there. Don't change protocol types here without a corresponding spec PR.
- **Every PR must pass `pnpm ci`** — install, lint, typecheck, test.
- **Apache-2.0 only.** All contributions are accepted under the project license. By submitting a PR you certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Local setup

```bash
git clone https://github.com/facet-llc/sdk.git
cd sdk
pnpm install
pnpm ci
```

Requirements: Node 20+, pnpm 10+.

## Workflow

1. Fork + branch from `main`.
2. Make your change. Add or update tests under `packages/<name>/test/`.
3. Run `pnpm ci` locally. All must pass.
4. Open a PR with a clear description of the change and why.
5. CI runs on every push. Once green and reviewed, we'll merge.

## Reporting issues

- **Bugs**: open an issue with a minimal reproduction.
- **Security**: see [SECURITY.md](./SECURITY.md) — do NOT file public issues for vulnerabilities.

## Release cadence

Packages are versioned independently using semver. Releases are coordinated from the upstream monorepo; this mirror gets a single `release: vX.Y.Z` commit per release with the version bumps + a CHANGELOG entry.
