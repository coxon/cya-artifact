// Offline contract checks. No Cloudflare credentials, DO runtime, or network access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { webcrypto } from "node:crypto";

const source = readFileSync(new URL("../worker.src.js", import.meta.url), "utf8")
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
  .replace(/export class /g, "class ")
  .replace("export default {", "globalThis.worker = {")
  .replace(/__SDK_SOURCE__|__SDK_OFFLINE__|__BRIDGE__|__HOST_JS__/g, '""')
  .replace("__ASSET_HASHES__", "{}")
  + "\nglobalThis.subject = { notify, notifyJob, artifactCsp, hostCsp };";

// Each test gets fresh globals. fetch always uses a local mock, never Node's fetch.
function loadWorker(respond = async () => new Response(null, { status: 204 })) {
  const calls = [], logs = [], deadlines = [];
  const signal = new AbortController().signal;
  const context = vm.createContext({
    DurableObject: class {}, Request, Response, URL, Headers, TextEncoder,
    crypto: webcrypto,
    AbortSignal: { timeout(ms) { deadlines.push(ms); return signal; } },
    console: { log(...args) { logs.push(args.join(" ")); } },
    fetch: async (...args) => { calls.push(args); return respond(...args); },
  });
  vm.runInContext(source, context, { filename: "worker.src.js", timeout: 1000 });
  return { ...context.subject, worker: context.worker, calls, logs, deadlines, signal };
}

// Convert VM objects to this test's realm before comparing them.
const plain = (value) => JSON.parse(JSON.stringify(value));
const payload = { job_id: "job-example", artifact_id: "Example1", kind: "edit", url: "https://reports.example.com/a/Example1" };
const routine = { ROUTINE_WEBHOOK_URL: "https://routine.example.com/hook", ROUTINE_SENDER_KEY: "test-routine-key" };
const editor = { EDITOR_WEBHOOK_URL: "https://editor.example.com/hook", EDITOR_SENDER_KEY: "test-editor-key" };

test("missing or partial webhook configuration skips delivery", async () => {
  const subject = loadWorker();
  for (const [env, route] of [
    [{}, undefined],
    [{ ROUTINE_WEBHOOK_URL: routine.ROUTINE_WEBHOOK_URL }, undefined],
    [{ ROUTINE_SENDER_KEY: routine.ROUTINE_SENDER_KEY }, undefined],
    [{ ROUTINE_SENDER_KEY_ARTIFACT: "test-legacy-key" }, undefined],
    [{}, "editor"],
    [{ EDITOR_WEBHOOK_URL: editor.EDITOR_WEBHOOK_URL }, "editor"],
    [{ EDITOR_SENDER_KEY: editor.EDITOR_SENDER_KEY }, "editor"],
  ]) {
    assert.deepEqual(plain(await subject.notify(env, payload, route)), { skipped: "not_configured" });
  }
  assert.equal(subject.calls.length, 0);
  assert.equal(subject.deadlines.length, 0);
});

test("an explicit unconfigured editor route never falls back to the routine", async () => {
  const subject = loadWorker();
  for (const env of [routine, { ...routine, EDITOR_WEBHOOK_URL: editor.EDITOR_WEBHOOK_URL }, { ...routine, EDITOR_SENDER_KEY: editor.EDITOR_SENDER_KEY }]) {
    assert.deepEqual(plain(await subject.notify(env, payload, "editor")), { skipped: "not_configured" });
  }
  assert.equal(subject.calls.length, 0);
});

test("configured delivery sends only the pointer with auth, a deadline, and no redirects", async () => {
  let cancelled = false;
  const subject = loadWorker(async () => ({ status: 202, body: { async cancel() { cancelled = true; } } }));
  assert.deepEqual(plain(await subject.notify(routine, payload)), { status: 202, to: "routine" });
  const [url, options] = subject.calls[0];
  assert.equal(url, routine.ROUTINE_WEBHOOK_URL);
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "manual");
  assert.equal(options.headers.authorization, "Bearer " + routine.ROUTINE_SENDER_KEY);
  assert.equal(options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(options.body), payload);
  assert.equal(options.signal, subject.signal);
  assert.deepEqual(subject.deadlines, [10000]);
  assert.equal(cancelled, true);
  assert(!subject.logs.join("\n").includes(routine.ROUTINE_SENDER_KEY));
});

test("routine sender keys support the legacy name and prefer the generic name", async () => {
  const subject = loadWorker();
  await subject.notify({ ROUTINE_WEBHOOK_URL: routine.ROUTINE_WEBHOOK_URL, ROUTINE_SENDER_KEY_ARTIFACT: "test-legacy-key" }, payload);
  assert.equal(subject.calls[0][1].headers.authorization, "Bearer test-legacy-key");
  await subject.notify({ ...routine, ROUTINE_SENDER_KEY_ARTIFACT: "test-legacy-key" }, payload);
  assert.equal(subject.calls[1][1].headers.authorization, "Bearer " + routine.ROUTINE_SENDER_KEY);
});

