// Local-only integration regression. Requires a running `wrangler dev --local` with no webhooks.
// COMMENTS_TEST_ORIGIN=http://127.0.0.1:8787 COMMENTS_TEST_VARS=.codex-run/.dev.vars \
//   node tests/comments_polish_test.mjs
// Optional: COMMENTS_TEST_ADMIN_TOKEN, PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE_PATH.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = new URL(process.env.COMMENTS_TEST_ORIGIN || process.env.ARTIFACT_BASE_URL || "http://127.0.0.1:8787");
assert(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.protocol === "http:", "Refusing non-loopback test origin");
const base = origin.origin;
const runDir = path.resolve(".codex-run"), shotsDir = path.join(runDir, "shots");
await fs.mkdir(shotsDir, { recursive: true });
let adminToken = process.env.COMMENTS_TEST_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
if (!adminToken) {
  const vars = await fs.readFile(process.env.COMMENTS_TEST_VARS || ".dev.vars", "utf8");
  adminToken = vars.match(/^ADMIN_TOKEN\s*=\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
}
assert(adminToken, "Missing local test ADMIN_TOKEN");
const results = { origin: base, started: new Date().toISOString(), checks: [], screenshots: [], browserErrors: [], limitations: ["Chromium only; no real iOS/Safari device", "390px selection uses DOM Range, not a native touch selection gesture", "History rendering is triggered programmatically because its existing toolbar button is hidden"] };
const sockets = [], sensitiveValues = [adminToken];
let browser;
function check(condition, label) {
  assert(condition, label);
  results.checks.push(label);
  console.log("PASS " + label);
}
function redact(error) {
  return sensitiveValues.reduce((text, value) => value ? text.replaceAll(value, "[redacted]") : text, String(error?.stack || error)).replace(/([?&]edit=)[^\s"')]+/g, "$1[redacted]");
}
async function api(route, body, auth = "admin", expected = 200) {
  const headers = { "content-type": "application/json" };
  if (auth === "admin") headers.authorization = "Bearer " + adminToken;
  else if (auth) headers["x-edit-token"] = auth;
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  assert.equal(response.status, expected, `${route}: expected HTTP ${expected}, received ${response.status}`);
  return response.json();
}
const request1 = "请把第一处说明写清楚，保留原来的定位。";
const request2 = "请补充第二处结论，并由编辑者署名。";
const text1 = "第一处评论目标：这段说明需要保留原来的位置。";
const text2 = "第二处评论目标跨越行内标签，仍然应该准确定位。";
function fixture(signatures = true) {
  return `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>评论交互本地实测</title><style>
  *{box-sizing:border-box}body{margin:0;color:#24302b;background:#f7f8f4;font:17px/1.8 system-ui,sans-serif}main{max-width:840px;margin:auto;padding:30px 22px 160px}h1{font-size:28px;line-height:1.3}h2{font-size:22px}p{margin:18px 0}.by{display:inline-block;padding:3px 10px;border-radius:7px;background:#e2ece5;color:#315743;font-size:13px;white-space:normal}.spacer{height:1050px;border-left:2px solid #d9e2da;margin:28px 4px}.answer{padding:14px;background:#fff;border:1px solid #d9e2da;border-radius:10px}.label{font-size:13px;color:#69796f}
  </style></head><body><main><div class="label">LOCAL REGRESSION / COMMENTS</div><h1>评论与回答，准确相连</h1><p id="selection">选择这一段文字，可以提交带有原文的评论。</p>
  ${signatures ? '<p class="answer">第一条回答 <span class="by" id="sig1">Cya 答 · 评论&nbsp;1 · 11/2 10:00</span></p><p class="answer">第二条回答 <span class="by" id="sig2"><b>Cya.Editor</b> 答 · 评&#35770; <b>2</b> · 11/2 10:01</span></p><div hidden><span class="by" id="ambiguous">评论 1 / 评论 2</span><span class="by" id="decimal">评论 1.5</span><span class="by" id="zero">评论 0</span><span class="by" id="suffix">评论 1abc</span><span class="by" id="exponent">评论 1e2</span><span class="by" id="explicit" data-cid="keep-this-id">评论 1</span></div><script type="text/plain" id="raw-label"><span class="by">Cya 答 · 评论 1</span></script>' : ""}
  <p id="old-target">这个段落已经改写，不能当成第二处评论目标。</p><div class="spacer" aria-hidden="true"></div><h2>第一处原文</h2><p id="target1">${text1}</p><div class="spacer" aria-hidden="true"></div><h2>第二处原文</h2><p id="target2">第二处评论目标<strong>跨越行内标签</strong>，仍然应该准确定位。</p></main></body></html>`;
}
async function frameOf(page) {
  await page.waitForFunction(() => !!document.querySelector("#frame"));
  // Use elementHandle for a stable Frame across Playwright versions.
  const element = await page.locator("#frame").elementHandle();
  const actual = await element.contentFrame();
  await actual.waitForFunction(() => !!document.querySelector("#selection") && !!window.__AE_BRIDGE__);
  return actual;
}
async function watchVersions(id) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/a/" + id + "/ws");
  sockets.push(ws);
  const messages = [];
  ws.addEventListener("message", event => { try { messages.push(JSON.parse(event.data)); } catch {} });
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error("Local websocket failed")), { once: true }); });
  return { ws, messages };
}
async function until(fn, label, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 80)); }
  assert.fail(label);
}
// CDP can inspect the product's closed shadow root without changing application behavior.
async function findCdpNode(cdp, match) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const search = n => {
    const attrs = {}, a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) attrs[a[i]] = a[i + 1];
    if (match(attrs)) return n;
    for (const child of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) { const hit = search(child); if (hit) return hit; }
    return null;
  };
  return search(root);
}
async function overlayState(cdp) {
  const node = await findCdpNode(cdp, attrs => attrs.id === "fl");
  if (!node) return null;
  const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId });
  return Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
}
async function clickSignature(page, frame, selector) {
  await frame.locator(selector).scrollIntoViewIfNeeded();
  // Let the iframe's debounced scroll event finish before opening the popover.
  await page.waitForTimeout(220);
  await frame.locator(selector).click();
  await page.locator("#byPop").waitFor({ state: "visible" });
}
async function assertFits(page, selector, label) {
  const rect = await page.locator(selector).boundingBox();
  const { width, height } = page.viewportSize();
  check(rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1, label);
}
async function assertPublicHostHasNoToken(id, token, status) {
  const response = await fetch(`${base}/a/${id}`, { redirect: "error" });
  assert.equal(response.status, 200, `${status}: public host responds`);
  const html = await response.text();
  const bootstrapText = html.match(/window\.__HOST__=(\{[^<]*?\});<\/script>/)?.[1];
  const bootstrap = bootstrapText ? JSON.parse(bootstrapText) : null;
  check(!html.includes(token) && bootstrap && !Object.hasOwn(bootstrap, "edit_token"), `${status}: public host HTML and bootstrap contain no editor token`);
}

