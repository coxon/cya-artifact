#!/usr/bin/env bash
# Local-only API regression; creates its own fixture and returns failure status.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node tests/api_test.mjs
