#!/usr/bin/env bash
# Usage: stream_append.sh <artifact_id> [file]      (reads the section from stdin when no file is given)
# Appends freshly written HTML to .drafts/<artifact_id>.html AND streams it to everyone watching.
# Prefer small, frequent appends (sentence / short paragraph). Large pipes are auto-split into
# denser live chunks (~120 chars, broken on whitespace) so the viewer sees a Claude-like stream.
# Append in page order: <!doctype>/<head>/<style> first, then body text top to bottom, <script> last.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/artifact_env.sh"
[ $# -ge 1 ] || { echo "usage: $0 <artifact_id> [file]  (or pipe the section on stdin)" >&2; exit 2; }
ID="$1"; SRC="${2:--}"; F="$DIR/.drafts/$ID.html"
[ -f "$F" ] || { echo "no live draft file $F: run stream_start.sh $ID first" >&2; exit 2; }
CH="$(mktemp)"; RES="$(mktemp)"; trap 'rm -f "$CH" "$RES"' EXIT
if [ "$SRC" = "-" ]; then cat > "$CH"; else cat "$SRC" > "$CH"; fi
[ -s "$CH" ] || { echo "empty section, nothing appended" >&2; exit 0; }
cat "$CH" >> "$F"
# Split into denser live pieces (keeps .drafts whole; only the wire is chunked). Never fake a finished file.
node - "$CH" "$DIR" "$ID" "$BASE" "$RES" <<'NODE'
const fs = require("fs"), https = require("https"), http = require("http");
const [chunkPath, dir, id, base, resPath] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
const raw = fs.readFileSync(chunkPath, "utf8");
const TARGET = 120;
function pieces(s) {
  // atoms that must travel whole: everything up to and including <body…> (head, styles, fonts), and any <style>/<script>/<svg> block
  const atoms = [];
  let rest = s;
  const bm = /<body\b[^>]*>/i.exec(rest);
  if (bm && /<head\b|<style\b|<!doctype/i.test(rest.slice(0, bm.index))) { atoms.push({ whole: rest.slice(0, bm.index + bm[0].length) }); rest = rest.slice(bm.index + bm[0].length); }
  const re = /<(style|script|svg)\b[\s\S]*?<\/\1\s*>/gi; let last = 0, m;
  while ((m = re.exec(rest))) { if (m.index > last) atoms.push({ text: rest.slice(last, m.index) }); atoms.push({ whole: m[0] }); last = m.index + m[0].length; }
  if (last < rest.length) atoms.push({ text: rest.slice(last) });
  const out = [];
  for (const a of atoms) {
    if (a.whole != null) { out.push(a.whole); continue; }
    const t = a.text; let i = 0;
    while (i < t.length) {
      if (t.length - i <= TARGET * 1.5) { out.push(t.slice(i)); break; }
      let end = i + TARGET;
      const lt = t.lastIndexOf("<", end), gtAfter = t.indexOf(">", lt);
      if (lt >= i && gtAfter >= end) end = gtAfter + 1; // don't cut inside a tag
      else { const br = Math.max(t.lastIndexOf(" ", end), t.lastIndexOf("\n", end)); if (br > i + 40) end = br + 1; }
      out.push(t.slice(i, end)); i = end;
    }
  }
  return out.filter((x) => x.length);
}
const parts = pieces(raw);
const url = new URL(base + "/api/admin/artifacts/" + id + "/draft");
const lib = url.protocol === "https:" ? https : http;
function post(chunk) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ op: "append", chunk });
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname, method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (res) => {
      const bufs = []; res.on("data", d => bufs.push(d));
      res.on("end", () => resolve({ code: res.statusCode, body: Buffer.concat(bufs).toString("utf8") }));
    });
    req.on("error", reject); req.write(body); req.end();
  });
}
(async () => {
  let last = null, code = 0;
  for (let i = 0; i < parts.length; i++) {
    const r = await post(parts[i]);
    code = r.code; last = r.body;
    if (r.code !== 200) break;
    if (i + 1 < parts.length) await new Promise(r => setTimeout(r, 35));
  }
  fs.writeFileSync(resPath, last || "");
  if (code === 200) {
    const j = JSON.parse(last);
    console.log("streamed " + parts.length + " live piece(s), seq " + j.seq + " (" + j.bytes + " bytes so far)");
    process.exit(0);
  }
  console.error("warning: live stream rejected (HTTP " + code + "): " + (last || ""));
  console.error("the section IS saved in " + dir + "/.drafts/" + id + ".html; keep going (publish as usual)");
  process.exit(1);
})().catch(() => {
  console.error("live stream request failed; the section remains saved in the local draft");
  process.exit(1);
});
NODE
