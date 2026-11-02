// Exercise the built Worker over HTTP, including shell/raw markup and revalidation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { base, api, createPage } from "./local_helpers.mjs";

const hashOf = content => createHash("sha256").update(content).digest("hex").slice(0, 10);
const immutable = "public, max-age=31536000, immutable";
const assets = new Map();
for (const file of ["host.js", "bridge.js", "sdk.js"]) {
  const content = await readFile(new URL("../" + file, import.meta.url));
  const hash = hashOf(content), etag = `"${hash}"`;
  assets.set(file, hash);
  const staleHash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  for (const [query, cache] of [[`?v=${hash}`, immutable], ["", "no-cache"], [`?v=${staleHash}`, "no-cache"], ["?v=", "no-cache"]]) {
    const url = `${base}/${file}${query}`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), cache, `${file}${query}: cache policy`);
    assert.equal(response.headers.get("etag"), etag, `${file}${query}: content ETag`);
    assert.match(response.headers.get("content-type"), /^application\/javascript/);
    const served = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(served, content, `${file}${query}: serves current source`);
    assert.equal(hashOf(served), hash);
    for (const condition of [etag, `W/${etag}`, `"stale", W/${etag}`, "*"]) {
      const cached = await fetch(url, { headers: { "if-none-match": condition } });
      assert.equal(cached.status, 304, `${file}${query}: revalidation ${condition}`);
      assert.equal(await cached.text(), "", "304 has no body");
      assert.equal(cached.headers.get("etag"), etag);
      assert.equal(cached.headers.get("cache-control"), cache);
    }
    const changed = await fetch(url, { headers: { "if-none-match": `"${staleHash}"` } });
    assert.equal(changed.status, 200, "stale ETag receives current content");
    assert.equal(hashOf(Buffer.from(await changed.arrayBuffer())), hash);
  }
  const head = await fetch(`${base}/${file}?v=${hash}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(head.headers.get("cache-control"), immutable);
  assert.equal(await head.text(), "");
  const cachedHead = await fetch(`${base}/${file}`, { method: "HEAD", headers: { "if-none-match": etag } });
  assert.equal(cachedHead.status, 304);
  assert.equal(cachedHead.headers.get("cache-control"), "no-cache");
  console.log(`PASS ${file}: content hash, versioned/fallback caching, ETag and GET/HEAD revalidation`);
}

async function assertScripts(route, expected) {
  const response = await fetch(base + route);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sources, expected.map(file => `/${file}?v=${assets.get(file)}`), "all emitted script URLs carry their content hash");
  for (const source of sources) {
    const response = await fetch(base + source);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), immutable);
    assert.equal(new URL(source, base).searchParams.get("v"), hashOf(Buffer.from(await response.arrayBuffer())), "script URL hash matches served bytes");
  }
}

const page = await createPage();
await assertScripts(`/a/${page.artifact_id}`, ["host.js"]);
await api(`/api/admin/jobs/${page.job_id}/publish`, { html: "<!doctype html><html><head><title>Local asset regression</title></head><body>Asset cache fixture</body></html>" });
await assertScripts(`/a/${page.artifact_id}`, ["host.js"]);
await assertScripts(`/a/${page.artifact_id}/raw`, ["sdk.js", "bridge.js"]);
console.log("PASS pending/ready shells and raw page: versioned URLs match served content hashes");
