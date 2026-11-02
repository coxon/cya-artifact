import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const files = { SDK_SOURCE: "sdk.js", SDK_OFFLINE: "sdk_offline.js", BRIDGE: "bridge.js", HOST_JS: "host.js" };
const replacements = {}, hashes = {};
for (const [key, file] of Object.entries(files)) {
  const content = readFileSync(new URL("./" + file, import.meta.url), "utf8");
  replacements[key] = JSON.stringify(content);
  if (key !== "SDK_OFFLINE") hashes[file] = createHash("sha256").update(content).digest("hex").slice(0, 10);
}
replacements.ASSET_HASHES = JSON.stringify(hashes);
// Replace in one pass so embedded script content is never treated as a placeholder.
const src = readFileSync(new URL("./worker.src.js", import.meta.url), "utf8")
  .replace(/__(SDK_SOURCE|SDK_OFFLINE|BRIDGE|HOST_JS|ASSET_HASHES)__/g, (_, key) => replacements[key]);
mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/worker.js", import.meta.url), src);
console.log("built", src.length);