try {
  const invite = await api("/api/admin/invites", { label: "comments-polish local-only", daily_limit: 100 });
  const created = await api("/api/create", { invite: invite.code, instructions: "Local-only comments regression fixture" }, null);
  const id = created.artifact_id, editToken = created.edit_token;
  sensitiveValues.push(editToken, invite.code);
  results.artifactId = id;
  await api(`/api/admin/artifacts/${id}/settings`, { notify: false });
  await assertPublicHostHasNoToken(id, editToken, "pending");
  await api(`/api/admin/jobs/${created.job_id}/publish`, { html: fixture(false), title: "评论交互本地实测" });
  await assertPublicHostHasNoToken(id, editToken, "ready");
  const c1 = await api(`/api/a/${id}/comments`, { request: request1, selector: "#target1", text: text1 }, editToken);
  const c2 = await api(`/api/a/${id}/comments`, { request: request2, selector: "#old-target", text: text2, author: "审阅者" }, editToken);
  const stream = await watchVersions(id);
  let current = await api(`/api/admin/artifacts/${id}/html`);
  const v1 = await api(`/api/admin/jobs/${c1.job_id}/publish`, { html: fixture(), base_version: current.version, author: "Cya", note: "Explicit Cya author" });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  // Only comment 2 remains pending: the marker must keep global number 2, not restart at 1.
  const pendingContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await pendingContext.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const pending = await pendingContext.newPage(), pendingErrors = [];
  pending.on("pageerror", error => pendingErrors.push(redact(error)));
  await pending.goto(`${base}/a/${id}?edit=${encodeURIComponent(editToken)}`);
  const pendingFrame = await frameOf(pending), pendingCdp = await pendingContext.newCDPSession(pending);
  await pendingCdp.send("DOM.enable");
  await pendingFrame.locator("#target2").scrollIntoViewIfNeeded();
  let pin;
  await until(async () => { pin = await findCdpNode(pendingCdp, attrs => (attrs.class || "").split(/\s+/).includes("pin")); return pin; }, "pending comment marker appears");
  const { object } = await pendingCdp.send("DOM.resolveNode", { nodeId: pin.nodeId });
  const { result: pinResult } = await pendingCdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){ const r=this.getBoundingClientRect(); return {text:this.textContent,x:r.left+r.width/2,y:r.top+r.height/2}; }", returnByValue: true });
  check(pinResult.value.text === "2", "pending marker retains global comment number 2 after comment 1 resolves");
  const iframeRect = await pending.locator("#frame").boundingBox();
  await pending.mouse.click(iframeRect.x + pinResult.value.x, iframeRect.y + pinResult.value.y);
  await pending.locator(`#cm-${c2.comment_id}.focus`).waitFor();
  check((await pending.locator(`#cm-${c2.comment_id} .pinb`).innerText()) === "2", "clicking pending marker opens matching comment panel with global numbering");
  check(pendingErrors.length === 0, "pending marker flow has no browser errors");
  await pendingContext.close();
  const v2 = await api(`/api/admin/jobs/${c2.job_id}/publish`, { html: fixture(), base_version: v1.version, author: "  Cya.Editor  ", note: "Editor answer" });
  await until(() => stream.messages.some(m => m.t === "version" && m.author === "Cya.Editor"), "version broadcast includes Cya.Editor");
  check(stream.messages.some(m => m.t === "version" && m.author === "Cya"), "version broadcast preserves explicit Cya author");
  check(stream.messages.some(m => m.t === "version" && m.author === "Cya.Editor"), "version broadcast preserves trimmed Cya.Editor author");
  stream.ws.close();
  const comments = (await api(`/api/a/${id}/comments`, undefined, editToken)).comments;
  check(comments.length === 2 && comments[0].id === c1.comment_id && comments[1].id === c2.comment_id, "two comments have stable creation order");
  check(comments[0].resolved_by === "Cya" && comments[1].resolved_by === "Cya.Editor", "job publish stores both answerers");
  check(comments.every(c => c.status === "resolved"), "both edit jobs resolve comments");
  const versions = (await api(`/api/admin/artifacts/${id}/versions`)).versions;
  check(versions.find(v => v.n === v1.version).author === "Cya" && versions.find(v => v.n === v2.version).author === "Cya.Editor", "versions store both answerers");
  current = await api(`/api/admin/artifacts/${id}/html`);
  check(current.html.includes(`data-cid="${c1.comment_id}"`) && current.html.includes(`data-cid="${c2.comment_id}"`), "publishing legacy signature labels persists data-cid");
  check(["ambiguous", "decimal", "zero", "suffix", "exponent"].every(id => {
    const tag = current.html.match(new RegExp('<span\\b(?=[^>]*\\bid="' + id + '")[^>]*>'))?.[0];
    return tag && !tag.includes("data-cid");
  }), "publish leaves ambiguous, decimal, zero and suffixed comment numbers unbound");
  check(current.html.includes('data-cid="keep-this-id"'), "publish preserves explicit unknown comment ID");
  check(current.html.includes('<script type="text/plain" id="raw-label"><span class="by">Cya 答 · 评论 1</span></script>'), "publish does not rewrite signature-like text inside script");
  const anonymous = await api(`/api/admin/artifacts/${id}/html`, { html: current.html, base_version: current.version, note: "direct publish without author" });
  check((await api(`/api/admin/artifacts/${id}/versions`)).versions.find(v => v.n === anonymous.version).author === null, "direct HTML publish without author stays null");
  const longAuthor = await api(`/api/admin/artifacts/${id}/html`, { html: current.html, base_version: anonymous.version, author: "  " + "C".repeat(70) + "  ", source: "hand", note: "author length boundary" });
  check((await api(`/api/admin/artifacts/${id}/versions`)).versions.find(v => v.n === longAuthor.version).author === "C".repeat(60), "direct publish trims author and limits it to 60 characters");
  await api(`/api/admin/artifacts/${id}/html`, { html: fixture(), base_version: current.version, note: "stale write must fail" }, "admin", 409);
  check((await api(`/api/admin/artifacts/${id}/html`)).version === longAuthor.version, "stale publish returns 409 and leaves current version unchanged");
  await api(`/api/a/${id}/comments`, undefined, null, 403);
  check(true, "viewer comment API is forbidden");

  for (const width of [1280, 390]) {
    const prefix = `${width}px`;
    const context = await browser.newContext({ viewport: { width, height: width === 1280 ? 900 : 844 }, ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.origin === base || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(redact(e)));
    await page.goto(`${base}/a/${id}?edit=${encodeURIComponent(editToken)}`);
    await page.waitForFunction(() => document.body.classList.contains("m-edit"));
    let frame = await frameOf(page);
    await frame.waitForFunction(() => document.querySelector("#selection").isContentEditable);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    check(await page.locator("#bComments").count() === 0, `${prefix}: comments toolbar button is absent from DOM`);
    check(!await page.locator("#panel").evaluate(el => el.classList.contains("show")), `${prefix}: comment panel starts closed`);
    check(await frame.locator("#sig1").getAttribute("data-cid") === c1.comment_id && await frame.locator("#sig2").getAttribute("data-cid") === c2.comment_id, `${prefix}: served signatures are bound to comment IDs`);
    check(await frame.locator(".by").evaluateAll(nodes => nodes.every(n => !n.isContentEditable)), `${prefix}: signatures are not editable`);

    for (const [sig, request, asker, answerer, cid] of [["#sig1", request1, "Editor", "Cya", c1.comment_id], ["#sig2", request2, "审阅者", "Cya.Editor", c2.comment_id]]) {
      await clickSignature(page, frame, sig);
      const popup = await page.locator("#byPop").innerText();
      check(popup.includes(request) && popup.includes(asker) && popup.includes(answerer) && /v\d+/.test(popup) && /\d{1,2}[/-]\d{1,2}/.test(popup) && /已完成/.test(popup), `${prefix}: ${answerer} popup shows correct request, people, time, status and version`);
      await assertFits(page, "#byPop", `${prefix}: ${answerer} popup stays inside viewport`);
      check(!await frame.locator(sig).evaluate(el => el.isContentEditable), `${prefix}: clicking ${answerer} keeps signature locked`);
      if (sig === "#sig2") {
        const shot = path.join(shotsDir, `comments-${width}.png`);
        await page.screenshot({ path: shot });
        results.screenshots.push(path.relative(process.cwd(), shot));
      }
      await page.locator("#bpAll").click();
      await page.locator(`#cm-${cid}.focus`).waitFor();
      const panelText = await page.locator("#pbody").innerText();
      check(panelText.includes("Editor") && panelText.includes("审阅者") && panelText.includes("Cya.Editor"), `${prefix}: comments panel displays both askers and answerers`);
      await page.locator("#pclose").click();
    }
    await clickSignature(page, frame, "#sig2");
    await page.keyboard.press("Escape");
    await page.locator("#byPop").waitFor({ state: "hidden" });
    check(true, `${prefix}: Escape with iframe focus closes comment popup`);
    await clickSignature(page, frame, "#sig2");
    await frame.evaluate(() => scrollBy(0, 100));
    await page.locator("#byPop").waitFor({ state: "hidden" });
    check(true, `${prefix}: iframe scrolling closes comment popup`);
    for (const [sig, target] of [["#sig1", "#target1"], ["#sig2", "#target2"]]) {
      await clickSignature(page, frame, sig);
      const before = await frame.evaluate(() => scrollY);
      await page.locator("#bpGo").click();
      await until(async () => {
        const s = await overlayState(cdp);
        const r = await frame.locator(target).evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight, scrollY }; });
        // Wait for the requested target, not a previous highlight whose postMessage has yet to clear.
        return s && s.display !== "none" && +s.opacity > 0 && r.scrollY > before + 500 && r.top >= 0 && r.bottom <= r.height && Math.abs(parseFloat(s.top) - (r.top + r.scrollY - 3)) < 2;
      }, `${prefix}: requested target must scroll into view with its own highlight`);
      const targetRect = await frame.locator(target).evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight, scrollY }; });
      check(targetRect.scrollY > before + 500 && targetRect.top >= 0 && targetRect.bottom <= targetRect.height, `${prefix}: ${target} scrolls into view with visible highlight`);
      if (target === "#target2") {
        const shot = path.join(shotsDir, `locate-${width}.png`);
        await page.screenshot({ path: shot }); results.screenshots.push(path.relative(process.cwd(), shot));
      }
    }
    // A stale number must never override an explicit stable ID.
    await frame.locator("#sig1").evaluate(el => { el.textContent = "Cya 答 · 评论 2 · 11/2 10:00"; });
    await clickSignature(page, frame, "#sig1");
    check((await page.locator("#byPop").innerText()).includes(request1), `${prefix}: data-cid wins over a conflicting comment number`);
    await page.locator("#bpX").click();
    // Simulate legacy stored HTML or a client-generated label, without altering persisted source.
    await frame.locator("#sig2").evaluate(el => el.removeAttribute("data-cid"));
    await clickSignature(page, frame, "#sig2");
    check((await page.locator("#byPop").innerText()).includes(request2), `${prefix}: legacy label falls back to comment number`);
    await page.locator("#bpX").click();
    await frame.locator("#sig2").evaluate(el => { el.dataset.cid = "missing-comment-id"; });
    await clickSignature(page, frame, "#sig2");
    check(/没找到|未找到/.test(await page.locator("#byPop").innerText()), `${prefix}: unknown explicit data-cid cannot open another comment`);
    await page.locator("#bpX").click();
    for (const label of ["评论未知", "评论 1 / 评论 2", "评论 1.5", "评论 0", "评论 1abc", "评论 1e2"]) {
      await frame.locator("#sig2").evaluate((el, label) => { el.removeAttribute("data-cid"); el.textContent = "Cya.Editor 答 · " + label; }, label);
      await clickSignature(page, frame, "#sig2");
      check(/没找到|未找到/.test(await page.locator("#byPop").innerText()), `${prefix}: invalid label ${label} fails gracefully`);
      await page.locator("#bpX").click();
    }
    // Delay an uncached lookup, then dismiss before it completes. The response must not reopen it.
    await frame.locator("#sig2").scrollIntoViewIfNeeded(); await page.waitForTimeout(220);
    let releaseLookup, lookupBegan = false;
    const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
    const commentsUrl = `${base}/api/a/${id}/comments`;
    const delayLookup = async route => { lookupBegan = true; await lookupGate; await route.continue(); };
    await context.route(commentsUrl, delayLookup);
    await frame.locator("#sig2").click();
    await until(() => lookupBegan, `${prefix}: delayed comment lookup starts`);
    await page.keyboard.press("Escape");
    const lookupResponse = page.waitForResponse(response => response.url() === commentsUrl);
    releaseLookup(); await lookupResponse; await page.waitForTimeout(150);
    check(!await page.locator("#byPop").isVisible(), `${prefix}: dismissed async comment lookup cannot reopen popup`);
    await context.unroute(commentsUrl, delayLookup);
    // Reload removes DOM-only fixture mutations and restores editable static text.
    await page.reload(); frame = await frameOf(page);
    await frame.waitForFunction(() => document.querySelector("#selection").isContentEditable);
    await frame.locator("#selection").scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
    const selection = frame.locator("#selection");
    if (width === 1280) {
      const box = await selection.boundingBox();
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + Math.min(190, box.width - 3), box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
    } else {
      await selection.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    }
    const selected = await frame.evaluate(() => getSelection().toString().trim());
    check(selected.length > 4, `${prefix}: ${width === 1280 ? "mouse drag preserves selected text" : "DOM Range creates selected text for mobile-width form test"}`);
    await page.locator("#askChip.show").waitFor();
    await page.locator("#askChip").click();
    await page.locator("#cmModal.show").waitFor();
    check((await page.locator("#cmTarget").innerText()).includes(selected), `${prefix}: Ask Cya retains selected text after focus leaves iframe`);
    await page.locator("#cmCancel").click();
    await page.locator("#bHistory").evaluate(el => el.click());
    await page.waitForFunction(() => document.querySelector("#pbody").textContent.includes("Cya.Editor 修改"));
    check((await page.locator("#pbody").innerText()).includes("Cya 修改"), `${prefix}: programmatically opened history distinguishes Cya and Cya.Editor`);
    await page.locator("#pclose").click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${prefix}: host has no horizontal overflow`);
    check(errors.length === 0, `${prefix}: editor has no browser errors`);
    results.browserErrors.push(...errors);
    await context.close();

    const viewerContext = await browser.newContext({ viewport: { width, height: width === 1280 ? 900 : 844 } });
    await viewerContext.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const viewer = await viewerContext.newPage(), viewerErrors = [];
    let viewerCommentRequests = 0;
    viewer.on("request", request => { if (new URL(request.url()).pathname === `/api/a/${id}/comments`) viewerCommentRequests++; });
    viewer.on("pageerror", e => viewerErrors.push(redact(e)));
    await viewer.goto(`${base}/a/${id}`); const viewerFrame = await frameOf(viewer);
    check(!await viewer.evaluate(() => document.body.classList.contains("is-editor")) && await viewerFrame.evaluate(() => !document.querySelector("[contenteditable]")), `${prefix}: fresh viewer has no editor role or editable elements`);
    await clickSignature(viewer, viewerFrame, "#sig2");
    const viewerText = await viewer.locator("#byPop").innerText();
    check(viewerText.includes("Cya.Editor") && viewerText.includes("编辑链接") && !viewerText.includes(request2), `${prefix}: viewer sees author and permission hint without private comment`);
    await assertFits(viewer, "#byPop", `${prefix}: viewer popup stays inside viewport`);
    check(viewerCommentRequests === 0, `${prefix}: viewer never requests private comment API`);
    check(await viewer.locator("#bComments").count() === 0 && viewerErrors.length === 0, `${prefix}: viewer has no toolbar button or browser errors`);
    results.browserErrors.push(...viewerErrors); await viewerContext.close();
  }
  const invalidContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await invalidContext.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const invalid = await invalidContext.newPage(), invalidErrors = [];
  let invalidCommentRequests = 0;
  invalid.on("pageerror", error => invalidErrors.push(redact(error)));
  invalid.on("request", request => { if (new URL(request.url()).pathname === `/api/a/${id}/comments`) invalidCommentRequests++; });
  await invalid.goto(`${base}/a/${id}?edit=deliberately-invalid-local-test`);
  const invalidFrame = await frameOf(invalid);
  await invalid.waitForFunction(() => document.querySelector("#toast").textContent.includes("编辑链接无效"));
  check(!await invalid.evaluate(() => document.body.classList.contains("is-editor")) && await invalidFrame.evaluate(() => !document.querySelector("[contenteditable]")), "invalid editor link remains read-only and cannot obtain editor privileges");
  await clickSignature(invalid, invalidFrame, "#sig2");
  check((await invalid.locator("#byPop").innerText()).includes("编辑链接") && invalidCommentRequests === 0, "invalid editor link gets viewer popup without private comment requests");
  await api(`/api/a/${id}/comments`, undefined, "deliberately-invalid-local-test", 403);
  check(invalidErrors.length === 0, "invalid editor-link flow has no browser errors");
  results.browserErrors.push(...invalidErrors); await invalidContext.close();

  const storageContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await storageContext.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await storageContext.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage disabled", "SecurityError"); } });
  });
  const storagePage = await storageContext.newPage(), storageErrors = [];
  storagePage.on("pageerror", error => storageErrors.push(redact(error)));
  await storagePage.goto(`${base}/a/${id}?edit=${encodeURIComponent(editToken)}`);
  await storagePage.waitForFunction(() => document.body.classList.contains("m-edit"));
  check(new URL(storagePage.url()).searchParams.get("edit") === editToken, "disabled localStorage preserves editor-link credentials for reload");
  await storagePage.reload();
  await storagePage.waitForFunction(() => document.body.classList.contains("m-edit"));
  const storageFrame = await frameOf(storagePage);
  await storageFrame.waitForFunction(() => document.querySelector("#selection").isContentEditable);
  await storageFrame.locator("#selection").evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await storagePage.locator("#askChip.show").click();
  await storagePage.locator("#cmModal.show").waitFor();
  check((await storagePage.locator("#cmTarget").innerText()).includes("选择这一段文字"), "disabled localStorage allows editor reload and selected-text comment form");
  check(storageErrors.length === 0, "disabled localStorage flow has no browser errors");
  results.browserErrors.push(...storageErrors); await storageContext.close();
  results.status = "passed";
} catch (error) {
  results.status = "failed"; results.error = redact(error); console.error(results.error); process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  if (browser) await browser.close();
  results.finished = new Date().toISOString();
  await fs.writeFile(path.join(runDir, "test-results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`${results.status.toUpperCase()}: ${results.checks.length} checks; results in .codex-run/test-results.json`);
}
