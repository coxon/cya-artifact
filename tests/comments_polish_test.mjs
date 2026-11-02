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
const request3 = "请检查整个页面的说明是否完整。";
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
  if (await page.locator("#panel.show").count()) await closeDrawer(page);
  await frame.locator(selector).scrollIntoViewIfNeeded();
  // Let the iframe's debounced scroll event finish before opening the drawer.
  await page.waitForTimeout(220);
  await frame.locator(selector).click();
  await page.locator("#panel.show").waitFor({ state: "visible" });
  await page.waitForTimeout(220);
}
async function closeDrawer(page, method = "button") {
  if (method === "escape") await page.keyboard.press("Escape");
  else await page.locator("#pclose").click();
  await page.locator("#panel").waitFor({ state: "hidden" });
  const frame = await page.locator("#frame").boundingBox();
  check(Math.abs(frame.x + frame.width - page.viewportSize().width) <= 1, `${page.viewportSize().width}px: closing restores full iframe width`);
  check(await page.locator("#panel").evaluate(el => el.inert && el.getAttribute("aria-hidden") === "true"), `${page.viewportSize().width}px: closed drawer is inert and hidden from accessibility tree`);
}
async function assertHighlight(frame, cdp, target, label) {
  await until(async () => {
    const s = await overlayState(cdp);
    const r = await frame.locator(target).evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: innerWidth, height: innerHeight, scrollY }; });
    const page = frame.page();
    let visibleHeight = r.height;
    if (page.viewportSize().width <= 640 && await page.locator("#panel.show").count()) {
      const drawer = await page.locator("#panel").boundingBox(), iframe = await page.locator("#frame").boundingBox();
      visibleHeight = Math.min(visibleHeight, drawer.y - iframe.y);
    }
    return s && s.display !== "none" && +s.opacity > 0 && r.top >= 0 && r.bottom <= visibleHeight && r.left >= 0 && r.right <= r.width && Math.abs(parseFloat(s.top) - (r.top + r.scrollY - 3)) < 2;
  }, label);
  check(true, label);
}
async function assertDrawerLayout(page, width, label) {
  await assertFits(page, "#panel", label + ": drawer fits viewport");
  const rect = await page.locator("#panel").boundingBox(), frame = await page.locator("#frame").boundingBox(), { height } = page.viewportSize();
  check(!intersects(rect, frame), label + ": drawer never intersects the iframe");
  check(await page.locator('.modal, [id*="backdrop"], [class*="backdrop"], [data-backdrop]').evaluateAll(nodes => nodes.every(el => !el.getClientRects().length || getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).opacity === "0")), label + ": no visible backdrop");
  if (width > 640) {
    check(rect.width >= 260 && rect.width <= 320 && rect.width <= width * .26 + 1, label + ": drawer width is clamped to 260–320px and at most 26vw");
    check(Math.abs(rect.x + rect.width - width) <= 1 && Math.abs(rect.y - 44) <= 1 && Math.abs(rect.y + rect.height - height) <= 1, label + ": full-height right drawer sits below top bar");
    check(frame.x + frame.width <= rect.x + .5 && Math.abs(frame.x + frame.width - rect.x) <= 1, label + ": iframe ends at the drawer's left edge");
    const bar = await page.locator("#bar").boundingBox();
    check(bar.x + bar.width <= rect.x + .5, label + ": top bar shrinks with the iframe");
    for (const button of await page.locator("#bar button:visible").all()) {
      const box = await button.boundingBox();
      check(!intersects(rect, box) && box.x + box.width <= rect.x + .5 && await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), label + ": visible top-bar button is uncovered and clickable");
    }
  }
  else {
    const radius = await page.locator("#panel").evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    check(Math.abs(rect.x) <= 1 && Math.abs(rect.width - width) <= 1 && Math.abs(rect.y + rect.height - height) <= 1 && rect.height > 0 && rect.height <= height * .6 + 2 && radius > 0, label + ": rounded bottom sheet uses at most 60% height");
    check(frame.y + frame.height <= rect.y + .5, label + ": mobile iframe ends above the sheet");
  }
  check(await page.locator("#pbody").evaluate(el => getComputedStyle(el).overflowY === "auto" && el.clientHeight > 0 && el.scrollHeight >= el.clientHeight), label + ": drawer content remains scrollable");
}
function intersects(a, b) {
  return a.x < b.x + b.width - .5 && a.x + a.width > b.x + .5 && a.y < b.y + b.height - .5 && a.y + a.height > b.y + .5;
}
async function assertTargetVisible(page, frame, selector, label) {
  const target = await frame.locator(selector).boundingBox(), viewport = await page.locator("#frame").boundingBox(), drawer = await page.locator("#panel").boundingBox();
  check(target && target.x >= viewport.x && target.y >= viewport.y && target.x + target.width <= viewport.x + viewport.width + .5 && target.y + target.height <= viewport.y + viewport.height + .5 && !intersects(target, drawer), label);
}
async function screenshot(page, filename) {
  const shot = path.join(shotsDir, filename);
  await page.screenshot({ path: shot }); results.screenshots.push(path.relative(process.cwd(), shot));
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
  check((await pending.locator(`#cm-${c2.comment_id} .pinb`).innerText()) === "2", "clicking pending marker opens matching drawer selection with global numbering");
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
  const c3 = await api(`/api/a/${id}/comments`, { request: request3, selector: null }, editToken);

  for (const [width, height] of [[1280, 850], [1024, 768], [390, 844]]) {
    const prefix = `${width}px`;
    const context = await browser.newContext({ viewport: { width, height }, ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
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

    const fixtureComments = (await api(`/api/a/${id}/comments`, undefined, editToken)).comments;
    for (const [sig, request, asker, answerer, cid, num, version] of [["#sig1", request1, "Editor", "Cya", c1.comment_id, 1, v1.version], ["#sig2", request2, "审阅者", "Cya.Editor", c2.comment_id, 2, v2.version]]) {
      await clickSignature(page, frame, sig);
      const detail = await page.locator("#commentDetail").innerText();
      check(detail.includes(`评论 ${num}`) && detail.includes(request) && detail.includes(`提问 ${asker}`) && detail.includes(`回答 ${answerer}`) && detail.includes(` · v${version}`) && /\d{1,2}[/-]\d{1,2}/.test(detail) && detail.includes("已完成"), `${prefix}: ${answerer} detail shows correct number, question, asker, answerer, time, status and version`);
      check(detail.includes(num === 1 ? text1 : text2), `${prefix}: selected detail includes the original snippet`);
      await assertDrawerLayout(page, width, prefix);
      check(await page.locator("#panel").getAttribute("role") === "dialog" && !!await page.locator("#panel").getAttribute("aria-label"), `${prefix}: drawer has dialog role and accessible label`);
      check(await page.locator("#panel").evaluate(el => el.contains(document.activeElement)), `${prefix}: focus moves into drawer on open`);
      check(!await frame.locator(sig).evaluate(el => el.isContentEditable), `${prefix}: clicking ${answerer} keeps signature locked`);
      await page.locator(`#cm-${cid}.focus[aria-current=true]`).waitFor();
      const listIds = await page.locator("#commentList .cm").evaluateAll(rows => rows.map(row => row.dataset.comment));
      check(JSON.stringify(listIds) === JSON.stringify(fixtureComments.map(c => c.id).reverse()), `${prefix}: complete comment list is newest first with selected entry marked`);
      check((await page.locator("#commentList").innerText()).includes(request3), `${prefix}: full list includes the pending comment`);
      await assertHighlight(frame, cdp, `${sig} >> xpath=..`, `${prefix}: chip selection immediately highlights its answer`);
      await assertTargetVisible(page, frame, sig, `${prefix}: located chip is inside the visible iframe and clear of the drawer`);
      check(!/\u{1F4CC}/u.test(await page.locator("body").innerText()) && !/\u{1F4CC}/u.test(await frame.locator("body").innerText()), `${prefix}: no pushpin glyph is visible`);
      if (sig === "#sig1") await screenshot(page, `narrow-${width}.png`);
      await closeDrawer(page);
      check(await page.evaluate(() => document.activeElement === document.querySelector("#frame")), `${prefix}: close button restores focus to page iframe`);
      await frame.waitForFunction(selector => document.activeElement === document.querySelector(selector), sig);
      check(true, `${prefix}: close button restores focus to the opening chip`);
    }
    // Selecting a list entry updates the detail and locates the original comment spot.
    await clickSignature(page, frame, "#sig1");
    await page.locator(`[data-comment="${c2.comment_id}"]`).click();
    await page.locator(`#cm-${c2.comment_id}.focus[aria-current=true]`).waitFor();
    check((await page.locator("#commentDetail").innerText()).includes(request2) && !(await page.locator("#commentDetail").innerText()).includes(request1), `${prefix}: list click switches selected detail`);
    await assertHighlight(frame, cdp, "#target2", `${prefix}: list selection locates and highlights its original comment spot`);
    check(await page.locator("#panel.show").isVisible(), `${prefix}: locate leaves drawer open`);
    await page.locator("#pbody").evaluate(el => { el.scrollTop = 0; });
    if (width === 1280) await screenshot(page, "drawer-1280-switched.png");
    // A real comments broadcast refreshes the selected detail and preserves a draft.
    await page.locator("#pgReq").fill("保留尚未发送的整页修改请求。");
    await api(`/api/admin/artifacts/${id}/comments/${c2.comment_id}`, { resolved_by: "Updated answerer" });
    await until(async () => (await page.locator("#commentDetail").innerText()).includes("Updated answerer"), `${prefix}: comments websocket refreshes selected detail`);
    check(await page.locator(`#cm-${c2.comment_id}.focus[aria-current=true]`).count() === 1 && await page.locator("#pgReq").inputValue() === "保留尚未发送的整页修改请求。", `${prefix}: live reload retains selection and unsent draft`);
    check(await page.locator("#pgReq").evaluate(el => el === document.activeElement && el.selectionStart === el.value.length), `${prefix}: live reload preserves composer focus and caret`);
    await api(`/api/admin/artifacts/${id}/comments/${c2.comment_id}`, { resolved_by: "Cya.Editor" });
    await until(async () => (await page.locator("#commentDetail").innerText()).includes("Cya.Editor"), `${prefix}: restored answerer appears live`);
    await page.locator("#pgReq").fill("");
    await closeDrawer(page, "escape");
    check(await page.evaluate(() => document.activeElement === document.querySelector("#frame")), `${prefix}: Escape closes drawer and restores iframe focus`);
    await frame.waitForFunction(() => document.activeElement === document.querySelector("#sig1"));
    check(true, `${prefix}: Escape restores focus to the chip that opened the drawer`);
    await clickSignature(page, frame, "#sig2");
    await frame.evaluate(() => scrollBy(0, 100));
    await page.waitForTimeout(350);
    check(await page.locator("#panel.show").isVisible(), `${prefix}: iframe scrolling keeps drawer open`);
    // The top bar is outside; it stays usable while the drawer is open.
    await page.locator("#bar").click({ position: { x: 2, y: 2 } });
    if (width > 640) check(await page.locator("#panel.show").isVisible(), `${prefix}: host outside click keeps desktop drawer open`);
    else { await page.locator("#panel").waitFor({ state: "hidden" }); check(true, `${prefix}: host outside click closes mobile sheet`); }
    await clickSignature(page, frame, "#sig2");
    await frame.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(250);
    await frame.locator("h1").click({ position: { x: 8, y: 8 } });
    if (width > 640) {
      await page.waitForTimeout(200);
      check(await page.locator("#panel.show").isVisible(), `${prefix}: iframe outside click keeps desktop drawer open`);
      await page.keyboard.press("Escape");
      await page.locator("#panel").waitFor({ state: "hidden" });
      check(true, `${prefix}: Escape from inside the iframe still closes the drawer`);
    } else { await page.locator("#panel").waitFor({ state: "hidden" }); check(true, `${prefix}: iframe outside click closes mobile sheet`); }
    // Chip clicks while a drawer is already open switch selection instead of dismissing it.
    await clickSignature(page, frame, "#sig1");
    await frame.locator("#sig2").evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 60));
    await page.waitForTimeout(250);
    await frame.locator("#sig2").click();
    await page.locator(`#cm-${c2.comment_id}.focus`).waitFor();
    check((await page.locator("#commentDetail").innerText()).includes(request2), `${prefix}: a second chip switches the open drawer`);
    for (const [sig, target] of [["#sig1", "#target1"], ["#sig2", "#target2"]]) {
      await clickSignature(page, frame, sig);
      const before = await frame.evaluate(() => scrollY);
      await page.locator("#commentLocate").click();
      await assertHighlight(frame, cdp, target, `${prefix}: Locate button scrolls to original target and flashes highlight`);
      await assertTargetVisible(page, frame, target, `${prefix}: Locate target is visible above or beside the drawer`);
      check((await frame.evaluate(() => scrollY)) > before + 500 && await page.locator("#panel.show").isVisible(), `${prefix}: Locate jumps to original text without closing drawer`);
      if (width === 390 && sig === "#sig2") await screenshot(page, "narrow-390-locate.png");
    }
    await page.locator(`[data-comment="${c3.comment_id}"]`).click();
    check((await page.locator("#commentDetail").innerText()).includes("整个页面 Whole page") && (await page.locator("#commentDetail").innerText()).includes("待处理"), `${prefix}: whole-page pending comment shows its scope and status`);
    if (width === 1280) {
      const wholeRequest = "请统一整个页面的段落间距。";
      await page.locator("#pgReq").fill(wholeRequest);
      await page.locator("#pgSend").click();
      await until(async () => (await page.locator("#commentList").innerText()).includes(wholeRequest), `${prefix}: whole-page Send adds a comment to the drawer`);
      const sent = (await api(`/api/a/${id}/comments`, undefined, editToken)).comments.find(c => c.request === wholeRequest);
      check(sent && sent.selector === null && sent.status === "open", `${prefix}: whole-page composer preserves the comment API behavior`);
      check(await page.locator("#pgReq").inputValue() === "", `${prefix}: successful Send clears the submitted draft`);
    }
    // A stale number must never override an explicit stable ID.
    await frame.locator("#sig1").evaluate(el => { el.textContent = "Cya 答 · 评论 2 · 11/2 10:00"; });
    await clickSignature(page, frame, "#sig1");
    check((await page.locator("#commentDetail").innerText()).includes(request1), `${prefix}: data-cid wins over a conflicting comment number`);
    await closeDrawer(page);
    // Simulate legacy stored HTML or a client-generated label, without altering persisted source.
    await frame.locator("#sig2").evaluate(el => el.removeAttribute("data-cid"));
    await clickSignature(page, frame, "#sig2");
    check((await page.locator("#commentDetail").innerText()).includes(request2), `${prefix}: legacy label falls back to comment number`);
    await closeDrawer(page);
    await frame.locator("#sig2").evaluate(el => { el.dataset.cid = "missing-comment-id"; });
    await clickSignature(page, frame, "#sig2");
    check(/没找到|未找到/.test(await page.locator("#commentDetail").innerText()), `${prefix}: unknown explicit data-cid cannot open another comment`);
    await closeDrawer(page);
    for (const label of ["评论未知", "评论 1 / 评论 2", "评论 1.5", "评论 0", "评论 1abc", "评论 1e2"]) {
      await frame.locator("#sig2").evaluate((el, label) => { el.removeAttribute("data-cid"); el.textContent = "Cya.Editor 答 · " + label; }, label);
      await clickSignature(page, frame, "#sig2");
      check(/没找到|未找到/.test(await page.locator("#commentDetail").innerText()), `${prefix}: invalid label ${label} fails gracefully`);
      await closeDrawer(page);
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
    await closeDrawer(page, "escape");
    const lookupResponse = page.waitForResponse(response => response.url() === commentsUrl);
    releaseLookup(); await (await lookupResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(await page.locator("#panel.show").count() === 0 && !await page.locator("#panel").isVisible(), `${prefix}: dismissed async comment lookup cannot reopen drawer`);
    await context.unroute(commentsUrl, delayLookup);
    // A delayed unknown chip must also not replace a newer valid selection.
    let releaseStale, staleBegan = false;
    const staleGate = new Promise(resolve => { releaseStale = resolve; });
    const delayStale = async route => { if (!staleBegan) { staleBegan = true; await staleGate; } await route.continue(); };
    await context.route(commentsUrl, delayStale);
    await frame.locator("#sig2").scrollIntoViewIfNeeded();
    await frame.locator("#sig2").click();
    await until(() => staleBegan, `${prefix}: stale lookup begins`);
    await frame.locator("#sig1").evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 60));
    await page.waitForTimeout(250);
    await frame.locator("#sig1").click();
    await page.locator(`#cm-${c1.comment_id}.focus`).waitFor();
    const staleResponse = page.waitForResponse(response => response.url() === commentsUrl);
    releaseStale(); await (await staleResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check((await page.locator("#commentDetail").innerText()).includes(request1) && await page.locator(`#cm-${c1.comment_id}.focus`).count() === 1, `${prefix}: stale lookup cannot overwrite newer chip selection`);
    await context.unroute(commentsUrl, delayStale);
    // Reload removes DOM-only fixture mutations and restores editable static text.
    await page.reload(); frame = await frameOf(page);
    await frame.waitForFunction(() => document.querySelector("#selection").isContentEditable);
    await frame.locator("#selection").scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
    const selection = frame.locator("#selection");
    if (width > 640) {
      const box = await selection.boundingBox();
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + Math.min(190, box.width - 3), box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
    } else {
      await selection.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    }
    const selected = await frame.evaluate(() => getSelection().toString().trim());
    check(selected.length > 4, `${prefix}: ${width > 640 ? "mouse drag preserves selected text" : "DOM Range creates selected text for mobile-width form test"}`);
    await page.locator("#askChip.show").waitFor();
    await page.locator("#askChip").click();
    await page.locator("#cmModal.show").waitFor();
    check((await page.locator("#cmTarget").innerText()).includes(selected), `${prefix}: Ask Cya retains selected text after focus leaves iframe`);
    await page.locator("#cmCancel").click();
    await page.locator("#bHistory").evaluate(el => el.click());
    await page.waitForFunction(() => document.querySelector("#pbody").textContent.includes("Cya.Editor 修改"));
    check((await page.locator("#pbody").innerText()).includes("Cya 修改"), `${prefix}: programmatically opened history distinguishes Cya and Cya.Editor`);
    if (width > 640) await assertDrawerLayout(page, width, `${prefix} history`);
    await closeDrawer(page);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${prefix}: host has no horizontal overflow`);
    check(errors.length === 0, `${prefix}: editor has no browser errors`);
    results.browserErrors.push(...errors);
    await context.close();

    const viewerContext = await browser.newContext({ viewport: { width, height } });
    await viewerContext.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const viewer = await viewerContext.newPage(), viewerErrors = [];
    let viewerCommentRequests = 0;
    const viewerAssets = new Map();
    viewer.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === `/api/a/${id}/comments`) viewerCommentRequests++;
      if (["/host.js", "/bridge.js", "/sdk.js"].includes(url.pathname)) viewerAssets.set(url.pathname, url.search);
    });
    viewer.on("pageerror", e => viewerErrors.push(redact(e)));
    await viewer.goto(`${base}/a/${id}`); const viewerFrame = await frameOf(viewer);
    check(!await viewer.evaluate(() => document.body.classList.contains("is-editor")) && await viewerFrame.evaluate(() => !document.querySelector("[contenteditable]")), `${prefix}: fresh viewer has no editor role or editable elements`);
    check(viewerAssets.size === 3 && [...viewerAssets.values()].every(query => /^\?v=[a-f0-9]{10}$/.test(query)), `${prefix}: viewer loads host, bridge and SDK through versioned URLs`);
    await clickSignature(viewer, viewerFrame, "#sig2.by[data-cid]");
    const viewerText = await viewer.locator("#commentDetail").innerText();
    check(viewerText.includes("评论 2") && viewerText.includes("Cya.Editor") && viewerText.includes("评论内容只有用编辑链接打开才能看到 · Open with the editor link to see the comment") && ![request1, request2, request3, text1, text2, "审阅者"].some(text => viewerText.includes(text)), `${prefix}: viewer sees only chip number, answerer and permission hint`);
    check(await viewer.locator("#commentList, #pgReq, #pgSend").count() === 0, `${prefix}: viewer drawer has no comment list or composer`);
    await assertDrawerLayout(viewer, width, `${prefix} viewer`);
    if (width === 390) await screenshot(viewer, "drawer-viewer-390.png");
    check(viewerCommentRequests === 0, `${prefix}: viewer never requests private comment API`);
    check(await viewer.locator("#bComments").count() === 0 && viewerErrors.length === 0, `${prefix}: viewer has no toolbar button or browser errors`);
    results.browserErrors.push(...viewerErrors); await viewerContext.close();
  }
  // Simulate a shell/script mismatch before host.js initializes, then click a real chip.
  for (const role of ["viewer", "editor"]) for (const missing of ["panel", "pbody", "ptitle", "pclose"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname !== `/a/${id}`) return route.continue();
      const response = await route.fetch();
      // Renaming the element makes the expected selector unavailable during initialization.
      return route.fulfill({ response, body: (await response.text()).replace(`id="${missing}"`, `data-missing-id="${missing}"`) });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(redact(error)));
    await page.goto(`${base}/a/${id}${role === "editor" ? `?edit=${encodeURIComponent(editToken)}` : ""}`);
    if (role === "editor") await page.waitForFunction(() => document.body.classList.contains("m-edit"));
    const frame = await frameOf(page);
    const label = `${role} with missing #${missing}`;
    if (missing === "panel" || missing === "pbody") {
      await frame.locator("#sig2.by[data-cid]").click();
      await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Reload"));
      check(!await page.evaluate(() => document.body.classList.contains("panel-open")), `${label}: chip shows reload hint without opening an empty drawer`);
      if (role === "editor") {
        await page.locator("#bHistory").evaluate(el => el.click());
        check(!await page.evaluate(() => document.body.classList.contains("panel-open")), `${label}: history also degrades gracefully`);
      }
    } else {
      await clickSignature(page, frame, "#sig2.by[data-cid]");
      check((await page.locator("#commentDetail").innerText()).includes("评论 2"), `${label}: comment still opens`);
      // Closing must also tolerate the drawer disappearing while it is open.
      await page.locator("#panel").evaluate(el => el.remove());
      await page.keyboard.press("Escape");
      check(!await page.evaluate(() => document.body.classList.contains("panel-open")), `${label}: Escape cleans up after drawer removal`);
    }
    check(errors.length === 0, `${label}: no browser errors`);
    results.browserErrors.push(...errors); await context.close();
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
  check((await invalid.locator("#commentDetail").innerText()).includes("编辑链接") && invalidCommentRequests === 0, "invalid editor link gets viewer drawer without private comment requests");
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
