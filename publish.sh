#!/usr/bin/env bash
# Usage: publish.sh <job_id> <html_file> [title]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 2 ] || { echo "usage: $0 <job_id> <html_file> [title]" >&2; exit 2; }
JOB="$1"; FILE="$2"; TITLE="${3:-}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 2; }
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[3],JSON.stringify({html:fs.readFileSync(process.argv[1],"utf8"),title:process.argv[2]}))' "$FILE" "$TITLE" "$BODY"
curl -sS --fail-with-body -X POST "$BASE/api/admin/jobs/$JOB/publish" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data-binary @"$BODY"
echo
