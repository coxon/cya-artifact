import { DurableObject } from "cloudflare:workers";

const SDK = __SDK_SOURCE__;
const SDK_OFFLINE = __SDK_OFFLINE__;
const BRIDGE = __BRIDGE__;
const HOST_JS = __HOST_JS__;
const ASSET_HASHES = __ASSET_HASHES__;

function assetResponse(req, url, source, hash) {
  const etag = `"${hash}"`;
  const headers = {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": url.searchParams.get("v") === hash ? "public, max-age=31536000, immutable" : "no-cache",
    etag,
  };
  // If-None-Match uses weak comparison for GET/HEAD, including lists and '*'.
  const matches = (req.headers.get("if-none-match") || "").split(",").some(value => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
  if ((req.method === "GET" || req.method === "HEAD") && matches) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : source, { headers });
}
const MAX_STATE = 1024 * 1024;          // 1 MB total shared state per artifact
const MAX_MSG = 256 * 1024;             // 256 KB per websocket message
const MAX_HTML = 1536 * 1024;
const DRAFT_TTL = 15 * 60 * 1000;        // a live draft with no appends for 15 min is dropped           // 1.5 MB generated HTML
const MAX_CONTEXT = 200 * 1024;         // 200 KB context text
const MAX_INSTR = 10 * 1024;            // 10 KB instructions
const DEFAULT_DAILY = 20;
const EDIT_DAILY = 30;               // Edit jobs per artifact per 24h

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function rid(n) {
  let out = "";
  while (out.length < n) {
    const buf = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of buf) { if (b < 248 && out.length < n) out += B62[b % 62]; }
  }
  return out;
}
const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => Date.now();
// Names are optional user-facing strings, never object coercions such as "[object Object]".
const authorName = (value) => typeof value === "string" ? value.trim().slice(0, 60) || null : null;

