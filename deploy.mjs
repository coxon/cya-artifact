// Optional direct-API deployment. Prefer `npx wrangler deploy` for normal use.
// Reads configuration from the environment; preserves existing secret/plain bindings.
import { readFileSync } from "node:fs";

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--domain")) {
    throw new Error("Usage: node deploy.mjs [--domain]");
  }
  const account = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const name = process.env.CF_WORKER_NAME || "cya-artifact";
  if (!/^[a-f0-9]{32}$/i.test(account || "")) throw new Error("Set CF_ACCOUNT_ID to your Cloudflare account ID.");
  if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN to a token with Worker deployment permissions.");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("CF_WORKER_NAME must be a valid Worker name (lowercase letters, digits, hyphens).");

  let domain;
  if (process.argv.includes("--domain")) {
    const zone = process.env.CF_ZONE_ID;
    if (!/^[a-f0-9]{32}$/i.test(zone || "")) throw new Error("--domain requires CF_ZONE_ID.");
    let url;
    try { url = new URL(process.env.ARTIFACT_BASE_URL); } catch { /* Validate below without echoing input. */ }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("--domain requires ARTIFACT_BASE_URL to be an HTTPS origin without a port or path.");
    }
    domain = { hostname: url.hostname, service: name, zone_id: zone, environment: "production" };
  }

  // Read the build before making any remote changes.
  let source;
  try { source = readFileSync(new URL("./dist/worker.js", import.meta.url)); }
  catch { throw new Error("Build the Worker first: node build.mjs"); }

  const api = async (method, path, body) => {
    const isForm = body instanceof FormData;
    let response;
    try {
      response = await fetch("https://api.cloudflare.com/client/v4" + path, {
        method,
        headers: { authorization: "Bearer " + apiToken, ...(isForm ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch { throw new Error("Cloudflare request failed; check your network connection."); }
    let result;
    try { result = await response.json(); } catch { throw new Error("Cloudflare returned an invalid response."); }
    if (!response.ok || !result.success) {
      const codes = (result.errors || []).map((error) => Number(error.code)).filter(Number.isFinite);
      throw new Error(`Cloudflare request failed (HTTP ${response.status}; error codes: ${codes.join(", ") || "unknown"}).`);
    }
    return result;
  };

  const scripts = await api("GET", `/accounts/${account}/workers/scripts`);
  if (!Array.isArray(scripts.result)) throw new Error("Cloudflare returned an invalid Worker list.");
  if (scripts.result_info?.total_count > scripts.result.length) throw new Error("Worker list is paginated; use Wrangler to preserve migration history safely.");
  const tag = scripts.result.find((script) => script.id === name)?.migration_tag;
  if (tag && tag !== "v1") throw new Error("This Worker has another migration history. Use its existing Wrangler configuration.");
  const metadata = {
    main_module: "worker.js", compatibility_date: "2026-10-01",
    bindings: [
      { type: "durable_object_namespace", name: "ARTIFACT", class_name: "ArtifactDO" },
      { type: "durable_object_namespace", name: "INDEX", class_name: "IndexDO" },
    ],
    keep_bindings: ["secret_text", "plain_text"],
    observability: { enabled: true },
  };
  if (!tag) metadata.migrations = { new_tag: "v1", new_sqlite_classes: ["ArtifactDO", "IndexDO"] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");
  await api("PUT", `/accounts/${account}/workers/scripts/${name}`, form);
  console.log("Worker uploaded; existing secrets and plain-text variables preserved.");
  await api("POST", `/accounts/${account}/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  console.log("workers.dev enabled. Find the address in your Cloudflare dashboard.");
  if (domain) {
    await api("PUT", `/accounts/${account}/workers/domains`, domain);
    console.log("Custom domain attached.");
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
