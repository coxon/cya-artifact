#!/usr/bin/env bash
# Usage: edit_fetch.sh <job_id> > current.html
# Writes the artifact's CURRENT HTML to stdout; prints the job (comments, base version) to stderr,
# and remembers the base version in .edits/<job_id>.base for publish_edit.sh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 1 ] || { echo "usage: $0 <job_id> > file.html" >&2; exit 2; }
JOB="$1"; mkdir -p "$DIR/.edits"; chmod 700 "$DIR/.edits"
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
curl -sS --fail-with-body "$BASE/api/admin/jobs/$JOB" -H "Authorization: Bearer $ADMIN_TOKEN" > "$OUT"
node -e '
const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(j.kind!=="edit"){console.error("not an edit job (kind="+j.kind+")");process.exit(3)}
fs.writeFileSync(process.argv[2],String(j.current_version));
const {html,...rest}=j; console.error(JSON.stringify(rest,null,2)); console.error("base_version="+j.current_version);
process.stdout.write(html||"");' "$OUT" "$DIR/.edits/$JOB.base"
