#!/usr/bin/env bash
# Usage: artifact_put.sh <artifact_id> <html_file> <base_version> [note] [author]   (or AUTHOR=...; e.g. "Cya.Editor")
# Publishes a new version (source "cya") keeping all shared state. Exit 3 = stale: re-fetch, re-apply, retry.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 3 ] || { echo "usage: $0 <artifact_id> <html_file> <base_version> [note] [author]" >&2; exit 2; }
ID="$1"; FILE="$2"; BV="$3"; NOTE="${4:-}"; WHO="${5:-${AUTHOR:-}}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 2; }
BODY="$(mktemp)"; RES="$(mktemp)"; trap 'rm -f "$BODY" "$RES"' EXIT
node -e 'const fs=require("fs");const b={html:fs.readFileSync(process.argv[1],"utf8"),base_version:Number(process.argv[2]),source:"cya"};if(process.argv[3])b.note=process.argv[3];if(process.argv[5])b.author=process.argv[5];fs.writeFileSync(process.argv[4],JSON.stringify(b))' "$FILE" "$BV" "$NOTE" "$BODY" "$WHO"
CODE=$(curl -sS -o "$RES" -w '%{http_code}' -X POST "$BASE/api/admin/artifacts/$ID/html" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data-binary @"$BODY")
cat "$RES"; echo
[ "$CODE" = 200 ] && exit 0
[ "$CODE" = 409 ] && { echo "STALE: page changed since v$BV. Re-run artifact_get.sh $ID, re-apply, retry." >&2; exit 3; }
exit 1
