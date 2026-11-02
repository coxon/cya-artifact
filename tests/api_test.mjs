import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { api, base, createPage } from "./local_helpers.mjs";

let checks = 0;
function check(value, name) { assert(value, name); checks++; console.log("PASS " + name); }
const tmp = await mkdtemp(path.join(tmpdir(), "artifact-api-"));
const scripts = new URL("..", import.meta.url).pathname;
function helper(name, args, status = 0, input) {
  const result = spawnSync("bash", [path.join(scripts, name), ...args], { encoding: "utf8", env: { ...process.env, ARTIFACT_BASE_URL: base }, input });
  assert.equal(result.status, status, `${name} exit status`);
  return result.stdout;
}
async function notifiedJob(id) {
  // waitUntil notifications may finish after the create/comment response.
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await api(`/api/admin/jobs/${id}`);
    if (job.notified) return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for local notification status");
}
try {
  await api("/api/admin/invites", undefined, null, 401);
  await api("/api/create", { instructions: "No invite" }, null, 403);
  check(true, "admin and invite authorization fail closed");
  const html = await readFile(new URL("./counter.html", import.meta.url), "utf8");
  const page = await createPage(null, true);
  const id = page.artifact_id, token = page.edit_token, a = `/api/admin/artifacts/${id}`, e = `/api/a/${id}`;
  check([page.url, page.view_url, page.edit_url].every(url => new URL(url).origin === base), "create links use request origin");
  const pendingJob = await notifiedJob(page.job_id);
  check(pendingJob.status === "pending" && JSON.parse(pendingJob.notified).skipped === "not_configured", "new page stays pending without webhook");
  check((await api(`/a/${id}/status`, undefined, null)).status === "pending", "unpublished page status is pending");
  // Same local helper flow documented for a first manual page, including live drafts.
  const file = path.join(tmp, "page.html"); await writeFile(file, html);
  helper("stream_start.sh", [id, "Local first page"]);
  helper("stream_append.sh", [id], 0, html.slice(0, 220));
  const draft = await api(a + "/draft");
  check(draft.active && draft.html === html.slice(0, 220), "live draft start/append is available without webhook");
  const published = JSON.parse(helper("publish.sh", [page.job_id, file, "Local report"]));
  check(published.ok && new URL(published.url).origin === base, "publish.sh creates first page using environment configuration");
  check(!(await api(a + "/draft")).active, "publish closes live draft");
  check((await api(a + "/versions")).versions[0].author === "Assistant", "generic default publisher name");
  const raw = await fetch(`${base}/a/${id}/raw`);
  check(raw.headers.get("content-security-policy").includes(base) && raw.headers.get("content-security-policy").includes(base.replace(/^http/, "ws")), "raw CSP allows local SDK and WebSocket origin");
  const host = await (await fetch(page.url)).text();
  check(!host.includes(token), "viewer host never embeds edit token");
  for (const route of ["me", "source", "versions", "versions/1", "comments"]) {
    await api(e + "/" + route, undefined, null, 403);
    await api(e + "/" + route, undefined, "invalid", 403);
    await api(e + "/" + route, undefined, token);
  }
  for (const route of ["versions", "restore", "comments"]) await api(e + "/" + route, {}, null, 403);
  await api(`${e}/source?edit=${token}`, undefined, null, 403);
  check(true, "editor GET/POST APIs require the header token; query token is refused");
  const saved = await api(e + "/versions", { html, base_version: 1, sid: "first-editor" }, token);
  await api(e + "/versions", { html, base_version: 1 }, token, 409);
  await api(e + "/versions", { html }, token, 400);
  check(saved.version === 2, "hand edits create versions and reject stale/missing base_version");
  const comment = await api(e + "/comments", { request: "Make the heading red", author: "Reviewer", text: "Shared counter", selector: ".m" }, token);
  const job = await notifiedJob(comment.job_id);
  check(job.status === "pending" && JSON.parse(job.notified).skipped === "not_configured" && job.comments[0].status === "open", "comment stays pending with notify enabled and no webhook");
  check(job.kind === "edit" && job.html === html && job.current_version === 2, "manual edit job supplies current HTML, version, and comment");
  const fetched = helper("edit_fetch.sh", [comment.job_id]);
  check(fetched === html, "edit_fetch.sh returns current HTML and records base version");
  await api(e + "/versions", { html: html.replace("Shared counter", "Shared counter edited"), base_version: 2, sid: "other-editor" }, token);
  helper("publish_edit.sh", [comment.job_id, file, "red heading", "Maintainer"], 3);
  check((await api(e + "/comments", undefined, token)).comments[0].status === "open", "stale manual publish leaves comment pending");
  const fresh = helper("edit_fetch.sh", [comment.job_id]);
  await writeFile(file, fresh.replace("</head>", "<style>h1{color:red}</style></head>"));
  helper("publish_edit.sh", [comment.job_id, file, "red heading", "Maintainer"]);
  const resolved = (await api(e + "/comments", undefined, token)).comments[0];
  check(resolved.status === "resolved" && resolved.resolved_by === "Maintainer", "manual publish resolves comment with explicit author");
  const latest = await api(a + "/html");
  check(latest.html.includes("Shared counter edited"), "refetch and publish preserves concurrent hand edits");
  await api(a + "/html", { html, base_version: 1 }, "admin", 409);
  const failed = await api(e + "/comments", { request: "Unsupported change" }, token);
  helper("fail.sh", [failed.job_id, "Cannot perform this request"]);
  check((await api(e + "/comments", undefined, token)).comments.find(c => c.id === failed.comment_id).status === "failed", "manual fail records reason without changing ready page");
  await api(a + "/settings", { route: "editor" });
  const editorComment = await api(e + "/comments", { request: "Queue for optional editor" }, token);
  check((await api(`/api/admin/jobs/${editorComment.job_id}/notify`, {})).skipped === "not_configured", "explicit editor route without webhook remains manually processable");
  await api(a + "/settings", { notify: false });
  check((await api(`/api/admin/jobs/${editorComment.job_id}/notify`, {})).skipped === "notify_off", "notify:false suppresses delivery");
  const restored = await api(e + "/restore", { n: 1 }, token);
  check(restored.version > latest.version && (await api(a + "/versions")).versions[0].source === "restore", "restore creates a new history entry");
  const snapshot = await fetch(`${base}/a/${id}/export`), exported = await snapshot.text();
  check(snapshot.headers.get("content-disposition").includes("attachment") && exported.includes("offline: true") && !exported.includes("new WebSocket"), "HTML export is an offline snapshot without live socket");
  const copy = await api(a + "/copy", { notify: false });
  check(new URL(copy.url).origin === base && new URL(copy.edit_url).origin === base, "copy links use request origin");
  const rotated = await api(a + "/edit-token/rotate", {});
  await api(e + "/me", undefined, token, 403);
  await api(e + "/me", undefined, rotated.edit_token);
  check(new URL(rotated.edit_url).origin === base, "rotation invalidates old editor token and uses request origin");
  console.log(`API: ${checks} grouped checks passed`);
} finally { await rm(tmp, { recursive: true, force: true }); }
