import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const origin = new URL(process.env.ARTIFACT_BASE_URL || "http://127.0.0.1:8787");
assert(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), "Tests only accept a loopback HTTP origin");
assert(!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "Use a bare local origin");
export const base = origin.origin;
export const adminToken = process.env.ADMIN_TOKEN || (process.env.ADMIN_TOKEN_FILE ? readFileSync(process.env.ADMIN_TOKEN_FILE, "utf8").trim() : "");
const sensitive = new Set([adminToken, process.env.TEST_EDIT_TOKEN].filter(Boolean));
export function redact(error) {
  let text = String(error?.stack || error);
  for (const value of sensitive) text = text.replaceAll(value, "[redacted]");
  return text.replace(/([?&]edit=)[^\s"')]+/g, "$1[redacted]");
}
process.on("uncaughtException", error => { console.error(redact(error)); process.exit(1); });
export async function api(route, body, auth = "admin", expected = 200) {
  assert(route.startsWith("/") && !route.startsWith("//"));
  const headers = { "content-type": "application/json" };
  if (auth === "admin") { assert(adminToken, "Set a local ADMIN_TOKEN"); headers.authorization = "Bearer " + adminToken; }
  else if (auth) { headers["x-edit-token"] = auth; sensitive.add(auth); }
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  assert.equal(response.status, expected, `${route}: expected HTTP ${expected}, received ${response.status}`);
  const data = await response.json();
  for (const key of ["edit_token", "code"]) if (data[key]) sensitive.add(data[key]);
  if (data.edit_url) sensitive.add(new URL(data.edit_url).searchParams.get("edit"));
  return data;
}
export async function blockExternal(context) {
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    if (url.origin === base.replace(/^http/, "ws")) socket.connectToServer();
    else socket.close();
  });
}
export const launchOptions = engine => ({ headless: true, ...(engine === "chromium" && process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
export async function createPage(html, notify = false) {
  const invite = await api("/api/admin/invites", { label: "Local test", daily_limit: 100 });
  const page = await api("/api/create", { invite: invite.code, instructions: "Local test fixture" }, null);
  await api(`/api/admin/artifacts/${page.artifact_id}/settings`, { notify });
  if (html) await api(`/api/admin/jobs/${page.job_id}/publish`, { html });
  return page;
}
