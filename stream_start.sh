#!/usr/bin/env bash
# Usage: stream_start.sh <artifact_id> [note] [--md]
#        stream_start.sh <artifact_id> --md
# Starts live writing: anyone with the page open now watches the page appear as you write it.
# Default mode is html (document.write paint). Pass --md for Claude-like Markdown source+preview.
# Then pipe each section into stream_append.sh as you write it, and publish .drafts/<artifact_id>.html
# with publish.sh / publish_edit.sh / artifact_put.sh (publishing ends the live view automatically).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 1 ] || { echo "usage: $0 <artifact_id> [note] [--md]" >&2; exit 2; }
ID="$1"; shift
NOTE=""; MODE="html"
for arg in "$@"; do
  if [ "$arg" = "--md" ] || [ "$arg" = "md" ]; then MODE="md"
  elif [ -z "$NOTE" ]; then NOTE="$arg"
  else NOTE="$NOTE $arg"
  fi
done
mkdir -p "$DIR/.drafts"
if [ "$MODE" = "md" ]; then : > "$DIR/.drafts/$ID.md"; : > "$DIR/.drafts/$ID.html"
else : > "$DIR/.drafts/$ID.html"
fi
BODY=$(node -e 'const note=process.argv[1]||undefined,mode=process.argv[2];const o={op:"start"};if(note)o.note=note;if(mode==="md")o.mode="md";process.stdout.write(JSON.stringify(o))' "$NOTE" "$MODE")
curl -sS -f -X POST "$BASE/api/admin/artifacts/$ID/draft" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' --data-binary "$BODY" >/dev/null
echo "live draft started (mode=$MODE); file: $DIR/.drafts/$ID.$([ "$MODE" = md ] && echo md || echo html)"