test("edit routing uses editor credentials while new jobs always use the routine", async () => {
  const subject = loadWorker();
  const env = { ...routine, ...editor };
  assert.deepEqual(plain(await subject.notify(env, payload, "editor")), { status: 204, to: "editor" });
  assert.equal(subject.calls[0][0], editor.EDITOR_WEBHOOK_URL);
  assert.equal(subject.calls[0][1].headers.authorization, "Bearer " + editor.EDITOR_SENDER_KEY);
  assert.deepEqual(plain(await subject.notify(env, { ...payload, kind: "new" }, "editor")), { status: 204, to: "routine" });
  assert.equal(subject.calls[1][0], routine.ROUTINE_WEBHOOK_URL);
});

test("HTTP failures and redirects record status without consuming or logging receiver content", async () => {
  for (const status of [302, 500]) {
    const subject = loadWorker(async () => new Response("private receiver response", { status }));
    assert.deepEqual(plain(await subject.notify(routine, payload)), { status, to: "routine" });
    assert.equal(subject.calls.length, 1);
    assert(!subject.logs.join("\n").includes("private receiver response"));
  }
});

test("network and timeout errors cannot leak sender keys or receiver URLs", async () => {
  for (const name of ["TypeError", "TimeoutError"]) {
    const subject = loadWorker(async () => {
      const error = new Error("request failed at " + routine.ROUTINE_WEBHOOK_URL + " using " + routine.ROUTINE_SENDER_KEY);
      error.name = name;
      throw error;
    });
    const result = await subject.notify(routine, payload);
    assert.deepEqual(plain(result), { error: "delivery_failed", to: "routine" });
    const output = JSON.stringify(result) + subject.logs.join("\n");
    assert(!output.includes(routine.ROUTINE_WEBHOOK_URL));
    assert(!output.includes(routine.ROUTINE_SENDER_KEY));
  }
});

test("notify:false records a skip and does not send or settle a pending job", async () => {
  const subject = loadWorker();
  const recorded = [];
  const env = { ...routine, INDEX: { getByName: () => ({ setNotified: async (...args) => recorded.push(args) }) } };
  const job = { id: payload.job_id, artifact_id: payload.artifact_id, kind: "edit", status: "pending" };
  const result = await subject.notifyJob(env, job, payload.url, { info: async () => ({ notify: "0" }) });
  assert.deepEqual(plain(result), { skipped: "notify_off" });
  assert.deepEqual(recorded, [[payload.job_id, JSON.stringify({ skipped: "notify_off" })]]);
  assert.equal(subject.calls.length, 0);
  assert.equal(job.status, "pending");
});

test("unconfigured integrations record a skip without requiring a receiver", async () => {
  const subject = loadWorker();
  let recorded;
  const env = { INDEX: { getByName: () => ({ setNotified: async (_id, value) => { recorded = JSON.parse(value); } }) } };
  await subject.notifyJob(env, { id: payload.job_id, artifact_id: payload.artifact_id }, payload.url, { info: async () => ({}) });
  assert.deepEqual(recorded, { skipped: "not_configured" });
  assert.equal(subject.calls.length, 0);
});

test("admin routes fail closed before touching storage when ADMIN_TOKEN is absent or invalid", async () => {
  const { worker } = loadWorker();
  for (const [env, authorization] of [
    [{}, undefined], [{}, "Bearer undefined"], [{ ADMIN_TOKEN: "" }, "Bearer "],
    [{ ADMIN_TOKEN: "test-admin-key" }, "Bearer wrong-key"],
  ]) {
    const response = await worker.fetch(new Request("http://127.0.0.1:8787/api/admin/invites", {
      headers: authorization ? { authorization } : {},
    }), env, {});
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
});

test("creation URLs and webhook pointers follow the actual request origin", async () => {
  for (const origin of ["http://127.0.0.1:8787", "https://reports.example.com"]) {
    const subject = loadWorker();
    const pending = [];
    let recorded;
    const env = {
      ...routine, ARTIFACT_BASE_URL: "https://unused-config.example.com",
      INDEX: { getByName: () => ({
        createJob: async () => ({ artifact_id: payload.artifact_id, job_id: payload.job_id }),
        setNotified: async (_id, value) => { recorded = JSON.parse(value); },
      }) },
      ARTIFACT: { getByName: () => ({ init: async () => ({ edit_token: "test-edit-key" }), info: async () => ({}) }) },
    };
    const response = await subject.worker.fetch(new Request(origin + "/api/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: "test-invite", instructions: "Make a report" }),
    }), env, { waitUntil: (promise) => pending.push(promise) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.view_url, origin + "/a/" + payload.artifact_id);
    assert.equal(body.edit_url, body.view_url + "?edit=test-edit-key");
    await Promise.all(pending);
    assert.deepEqual(JSON.parse(subject.calls[0][1].body), { ...payload, kind: "new", url: body.view_url });
    assert.deepEqual(recorded, { status: 204, to: "routine" });
  }
});

test("CSP matches local HTTP and deployed HTTPS origins, including socket ports", () => {
  const subject = loadWorker();
  for (const [origin, socket] of [["http://127.0.0.1:8787", "ws://127.0.0.1:8787"], ["https://reports.example.com", "wss://reports.example.com"]]) {
    const url = new URL(origin + "/a/Example1/raw");
    const csp = subject.artifactCsp(url);
    assert(csp.includes("img-src data: blob: " + origin));
    assert(csp.includes("connect-src " + socket));
    assert(!csp.includes("allow-same-origin"));
    assert(subject.hostCsp(url).includes("connect-src 'self' " + socket));
  }
});
