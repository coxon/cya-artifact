// Local always-on editing + live writing regression against tests/edit_fixture.html.
// TEST_ARTIFACT_ID / TEST_EDIT_TOKEN select a notify-off fixture; optional argv: id token engines sizes.
import * as pw from "playwright";
import { base as O, api, blockExternal, launchOptions } from "./local_helpers.mjs";
const id = process.env.TEST_ARTIFACT_ID || process.argv[2];
const tok = process.env.TEST_EDIT_TOKEN || process.argv[3];
if (!id || !tok) throw Error("Set TEST_ARTIFACT_ID and TEST_EDIT_TOKEN for a local notify-off fixture.");
const engines = (process.env.TEST_ENGINES || process.argv[4] || "chromium").split(",");
if (engines.some(engine => !["chromium", "webkit", "firefox"].includes(engine))) throw Error("Unknown browser engine");
const base = O + "/a/" + id;
let fails = 0, checks = 0;
const admin = (path, body) => api("/api/admin/artifacts/" + path, body);
const browsers = [];
const newContext = async (browser, options) => {
  const context = await browser.newContext(options);
  await blockExternal(context);
  return context;
};
const launch = async engine => { const browser = await pw[engine].launch(launchOptions(engine)); browsers.push(browser); return browser; };
const safe = value => String(value).replaceAll(tok, "<redacted>");
const ok = (c, m) => { checks++; console.log((c ? "PASS " : "FAIL ") + safe(m)); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raw = (p) => p.frames().find(f => f.url().includes("/raw"));
const liveText = (p) => p.evaluate(() => { const l = document.getElementById("live"); return l && document.body.classList.contains("m-live") ? (l.contentDocument.body || {}).textContent || "" : null; });
try {
if ((await admin(id)).notify !== "0") throw Error("Refusing to test a page with notifications enabled");
if (!(await admin(id + "/html")).html.includes('id="theme"')) throw Error("Publish tests/edit_fixture.html first");
for (const eng of engines) for (const name of (process.argv.includes("--new-only") ? [] : (process.argv[5]||"desktop,mobile").split(","))) {
  const b = await launch(eng);
  const opts = name==="desktop" ? {viewport:{width:1280,height:820}} : (()=>{const d={...pw.devices["iPhone 13"]}; delete d.defaultBrowserType; return d;})();
  const T = `[${eng} ${name}]`, mob = name === "mobile";
  const tap = async (p, x, y) => mob ? p.touchscreen.tap(x, y) : p.mouse.click(x, y);
  const ctx = await newContext(b, opts), p = await ctx.newPage(); const errs=[]; p.on("pageerror", e=>errs.push(e.message));
  await p.goto(base + "?edit=" + tok); await p.waitForTimeout(3500);
  ok(await p.evaluate(()=>document.body.classList.contains("is-editor") && document.body.classList.contains("m-edit") && !document.getElementById("bEdit")), T+" editor lands directly in editing (no Edit button)");
  ok(!(await p.isVisible("#hint")), T+" no tip bar");
  let f = raw(p);
  ok(await f.evaluate(()=>document.querySelector("p.sub").isContentEditable), T+" static text editable right away");
  ok(await f.evaluate(()=>[...document.querySelectorAll("a,button")].every(e=>!e.isContentEditable)), T+" links/buttons not editable");
  // app controls still work
  const th0 = await f.evaluate(()=>document.documentElement.outerHTML.slice(0,300) + getComputedStyle(document.body).backgroundColor);
  const tb = await f.locator("#theme").boundingBox(); await tap(p, tb.x+tb.width/2, tb.y+tb.height/2); await p.waitForTimeout(400);
  ok(th0 !== await f.evaluate(()=>document.documentElement.outerHTML.slice(0,300) + getComputedStyle(document.body).backgroundColor), T+" theme button works for editor");
  await tap(p, tb.x+tb.width/2, tb.y+tb.height/2); await p.waitForTimeout(300);
  const rb = f.locator("#reacts button").first(); await rb.scrollIntoViewIfNeeded(); const r0 = await rb.textContent();
  const rbb = await rb.boundingBox(); await tap(p, rbb.x+rbb.width/2, rbb.y+rbb.height/2); await p.waitForTimeout(800);
  ok(r0 !== await rb.textContent(), T+` reaction button works for editor (${r0.trim()} -> ${(await rb.textContent()).trim()})`);
  // type like a doc
  const v0 = await f.evaluate(()=>document.querySelector("p.sub").textContent);
  await f.locator("p.sub").first().scrollIntoViewIfNeeded(); let bb = await f.locator("p.sub").first().boundingBox();
  await tap(p, bb.x+bb.width-4, bb.y+bb.height-8);
  await f.locator("p.sub").evaluate(el => { el.focus(); const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); });
  await p.keyboard.type("!"); await p.waitForTimeout(3200);
  const sv = await p.evaluate(()=>document.getElementById("save").textContent);
  ok(/已保存 Saved · v\d+/.test(sv), T+" autosaved: " + sv);
  const ctx2 = await newContext(b, opts), p2 = await ctx2.newPage(); await p2.goto(base); await p2.waitForTimeout(3000);
  ok((await raw(p2).evaluate(()=>document.querySelector("p.sub").textContent)) === v0 + "!", T+" viewer sees the edit");
  ok(!(await p2.evaluate(()=>document.body.classList.contains("is-editor"))) && (await raw(p2).evaluate(()=>!document.querySelector("[contenteditable]"))), T+" viewer unchanged (nothing editable)");
  bb = await f.locator("p.sub").first().boundingBox(); await tap(p, bb.x+bb.width-4, bb.y+bb.height-8);
  await f.locator("p.sub").evaluate(el => { el.focus(); const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); });
  await p.keyboard.press("Backspace"); await p.waitForTimeout(3200);
  // selection -> floating comment chip
  await f.evaluate(()=>{ const n=document.querySelector("h1"); const r=document.createRange(); r.selectNodeContents(n); const s=getSelection(); s.removeAllRanges(); s.addRange(r); });
  await p.waitForTimeout(700);
  ok(await p.isVisible("#askChip"), T+" selecting text shows floating 💬 comment chip");
  const cb = await p.locator("#askChip").boundingBox(), fb = await p.locator("#frame").boundingBox();
  ok(cb && cb.x >= 0 && cb.x + cb.width <= (opts.viewport||{width:390}).width + 1 && cb.y >= fb.y, T+" chip on screen");
  await p.click("#askChip"); await p.waitForTimeout(300);
  ok(await p.isVisible("#cmModal") && /h1/.test(await p.textContent("#cmTarget")), T+" chip opens comment form for the selection");
  await p.click("#cmCancel"); await f.evaluate(()=>getSelection().removeAllRanges()); await p.waitForTimeout(500);
  ok(!(await p.isVisible("#askChip")), T+" chip hides when selection clears");
  // JS-generated text
  ok(!(await f.evaluate(()=>document.getElementById("pres").isContentEditable)), T+" text the app rewrites (live counter) is not offered for typing");
  const pr = f.locator("#pres"); {
    await pr.scrollIntoViewIfNeeded(); const pb = await pr.boundingBox(); await tap(p, pb.x+pb.width/2, pb.y+pb.height/2); await p.waitForTimeout(500);
    ok(await p.isVisible("#askChip") && /程序生成/.test(await p.textContent("#askChip")), T+" app-generated text offers comment");
  }
  ok(!(await p.isVisible("#toast")) || !/程序生成/.test(await p.textContent("#toast")), T+" no nagging toasts");
  // ---- live writing on an existing page ----
  const cur = await admin(id + "/html");
  await admin(id + "/draft", { op: "start", note: "测试 test" }); await sleep(800);
  await admin(id + "/draft", { op: "append", chunk: "<!doctype html><html><head><style>body{font:22px system-ui;padding:20px}</style></head><body><h1>Live heading</h1><p>Second sec" });
  await sleep(2800);
  let lt = await liveText(p2);
  ok(lt && lt.includes("Live heading") && lt.includes("Second sec"), T+" viewer watches partial page appear: " + JSON.stringify(lt && lt.slice(0, 40)));
  ok(((await liveText(p)) || "").includes("Live heading"), T+" editor sees it too");
  await admin(id + "/draft", { op: "append", chunk: "tion</p><script>parent.__pwned=1;document.body.dataset.ran=1</script><p>Third" }); await sleep(2800);
  lt = await liveText(p2);
  ok(lt.includes("Second section") && lt.includes("Third"), T+" split tag continues cleanly");
  ok(await p2.evaluate(()=>!window.__pwned && !document.getElementById("live").contentDocument.body.dataset.ran), T+" scripts never run in the live view");
  const p3 = await (await newContext(b, opts)).newPage(); await p3.goto(base); await p3.waitForTimeout(2500);
  ok(((await liveText(p3)) || "").includes("Third"), T+" late joiner catches up on the stream so far");
  await p3.context().close();
  const put = await admin(id + "/html", { html: cur.html, base_version: cur.version, note: "live test publish" });
  ok(put.ok, T+" publish v" + put.version);
  await sleep(4000);
  ok(await p2.evaluate(()=>!document.body.classList.contains("m-live")) && (await raw(p2).evaluate(()=>!!document.querySelector("p.sub"))), T+" viewer swaps to the final page");
  f = raw(p);
  ok(await p.evaluate(()=>!document.body.classList.contains("m-live")) && await f.evaluate(()=>document.querySelector("p.sub").isContentEditable), T+" editor back on final page, still editable");
  // ---- progressive stream (many small appends grow text over time) ----
  await admin(id + "/draft", { op: "start", note: "stream" }); await sleep(400);
  await admin(id + "/draft", { op: "append", chunk: "<!doctype html><html><body style=\"font:20px system-ui;padding:24px\"><h1>" });
  const words = ["Hello ", "from ", "the ", "live ", "stream ", "— ", "watching ", "tokens ", "appear ", "one ", "by ", "one."];
  const samples = [];
  for (const w of words) {
    await admin(id + "/draft", { op: "append", chunk: w });
    await sleep(260);
    samples.push(((await liveText(p2)) || "").replace(/\s+/g, " ").trim());
  }
  await sleep(2800);
  const final = ((await liveText(p2)) || "").replace(/\s+/g, " ").trim();
  ok(final.includes("Hello from the live stream") && final.includes("one by one."), T+" dense appends paint full sentence: " + JSON.stringify(final.slice(0, 60)));
  let grew = 0; for (let i = 1; i < samples.length; i++) if (samples[i].length > samples[i - 1].length) grew++;
  ok(grew >= 4, T+" text grows progressively across samples (" + grew + "/" + (samples.length - 1) + " steps grew): " + JSON.stringify(samples.map(x => x.length)));
  await admin(id + "/draft", { op: "end" }); await sleep(800);
  // abort
  await admin(id + "/draft", { op: "start" }); await admin(id + "/draft", { op: "append", chunk: "<body><h1>Abandoned" }); await sleep(1500);
  ok(((await liveText(p2)) || "").includes("Abandoned"), T+" abort test: stream visible");
  await admin(id + "/draft", { op: "end" }); await sleep(1000);
  ok(await p2.evaluate(()=>!document.body.classList.contains("m-live")), T+" abort: viewer back on current page");
  ok(errs.length === 0, T+" no page errors " + errs.join("; "));
  await b.close();
}
// ---- a brand-new page being written (pending artifact, created with notify off) ----
for (const eng of engines) {
  const b = await launch(eng); const T = `[${eng} new page]`;
  const blank = await admin(id + "/copy", { notify: false, empty: true }); const nid = blank.artifact_id;
  const p = await (await newContext(b, { viewport: { width: 1280, height: 820 } })).newPage(); const errs=[]; p.on("pageerror", e=>errs.push(e.message));
  await p.goto(O + "/a/" + nid); await p.waitForTimeout(2500);
  ok(await p.evaluate(()=>!!document.getElementById("bar")), T+" pending page shows the host page (not a bare spinner)");
  await admin(nid + "/draft", { op: "start", note: "新页面" });
  const html = '<!doctype html><html><head><title>Live New</title><style>body{font:20px system-ui}</style></head><body><h1>Brand new</h1>';
  await admin(nid + "/draft", { op: "append", chunk: html }); await sleep(2800);
  ok(((await liveText(p)) || "").includes("Brand new"), T+" watch a new page being written");
  await admin(nid + "/draft", { op: "append", chunk: "<p>Done.</p></body></html>" });
  const pub = await admin(nid + "/html", { html: html + "<p>Done.</p></body></html>", force: true, source: "generated", title: "Live New" }); ok(pub.ok, T+" published");
  await sleep(4500);
  ok(await p.evaluate(()=>!document.body.classList.contains("m-live")) && ((await raw(p).evaluate(()=>document.body.textContent)) || "").includes("Done."), T+" swaps to the finished page");
  ok((await p.textContent("#ttl")) === "Live New", T+" title updated: " + await p.textContent("#ttl"));
  ok(errs.length === 0, T+" no page errors " + errs.join("; "));
  console.log("blank test artifact:", nid);
  await b.close();
}
console.log(fails ? `${fails}/${checks} FAILED` : `ALL PASS (${checks} checks)`);
if (fails) process.exitCode = 1;
} catch (error) {
  console.error(safe(error.message));
  process.exitCode = 1;
} finally { await Promise.all(browsers.map(browser => browser.close().catch(() => {}))); }
