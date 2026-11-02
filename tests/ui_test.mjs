// Two isolated editors and a viewer; publish edit_fixture.html to a notify-off local page first.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { base, api, blockExternal, launchOptions } from "./local_helpers.mjs";

const ID = process.env.TEST_ARTIFACT_ID || process.argv[2];
const TK = process.env.TEST_EDIT_TOKEN || process.argv[3];
if (!ID || !TK) throw Error("Set TEST_ARTIFACT_ID and TEST_EDIT_TOKEN for a local notify-off fixture.");
const admin = (route, body) => api(`/api/admin${route}`, body);
const artifact = (suffix = "", body) => admin(`/artifacts/${ID}${suffix}`, body);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const raw = page => page.frames().find(frame => new URL(frame.url()).pathname === `/a/${ID}/raw`);
const text = (page, selector) => raw(page).locator(selector).textContent();
let passes = 0;
function check(name, condition) { assert.ok(condition, name); passes++; console.log(`PASS ${name}`); }
async function until(test, message, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await test()) return; } catch {} await pause(100); }
  throw Error(`Timed out: ${message}`);
}
const changeText = (page, selector, from, to) => raw(page).evaluate(({selector, from, to}) => {
  const el = document.querySelector(selector);
  if (!el?.isContentEditable) return false;
  el.focus();
  el.dispatchEvent(new InputEvent("beforeinput", {bubbles:true}));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) if (node.nodeValue.includes(from)) {
    node.nodeValue = node.nodeValue.replace(from, to);
    el.dispatchEvent(new InputEvent("input", {bubbles:true}));
    return true;
  }
  return false;
}, {selector, from, to});