// A legacy label is usable only when it names exactly one positive comment number.
function commentNumber(text) {
  const matches = [...text.matchAll(/评论\s*([0-9]+)(?=$|\s|[·•|｜,，:：;；。!?！？)\]】）])/g)];
  if (matches.length !== 1) return null;
  const n = Number(matches[0][1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function chipText(text) {
  // HTMLRewriter text chunks retain character references. Decode only text, never markup.
  return text.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|nbsp|Tab|NewLine);/gi, (entity, num) => {
    if (!num) return " ";
    const cp = /^x/i.test(num) ? parseInt(num.slice(1), 16) : Number(num);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : entity;
  });
}
async function bindCommentChips(html, comments) {
  if (!comments.length) return html;
  const chips = [], active = [];
  // Read labels through the HTML parser, including nested formatting and streamed text chunks.
  // A second pass can update the opening tag without replacing or reserializing its contents.
  await new HTMLRewriter().on(".by", {
    element(el) {
      const chip = { cid: (el.getAttribute("data-cid") || "").trim(), text: "", closed: false };
      chips.push(chip);
      if (/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(el.tagName)) return;
      active.push(chip);
      el.onEndTag(() => { chip.closed = true; active.splice(active.indexOf(chip), 1); });
    },
  }).onDocument({ text(chunk) { for (const chip of active) chip.text += chunk.text; } }).transform(new Response(html)).text();
  const bindings = chips.map((chip) => {
    if (chip.cid || !chip.closed) return null; // Explicit IDs are authoritative, even when unknown.
    const n = commentNumber(chipText(chip.text));
    return n == null ? null : comments[n - 1]?.id || null;
  });
  if (!bindings.some(Boolean)) return html;
  let index = 0;
  return new HTMLRewriter().on(".by", { element(el) {
    const cid = bindings[index++];
    if (cid) el.setAttribute("data-cid", cid);
  } }).transform(new Response(html)).text();
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

/* ---------------- Index DO: invites + jobs (single instance "index") ---------------- */
function addCol(sql, table, col, type) {
  const cols = sql.exec(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((r) => r.name);
  if (!cols.includes(col)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
export class IndexDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, label TEXT, daily_limit INTEGER NOT NULL, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, status TEXT NOT NULL, instructions TEXT, context_text TEXT, context_url TEXT, invite_code TEXT, title TEXT, reason TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
      addCol(sql, "jobs", "kind", "TEXT NOT NULL DEFAULT 'new'");
      addCol(sql, "jobs", "notified", "TEXT");
      sql.exec(`CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS jobs_invite ON jobs(invite_code, created)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS jobs_artifact ON jobs(artifact_id, kind, created)`);
    });
  }
  createInvite(label, daily_limit) {
    const code = rid(12);
    this.ctx.storage.sql.exec(`INSERT INTO invites (code,label,daily_limit,created) VALUES (?,?,?,?)`, code, label || "", daily_limit || DEFAULT_DAILY, now());
    return { code, label: label || "", daily_limit: daily_limit || DEFAULT_DAILY };
  }
  listInvites() {
    const since = now() - 86400000;
    return this.ctx.storage.sql.exec(`SELECT i.code,i.label,i.daily_limit,i.created,i.revoked,(SELECT COUNT(*) FROM jobs j WHERE j.invite_code=i.code AND j.created>?) AS used_24h,(SELECT COUNT(*) FROM jobs j WHERE j.invite_code=i.code) AS total FROM invites i ORDER BY created`, since).toArray();
  }
  revokeInvite(code) { return this.ctx.storage.sql.exec(`UPDATE invites SET revoked=1 WHERE code=?`, code).rowsWritten > 0; }
  createJob({ invite, instructions, context_text, context_url }) {
    const sql = this.ctx.storage.sql;
    const inv = sql.exec(`SELECT * FROM invites WHERE code=?`, invite).toArray()[0];
    if (!inv || inv.revoked) return { error: "invalid_invite", status: 403 };
    const used = sql.exec(`SELECT COUNT(*) AS n FROM jobs WHERE invite_code=? AND created>?`, invite, now() - 86400000).one().n;
    if (used >= inv.daily_limit) return { error: "rate_limited", status: 429, limit: inv.daily_limit };
    const job_id = "j" + rid(15), artifact_id = rid(10), t = now();
    sql.exec(`INSERT INTO jobs (id,artifact_id,status,kind,instructions,context_text,context_url,invite_code,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      job_id, artifact_id, "pending", "new", instructions, context_text, context_url, invite, t, t);
    return { job_id, artifact_id, created: t };
  }
  createEditJob(artifact_id, instructions) {
    const sql = this.ctx.storage.sql;
    const used = sql.exec(`SELECT COUNT(*) AS n FROM jobs WHERE artifact_id=? AND kind='edit' AND created>?`, artifact_id, now() - 86400000).one().n;
    if (used >= EDIT_DAILY) return { error: "rate_limited", limit: EDIT_DAILY };
    const job_id = "j" + rid(15), t = now();
    sql.exec(`INSERT INTO jobs (id,artifact_id,status,kind,instructions,created,updated) VALUES (?,?,?,?,?,?,?)`, job_id, artifact_id, "pending", "edit", instructions, t, t);
    return { job_id };
  }
  listJobs(status, kind, limit = 50) {
    const where = [], args = [];
    if (status) { where.push("status=?"); args.push(status); }
    if (kind) { where.push("kind=?"); args.push(kind); }
    return this.ctx.storage.sql.exec(`SELECT id,artifact_id,kind,status,title,reason,notified,created,updated,substr(instructions,1,200) AS instructions_preview FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC LIMIT ?`, ...args, limit).toArray();
  }
  getJob(id) { return this.ctx.storage.sql.exec(`SELECT * FROM jobs WHERE id=?`, id).toArray()[0] || null; }
  setJob(id, status, { title = null, reason = null } = {}) {
    this.ctx.storage.sql.exec(`UPDATE jobs SET status=?, title=COALESCE(?,title), reason=?, updated=? WHERE id=?`, status, title, reason, now(), id);
    return this.getJob(id);
  }
  setNotified(id, v) { this.ctx.storage.sql.exec(`UPDATE jobs SET notified=? WHERE id=?`, String(v).slice(0, 200), id); }
}

/* ---------------- Artifact DO: one per artifact (HTML versions + shared state + comments + live sync) ---------------- */
export class ArtifactDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS versions (n INTEGER PRIMARY KEY AUTOINCREMENT, html TEXT NOT NULL, title TEXT, created INTEGER NOT NULL)`);
      addCol(sql, "versions", "source", "TEXT");
      addCol(sql, "versions", "note", "TEXT");
      addCol(sql, "versions", "author", "TEXT");
      addCol(sql, "versions", "sid", "TEXT");
      sql.exec(`CREATE TABLE IF NOT EXISTS draft (seq INTEGER PRIMARY KEY, chunk TEXT NOT NULL, at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, job_id TEXT, selector TEXT, snippet_html TEXT, snippet_text TEXT, request TEXT NOT NULL, author TEXT, status TEXT NOT NULL, reason TEXT, resolved_version INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
      addCol(sql, "comments", "resolved_by", "TEXT");
      if (this._meta("id") && !this._meta("edit_token")) this._setMeta({ edit_token: rid(24) });
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }
  _meta(k) { return this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0]?.v ?? null; }
  _setMeta(obj) { for (const [k, v] of Object.entries(obj)) this.ctx.storage.sql.exec(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v == null ? null : String(v)); }
  init(artifact_id, job_id) { const edit_token = rid(24); this._setMeta({ id: artifact_id, job_id, status: "pending", created: now(), edit_token }); return { edit_token }; }
  info() {
    const rows = this.ctx.storage.sql.exec(`SELECT k,v FROM meta`).toArray();
    const { edit_token, ...m } = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    const ver = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n, MAX(n) AS cur FROM versions`).one();
    const openc = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM comments WHERE status='open'`).one().n;
    return { ...m, versions: ver.n, version: ver.cur, open_comments: openc, state_bytes: this._stateBytes(), presence: this._alive().length };
  }
  checkToken(t) { const tok = this._meta("edit_token"); return !!tok && timingSafeEq(String(t || ""), tok); }
  editToken(rotate) {
    if (!this._meta("id")) return null;
    if (rotate || !this._meta("edit_token")) this._setMeta({ edit_token: rid(24) });
    return this._meta("edit_token");
  }
  setSettings(o) { if ("notify" in o) this._setMeta({ notify: o.notify ? "1" : "0" }); if ("route" in o) this._setMeta({ route: o.route === "editor" ? "editor" : "routine" }); return this.info(); }
  _cur() { return this.ctx.storage.sql.exec(`SELECT n,html,title,source,sid,created FROM versions ORDER BY n DESC LIMIT 1`).toArray()[0] || null; }
  current() { const c = this._cur(); return c ? { html: c.html, version: c.n, title: c.title } : null; }
  // Append a version. Rejects stale base_version unless force. Never touches shared state.
  addVersion({ html, title, source = "generated", note = null, author = null, sid = null, base_version = null, from = null, force = false }) {
    const sql = this.ctx.storage.sql, cur = this._cur();
    author = authorName(author);
    const curN = cur ? cur.n : 0;
    if (!force) {
      if (base_version == null && cur) return { error: "base_version_required", version: curN };
      if (base_version != null && Number(base_version) !== curN) return { error: "stale", version: curN };
    }
    // squash rapid hand-edit autosaves from the same editor session into one history entry
    if (cur && source === "hand" && sid && cur.source === "hand" && cur.sid === sid && now() - cur.created < 120000) sql.exec(`DELETE FROM versions WHERE n=?`, cur.n);
    const t = title == null || title === "" ? (htmlTitle(html) || cur?.title || this._meta("title") || "") : title;
    const n = sql.exec(`INSERT INTO versions (html,title,created,source,note,author,sid) VALUES (?,?,?,?,?,?,?) RETURNING n`, html, t, now(), source, note, author, sid).one().n;
    this._setMeta({ status: "ready", title: t, reason: null, published: now() });
    this._broadcast({ t: "version", v: n, from, source, author });
    if ((source === "generated" || source === "cya") && this._meta("draft_active") === "1") this.draftEnd(true, n);
    return { ok: true, version: n, title: t };
  }
  publish(html, title, author) { return this.addVersion({ html, title, author, source: "generated", force: true }); }
  fail(reason) { this._setMeta({ status: "failed", reason }); this.draftEnd(false); this._live({ t: "status", status: "failed" }); return this.info(); }
  /* live draft: a publisher streams partial HTML while writing; viewers see it in a script-less frame. Never a version. */
  _draftClear() { this.ctx.storage.sql.exec(`DELETE FROM draft`); this._setMeta({ draft_active: "0", draft_mode: null }); }
  _draftLive() {
    if (this._meta("draft_active") !== "1") return null;
    if (now() - (+this._meta("draft_last") || 0) > DRAFT_TTL) { this._draftClear(); return null; }
    return { note: this._meta("draft_note"), started: +this._meta("draft_started") };
  }
  draftStart(note, mode) {
    this._draftClear(); const t = now();
    const m = mode === "md" ? "md" : "html";
    this._setMeta({ draft_active: "1", draft_note: note || null, draft_started: t, draft_last: t, draft_mode: m });
    this._live({ t: "draft", op: "start", note: note || null, mode: m });
    return { ok: true, mode: m };
  }
  draftAppend(chunk) {
    if (!this._draftLive()) return { error: "no_draft" };
    const sql = this.ctx.storage.sql, size = sql.exec(`SELECT COALESCE(SUM(length(chunk)),0) AS n FROM draft`).one().n;
    if (size + chunk.length > MAX_HTML) return { error: "too_large" };
    const seq = sql.exec(`INSERT INTO draft (chunk,at) VALUES (?,?) RETURNING seq`, chunk, now()).one().seq;
    this._setMeta({ draft_last: now() });
    this._live({ t: "draft", op: "append", seq, chunk });
    return { ok: true, seq, bytes: size + chunk.length };
  }
  draftEnd(published, v) {
    const had = this._meta("draft_active") === "1"; this._draftClear();
    if (had) this._live({ t: "draft", op: "end", published: !!published, v: v || null });
    return { ok: true, was_active: had };
  }
  draftGet() {
    const d = this._draftLive(); if (!d) return { active: false };
    const rows = this.ctx.storage.sql.exec(`SELECT seq,chunk FROM draft ORDER BY seq`).toArray();
    const text = rows.map((r) => r.chunk).join("");
    const mode = this._meta("draft_mode") === "md" ? "md" : "html";
    return { active: true, ...d, mode, seq: rows.length ? rows[rows.length - 1].seq : 0, html: text, text };
  }
  listVersions() {
    return { current: this._cur()?.n ?? null, versions: this.ctx.storage.sql.exec(`SELECT n,title,created,COALESCE(source,'generated') AS source,note,author,length(html) AS size FROM versions ORDER BY n DESC LIMIT 300`).toArray() };
  }
  getVersion(n) { return this.ctx.storage.sql.exec(`SELECT n,html,title,source,created FROM versions WHERE n=?`, n).toArray()[0] || null; }
  restore(n, from) {
    const v = this.getVersion(n); if (!v) return { error: "version_not_found" };
    return this.addVersion({ html: v.html, title: v.title, source: "restore", note: `从 v${n} 恢复 restored from v${n}`, from, force: true });
  }
  page() {
    const status = this._meta("status");
    if (status !== "ready") return { status, reason: this._meta("reason"), created: this._meta("created") };
    const c = this._cur();
    return { status, html: c.html, title: c.title, version: c.n, state: this._state() };
  }
  /* comments */
  addComment({ job_id, selector, html, text, request, author }) {
    const id = "c" + rid(10), t = now();
    this.ctx.storage.sql.exec(`INSERT INTO comments (id,job_id,selector,snippet_html,snippet_text,request,author,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, job_id, selector, html, text, request, author, "open", t, t);
    this._broadcast({ t: "comments" });
    return { id };
  }
  listComments(job_id) {
    return job_id ? this.ctx.storage.sql.exec(`SELECT * FROM comments WHERE job_id=? ORDER BY created,rowid`, job_id).toArray()
      : this.ctx.storage.sql.exec(`SELECT * FROM comments ORDER BY created,rowid`).toArray();
  }
  settleJob(job_id, status, { version = null, reason = null, by = null } = {}) {
    this.ctx.storage.sql.exec(`UPDATE comments SET status=?, resolved_version=?, reason=?, resolved_by=?, updated=? WHERE job_id=?`, status, version, reason, by, now(), job_id);
    this._broadcast({ t: "comments" });
  }
  // admin backfill: who asked / who answered a comment; who authored a version
  setCommentMeta(id, { author, resolved_by } = {}) {
    const sql = this.ctx.storage.sql;
    if (author !== undefined) sql.exec(`UPDATE comments SET author=? WHERE id=?`, author, id);
    if (resolved_by !== undefined) sql.exec(`UPDATE comments SET resolved_by=? WHERE id=?`, resolved_by, id);
    this._broadcast({ t: "comments" });
    return sql.exec(`SELECT * FROM comments WHERE id=?`, id).toArray()[0] || null;
  }
  setVersionAuthor(n, author) {
    this.ctx.storage.sql.exec(`UPDATE versions SET author=? WHERE n=?`, author, n);
    return this.ctx.storage.sql.exec(`SELECT n,source,author,note FROM versions WHERE n=?`, n).toArray()[0] || null;
  }
  /* copy (for tests / forks) */
  snapshot() { const c = this._cur(); return { title: c?.title, html: c?.html, state: this.ctx.storage.sql.exec(`SELECT k,v,updated FROM state`).toArray() }; }
  initBlank(id) { const edit_token = rid(24); this._setMeta({ id, job_id: null, created: now(), edit_token, notify: "0", status: "pending" }); return { edit_token }; }
  importSnapshot(id, snap, notify) {
    const edit_token = rid(24);
    this._setMeta({ id, job_id: null, created: now(), edit_token, notify: notify ? "1" : "0", status: "ready" });
    for (const r of snap.state) this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO state (k,v,updated) VALUES (?,?,?)`, r.k, r.v, r.updated);
    this.addVersion({ html: snap.html, title: snap.title, source: "generated", note: "copy", force: true });
    return { edit_token };
  }
  _state() {
    const o = {};
    for (const r of this.ctx.storage.sql.exec(`SELECT k,v FROM state`)) o[r.k] = JSON.parse(r.v);
    return o;
  }
  _stateBytes() { return this.ctx.storage.sql.exec(`SELECT COALESCE(SUM(length(k)+length(v)),0) AS n FROM state`).one().n; }
  getState() { return this._state(); }
  resetState() { this.ctx.storage.sql.exec(`DELETE FROM state`); this._broadcast({ t: "init", state: {}, presence: this._alive().length }); return true; }

  async fetch(request) {
    const u0 = new URL(request.url);
    // SSE live channel (HTTP); pathname may stay /a/<id>/live when proxied into the DO
    if (request.headers.get("X-Artifact-Live-SSE") === "1" || u0.searchParams.get("sse") === "1" || /\/live\/?$/.test(u0.pathname)) return this.sseLive(request);
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (new URL(request.url).searchParams.get("live") === "1") { // host page channel: draft stream + status; not counted as presence
      if (!this._meta("id")) return new Response("not found", { status: 404 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["live"]);
      pair[1].serializeAttachment({ at: now(), live: 1 });
      const d = this.draftGet(), c = this._cur();
      pair[1].send(JSON.stringify({ t: "hello", status: this._meta("status"), version: c ? c.n : null, draft: d.active ? d : null }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (this._meta("status") !== "ready") return new Response("not ready", { status: 409 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ at: now() });
    pair[1].send(JSON.stringify({ t: "init", state: this._state(), presence: this._alive().length }));
    this._presence();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > MAX_MSG) { ws.send(JSON.stringify({ t: "error", message: "message too large (max 256KB)", state: this._state() })); return; }
    let m; try { m = JSON.parse(msg); } catch { return; }
 const att = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ ...att, at: now() });
    if (att.live) return;
    if (m.t !== "merge" || !m.changes || typeof m.changes !== "object") return;
    const sql = this.ctx.storage.sql;
    const entries = Object.entries(m.changes).filter(([k]) => typeof k === "string" && k.length > 0 && k.length <= 256);
    // size check: current - replaced + new
    let size = this._stateBytes();
    for (const [k, v] of entries) {
      const old = sql.exec(`SELECT length(k)+length(v) AS n FROM state WHERE k=?`, k).toArray()[0]?.n || 0;
      size += -old + (v === null ? 0 : k.length + JSON.stringify(v).length);
    }
    if (size > MAX_STATE) { ws.send(JSON.stringify({ t: "error", message: "state limit exceeded (max 1MB)", state: this._state() })); return; }
    const t = now(), applied = {};
    for (const [k, v] of entries) {
      if (v === null) sql.exec(`DELETE FROM state WHERE k=?`, k);
      else sql.exec(`INSERT INTO state (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated`, k, JSON.stringify(v), t);
      applied[k] = v;
    }
    this._broadcast({ t: "ops", changes: applied, from: typeof m.from === "string" ? m.from.slice(0, 32) : null });
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {} this._presence(ws); }
  async webSocketError(ws) { this._presence(ws); }
  _alive(except) {
    const t = now();
    return this.ctx.getWebSockets().filter((s) => {
      if (s === except || s.readyState !== 1) return false;
      const last = Math.max(s.deserializeAttachment()?.at || 0, this.ctx.getWebSocketAutoResponseTimestamp(s)?.getTime() || 0);
      if (t - last > 65000) { try { s.close(1001, "stale"); } catch {} return false; }
      return !s.deserializeAttachment()?.live;
    });
  }
  _presence(except) { this._broadcast({ t: "presence", n: this._alive(except).length }, except); }
  _live(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets("live")) { try { ws.send(s); } catch {} }
    if (this._sse) for (const e of [...this._sse]) { try { e.send(obj); } catch { this._sse.delete(e); } }
  }
  sseLive(request) {
    if (!this._meta("id")) return new Response("not found", { status: 404 });
    if (!this._sse) this._sse = new Set();
    const enc = new TextEncoder();
    const self = this;
    let heartbeat;
    const stream = new ReadableStream({
      start(controller) {
        const entry = {
          send(obj) {
            try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); }
            catch { try { self._sse.delete(entry); } catch {} }
          },
        };
        self._sse.add(entry);
        const d = self.draftGet(), c = self._cur();
        entry.send({ t: "hello", status: self._meta("status"), version: c ? c.n : null, draft: d.active ? d : null });
        heartbeat = setInterval(() => { try { entry.send({ t: "ping", at: Date.now() }); } catch {} }, 15000);
        const abort = () => {
          clearInterval(heartbeat);
          self._sse.delete(entry);
          try { controller.close(); } catch {}
        };
        if (request.signal) request.signal.addEventListener("abort", abort);
      },
      cancel() { clearInterval(heartbeat); },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }
  _broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { if (ws === except) continue; try { ws.send(s); } catch {} }
  }
}

/* ---------------- HTML pages ---------------- */
const BASE_CSS = `*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Roboto,sans-serif;background:#0f1115;color:#e8e8ea;line-height:1.5}
a{color:#9cc3ff}.wrap{max-width:720px;margin:0 auto;padding:32px 18px 60px}h1{font-size:26px;margin:0 0 4px}.sub{color:#9a9ca5;margin:0 0 24px;font-size:14px}
label{display:block;font-size:13px;color:#b9bbc4;margin:18px 0 6px}label small{color:#777a84;font-weight:normal}
input,textarea{width:100%;background:#171a21;border:1px solid #2a2e38;color:#e8e8ea;border-radius:10px;padding:12px 13px;font:inherit;font-size:15px}
textarea{min-height:110px;resize:vertical}textarea.ctx{min-height:170px;font-family:ui-monospace,Menlo,monospace;font-size:13px}
input:focus,textarea:focus{outline:none;border-color:#5b8def}
button{margin-top:22px;width:100%;padding:14px;border:0;border-radius:10px;background:#5b8def;color:white;font-size:16px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.err{color:#ff8a8a;margin-top:14px;min-height:1em;font-size:14px}.row{display:flex;gap:10px;align-items:center}
.file{font-size:13px;color:#9a9ca5;margin-top:8px}.card{background:#151820;border:1px solid #232733;border-radius:14px;padding:22px}
.spin{width:42px;height:42px;border:4px solid #2a2e38;border-top-color:#5b8def;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 18px}@keyframes s{to{transform:rotate(360deg)}}
.center{text-align:center;padding-top:14vh}.muted{color:#8a8c95;font-size:14px}`;

function createPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Artifact</title><style>${BASE_CSS}</style></head><body><div class="wrap">
<h1>✨ Artifact</h1><p class="sub">提交上下文和需求，创建可评论、实时协作的 HTML 页面。<br>Submit context and instructions for a shared HTML page. An operator or a configured generator can publish it.</p>
<form id="f" class="card" autocomplete="off">
<label for="invite">邀请码 Invite code</label><input id="invite" name="invite" required placeholder="xxxxxxxxxxxx">
<label for="instructions">需求 Instructions</label><textarea id="instructions" name="instructions" required maxlength="10000" placeholder="例如：把这篇文章做成一个可以多人投票的问答卡片 / e.g. turn this into a shared checklist we can tick off together"></textarea>
<label for="url">链接 URL <small>(可选 optional)</small></label><input id="url" name="url" type="url" placeholder="https://…">
<label for="context">上下文 Context <small>(文字 / 数据 / 代码，可选 optional)</small></label><textarea id="context" name="context" class="ctx" placeholder="粘贴文字、表格、JSON…  Paste text, a table, JSON…"></textarea>
<div class="file"><input type="file" id="file" accept=".txt,.md,.csv,.json,.html,.xml,.yaml,.yml,.tsv,.log,text/*" style="width:auto;padding:6px;font-size:13px"> 或导入文本文件 / or load a text file</div>
<button id="go" type="submit">生成 Generate</button><div class="err" id="err"></div></form>
<p class="muted" style="margin-top:18px">生成后你会拿到「编辑链接」（可改页面、提评论、看历史）和「访客链接」（只能使用应用）。内容保存在本部署中。<br>You get an editor link (edit, comments, history) and a view link (use the app only). Content is stored in this deployment.</p>
</div><script>
const $=id=>document.getElementById(id);
try{const s=localStorage.getItem("artifact_invite");if(s)$("invite").value=s;}catch(e){}
$("file").onchange=async e=>{const f=e.target.files[0];if(!f)return;if(f.size>200*1024){$("err").textContent="文件太大 (max 200KB)";return;}const t=await f.text();$("context").value=($("context").value?$("context").value+"\\n\\n":"")+"--- "+f.name+" ---\\n"+t;};
$("f").onsubmit=async e=>{e.preventDefault();$("err").textContent="";$("go").disabled=true;$("go").textContent="提交中… Submitting…";
try{const body={invite:$("invite").value.trim(),instructions:$("instructions").value,url:$("url").value.trim(),context:$("context").value};
const r=await fetch("/api/create",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));
if(!r.ok)throw new Error(d.message||d.error||("HTTP "+r.status));try{localStorage.setItem("artifact_invite",body.invite);}catch(e){}location.href=d.edit_url||d.url;}
catch(err){$("err").textContent=err.message;$("go").disabled=false;$("go").textContent="生成 Generate";}};
</script></body></html>`;
}

// pending: a plain blank sheet with a blinking caret where writing starts (the host page streams the draft over it
// and swaps in the published page); failed: one quiet line. No spinner, timers or link blurbs.
const BLANK_CSS = `html,body{margin:0;height:100%;background:#fff;color:#1f2328;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Roboto,sans-serif}
.c{display:inline-block;width:.5em;height:1em;margin:32px 0 0 32px;border-radius:2px;background:currentColor;opacity:.55;vertical-align:-.12em;animation:b 1s step-end infinite}@keyframes b{50%{opacity:0}}
.f{margin:32px;color:#8b9099;font-size:13px}.f a{color:inherit}@media (prefers-reduced-motion:reduce){.c{animation:none}}`;
function statusPage(id, info) {
  const failed = info.status === "failed";
  const missing = !info.status;
  if (missing) return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found · Artifact</title><style>${BASE_CSS}</style></head><body><div class="wrap center"><h1>找不到 Not found</h1><p class="muted">This artifact doesn't exist.</p><p><a href="/">← 新建 Create one</a></p></div></body></html>`;
  const head = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${failed ? "Failed" : "\u200b"}</title><style>${BLANK_CSS}</style></head><body>`;
  if (failed) return head + `<p class="f" title="${esc(info.reason || "")}">没写成 · Couldn't finish this page. <a href="/" target="_blank" rel="noopener">新建 New</a></p></body></html>`;
  // fallback if the host page's live socket misses the publish: reload quietly once it's ready
  return head + `<span class="c" aria-label="Waiting for publication"></span>
<script>async function p(){try{const r=await fetch("/a/${id}/status",{cache:"no-store"});const d=await r.json();if(d.status!=="pending"){location.reload();return;}}catch(e){}setTimeout(p,4000);}setTimeout(p,3000);</script></body></html>`;
}

// <title> of a page (used when a publish doesn't pass one)
function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html || "").slice(0, 20000)); if (!m) return "";
  return m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 200);
}
// CSP for generated pages: sandboxed (opaque origin => no access to other artifacts' storage/cookies),
// network only back to this host (websocket sync), assets only inline/data or from a few CDNs.
const CDNS = "https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh";
function socketOrigin(url) {
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}
function artifactCsp(url) {
  const origin = url.origin;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin} ${CDNS}`,
    `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
    `font-src data: ${CDNS} https://fonts.gstatic.com`,
    `img-src data: blob: ${origin}`,
    `media-src data: blob: ${origin}`,
    `connect-src ${socketOrigin(url)}`,
    "worker-src blob:",
    "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-scripts allow-modals allow-popups allow-downloads allow-forms",
  ].join("; ");
}

const scriptSafe = (js) => js.replace(/<\/(script)/gi, "<\\/$1");
// Inject the SDK (live or offline) + optional bridge right after <head>.
function injectSdk(html, id, state, title, { offline = false, bridge = false, banner = null } = {}) {
  const bootJson = JSON.stringify({ id, state }).replace(/</g, "\\u003c");
  let boot;
  if (offline) {
    // export/offline snapshot must be self-contained
    boot = `<script>window.__ARTIFACT_BOOT__=${bootJson};
${scriptSafe(SDK_OFFLINE)}</script>`;
  } else {
    const extra = bridge ? `<script src="/bridge.js?v=${ASSET_HASHES["bridge.js"]}" defer></script>` : "";
    boot = `<script>window.__ARTIFACT_BOOT__=${bootJson};</script><script src="/sdk.js?v=${ASSET_HASHES["sdk.js"]}"></script>${extra}`;
  }
  boot += (banner || "");
  const meta = `<meta charset="utf-8">`;
  let out = html;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + boot);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => m + "<head>" + meta + boot + "</head>");
  else out = "<!doctype html><html><head>" + meta + (title ? `<title>${esc(title)}</title>` : "") + boot + "</head><body>" + out + "</body></html>";
  return out;
}
function offlineBanner(date) {
  return `<script>addEventListener("DOMContentLoaded",function(){var d=document.createElement("div");d.setAttribute("data-artifact-offline","");d.style.cssText="position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;background:rgba(20,22,28,.92);color:#fff;font:12px/1.4 system-ui,sans-serif;padding:7px 12px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer;max-width:92vw;text-align:center";d.textContent="离线快照 · Offline snapshot (${date}) — 修改不会同步 changes won't sync  ✕";d.onclick=function(){d.remove()};document.body.appendChild(d);var s=document.createElement("style");s.textContent="@media print{[data-artifact-offline]{display:none!important}}";document.head.appendChild(s);});</script>`;
}

const HOST_CSS = `*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#f0eee6;color:#141413;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:14px}
body{--drawer-width:clamp(260px,26vw,320px);--sheet-height:60vh;--content-right:0px;--content-bottom:0px;--content-top:44px}.m-comment{--content-top:72px}
@supports(height:100dvh){body{--sheet-height:60dvh}}
#bar{position:fixed;top:0;left:0;right:var(--content-right);height:44px;display:flex;align-items:center;gap:8px;padding:0 14px;background:rgba(240,238,230,.88);border-bottom:1px solid #e3e0d6;color:#141413;z-index:10;backdrop-filter:blur(14px)}
#bar .ttl{font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;letter-spacing:-.01em;color:#3d3d3a}
#bar .ttl a{color:inherit;text-decoration:none;opacity:.45;margin-right:8px;display:inline-flex;align-items:center;vertical-align:middle}#bar .ttl a.brand{opacity:1}#bar .ttl a.brand svg{width:22px;height:22px;display:block;overflow:visible}
.pill{display:none!important}
#bar button{border:0;background:transparent;color:#5c5b57;border-radius:8px;padding:7px 8px;font:inherit;font-size:15px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
#bar button:hover{background:rgba(20,20,19,.06);color:#141413}#bar button.on{background:#141413;color:#f0eee6}#bComment.on{background:#d97757;color:#fff}
#bMenu{min-width:34px;justify-content:center;font-size:15px;color:#5c5b57;border:1px solid #e3e0d6;background:#faf9f5;border-radius:999px;padding:6px 10px}
#bMenu:hover{background:#fff;border-color:#d4d1c7}
.ed{display:none!important}.is-editor .ed{display:none!important}
.save{font-size:12px;color:#73726c;white-space:nowrap}.save.saving,.save.editing{color:#b45309}.save.saved{color:#3d7a5a}.save.error,.save.conflict{color:#b42318}.m-edit .save{display:inline}.save{display:none}
#hint{position:fixed;top:44px;left:0;right:var(--content-right);z-index:9;font-size:12px;text-align:center;padding:6px 10px;display:none}.m-comment #hint{display:block;background:#f6e6df;color:#7a3b28}.is-editor #mHow{display:none}
#frame,#live,#liveMd{position:fixed;top:var(--content-top);left:0;width:calc(100% - var(--content-right));height:calc(100% - var(--content-top) - var(--content-bottom));border:0}
#frame{background:#f3eee4}
#live{background:#f3eee4;z-index:5;opacity:0;transition:opacity .2s}.m-live.live-shown #live{opacity:1}.m-live.live-hide #live{opacity:0;pointer-events:none}
#livePill{display:none!important}
@keyframes lp{50%{opacity:.25}}
#askChip{position:fixed;z-index:13;display:none;align-items:center;gap:5px;background:#141413;color:#faf9f5;border:0;border-radius:999px;padding:7px 12px;font:inherit;font-size:12.5px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.16);white-space:nowrap}#askChip.show{display:inline-flex}#askChip:hover{background:#2a2926}
#menu{display:none!important}
#panel{position:fixed;top:44px;right:0;bottom:0;width:var(--drawer-width);max-width:100%;background:#faf9f5;border-left:1px solid #e3e0d6;z-index:15;transform:translateX(105%);visibility:hidden;display:flex;flex-direction:column;color:#141413}#panel.show{transform:none;visibility:visible}
.ph{display:flex;flex-shrink:0;align-items:center;padding:12px 14px;border-bottom:1px solid #e3e0d6;font-weight:600}.ph span{flex:1}.ph button,.x{background:none;border:0;color:#73726c;font-size:20px;cursor:pointer;line-height:1}
#pbody{overflow:auto;overscroll-behavior:contain;padding:12px;flex:1;min-height:0;overflow-wrap:anywhere}.empty{color:#73726c;text-align:center;padding:24px 8px;line-height:1.6}
.ver,.cm{border:1px solid #e3e0d6;background:#fff;border-radius:12px;padding:10px 12px;margin-bottom:9px}.ver.cur{border-color:#d97757}.vh{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.tm{font-size:12px;color:#73726c;margin-top:3px}
.tag{font-size:11px;border-radius:6px;padding:1px 6px;background:#efeee9;color:#5c5b57}.tag.hand{background:#f6e6df;color:#7a3b28}.tag.cya{background:#f6e6df;color:#7a3b28}.tag.restore{background:#ebe8f5;color:#5b4a8a}.tag.now{background:#141413;color:#fff}
.vb{margin-top:8px;display:flex;gap:6px}.vb button,.pgen button,.mb button{border:1px solid #e3e0d6;background:#fff;color:#141413;border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}
button.pri{background:#141413!important;border-color:#141413!important;color:#faf9f5!important}
.cmh{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.pinb{background:#d97757;color:#fff;font-weight:700;font-size:11px;border-radius:9px 9px 9px 2px;padding:1px 6px}.st{font-size:12px;font-weight:600}.cm.open .st{color:#b45309}.cm.resolved .st{color:#3d7a5a}.cm.failed .st{color:#b42318}.cm.focus{border-color:#d97757;background:#fff6ef;box-shadow:inset 3px 0 #d97757}
.cmr{margin:6px 0 4px;white-space:pre-wrap;word-break:break-word}.cmn{display:block;font-size:12px;color:#141413;margin-top:4px}.cmn b{font-weight:600}.cmb{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}.cmb button{font-size:12px;border:1px solid #e3e0d6;background:#faf9f5;border-radius:8px;padding:3px 9px;cursor:pointer;color:#141413}.cmb button:hover{border-color:#d97757;color:#b4532f}.cmtag{font-size:11px;font-weight:700;color:#8a5a2b;background:#fbeee2;border:1px solid #efd5bd;border-radius:8px;padding:0 6px}
#commentDetail{background:#fff;border:1px solid #e3e0d6;border-radius:12px;padding:14px;margin-bottom:14px;line-height:1.6}#commentDetail .cmr{margin:10px 0;background:#faf9f5;border-left:3px solid #d97757;padding:6px 9px}#commentDetail .cms{margin-top:8px}#commentDetail .cmb button{padding:8px 10px}
#commentList .cm{display:block;width:100%;text-align:left;font:inherit;font-size:13px;line-height:1.55;color:inherit;cursor:pointer}#commentList .cm:hover{border-color:#d97757}#commentList .cmr,#commentList .cms,#commentList .cmn{display:block}#commentList .cmr{font-weight:500}#panel button:focus-visible,#commentDetail:focus-visible{outline:2px solid #b4532f;outline-offset:2px}#pclose{min-width:32px;min-height:32px}.cms{font-size:12px;color:#73726c;overflow-wrap:anywhere}.err{color:#b42318}
.pgen{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}textarea,input{width:100%;background:#fff;border:1px solid #e3e0d6;color:#141413;border-radius:9px;padding:9px 10px;font:inherit;font-size:14px}textarea{min-height:70px;resize:vertical}textarea:focus,input:focus{outline:none;border-color:#c4bfb2}
.modal{position:fixed;inset:0;background:rgba(20,20,19,.4);z-index:30;display:none;align-items:center;justify-content:center;padding:16px}.modal.show{display:flex}
.mc{max-height:calc(100dvh - 32px);overflow:auto;background:#faf9f5;border:1px solid #e3e0d6;border-radius:16px;padding:16px;width:440px;max-width:100%;box-shadow:0 20px 60px rgba(0,0,0,.14)}.mc h3{margin:0 0 8px;font-size:16px}.tgt{font-size:12px;color:#5c5b57;background:#f0eee6;border-radius:8px;padding:7px 9px;margin-bottom:10px;max-height:70px;overflow:hidden;word-break:break-word}
.mb{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}.mb button{padding:9px 14px;font-size:14px}
#pvModal .mc{width:min(1100px,100%);height:min(88vh,100%);display:flex;flex-direction:column}#pvFrame{flex:1;border:0;border-radius:9px;background:#fff;margin-top:8px}
#toast{position:fixed;left:calc((100% - var(--content-right))/2);bottom:calc(20px + var(--content-bottom));transform:translate(-50%,30px);opacity:0;pointer-events:none;background:#141413;color:#faf9f5;padding:10px 14px;border-radius:11px;z-index:40;max-width:min(560px,calc(100% - var(--content-right) - 32px));transition:opacity .2s,transform .2s;box-shadow:0 10px 30px rgba(0,0,0,.22);font-size:13px;line-height:1.5}#toast.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}#toast button{margin-left:8px;background:#d97757;border:0;color:#fff;border-radius:7px;padding:3px 8px;cursor:pointer}
.lbl{display:inline}@media (max-width:720px){.lbl{display:none}#bar{gap:4px;padding:0 10px}#bar button{padding:7px}.m-edit .save{display:none}
.modal{align-items:flex-end;padding:0}.mc{border-radius:16px 16px 0 0;width:100%}#pvModal .mc{height:92vh}}
/* Reserve the same column for every host surface; the iframe itself reflows. */
@media (min-width:641px){.panel-open{--content-right:var(--drawer-width)}}
/* The mobile page viewport ends above the sheet so even end-of-page targets can be located. */
@media (max-width:640px){.panel-open{--content-bottom:72vh}.comments-open{--content-bottom:var(--sheet-height)}#panel{top:auto;left:0;width:100%;height:72vh;border-left:0;border-top:1px solid #e3e0d6;border-radius:16px 16px 0 0;transform:translateY(105%);transition:transform .2s,visibility 0s .2s;box-shadow:0 -12px 32px rgba(20,20,19,.12)}#panel[data-surface="comments"]{height:var(--sheet-height);max-height:var(--sheet-height)}#panel.show{transform:none;transition-delay:0s}}
@media (prefers-reduced-motion:reduce){#panel{transition:none}}
#liveMd{z-index:5;display:none;grid-template-columns:1fr;background:#faf9f5;opacity:0;transition:opacity .2s}
.m-live.m-live-md #liveMd{display:grid;opacity:1}.m-live.m-live-md.live-shown #liveMd{opacity:1}.m-live.m-live-md.live-hide #liveMd{opacity:0;pointer-events:none}.m-live.m-live-md #live{display:none!important}
#liveMd .pane{overflow:auto;height:100%;padding:18px 20px;-webkit-overflow-scrolling:touch}
#liveMd .src{display:none!important;background:#1f1e1d;color:#e8e6dc;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;border-right:1px solid #2a2926}
.m-live-md-source #liveMd{grid-template-columns:minmax(0,1fr) minmax(0,1fr);background:#1f1e1d}
.m-live-md-source #liveMd .src{display:block!important}
#liveMd .src .lab,#liveMd .prev .lab{position:sticky;top:0;z-index:1;font:11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;opacity:.5;margin:-6px 0 10px;user-select:none}
#liveMd .src .lab{color:#a8a29e;background:#1f1e1d}
#liveMd .prev{background:#f3eee4;color:#1c1915;font:16.5px/1.55 "Source Sans 3",ui-sans-serif,system-ui,"PingFang SC","Noto Sans SC",sans-serif;padding:0}
#liveMd .prev .lab{display:none}.m-live-md-source #liveMd .prev .lab{display:block;color:#73726c}
#liveMd .prev .md{max-width:680px;margin:0 auto;padding:40px 22px 96px;min-height:100%}
#liveMd .prev .md>*:first-child{margin-top:0}
#liveMd .prev .md h1{font-weight:580;font-size:clamp(1.65rem,3.8vw,1.95rem);line-height:1.25;letter-spacing:-.02em;margin:.15em 0 .55em;color:#141413}
#liveMd .prev .md h2{font-weight:580;font-size:1.15rem;letter-spacing:-.01em;margin:1.65em 0 .45em}
#liveMd .prev .md h3{font-weight:560;font-size:1.02rem;margin:1.25em 0 .35em}
#liveMd .prev .md p,#liveMd .prev .md ul,#liveMd .prev .md ol{margin:0 0 .85em}#liveMd .prev .md li{margin:.3em 0}
#liveMd .prev .md blockquote{margin:1em 0;padding:12px 14px;border-left:2px solid #d4d1c7;background:transparent;border-radius:0;color:#3d3d3a}
#liveMd .prev .md code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:#efeee9;padding:.08em .35em;border-radius:4px}
#liveMd .prev .md pre{background:#1f1e1d;color:#f5f4ef;padding:14px 16px;border-radius:10px;overflow:auto;font-size:12.5px;line-height:1.45}#liveMd .prev .md pre code{background:none;padding:0}
#liveMd .prev .md table{width:100%;border-collapse:collapse;background:transparent;border:0;font-size:.95em;margin:1em 0}
#liveMd .prev .md th,#liveMd .prev .md td{padding:10px 0;border-bottom:1px solid #e3e0d6;text-align:left;vertical-align:top}
#liveMd .prev .md th{background:transparent;font-weight:560;color:#73726c}
#liveMd .prev .md hr{border:0;border-top:1px solid #e3e0d6;margin:1.5em 0}
#liveMd .prev .md a{color:#c45c38}
#liveMd .caret{display:inline-block;width:.5em;height:1.05em;margin-left:1px;background:#141413;vertical-align:-.15em;border-radius:1px;animation:lp 1s step-end infinite}
@media (max-width:720px){.m-live-md-source #liveMd{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}.m-live-md-source #liveMd .src{border-right:0;border-bottom:1px solid #2a2926}}
@media print{#bar,#hint,#panel,#askChip,#livePill,#live,#liveMd{display:none!important}#frame{top:0;width:100%;height:100%}}`;

function hostPage(id, title, status) {
  const t = esc(title || "Artifact");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>${t}</title><style>${HOST_CSS}</style></head><body>
<div id="bar"><div class="ttl"><a class="brand" href="/" title="Cya"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="22" height="22" role="img" aria-label="Cya" class="cya-mark">
  <style>
    .cya-mark .bob{animation:cyaBob 5s ease-in-out infinite}
    .cya-mark .eyes{animation:cyaLook 14s ease-in-out infinite}
    .cya-mark .eye{transform-box:fill-box;transform-origin:50% 50%;animation:cyaBlink 14s ease-in-out infinite}
    .cya-mark .eye.r{animation-delay:0s}
    @keyframes cyaBob{0%,100%{transform:translateY(0)}40%{transform:translateY(-1.2px)}70%{transform:translateY(.5px)}}
    @keyframes cyaLook{
      0%,6%{transform:translate(0,0)}
      10%,18%{transform:translate(-3.2px,0)}
      22%,28%{transform:translate(0,0)}
      32%,40%{transform:translate(3.2px,0)}
      44%,50%{transform:translate(0,0)}
      54%,58%{transform:translate(0,-2.8px)}
      62%,70%{transform:translate(-2.6px,2px)}
      74%,80%{transform:translate(0,0)}
      84%,92%{transform:translate(2.8px,-2.2px)}
      96%,100%{transform:translate(0,0)}
    }
    @keyframes cyaBlink{
      0%,53%,57%,73%,76%,79%,100%{transform:scaleY(1)}
      55%,74.5%,77.5%{transform:scaleY(.08)}
    }
  </style>
  <g class="bob">
    <ellipse cx="32" cy="35" rx="21.5" ry="15.5" fill="#f09830"/>
    <ellipse cx="21" cy="29" rx="12.5" ry="11.5" fill="#f09830"/>
    <ellipse cx="43" cy="28" rx="13" ry="12.5" fill="#f09830"/>
    <ellipse cx="32" cy="23" rx="12" ry="10.5" fill="#f09830"/>
    <ellipse cx="15" cy="37" rx="8" ry="8" fill="#f09830"/>
    <ellipse cx="49" cy="37" rx="8.5" ry="8" fill="#f09830"/>
    <g class="eyes">
      <ellipse class="eye" cx="25.2" cy="31" rx="4.4" ry="7.6" fill="#fff"/>
      <ellipse class="eye r" cx="38.8" cy="31" rx="4.4" ry="7.6" fill="#fff"/>
    </g>
  </g>
</svg></a><span id="ttl">${t}</span></div><span class="pill" id="pres">1 在线</span><span class="save" id="save"></span>
<button id="bComment" class="ed" hidden title="Comments">💬</button>
<button id="bHistory" class="ed" hidden title="History">🕘</button>
<button id="bExport" class="ed" hidden title="Download">⬇️</button>
<button id="bMenu" title="分享 Share" aria-label="分享 Share">↗</button></div>
<div id="hint"></div>
<div id="menu" hidden></div>
<iframe id="frame" src="/a/${id}/raw" sandbox="allow-scripts allow-same-origin allow-modals allow-popups allow-downloads allow-forms" allow="clipboard-write; fullscreen" title="${t}"></iframe>
<div id="panel" role="dialog" aria-label="评论 Comments" aria-hidden="true" inert><div class="ph"><span id="ptitle"></span><button id="pclose" aria-label="关闭 Close">×</button></div><div id="pbody"></div></div>
<div class="modal" id="cmModal"><div class="mc"><h3>💬 请求修改 Request a change</h3><div class="tgt" id="cmTarget"></div>
<textarea id="cmReq" maxlength="2000" placeholder="想怎么改？例如：这里换成表格、加一个按钮…  What should change?"></textarea>
<input id="cmAuthor" maxlength="60" placeholder="你的名字（可选）Your name (optional)" style="margin-top:8px">
<div class="mb"><button id="cmCancel">取消 Cancel</button><button id="cmSend" class="pri">发送 Send</button></div></div></div>
<div class="modal" id="pvModal"><div class="mc"><div style="display:flex;align-items:center;gap:8px"><h3 id="pvTitle" style="flex:1;margin:0"></h3><div class="mb" style="margin:0"><button id="pvRestore" class="pri">恢复此版本 Restore</button></div><button class="x" id="pvClose">×</button></div>
<iframe id="pvFrame" sandbox="allow-scripts"></iframe></div></div>
<div id="toast"></div><button id="askChip">💬 <span id="askTxt">评论这里</span></button>
<div id="liveMd" aria-label="Markdown live writing"></div><div id="livePill" hidden><i></i><span id="liveTxt"></span><button id="liveToggle" type="button"></button></div>
<script>window.__HOST__=${JSON.stringify({ id, status }).replace(/</g, "\\u003c")};</script>
<script src="/host.js?v=${ASSET_HASHES["host.js"]}" defer></script></body></html>`;
}
const hostCsp = (url) => HOST_CSP.replace("connect-src 'self'", `connect-src 'self' ${socketOrigin(url)}`);
const HOST_CSP = [
  "default-src 'none'", `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CDNS}`, `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src data: ${CDNS} https://fonts.gstatic.com`, "img-src 'self' data: blob:", "media-src data: blob:", "connect-src 'self'", "worker-src blob:",
  "frame-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
const HTML_H = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

/* ---------------- Worker ---------------- */
const indexStub = (env) => env.INDEX.getByName("index");
const artStub = (env, id) => env.ARTIFACT.getByName(id);
const ID_RE = /^[A-Za-z0-9]{6,16}$/;

function isAdmin(req, env) {
  const h = req.headers.get("authorization") || "";
  return !!env.ADMIN_TOKEN && h.startsWith("Bearer ") && timingSafeEq(h.slice(7), env.ADMIN_TOKEN);
}

// Both webhook destinations are optional. An explicit editor route never falls
// back to another receiver: an unconfigured integration leaves the job pending.
async function notify(env, payload, route) {
  const toEditor = route === "editor" && payload.kind === "edit";
  const url = toEditor ? env.EDITOR_WEBHOOK_URL : env.ROUTINE_WEBHOOK_URL;
  const key = toEditor ? env.EDITOR_SENDER_KEY : (env.ROUTINE_SENDER_KEY || env.ROUTINE_SENDER_KEY_ARTIFACT);
  if (!url || !key) return { skipped: "not_configured" };
  const to = toEditor ? "editor" : "routine";
  try {
    // Do not forward the shared sender key through redirects or log receiver URLs.
    const r = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(payload) });
    if (r.body) await r.body.cancel();
    console.log("webhook", to, payload.kind, payload.job_id, r.status);
    return { status: r.status, to };
  } catch {
    // Runtime fetch errors can contain secret-bearing receiver URLs.
    console.log("webhook failed", to, payload.job_id);
    return { error: "delivery_failed", to };
  }
}
// Notify unless the artifact has notify turned off (test copies). Result is recorded on the job.
async function notifyJob(env, job, aurl, art) {
  const info = await art.info();
  const payload = { job_id: job.id, artifact_id: job.artifact_id, kind: job.kind || "new", url: aurl };
  const r = info.notify === "0" ? { skipped: "notify_off" } : await notify(env, payload, info.route);
  await indexStub(env).setNotified(job.id, JSON.stringify(r));
  return r;
}
const SOURCES = new Set(["generated", "hand", "cya", "restore"]);
// The publisher can supply a human or automation name with body.author.
const answererName = (a) => authorName(a) || "Assistant";
async function jobDetail(env, job, aurl) {
  const { invite_code, ...pub } = job;
  const out = { ...pub, kind: job.kind || "new", url: aurl };
  if (out.kind === "edit") {
    const art = artStub(env, job.artifact_id);
    const [cur, comments] = await Promise.all([art.current(), art.listComments(job.id)]);
    out.comments = comments.map((c) => ({ id: c.id, request: c.request, author: c.author, selector: c.selector, snippet_text: c.snippet_text, snippet_html: c.snippet_html, status: c.status, created: c.created }));
    out.current_version = cur?.version ?? null; out.title = cur?.title ?? null; out.html = cur?.html ?? null;
  }
  return out;
}

async function handleAdmin(req, env, ctx, url, parts) {
  if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  const idx = indexStub(env);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const [, , , res, rid_, action, sub] = parts; // ["", "api","admin", res, id, action, sub]
  if (res === "jobs") {
    if (!rid_ && req.method === "GET") return json({ jobs: await idx.listJobs(url.searchParams.get("status"), url.searchParams.get("kind"), Math.min(+url.searchParams.get("limit") || 50, 500)) });
    const job = await idx.getJob(rid_);
    if (!job) return json({ error: "job_not_found" }, 404);
    const kind = job.kind || "new";
    const aurl = `${url.origin}/a/${job.artifact_id}`;
    const art = artStub(env, job.artifact_id);
    if (!action && req.method === "GET") return json(await jobDetail(env, job, aurl));
    if (action === "publish" && req.method === "POST") {
      if (typeof body.html !== "string" || !body.html.trim()) return json({ error: "html required" }, 400);
      if (body.html.length > MAX_HTML) return json({ error: "html too large", max_bytes: MAX_HTML }, 413);
      const title = body.title == null ? null : String(body.title).slice(0, 200);
      const html = await bindCommentChips(body.html, await art.listComments());
      if (kind === "edit") {
        if (body.base_version == null && !body.force) return json({ error: "base_version_required", message: "edit jobs must publish with base_version (the version you edited)" }, 400);
        const by = answererName(body.author);
        const r = await art.addVersion({ html, title, source: "cya", author: by, note: String(body.note || job.instructions || "").slice(0, 200), base_version: body.base_version, force: !!body.force, from: "cya-" + job.id });
        if (r.error) return json({ error: r.error, current_version: r.version, message: "artifact changed since base_version: re-fetch the job, merge your change into the current HTML, publish again" }, 409);
        await art.settleJob(job.id, "resolved", { version: r.version, by });
        await idx.setJob(job.id, "ready", { title: r.title });
        return json({ ok: true, url: aurl, version: r.version });
      }
      const r = await art.publish(html, title || "", answererName(body.author));
      await idx.setJob(job.id, "ready", { title: r.title });
      return json({ ok: true, url: aurl, version: r.version, artifact: await art.info() });
    }
    if (action === "fail" && req.method === "POST") {
      const reason = String(body.reason || "Generation failed").slice(0, 2000);
      if (kind === "edit") { await art.settleJob(job.id, "failed", { reason }); await art.draftEnd(false); } else await art.fail(reason);
      await idx.setJob(job.id, "failed", { reason });
      return json({ ok: true, url: aurl });
    }
    if (action === "notify" && req.method === "POST") return json(await notifyJob(env, job, aurl, art));
    return json({ error: "not_found" }, 404);
  }
  if (res === "artifacts" && rid_ && ID_RE.test(rid_)) {
    const st = artStub(env, rid_);
    const info = await st.info();
    if (!info.id) return json({ error: "artifact_not_found" }, 404);
    const aurl = `${url.origin}/a/${rid_}`;
    if (!action && req.method === "GET") return json(info);
    if (action === "state" && req.method === "GET") return json(await st.getState());
    if (action === "reset-state" && req.method === "POST") return json({ ok: await st.resetState() });
    if (action === "edit-token") {
      const tok = await st.editToken(sub === "rotate" && req.method === "POST");
      return json({ edit_token: tok, edit_url: `${aurl}?edit=${tok}`, view_url: aurl });
    }
    if (action === "html" && req.method === "GET") return json((await st.current()) || { html: null, version: null });
    if (action === "html" && req.method === "POST") { // edit HTML, keep state; needs base_version unless force
      if (typeof body.html !== "string" || !body.html.trim() || body.html.length > MAX_HTML) return json({ error: "html required (<=1.5MB)" }, 400);
      const source = SOURCES.has(body.source) ? body.source : "cya";
      const html = await bindCommentChips(body.html, await st.listComments());
      const r = await st.addVersion({ html, title: body.title == null ? null : String(body.title).slice(0, 200), source, author: authorName(body.author), note: body.note ? String(body.note).slice(0, 200) : null, base_version: body.base_version, force: !!body.force, from: "admin-" + rid(6) });
      if (r.error) return json({ error: r.error, current_version: r.version, message: "re-fetch the current HTML, re-apply your change, retry with the new base_version" }, 409);
      if (info.job_id) await indexStub(env).setJob(info.job_id, "ready", { title: r.title });
      return json({ ok: true, version: r.version, url: aurl });
    }
    if (action === "versions" && req.method === "GET") return json(await st.listVersions());
    if (action === "draft" && req.method === "GET") return json(await st.draftGet());
    if (action === "draft" && req.method === "POST") { // live writing: {op:"start",note} | {op:"append",chunk} | {op:"end"} (abort; publishing ends it automatically)
      if (body.op === "start") return json(await st.draftStart(body.note ? String(body.note).slice(0, 200) : null, body.mode));
      if (body.op === "append") {
        if (typeof body.chunk !== "string" || !body.chunk) return json({ error: "chunk required" }, 400);
        const r = await st.draftAppend(body.chunk);
        if (r.error === "no_draft") return json({ error: r.error, message: "no live draft (never started, or idle >15 min): run stream_start again" }, 409);
        if (r.error) return json({ error: r.error, max_bytes: MAX_HTML }, 413);
        return json(r);
      }
      if (body.op === "end") return json(await st.draftEnd(false));
      return json({ error: "op must be start|append|end" }, 400);
    }
    if (action === "comments" && req.method === "GET") return json({ comments: await st.listComments() });
    if (action === "comments" && sub && req.method === "POST") { // backfill {author?, resolved_by?}
      const o = {}; for (const k of ["author", "resolved_by"]) if (k in body) o[k] = authorName(body[k]);
      const c = await st.setCommentMeta(sub, o); return c ? json({ ok: true, comment: c }) : json({ error: "comment_not_found" }, 404);
    }
    if (action === "versions" && sub && req.method === "POST") { // backfill {author}
      const v = await st.setVersionAuthor(+sub, authorName(body.author));
      return v ? json({ ok: true, version: v }) : json({ error: "version_not_found" }, 404);
    }
    if (action === "settings" && req.method === "POST") return json(await st.setSettings(body));
    if (action === "copy" && req.method === "POST") {
      const nid = rid(10);
      if (body.empty === true) { // blank pending artifact, notify off (testing the "being written" page); publish via /html with force
        const { edit_token } = await artStub(env, nid).initBlank(nid);
        return json({ ok: true, artifact_id: nid, url: `${url.origin}/a/${nid}`, edit_url: `${url.origin}/a/${nid}?edit=${edit_token}`, notify: false, status: "pending" });
      }
      const snap = await st.snapshot();
      if (!snap.html) return json({ error: "nothing_to_copy" }, 409);
      const { edit_token } = await artStub(env, nid).importSnapshot(nid, snap, body.notify === true);
      return json({ ok: true, artifact_id: nid, url: `${url.origin}/a/${nid}`, edit_url: `${url.origin}/a/${nid}?edit=${edit_token}`, notify: body.notify === true });
    }
    return json({ error: "not_found" }, 404);
  }
  if (res === "invites") {
    if (!rid_ && req.method === "GET") return json({ invites: await idx.listInvites() });
    if (!rid_ && req.method === "POST") return json(await idx.createInvite(String(body.label || "").slice(0, 100), Math.max(1, Math.min(+body.daily_limit || DEFAULT_DAILY, 1000))));
    if (rid_ && action === "revoke" && req.method === "POST") return json({ ok: await idx.revokeInvite(rid_) });
    return json({ error: "not_found" }, 404);
  }
  return json({ error: "not_found" }, 404);
}

async function handleCreate(req, env, ctx, url) {
  let b;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) b = await req.json().catch(() => null);
  else { const f = await req.formData().catch(() => null); b = f && Object.fromEntries(f); }
  if (!b) return json({ error: "bad_request", message: "无法解析请求 Bad request" }, 400);
  const invite = String(b.invite || "").trim();
  const instructions = String(b.instructions || "").trim();
  const context_text = String(b.context || "");
  let context_url = String(b.url || "").trim();
  if (!invite) return json({ error: "invalid_invite", message: "请填写邀请码 Invite code required" }, 403);
  if (!instructions) return json({ error: "bad_request", message: "请填写需求 Instructions required" }, 400);
  if (instructions.length > MAX_INSTR) return json({ error: "too_large", message: "需求太长 Instructions too long (max 10KB)" }, 413);
  if (context_text.length > MAX_CONTEXT) return json({ error: "too_large", message: "上下文太长 Context too long (max 200KB)" }, 413);
  if (context_url) { try { const u = new URL(context_url); if (!/^https?:$/.test(u.protocol)) throw 0; context_url = u.href; } catch { return json({ error: "bad_url", message: "链接无效 Invalid URL" }, 400); } }
  const r = await indexStub(env).createJob({ invite, instructions, context_text, context_url: context_url || null });
  if (r.error === "invalid_invite") return json({ error: r.error, message: "邀请码无效 Invalid invite code" }, 403);
  if (r.error === "rate_limited") return json({ error: r.error, message: `今天的额度已用完 Daily limit reached (${r.limit}/24h)` }, 429);
  const art = artStub(env, r.artifact_id);
  const { edit_token } = await art.init(r.artifact_id, r.job_id);
  const aurl = `${url.origin}/a/${r.artifact_id}`, eurl = `${aurl}?edit=${edit_token}`;
  ctx.waitUntil(notifyJob(env, { id: r.job_id, artifact_id: r.artifact_id, kind: "new" }, aurl, art));
  if (!ct.includes("application/json")) return Response.redirect(eurl, 303);
  return json({ ok: true, job_id: r.job_id, artifact_id: r.artifact_id, url: aurl, view_url: aurl, edit_url: eurl, edit_token });
}

// Editor API: /api/a/<id>/<action>[/<n>], requires X-Edit-Token. Viewers get 403 (server-enforced).
async function handleEditorApi(req, env, ctx, url, id, action, arg) {
  const st = artStub(env, id);
  const tok = req.headers.get("x-edit-token") || "";
  if (!tok || !(await st.checkToken(tok))) return json({ error: "forbidden", message: "需要编辑链接 Editor link required" }, 403);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const aurl = `${url.origin}/a/${id}`;
  if (action === "me" && req.method === "GET") { const i = await st.info(); return json({ editor: true, id, title: i.title, version: i.version, status: i.status }); }
  if (action === "source" && req.method === "GET") return json((await st.current()) || {});
  if (action === "versions" && req.method === "GET" && !arg) return json(await st.listVersions());
  if (action === "versions" && req.method === "GET" && arg) {
    const v = await st.getVersion(+arg); if (!v) return json({ error: "version_not_found" }, 404);
    return json({ n: v.n, title: v.title, source: v.source || "generated", created: v.created, html: injectSdk(v.html, id, await st.getState(), v.title, { offline: true }) });
  }
  if (action === "versions" && req.method === "POST") { // hand edit save
    if (typeof body.html !== "string" || !body.html.trim() || body.html.length > MAX_HTML) return json({ error: "html required (<=1.5MB)" }, 400);
    if (body.base_version == null) return json({ error: "base_version_required" }, 400);
    const r = await st.addVersion({ html: body.html, source: "hand", sid: String(body.sid || "").slice(0, 32) || null, author: authorName(body.author),
      base_version: body.base_version, from: String(body.from || "").slice(0, 40) || null });
    if (r.error) return json({ error: r.error, version: r.version }, 409);
    return json({ ok: true, version: r.version });
  }
  if (action === "restore" && req.method === "POST") {
    const r = await st.restore(+body.n, String(body.from || "").slice(0, 40) || null);
    if (r.error) return json(r, 404);
    return json({ ok: true, version: r.version });
  }
  if (action === "comments" && req.method === "GET") return json({ comments: (await st.listComments()).map(({ job_id, snippet_html, ...c }) => c) });
  if (action === "comments" && req.method === "POST") {
    const request = String(body.request || "").trim().slice(0, 2000);
    if (!request) return json({ error: "request required" }, 400);
    const selector = body.selector ? String(body.selector).slice(0, 600) : null;
    const text = body.text ? String(body.text).slice(0, 600) : null, html = body.html ? String(body.html).slice(0, 2000) : null;
    const author = authorName(body.author);
    const instr = (selector ? `[${selector}] ` : "[whole page] ") + request;
    const j = await indexStub(env).createEditJob(id, instr);
    if (j.error) return json({ error: j.error, message: `今天这个页面的修改请求已达上限 Edit-request limit reached (${j.limit}/24h)` }, 429);
    const c = await st.addComment({ job_id: j.job_id, selector, html, text, request, author });
    ctx.waitUntil(notifyJob(env, { id: j.job_id, artifact_id: id, kind: "edit" }, aurl, st));
    return json({ ok: true, comment_id: c.id, job_id: j.job_id });
  }
  return json({ error: "not_found" }, 404);
}

async function handleArtifact(req, env, url, id, sub) {
  const st = artStub(env, id);
  if (sub === "ws") return st.fetch(req);
  if (sub === "live") {
    const u = new URL(req.url);
    u.searchParams.set("sse", "1");
    return st.fetch(new Request(u.toString(), { method: "GET", signal: req.signal }));
  }
  if (sub === "status") {
    const i = await st.info();
    const d = await st.draftGet();
    const body = { status: i.status || "missing", title: i.title || null, reason: i.reason || null, version: i.version || null, draft: d.active ? { active: true, mode: d.mode || "html", note: d.note || null, seq: d.seq || 0, text: d.text || "", html: d.html || "" } : { active: false } };
    return json(body, i.status ? 200 : 404, { "access-control-allow-origin": "*" });
  }
  if (sub && sub !== "raw" && sub !== "export") return new Response("not found", { status: 404 });
  const p = await st.page();
  if (!sub && (p.status === "pending" || p.status === "failed")) { // host page so viewers can watch a publisher write it live
    return new Response(hostPage(id, p.status === "pending" ? "新页面 New page" : "生成失败 Failed", p.status), { headers: { ...HTML_H, "content-security-policy": hostCsp(url), "x-frame-options": "DENY" } });
  }
  if (p.status !== "ready") return new Response(statusPage(id, p), { status: p.status ? 200 : 404, headers: HTML_H });
  if (sub === "raw") return new Response(injectSdk(p.html, id, p.state, p.title, { bridge: true }), { headers: {
    ...HTML_H, "content-security-policy": artifactCsp(url), "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  } });
  if (sub === "export") {
    const d = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const html = injectSdk(p.html, id, p.state, p.title, { offline: true, banner: offlineBanner(d) });
    const fname = ((p.title || "artifact").replace(/[^\p{L}\p{N}\- _]+/gu, "").trim().slice(0, 60) || "artifact") + `-v${p.version}.html`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-disposition": `attachment; filename="artifact-${id}-v${p.version}.html"; filename*=UTF-8''${encodeURIComponent(fname)}`, "content-security-policy": "sandbox allow-scripts" } });
  }
  return new Response(hostPage(id, p.title, "ready"), { headers: { ...HTML_H, "content-security-policy": hostCsp(url), "x-frame-options": "DENY" } });
}

const CYA_MARK = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" width=\"22\" height=\"22\" role=\"img\" aria-label=\"Cya\" class=\"cya-mark\">\n  <style>\n    .cya-mark .bob{animation:cyaBob 5s ease-in-out infinite}\n    .cya-mark .eyes{animation:cyaLook 14s ease-in-out infinite}\n    .cya-mark .eye{transform-box:fill-box;transform-origin:50% 50%;animation:cyaBlink 14s ease-in-out infinite}\n    .cya-mark .eye.r{animation-delay:0s}\n    @keyframes cyaBob{0%,100%{transform:translateY(0)}40%{transform:translateY(-1.2px)}70%{transform:translateY(.5px)}}\n    @keyframes cyaLook{\n      0%,6%{transform:translate(0,0)}\n      10%,18%{transform:translate(-3.2px,0)}\n      22%,28%{transform:translate(0,0)}\n      32%,40%{transform:translate(3.2px,0)}\n      44%,50%{transform:translate(0,0)}\n      54%,58%{transform:translate(0,-2.8px)}\n      62%,70%{transform:translate(-2.6px,2px)}\n      74%,80%{transform:translate(0,0)}\n      84%,92%{transform:translate(2.8px,-2.2px)}\n      96%,100%{transform:translate(0,0)}\n    }\n    @keyframes cyaBlink{\n      0%,53%,57%,73%,76%,79%,100%{transform:scaleY(1)}\n      55%,74.5%,77.5%{transform:scaleY(.08)}\n    }\n  </style>\n  <g class=\"bob\">\n    <ellipse cx=\"32\" cy=\"35\" rx=\"21.5\" ry=\"15.5\" fill=\"#f09830\"/>\n    <ellipse cx=\"21\" cy=\"29\" rx=\"12.5\" ry=\"11.5\" fill=\"#f09830\"/>\n    <ellipse cx=\"43\" cy=\"28\" rx=\"13\" ry=\"12.5\" fill=\"#f09830\"/>\n    <ellipse cx=\"32\" cy=\"23\" rx=\"12\" ry=\"10.5\" fill=\"#f09830\"/>\n    <ellipse cx=\"15\" cy=\"37\" rx=\"8\" ry=\"8\" fill=\"#f09830\"/>\n    <ellipse cx=\"49\" cy=\"37\" rx=\"8.5\" ry=\"8\" fill=\"#f09830\"/>\n    <g class=\"eyes\">\n      <ellipse class=\"eye\" cx=\"25.2\" cy=\"31\" rx=\"4.4\" ry=\"7.6\" fill=\"#fff\"/>\n      <ellipse class=\"eye r\" cx=\"38.8\" cy=\"31\" rx=\"4.4\" ry=\"7.6\" fill=\"#fff\"/>\n    </g>\n  </g>\n</svg>\n";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/");
    try {
      if (url.pathname === "/" && req.method === "GET") return new Response(createPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });
      if (url.pathname === "/sdk.js") return assetResponse(req, url, SDK, ASSET_HASHES["sdk.js"]);
      if (url.pathname === "/bridge.js") return assetResponse(req, url, BRIDGE, ASSET_HASHES["bridge.js"]);
      if (url.pathname === "/host.js") return assetResponse(req, url, HOST_JS, ASSET_HASHES["host.js"]);
      if (url.pathname === "/api/create" && req.method === "POST") return handleCreate(req, env, ctx, url);
      if (parts[1] === "api" && parts[2] === "admin") return handleAdmin(req, env, ctx, url, parts);
      if (parts[1] === "api" && parts[2] === "a" && ID_RE.test(parts[3] || "") && parts.length <= 6) return handleEditorApi(req, env, ctx, url, parts[3], parts[4] || "", parts[5] || "");
      if (parts[1] === "a" && ID_RE.test(parts[2] || "") && parts.length <= 4) return handleArtifact(req, env, url, parts[2], parts[3] || "");
      if (url.pathname === "/favicon.ico" || url.pathname === "/cya.svg") {
        return new Response(CYA_MARK, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.log("error", String(e && e.stack || e));
      return json({ error: "internal", message: String(e && e.message || e) }, 500);
    }
  },
};
