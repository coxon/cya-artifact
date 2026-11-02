// Blank "about to write" page test (chromium + webkit). Creates its own notify-off blank artifact per engine.
// Usage: node tests/waiting_test.mjs [engines] [shotdir]
import * as pw from "playwright";
import fs from "node:fs";
import { base as O, adminToken as ADMIN, createPage, blockExternal, launchOptions } from "./local_helpers.mjs";
const engines = (process.argv[2] || "chromium").split(","), SHOTS = process.argv[3] || ".codex-run/shots";
fs.mkdirSync(SHOTS, { recursive: true });
const admin = async (path, body) => (await fetch(O + "/api/admin/artifacts/" + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + ADMIN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Waiting test</title><style>body{margin:0;background:#fbfaf7;font:18px/1.6 Georgia,serif;color:#222}.card{max-width:640px;margin:40px auto;padding:24px;border-radius:14px;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.08)}h1{font:700 30px system-ui;margin:0 0 8px}</style></head><body><div class="card"><h1>Hello from the stream</h1><p>This paragraph is typed live onto the blank sheet.</p></div></body></html>`;
for (const eng of engines) {
  const c = await createPage(); const id = c.artifact_id, T = `[${eng}]`;
  const b = await pw[eng].launch(launchOptions(eng));
  const context = await b.newContext({ viewport: { width: 1100, height: 720 } }); await blockExternal(context);
  const p = await context.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(c.edit_url); await sleep(3000);
  const f = p.frames().find(x => x.url().includes("/raw"));
  const info = await f.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, text: document.body.innerText.trim(), caret: !!document.querySelector(".c"), spin: !!document.querySelector(".spin") }));
  ok(info.bg === "rgb(255, 255, 255)", T + " blank page is light (" + info.bg + ")");
  ok(info.text === "" && !info.spin, T + " no spinner / no text blocks");
  ok(info.caret, T + " blinking caret present");
  ok(!(await p.evaluate(() => document.title)).includes("Generating"), T + " no 'Generating' title");
  await p.screenshot({ path: `${SHOTS}/waiting_new_${eng}.png` }); if (eng === "chromium") fs.copyFileSync(`${SHOTS}/waiting_new_${eng}.png`, `${SHOTS}/waiting_new.png`);
  // stream: head first -> blank sheet + caret should remain (live frame hidden until body text)
  await admin(id + "/draft", { op: "start", note: "test" }); await sleep(500);
  const head = PAGE.slice(0, PAGE.indexOf("</head>")), rest = PAGE.slice(PAGE.indexOf("</head>")); // head minus </head>: nothing to show yet
  await admin(id + "/draft", { op: "append", chunk: head }); await sleep(1200);
  ok(await p.evaluate(() => getComputedStyle(document.getElementById("live")).opacity === "0"), T + " head-only draft keeps the blank sheet visible");
  await admin(id + "/draft", { op: "append", chunk: rest.slice(0, 80) }); await sleep(1800);
  const mid = await p.evaluate(() => { const l = document.getElementById("live"); const d = l.contentDocument; return { shown: document.body.classList.contains("live-shown"), bg: getComputedStyle(d.body).backgroundColor, txt: d.body.textContent }; });
  ok(mid.shown && mid.bg === "rgb(251, 250, 247)" && mid.txt.includes("Hello"), T + " stream starts on it with page styles (" + mid.bg + ")");
  await p.screenshot({ path: `${SHOTS}/waiting_new_${eng}_mid.png` });
  await admin(id + "/draft", { op: "append", chunk: rest.slice(80) }); await sleep(2500);
  const put = await admin(id + "/html", { html: PAGE, base_version: 0, force: true, note: "waiting test" });
  ok(put.ok || put.version, T + " published v" + put.version);
  await sleep(4500);
  const fin = await p.evaluate(() => ({ live: document.body.classList.contains("m-live"), ttl: document.getElementById("ttl").textContent }));
  const f2 = p.frames().find(x => x.url().includes("/raw"));
  const ft = await f2.evaluate(() => document.body.innerText);
  ok(!fin.live && ft.includes("typed live") && fin.ttl === "Waiting test", T + " swapped to the final page, title updated");
  await p.screenshot({ path: `${SHOTS}/waiting_new_${eng}_final.png` });
  ok(errs.length === 0, T + " no page errors " + errs.join("|"));
  console.log(T, "id", id); await b.close();
}
console.log(fails ? `${fails} FAILED` : "ALL PASS"); process.exit(fails ? 1 : 0);
