#!/usr/bin/env bash
# Usage: stream_end.sh <artifact_id>
# Stops the live view WITHOUT publishing (use when you give up or restart). Viewers go back to the current page.
# Not needed after publishing: publish.sh / publish_edit.sh / artifact_put.sh end the live view by themselves.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 1 ] || { echo "usage: $0 <artifact_id>" >&2; exit 2; }
curl -sS -f -X POST "$BASE/api/admin/artifacts/$1/draft" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' --data-binary '{"op":"end"}' >/dev/null
echo "live view stopped (nothing published)"