let browser;
try {
  check("fixture notifications are disabled", (await artifact()).notify === "0");
  check("documented editing fixture is loaded", (await artifact("/html")).html.includes('id="left"'));
  browser = await chromium.launch(launchOptions("chromium"));
  const errors = [];
  const open = async editor => {
    const context = await browser.newContext({viewport:{width:1200,height:900}, acceptDownloads:true});
    await blockExternal(context);
    const page = await context.newPage();
    page.on("dialog", dialog => dialog.accept());
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/a/${ID}${editor ? `?edit=${TK}` : ""}`, {waitUntil:"load"});
    await until(async () => raw(page) && await raw(page).locator("#left").count(), "fixture loaded");
    if (editor) await until(() => raw(page).locator("#left").evaluate(el => el.isContentEditable), "always-on editing ready");
    return page;
  };
  const E1 = await open(true), E2 = await open(true), V = await open(false);
  check("editors land in always-on editing", await E1.locator("body").evaluate(el => el.classList.contains("is-editor") && el.classList.contains("m-edit")));
  check("viewer has no editor capabilities", await V.locator("body").evaluate(el => !el.classList.contains("is-editor")) && !await raw(V).locator("[contenteditable=true]").count());
  check("iframe URL never contains editor token", !await E1.locator("#frame").evaluate(el => el.src.includes("edit=")));
  check("app controls remain non-editable", await raw(E1).locator("#inc").evaluate(el => !el.isContentEditable));
  const count = Number(await text(V, "#n"));
  await raw(V).locator("#inc").click();
  await until(async () => Number(await text(E1, "#n")) === count + 1, "shared counter synchronized");
  check("viewer state changes synchronize to editor", true);
  await until(async () => /3 people online/.test(await text(E1, "#pres")), "three clients present");
  check("presence counts all clients", true);

  const first = await artifact("/html");
  check("static text accepts a hand edit", await changeText(E1, ".sub", "Static text", "Edited text"));
  await until(async () => (await artifact("/html")).html.includes("Edited text"), "hand edit persisted");
  const saved = await artifact("/html");
  check("hand edit creates version", saved.version > first.version);
  check("stored source excludes editor instrumentation", !/contenteditable|data-artifact-editor|artifact-overlay|__ARTIFACT_BOOT__|__AE_BRIDGE__/.test(saved.html));
  await until(async () => (await text(V, ".sub")).includes("Edited text"), "viewer reloaded to hand edit");
  check("viewer reload keeps shared state", Number(await text(V, "#n")) === count + 1);
  await until(async () => (await text(E2, ".sub")).includes("Edited text"), "second editor catches up");

  // Hold the first two saves until both editors submitted their old base version.
  async function concurrent(firstEdit, secondEdit) {
    await until(async () => await raw(E1).locator("#left").evaluate(el => el.isContentEditable) && await raw(E2).locator("#left").evaluate(el => el.isContentEditable), "both editor bridges ready");
    let arrivals = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const pattern = `**/api/a/${ID}/versions`;
    const intercept = async route => {
      if (route.request().method() === "POST" && arrivals < 2) { arrivals++; await barrier; }
      await route.continue();
    };
    let stale = 0;
    const response = r => { if (new URL(r.url()).pathname === `/api/a/${ID}/versions` && r.status() === 409) stale++; };
    E1.on("response", response); E2.on("response", response);
    await E1.route(pattern, intercept); await E2.route(pattern, intercept);
    try {
      const typed = await Promise.all([firstEdit(), secondEdit()]);
      check("both editors change text before save", typed.every(Boolean));
      await until(() => arrivals === 2, "both concurrent saves reached the barrier");
      release();
      await until(() => stale > 0, "stale-save conflict returned 409");
      return stale;
    } finally {
      release();
      await E1.unroute(pattern, intercept); await E2.unroute(pattern, intercept);
      E1.off("response", response); E2.off("response", response);
    }
  }
  await concurrent(() => changeText(E1, "#left", "Left paragraph", "Left edited"), () => changeText(E2, "#right", "Right paragraph", "Right edited"));
  await until(async () => { const html = (await artifact("/html")).html; return html.includes("Left edited") && html.includes("Right edited"); }, "non-conflicting concurrent changes both persist");
  check("stale save rebases independent text edits", true);
  await until(async () => (await text(E1, "#right")).includes("Right edited") && (await text(E2, "#left")).includes("Left edited"), "both editors catch up after rebase");
  await concurrent(() => changeText(E1, ".sub", "Edited text", "Winner Alpha"), () => changeText(E2, ".sub", "Edited text", "Winner Beta"));
  await until(async () => /Winner (Alpha|Beta)/.test((await artifact("/html")).html), "one conflicting save persists");
  const conflict = (await artifact("/html")).html;
  check("same-text conflict preserves exactly one winner", conflict.includes("Winner Alpha") !== conflict.includes("Winner Beta"));
  const winner = conflict.includes("Winner Alpha") ? "Winner Alpha" : "Winner Beta";
  await until(async () => (await text(E1, ".sub")).includes(winner) && (await text(E2, ".sub")).includes(winner), "losing editor shows winner");
  check("conflicting editors converge", true);

  await raw(E1).locator("h1").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); });
  await E1.locator("#askChip").click();
  await E1.locator("#cmReq").fill("Make the counter green");
  await E1.locator("#cmAuthor").fill("UI tester");
  await E1.locator("#cmSend").click();
  let jobs;
  await until(async () => { jobs = (await admin("/jobs?kind=edit&status=pending&limit=500")).jobs.filter(job => job.artifact_id === ID); return jobs.length === 1 && JSON.parse(jobs[0].notified || "{}").skipped === "notify_off"; }, "comment queued without webhook");
  check("UI comment creates pending job with notifications off", true);
  const job = await admin(`/jobs/${jobs[0].id}`);
  check("job includes selected text and request", job.comments[0].selector && job.comments[0].snippet_text.includes("Collaborative") && job.comments[0].request.includes("green"));
  await admin(`/jobs/${job.id}/publish`, {html:job.html.replace("</head>","<style>#n{color:#3ccf7a}</style></head>"),base_version:job.current_version,note:"Counter green",author:"Test maintainer"});
  await until(() => raw(V).locator("#n").evaluate(el => getComputedStyle(el).color === "rgb(60, 207, 122)"), "manual response published to viewer");
  check("manual job publication resolves comment", (await artifact("/comments")).comments[0].status === "resolved");
  check("manual response preserves state", Number(await text(V, "#n")) === count + 1);

  // History controls are intentionally hidden in the current UI; exercise their existing handlers.
  await E1.locator("#bHistory").evaluate(el => el.click());
  await until(async () => await E1.locator("#pbody .ver").count() >= 4, "history loaded");
  check("history includes publisher attribution", (await E1.locator("#pbody").textContent()).includes("Test maintainer"));
  await E1.locator(`[data-pv='${first.version}']`).click();
  await until(() => E1.locator("#pvFrame").evaluate(el => el.srcdoc.includes("Static text")), "original version preview");
  await E1.locator("#pvRestore").click();
  await until(async () => (await text(V,".sub")).includes("Static text"), "restore reaches viewer");
  check("restore records a new version", (await artifact("/versions")).versions[0].source === "restore");
  check("restore retains shared state", (await artifact("/state")).count === count + 1);

  const downloadPromise = E1.waitForEvent("download");
  await E1.locator("#bExport").evaluate(el => el.click());
  const download = await downloadPromise;
  const exported = await readFile(await download.path(), "utf8");
  check("download is a self-contained state snapshot", exported.includes("offline: true") && exported.includes(`"count":${count + 1}`) && exported.includes("Offline snapshot"));
  await V.setViewportSize({width:390,height:800});
  check("mobile toolbar fits", await V.locator("#bar").evaluate(el => el.scrollWidth <= innerWidth + 1));
  check("no browser script errors", errors.length === 0);
  console.log(`UI regression: ${passes} checks passed`);
} catch (error) {
  console.error(String(error.message).replaceAll(TK, "<redacted>"));
  process.exitCode = 1;
} finally { await browser?.close(); }
