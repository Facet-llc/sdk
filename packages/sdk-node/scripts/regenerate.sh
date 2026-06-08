#!/usr/bin/env bash
# Regenerate `src/generated/schema.d.ts` from the canonical
# `openapi/openapi.yaml`. Idempotent — running twice produces no diff
# unless the spec changed.
#
# Phase 8 of openapi-as-contract. The generated file is the typed wire
# surface for `openapi-fetch`; the hand-written ergonomic helpers
# (`discoverAndConnect`, `verifyResponseSignature`, `parseAgentsTxt`)
# live alongside it in `src/` and stay hand-maintained.
#
# Run: `bash packages/sdk-node/scripts/regenerate.sh`

set -euo pipefail

# Resolve the package directory regardless of where the script is invoked from.
pkg_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "${pkg_dir}/../.." && pwd)"
spec="${repo_root}/openapi/openapi.yaml"
out="${pkg_dir}/src/generated/schema.d.ts"

if [ ! -f "${spec}" ]; then
  echo "openapi/openapi.yaml not found at ${spec}" >&2
  echo "Build the OpenAPI spec first." >&2
  exit 1
fi

mkdir -p "$(dirname "${out}")"

# openapi-typescript is a dev dep of @facet-llc/sdk-node. Use pnpm exec
# so the local binary is picked up regardless of the operator's PATH.
cd "${pkg_dir}"
pnpm exec openapi-typescript "${spec}" -o "${out}" \
  --export-type \
  --default-non-nullable

line_count=$(wc -l < "${out}" | tr -d '[:space:]')
echo "sdk-node: regenerated ${out} (${line_count} lines)"
