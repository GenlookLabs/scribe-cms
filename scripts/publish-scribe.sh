#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Building scribe-cms..."
pnpm --filter scribe-cms build

echo "Running tests..."
pnpm --filter scribe-cms test

if [[ -n "${CI:-}" && -z "${NPM_TOKEN:-}" ]]; then
  echo "Error: NPM_TOKEN is required in CI to publish." >&2
  exit 1
fi

if [[ -z "${CI:-}" ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    echo "Error: not logged in to npm. Run 'npm login' first." >&2
    exit 1
  fi
fi

echo "Publishing scribe-cms..."
pnpm --filter scribe-cms publish:npm

echo "Done."
