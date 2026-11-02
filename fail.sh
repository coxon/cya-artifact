#!/usr/bin/env bash
# Usage: fail.sh <job_id> <reason...>
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 2 ] || { echo "usage: $0 <job_id> <reason>" >&2; exit 2; }
JOB="$1"; shift
REASON="$(node -e 'console.log(JSON.stringify({reason:process.argv.slice(1).join(" ")}))' "$@")"
curl -sS --fail-with-body -X POST "$BASE/api/admin/jobs/$JOB/fail" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data "$REASON"
echo
