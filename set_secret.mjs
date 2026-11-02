// Optional direct-API helper: node set_secret.mjs NAME < secret-file
// Configuration: CF_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, optional CF_WORKER_NAME.
// The secret is read from stdin and never printed. Prefer `npx wrangler secret put NAME`.
import { readFileSync } from "node:fs";

async function main() {
  const [name, extra] = process.argv.slice(2);
  if (!name || extra || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Usage: node set_secret.mjs SECRET_NAME < secret-file");
  const account = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const worker = process.env.CF_WORKER_NAME || "cya-artifact";
  if (!/^[a-f0-9]{32}$/i.test(account || "")) throw new Error("Set CF_ACCOUNT_ID to your Cloudflare account ID.");
  if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN to a token with Worker deployment permissions.");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) throw new Error("CF_WORKER_NAME must be a valid Worker name.");
  const value = readFileSync(0, "utf8").trim();
  if (!value) throw new Error("A nonempty secret value is required on stdin.");
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`, {
      method: "PUT",
      headers: { authorization: "Bearer " + apiToken, "content-type": "application/json" },
      body: JSON.stringify({ name, text: value, type: "secret_text" }),
    });
  } catch { throw new Error("Cloudflare request failed; check your network connection."); }
  let result;
  try { result = await response.json(); } catch { throw new Error("Cloudflare returned an invalid response."); }
  if (!response.ok || !result.success) {
    const codes = (result.errors || []).map((error) => Number(error.code)).filter(Number.isFinite);
    throw new Error(`Secret update failed (HTTP ${response.status}; error codes: ${codes.join(", ") || "unknown"}).`);
  }
  console.log("Secret updated.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
