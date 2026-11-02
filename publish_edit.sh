#!/usr/bin/env bash
# Usage: publish_edit.sh <job_id> <html_file> [note] [author]
# author = who answered (shown on the comment and in history), e.g. "Cya.Editor"; or set AUTHOR=...; server default "Assistant".
# Publishes an edit with the base version recorded by edit_fetch.sh (override: BASE_VERSION=N).
# Exit 3 = stale (someone changed the page meanwhile): run edit_fetch.sh again, re-apply the change, retry.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 2 ] || { echo "usage: $0 <job_id> <html_file> [note] [author]" >&2; exit 2; }
JOB="$1"; FILE="$2"; NOTE="${3:-}"; WHO="${4:-${AUTHOR:-}}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 2; }
BV="${BASE_VERSION:-$(cat "$DIR/.edits/$JOB.base" 2>/dev/null || true)}"
[ -n "$BV" ] || { echo "no base version: run edit_fetch.sh $JOB first (or set BASE_VERSION)" >&2; exit 2; }
BODY="$(mktemp)"; RES="$(mktemp)"; trap 'rm -f "$BODY" "$RES"' EXIT
node -e 'const fs=require("fs");const b={html:fs.readFileSync(process.argv[1],"utf8"),base_version:Number(process.argv[2])};if(process.argv[3])b.note=process.argv[3];if(process.argv[5])b.author=process.argv[5];fs.writeFileSync(process.argv[4],JSON.stringify(b))' "$FILE" "$BV" "$NOTE" "$BODY" "$WHO"
CODE=$(curl -sS -o "$RES" -w '%{http_code}' -X POST "$BASE/api/admin/jobs/$JOB/publish" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data-binary @"$BODY")
cat "$RES"; echo
[ "$CODE" = 200 ] && { rm -f "$DIR/.edits/$JOB.base"; exit 0; }
[ "$CODE" = 409 ] && { echo "STALE: page changed since v$BV. Re-run edit_fetch.sh $JOB, merge, publish again." >&2; exit 3; }
exit 1
