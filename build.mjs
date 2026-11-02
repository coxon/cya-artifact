import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const r = (f) => JSON.stringify(readFileSync(new URL("./" + f, import.meta.url), "utf8"));
const src = readFileSync(new URL("./worker.src.js", import.meta.url), "utf8")
  .replace("__SDK_SOURCE__", () => r("sdk.js")).replace("__SDK_OFFLINE__", () => r("sdk_offline.js"))
  .replace("__BRIDGE__", () => r("bridge.js")).replace("__HOST_JS__", () => r("host.js"));
mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/worker.js", import.meta.url), src);
console.log("built", src.length);
