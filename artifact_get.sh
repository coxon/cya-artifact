#!/usr/bin/env bash
# Usage:
#   artifact_get.sh <artifact_id> > current.html   # raw HTML on stdout; "version=N  title=…" on stderr
#   artifact_get.sh --json <artifact_id>           # JSON on stdout: {"id","version","title","html"}
#   artifact_get.sh --version <artifact_id>        # just the version number (use as base_version)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
MODE=html; case "${1:-}" in --json) MODE=json; shift;; --version) MODE=version; shift;; esac
[ $# -ge 1 ] || { echo "usage: $0 [--json|--version] <artifact_id>   (default: raw HTML to stdout, version to stderr)" >&2; exit 2; }
curl -sS --fail-with-body "$BASE/api/admin/artifacts/$1/html" -H "Authorization: Bearer $ADMIN_TOKEN" |
  MODE=$MODE ID="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s),m=process.env.MODE;
    if(m==="json")process.stdout.write(JSON.stringify({id:process.env.ID,version:j.version,title:j.title,html:j.html||""})+"\n");
    else if(m==="version")process.stdout.write(j.version+"\n");
    else{console.error("version="+j.version+"  title="+j.title);process.stdout.write(j.html||"")}})'
