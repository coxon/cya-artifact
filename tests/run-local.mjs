// Fresh, credential-free deployment rehearsal. No Cloudflare login or remote bindings.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, cp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "cya-artifact-test-"));
const token = randomBytes(24).toString("base64url");
const browser = process.argv.includes("--browser") || process.argv.includes("--all");
const all = process.argv.includes("--all");
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "PLAYWRIGHT_BROWSERS_PATH", "CHROMIUM_EXECUTABLE_PATH"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { CI: "true", WRANGLER_SEND_METRICS: "false", CLOUDFLARE_CF_FETCH_ENABLED: "false", WRANGLER_LOG_PATH: path.join(temp, "logs"), XDG_CONFIG_HOME: path.join(temp, "config") });
const redacted = text => String(text).replaceAll(token, "[local credential]").replace(/([?&]edit=)[^\s"')]+/g, "$1[redacted]");
let server, serverLog = "";
async function run(file, args = [], extra = {}) {
  console.log(`\nRunning ${file} ${args.join(" ")}`);
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => process.stdout.write(redacted(data)));
  child.stderr.on("data", data => process.stderr.write(redacted(data)));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${file} failed`);
}
try {
  await run("build.mjs");
  await run("--test", ["tests/webhooks_test.mjs"]);
  // Copy only public source/config: never load the developer's .env, .dev.vars,
  // local account configuration, production credentials, or existing DO state.
  for (const file of ["wrangler.toml", "build.mjs", "worker.src.js", "sdk.js", "sdk_offline.js", "bridge.js", "host.js"]) await cp(path.join(root, file), path.join(temp, file));
  await writeFile(path.join(temp, ".dev.vars"), `ADMIN_TOKEN=${token}\n`, { mode: 0o600 });
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", path.join(temp, "wrangler.toml"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--no-show-interactive-dev-session", "--persist-to", path.join(temp, "state")], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [server.stdout, server.stderr]) output.on("data", data => { serverLog = (serverLog + redacted(data)).slice(-12000); });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error("Local Wrangler exited\n" + serverLog);
    try { ready = (await fetch(origin, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, "Local Wrangler did not start\n" + serverLog);
  console.log("Fresh local Wrangler is ready; webhooks and remote credentials are absent.");
  Object.assign(env, { ARTIFACT_BASE_URL: origin, ADMIN_TOKEN: token });
  // Set parent values for fixture helpers imported after the server starts.
  process.env.ARTIFACT_BASE_URL = origin; process.env.ADMIN_TOKEN = token;
  await run("tests/api_test.mjs");
  await run("tests/asset_cache_test.mjs");
  const { createPage } = await import("./local_helpers.mjs");
  const { readFile } = await import("node:fs/promises");
  const counter = await createPage(await readFile(path.join(root, "tests/counter.html"), "utf8"));
  await run("tests/ws_test.mjs", [], { TEST_ARTIFACT_ID: counter.artifact_id });
  const fixture = await readFile(path.join(root, "tests/edit_fixture.html"), "utf8");
  const ui = await createPage(fixture);
  await run("tests/ui_test.mjs", [], { TEST_ARTIFACT_ID: ui.artifact_id, TEST_EDIT_TOKEN: ui.edit_token });
  if (browser) {
    await run("tests/comments_polish_test.mjs", [], { COMMENTS_TEST_ORIGIN: origin, COMMENTS_TEST_ADMIN_TOKEN: token });
    const ux = await createPage(fixture);
    await run("tests/edit_ux_test.mjs", [], { TEST_ARTIFACT_ID: ux.artifact_id, TEST_EDIT_TOKEN: ux.edit_token, TEST_ENGINES: all ? "chromium,webkit" : "chromium" });
    await run("tests/waiting_test.mjs", [all ? "chromium,webkit" : "chromium"]);
  }
  await mkdir(path.join(root, ".codex-run"), { recursive: true });
  await writeFile(path.join(root, ".codex-run/local-suite.json"), JSON.stringify({ status: "passed", suite: all ? "all" : browser ? "browser" : "core", freshStorage: true, remoteCredentials: false, webhooksConfigured: false, finished: new Date().toISOString() }, null, 2) + "\n");
  console.log("\nPASS: local deployment and requested regression suites");
} catch (error) {
  console.error(redacted(error.stack || error));
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM");
    const force = setTimeout(() => server.kill("SIGKILL"), 5000);
    await stopped; clearTimeout(force);
  }
  await rm(temp, { recursive: true, force: true });
}
