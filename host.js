/* Host page for /a/<id>: toolbar + sandboxed iframe + editor features (editors only; server enforces). */
(function () {
  var B = window.__HOST__, $ = function (s) { return document.querySelector(s); };
  var urlToken = new URLSearchParams(location.search).get("edit") || "", TK = "ae:edit:" + B.id;
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }
  var token = urlToken || ls(TK) || "";
  var frame = $("#frame"), editor = false, mode = null, source = null, sid = rnd(10), seq = 0, mySaves = new Set();
  var saving = false, dirtyPending = false, newerAvailable = false, needReload = false, saveTimer = null, comments = [], lastScroll = 0, panel = null;
  function rnd(n) { var a = "abcdefghijkmnopqrstuvwxyz23456789", s = ""; var b = crypto.getRandomValues(new Uint8Array(n)); for (var i = 0; i < n; i++) s += a[b[i] % a.length]; return s; }
  function api(path, o) {
    o = o || {}; o.headers = Object.assign({ "x-edit-token": token }, o.headers || {});
    if (o.body && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["content-type"] = "application/json"; }
    return fetch("/api/a/" + B.id + path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.message || d.error || ("HTTP " + r.status)); e.status = r.status; e.data = d; throw e; } return d; }); });
  }
  function send(m) { m.__ae = 1; try { frame.contentWindow.postMessage(m, "*"); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg, ms, action) {
    var t = $("#toast"); t.innerHTML = esc(msg) + (action ? ' <button id="toastAct">' + esc(action.label) + "</button>" : ""); t.className = "show";
    if (action) $("#toastAct").onclick = function () { t.className = ""; action.fn(); };
    clearTimeout(toast._t); if (ms !== 0) toast._t = setTimeout(function () { t.className = ""; }, ms || 3500);
  }
  function fmt(ts) { var d = new Date(+ts); return ts == null || !Number.isFinite(d.getTime()) ? "时间未知" : d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function setSave(s, v) { var el = $("#save"); if (!el) return; el.className = "save " + s; el.textContent = { editing: "编辑中… Editing", saving: "保存中… Saving", saved: "已保存 Saved" + (v ? " · v" + v : ""), error: "保存失败 Save failed", conflict: "冲突 Conflict", idle: "✏️ 点文字即可编辑 · Click text to edit" }[s] || ""; }

  /* ---------- iframe ---------- */
  var lastReload = 0, frameReadyAt = 0, reloadTimer = null;
  function reloadFrame() {
    clearTimeout(reloadTimer); reloadTimer = null;
    // Coalesce bursts into a trailing refresh instead of dropping newer versions.
    var delay = 1500 - (Date.now() - lastReload);
    if (delay > 0) { reloadTimer = setTimeout(reloadFrame, delay); return; }
    // A user may have started typing while a refresh was waiting. Save/rebase first.
    if (editor && mode === "edit" && (saving || dirtyPending)) { newerAvailable = true; return; }
    lastReload = Date.now();
    if (editor) source = null;
    hideChip(); frame.src = "/a/" + B.id + "/raw?r=" + lastReload;
  }
  window.addEventListener("message", function (e) {
    if (e.source !== frame.contentWindow) return; var m = e.data || {};
    if (m.__artifact) {
      if (m.t === "presence") $("#pres").textContent = m.n + " 在线";
      else if (m.t === "version") onVersion(m);
      else if (m.t === "comments" && editor) loadComments();
    } else if (m.__ae_ev) {
      if (m.t === "ready") { if (lastScroll) send({ t: "scroll", y: lastScroll }); if (mode) applyMode(); if (editor) loadComments(); frameReadyAt = Date.now(); if (liveClosing && frameReadyAt > lastReload) liveRemove(); }
      else if (m.t === "dirty") scheduleSave();
      else if (m.t === "edits") doSave(m.edits || []);
      else if (m.t === "pick") { setMode("edit"); openCommentForm(m); }
      else if (m.t === "pin") openPanel("comments", m.id);
      else if (m.t === "by") showComment(m);
      else if (m.t === "outside") { if (panel === "comments" && matchMedia("(max-width:640px)").matches) closePanel(false); }
      else if (m.t === "escape") { closePanel(); hideChip(); if (mode === "comment") setMode("edit"); }
      else if (m.t === "located") { if (!m.ok) toast("页面上找不到这个位置了（可能已被改写）· Location not found", 4000); }
      else if (m.t === "scroll") { lastScroll = m.y; hideChip(); }
      else if (m.t === "sel") { if (m.none) { if (Date.now() - chipAt > 500) hideChip(); } else showChip(m, "评论这里 · Request a change"); }
      else if (m.t === "noedit") { chipAt = Date.now(); showChip(m, "这里由程序生成 · 提交修改请求"); }
    }
  });
  function onVersion(m) {
    if (m.from && mySaves.has(m.from)) return;
    if (editor) { source = null; if (panel === "history") loadHistory(); setTimeout(loadComments, 1200); }
    if (m.source === "cya" && !liveOn) toast((m.author || "Assistant") + " 已更新页面 updated the page");
    if (mode === "edit") { newerAvailable = true; if (!saving) { clearTimeout(saveTimer); send({ t: "collect" }); } return; }
    reloadFrame();
  }

  /* ---------- floating comment chip (text selection / app-generated text) ---------- */
  var chip = $("#askChip"), chipData = null, chipAt = 0;
  function showChip(m, label) {
    if (!editor || mode !== "edit" || !m.rect) return;
    chipPress = null; chipData = m; $("#askTxt").textContent = label; chip.classList.add("show");
    var fr = frame.getBoundingClientRect(), r = m.rect, cw = chip.offsetWidth, ch = chip.offsetHeight;
    var top = fr.top + r.y + r.h + 8; if (top + ch > fr.bottom - 8) top = fr.top + r.y - ch - 8;
    var left = fr.left + r.x + r.w / 2 - cw / 2;
    chip.style.top = Math.max(fr.top + 4, Math.min(top, fr.bottom - ch - 8)) + "px";
    chip.style.left = Math.max(fr.left + 8, Math.min(left, fr.right - cw - 8)) + "px";
  }
  function hideChip() { if (chip) chip.classList.remove("show"); chipData = null; }
  var chipPress = null;
  chip.addEventListener("pointerdown", function (e) { chipPress = chipData; e.preventDefault(); });
  chip.addEventListener("pointercancel", function () { chipPress = null; });
  chip.addEventListener("mousedown", function (e) { e.preventDefault(); });
  chip.onclick = function (e) { e.stopPropagation(); var d = chipPress || chipData; chipPress = null; hideChip(); if (d) openCommentForm(d); };

  /* ---------- live writing: HTML document.write path, or MD source+preview (Claude-like) ---------- */
  var live = null, liveDoc = null, liveOn = false, liveClosing = false, liveSeq = 0, liveFollow = true, liveAuto = 0, liveWs = null, liveTimer = null, pendingPage = B.status !== "ready";
  var liveQ = "", liveRaf = 0, liveCss = false, liveInBody = false;
  var liveMode = "html", liveMdQ = "", liveMdShown = "", liveMdRaf = 0, liveSrcEl = null, livePrevEl = null, liveMdFollow = true;
  var markedOk = null, markedPromise = null;
  var RAW_RE = /^<(style|script|title|textarea|noscript|xmp|iframe|noembed|noframes|template|svg)\b/i;
  var HEAD_TAG = /^<\/?(html|head|meta|link|base|title|style|script|noscript|template)\b|^<!/i;
  function liveScroll() {
    if (!liveFollow || !liveDoc) return;
    var se = liveDoc.scrollingElement || liveDoc.documentElement;
    if (se) { liveAuto = Date.now(); se.scrollTop = se.scrollHeight; }
  }
  function liveDropCaret() {
    try { var c = liveDoc && liveDoc.getElementById("__ae_c"); if (c) c.parentNode.removeChild(c); } catch (e) {}
  }
  // caret is inserted with the DOM (never document.write), only once the body has started, at the end of the deepest open element
  function liveCaret() {
    if (!liveDoc || liveClosing || !liveInBody) return;
    document.body.classList.add("live-shown");
    liveDropCaret();
    try {
      var body = liveDoc.body; if (!body) return;
      if (!liveCss) {
        var st = liveDoc.createElement("style"); st.id = "__ae_live";
        st.textContent = "@keyframes __ae_b{50%{opacity:0}}#__ae_c{display:inline-block;width:.5em;height:1em;margin-left:2px;border-radius:2px;background:currentColor;opacity:.75;vertical-align:-.12em;animation:__ae_b 1s step-end infinite}";
        (liveDoc.head || liveDoc.documentElement).appendChild(st); liveCss = true;
      }
      var el = body;
      while (el.lastElementChild && !/^(SCRIPT|STYLE|BR|HR|IMG|INPUT|SVG|svg|VIDEO|AUDIO|IFRAME|SELECT|TEXTAREA|TEMPLATE)$/.test(el.lastElementChild.tagName)) {
        var t = el.lastChild; if (t && t.nodeType === 3 && t.nodeValue.trim()) break; // text after the last element: caret goes here
        el = el.lastElementChild;
      }
      var c = liveDoc.createElement("span"); c.id = "__ae_c"; c.setAttribute("aria-hidden", "true"); el.appendChild(c);
    } catch (e) {}
  }
  function livePace() {
    var n = liveQ.length;
    // chars per frame; stays a little behind so it reads like a token stream
    if (n > 20000) return 700;
    if (n > 8000) return 220;
    if (n > 2500) return 70;
    if (n > 900) return 28;
    if (n > 300) return 12;
    if (n > 80) return 5;
    return 2;
  }
  // next piece to write: whole tags / comments / raw-text blocks (style, script, title…) at once, waiting for them to be complete;
  // text before <body> at once; body text a few characters at a time
  function liveTake() {
    if (!liveQ) return "";
    if (liveQ.charAt(0) === "<") {
      if (liveQ.slice(0, 4) === "<!--") { var ce = liveQ.indexOf("-->"); if (ce < 0) return ""; var cm = liveQ.slice(0, ce + 3); liveQ = liveQ.slice(ce + 3); return cm; }
      var rm = RAW_RE.exec(liveQ);
      if (rm) {
        var close = new RegExp("</" + rm[1] + "\\s*>", "i"), cl = close.exec(liveQ);
        if (!cl) return ""; // wait until the whole <style>…</style> (etc.) has arrived
        var blk = liveQ.slice(0, cl.index + cl[0].length); liveQ = liveQ.slice(blk.length); return blk;
      }
      var gt = liveQ.indexOf(">"); if (gt < 0) return ""; // split tag: wait for the rest
      var tag = liveQ.slice(0, gt + 1); liveQ = liveQ.slice(gt + 1);
      if (!liveInBody && (/^<body\b/i.test(tag) || /^<\/head/i.test(tag) || !HEAD_TAG.test(tag))) liveInBody = true;
      return tag;
    }
    var cut = liveQ.indexOf("<"); if (cut < 0) cut = liveQ.length;
    if (!liveInBody) {
      var txt = liveQ.slice(0, cut);
      if (txt.trim()) liveInBody = true; else { liveQ = liveQ.slice(cut); return txt || ""; }
    }
    var n = Math.min(livePace(), cut);
    if (n >= 4 && n < cut) { var sp = liveQ.lastIndexOf(" ", n); if (sp >= Math.max(1, n - 12)) n = sp + 1; }
    var out = liveQ.slice(0, n); liveQ = liveQ.slice(n); return out;
  }
  function livePump() {
    liveRaf = 0;
    if (!liveOn || !liveDoc) { liveQ = ""; return; }
    var wrote = false, typed = false, guard = 0, piece;
    liveDropCaret();
    while (guard++ < 200 && (piece = liveTake())) {
      liveDoc.write(piece); wrote = true;
      if (piece.charAt(0) !== "<" && liveInBody && piece.trim()) { typed = true; break; } // one text burst per frame
    }
    if (wrote || typed) liveScroll();
    liveCaret();
    if (liveQ && (typed || wrote)) {
      var gap = liveQ.length > 400 ? 0 : (liveQ.length > 100 ? 12 : 22);
      if (gap) liveRaf = setTimeout(function () { liveRaf = requestAnimationFrame(livePump); }, gap);
      else liveRaf = requestAnimationFrame(livePump);
    }
    // if nothing could be written, we're waiting for the rest of a split tag/style: the next append re-arms the pump
  }
  function liveFlushQ() {
    if (liveMode === "md") { liveMdFlush(); return; }
    if (liveRaf) { try { cancelAnimationFrame(liveRaf); } catch (e) {} try { clearTimeout(liveRaf); } catch (e) {} liveRaf = 0; }
    if (!liveDoc) { liveQ = ""; return; }
    if (liveQ) { liveDropCaret(); liveDoc.write(liveQ); liveQ = ""; }
    liveDropCaret();
  }

  /* ---- Markdown live: source typewriter + preview ---- */
  function ensureMarked() {
    if (markedOk === true && window.marked) return Promise.resolve(window.marked);
    if (markedOk === false) return Promise.resolve(null);
    if (markedPromise) return markedPromise;
    markedPromise = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js";
      s.onload = function () {
        try {
          if (window.marked && window.marked.setOptions) window.marked.setOptions({ gfm: true, breaks: false });
          markedOk = !!window.marked; resolve(window.marked || null);
        } catch (e) { markedOk = false; resolve(null); }
      };
      s.onerror = function () { markedOk = false; resolve(null); };
      document.head.appendChild(s);
    });
    return markedPromise;
  }
  function mdFallback(src) {
    // tiny GFM-ish subset when marked CDN fails: headings, lists, code fences, inline, tables, hr
    var lines = String(src || "").replace(/\r\n?/g, "\n").split("\n"), html = [], i = 0, inFence = false, fenceLang = "", fence = [];
    function inline(t) {
      return esc(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
    }
    function flushPara(buf) { if (!buf.length) return; html.push("<p>" + inline(buf.join(" ")) + "</p>"); buf.length = 0; }
    var para = [];
    while (i < lines.length) {
      var line = lines[i], fm = /^```([\w-]*)\s*$/.exec(line);
      if (fm) {
        if (inFence) { html.push("<pre><code>" + esc(fence.join("\n")) + "</code></pre>"); fence = []; inFence = false; }
        else { flushPara(para); inFence = true; fenceLang = fm[1] || ""; }
        i++; continue;
      }
      if (inFence) { fence.push(line); i++; continue; }
      if (/^\s*$/.test(line)) { flushPara(para); i++; continue; }
      if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) { flushPara(para); html.push("<hr>"); i++; continue; }
      var hm = /^(#{1,3})\s+(.+)$/.exec(line);
      if (hm) { flushPara(para); html.push("<h" + hm[1].length + ">" + inline(hm[2]) + "</h" + hm[1].length + ">"); i++; continue; }
      if (/^\|.+\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
        flushPara(para);
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        if (rows.length >= 2) {
          var cells = function (r) { return r.replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
          var head = cells(rows[0]), body = rows.slice(2);
          html.push("<table><thead><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
            body.map(function (r) { return "<tr>" + cells(r).map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>");
        }
        continue;
      }
      var um = /^[-*+]\s+(.+)$/.exec(line), om = /^(\d+)\.\s+(.+)$/.exec(line);
      if (um || om) {
        flushPara(para);
        var tag = um ? "ul" : "ol", items = [];
        while (i < lines.length) {
          var u2 = /^[-*+]\s+(.+)$/.exec(lines[i]), o2 = /^(\d+)\.\s+(.+)$/.exec(lines[i]);
          if (um && u2) { items.push("<li>" + inline(u2[1]) + "</li>"); i++; }
          else if (om && o2) { items.push("<li>" + inline(o2[2]) + "</li>"); i++; }
          else break;
        }
        html.push("<" + tag + ">" + items.join("") + "</" + tag + ">");
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushPara(para); var bq = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { bq.push(lines[i].replace(/^>\s?/, "")); i++; }
        html.push("<blockquote><p>" + inline(bq.join(" ")) + "</p></blockquote>");
        continue;
      }
      para.push(line); i++;
    }
    if (inFence) html.push("<pre><code>" + esc(fence.join("\n")) + "</code></pre>");
    flushPara(para);
    return html.join("\n");
  }
  function renderMd(src) {
    var out = "";
    try {
      if (window.marked && typeof window.marked.parse === "function") out = window.marked.parse(src || "");
      else if (window.marked && typeof window.marked === "function") out = window.marked(src || "");
      else out = mdFallback(src);
    } catch (e) { out = mdFallback(src); }
    if (livePrevEl) livePrevEl.innerHTML = out;
  }
  function liveMdScroll() {
    if (!liveMdFollow) return;
    liveAuto = Date.now();
    var showSrc = document.body.classList.contains("m-live-md-source");
    if (showSrc && liveSrcEl && liveSrcEl.parentNode) liveSrcEl.parentNode.scrollTop = liveSrcEl.parentNode.scrollHeight;
    var pp = livePrevEl && livePrevEl.parentNode; if (pp) pp.scrollTop = pp.scrollHeight;
  }
  function liveMdPaint() {
    if (!liveSrcEl || !livePrevEl) return;
    var showSrc = document.body.classList.contains("m-live-md-source");
    var caret = liveClosing ? "" : '<span class="caret" aria-hidden="true"></span>';
    liveSrcEl.innerHTML = esc(liveMdShown) + (showSrc ? caret : "");
    renderMd(liveMdShown);
    if (!showSrc && !liveClosing) livePrevEl.insertAdjacentHTML("beforeend", caret);
    liveMdScroll();
    document.body.classList.add("live-shown");
  }
  function liveMdPace() {
    // Claude-like: a few glyphs/frame; never dump a backlog in one gulp
    var n = liveMdQ.length;
    if (n > 3000) return 4;
    if (n > 800) return 3;
    if (n > 200) return 2;
    return 1;
  }
  function liveMdPump() {
    liveMdRaf = 0;
    if (!liveOn || liveMode !== "md") { liveMdQ = ""; return; }
    if (!liveMdQ) return;
    var n = Math.min(liveMdPace(), liveMdQ.length);
    if (n >= 2 && n < liveMdQ.length) {
      var sp = Math.max(liveMdQ.lastIndexOf(" ", n), liveMdQ.lastIndexOf("\n", n));
      if (sp >= 1) n = sp + 1;
    }
    liveMdShown += liveMdQ.slice(0, n);
    liveMdQ = liveMdQ.slice(n);
    liveMdPaint();
    if (liveMdQ) {
      var gap = liveMdQ.length > 1500 ? 36 : (liveMdQ.length > 300 ? 48 : 56);
      liveMdRaf = setTimeout(function () { liveMdRaf = requestAnimationFrame(liveMdPump); }, gap);
    }
  }
  function liveMdFlush() {
    if (liveMdRaf) { try { cancelAnimationFrame(liveMdRaf); } catch (e) {} try { clearTimeout(liveMdRaf); } catch (e) {} liveMdRaf = 0; }
    if (liveMdQ) { liveMdShown += liveMdQ; liveMdQ = ""; }
    liveMdPaint();
  }
  function liveMdWrite(chunk, instant) {
    if (!chunk) return;
    ensureMarked();
    if (instant) { liveMdFlush(); liveMdShown += chunk; liveMdPaint(); return; }
    liveMdQ += chunk;
    if (!liveMdRaf) liveMdRaf = requestAnimationFrame(liveMdPump);
  }
  function liveMdBegin(note) {
    ensureMarked();
    if (!document.getElementById("liveMdFonts")) {
      var l1 = document.createElement("link"); l1.id = "liveMdFonts"; l1.rel = "stylesheet";
      l1.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
      document.head.appendChild(l1);
    }
    var box = $("#liveMd");
    // Viewers only see Preview. Source pane stays in DOM (hidden) for optional ?source=1 / operators.
    box.innerHTML = '<div class="pane src" aria-hidden="true"><div class="lab">Source · Markdown</div><div class="body" id="liveMdSrc"></div></div><div class="pane prev"><div class="md" id="liveMdPrev"></div></div>';
    liveSrcEl = $("#liveMdSrc"); livePrevEl = $("#liveMdPrev");
    liveMdQ = ""; liveMdShown = ""; liveMdFollow = true;
    var showSrc = false;
    try { showSrc = new URLSearchParams(location.search).get("source") === "1"; } catch (e) {}
    box.querySelector(".src").addEventListener("scroll", function () {
      if (Date.now() - liveAuto < 120) return;
      var el = box.querySelector(".src");
      liveMdFollow = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }, { passive: true });
    // Follow the preview pane for viewers (source is hidden)
    box.querySelector(".prev").addEventListener("scroll", function () {
      if (Date.now() - liveAuto < 120) return;
      var el = box.querySelector(".prev");
      liveMdFollow = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }, { passive: true });
    document.body.classList.add("m-live", "m-live-md", "live-shown");
    document.body.classList.toggle("m-live-md-source", !!showSrc);
    document.body.classList.remove("live-hide");
    document.body.classList.toggle("no-cur", pendingPage);
    $("#liveTxt").textContent = (note ? note.slice(0, 40) + " · " : "") + "正在写作… · writing live";
    $("#liveToggle").textContent = "看当前版本 Current";
    hideChip();
    liveMdPaint();
  }

  function liveBegin(note, mode) {
    if (liveRaf) { try { cancelAnimationFrame(liveRaf); } catch (e) {} try { clearTimeout(liveRaf); } catch (e) {} liveRaf = 0; }
    if (liveMdRaf) { try { cancelAnimationFrame(liveMdRaf); } catch (e) {} try { clearTimeout(liveMdRaf); } catch (e) {} liveMdRaf = 0; }
    liveQ = ""; liveMdQ = ""; liveCss = false; liveInBody = false;
    liveMode = mode === "md" ? "md" : "html";
    liveOn = true; liveClosing = false; liveSeq = 0; liveFollow = true;
    if (live) { try { live.remove(); } catch (e) {} live = null; liveDoc = null; }
    document.body.classList.remove("m-live-md", "live-hide", "live-shown");
    if (liveMode === "md") { liveMdBegin(note); return; }
    var box = $("#liveMd"); if (box) box.innerHTML = "";
    live = document.createElement("iframe"); live.id = "live"; live.setAttribute("sandbox", "allow-same-origin"); live.setAttribute("aria-label", "Live writing");
    document.body.appendChild(live);
    liveDoc = live.contentDocument; liveDoc.open();
    liveDoc.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a,form")) e.preventDefault(); }, true);
    live.contentWindow.addEventListener("scroll", function () {
      if (Date.now() - liveAuto < 120) return; var se = liveDoc.scrollingElement || liveDoc.documentElement;
      liveFollow = se.scrollHeight - se.scrollTop - live.clientHeight < 80;
    }, { passive: true });
    $("#liveTxt").textContent = (note ? note.slice(0, 40) + " · " : "") + "正在写作… · writing live";
    document.body.classList.add("m-live"); document.body.classList.remove("live-hide", "live-shown"); document.body.classList.toggle("no-cur", pendingPage);
    $("#liveToggle").textContent = "看当前版本 Current"; hideChip();
  }
  // instant=true for late-joiner catch-up (content already written); otherwise Claude-style stream paint
  function liveWrite(html, instant) {
    if (!liveOn || !html) return;
    if (liveMode === "md") { liveMdWrite(html, instant); return; }
    if (instant) { liveFlushQ(); liveDoc.write(html); liveInBody = /<body\b|<\/head\s*>/i.test(html) || !!(liveDoc.body && liveDoc.body.firstChild); liveCaret(); liveScroll(); return; }
    liveQ += html;
    if (!liveRaf) liveRaf = requestAnimationFrame(livePump);
  }
  function liveRemove() {
    clearTimeout(liveTimer);
    if (liveRaf) { try { cancelAnimationFrame(liveRaf); } catch (e) {} try { clearTimeout(liveRaf); } catch (e) {} liveRaf = 0; }
    if (liveMdRaf) { try { cancelAnimationFrame(liveMdRaf); } catch (e) {} try { clearTimeout(liveMdRaf); } catch (e) {} liveMdRaf = 0; }
    liveQ = ""; liveMdQ = ""; liveMdShown = ""; liveSrcEl = livePrevEl = null;
    liveOn = liveClosing = false; liveMode = "html";
    document.body.classList.remove("m-live", "m-live-md", "live-hide", "live-shown");
    var box = $("#liveMd"); if (box) box.innerHTML = "";
    var l = live; live = liveDoc = null; if (l) setTimeout(function () { try { l.contentDocument.close(); } catch (e) {} l.remove(); }, 300);
  }
  function liveFinish(published) {
    if (!liveOn) return;
    liveFlushQ();
    if (!published) { liveRemove(); return; }
    if (liveMode === "html") { try { liveDoc && liveDoc.close(); } catch (e) {} }
    $("#liveTxt").textContent = "写好了，正在加载… · Done, loading"; liveClosing = true;
    if (liveMode === "md") liveMdPaint();
    try {
      if (liveMode === "html" && liveDoc) {
        var lse = liveDoc.scrollingElement || liveDoc.documentElement; if (lse && lse.scrollTop) lastScroll = lse.scrollTop;
      }
    } catch (e) {}
    if (pendingPage) { pendingPage = false; B.status = "ready"; reloadFrame(); fetch("/a/" + B.id + "/status").then(function (r) { return r.json(); }).then(function (d) { if (d.title) { $("#ttl").textContent = d.title; document.title = d.title; } }).catch(function () {}); }
    if (lastReload > Date.now() - 10000 && frameReadyAt > lastReload) { liveRemove(); return; } // final page already loaded
    setTimeout(function () { if (liveClosing && Date.now() - lastReload > 3000 && !(editor && (dirtyPending || saving))) reloadFrame(); }, 2500);
    clearTimeout(liveTimer); liveTimer = setTimeout(liveRemove, 12000); // the real page normally replaces it as soon as it loads
  }
  if ($("#liveToggle")) $("#liveToggle").onclick = function () { document.body.classList.toggle("live-hide"); };
  function applyDraftSnapshot(d) {
    if (!d || !d.active) {
      if (liveOn && !liveClosing) liveRemove();
      return;
    }
    var mode = d.mode === "md" ? "md" : "html";
    if (!liveOn || liveMode !== mode) liveBegin(d.note, mode);
    if (d.seq > liveSeq) {
      liveWrite(d.text || d.html || "", true);
      liveSeq = d.seq;
    }
  }
  function livePoll() {
    fetch("/a/" + B.id + "/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      if (pendingPage && d.status === "ready") {
        if (liveOn) liveFinish(true);
        else { pendingPage = false; B.status = "ready"; reloadFrame(); }
      }
      if (d.status === "failed") { liveRemove(); reloadFrame(); return; }
      applyDraftSnapshot(d.draft);
    }).catch(function () {});
  }
  function liveHandleMsg(m) {
    if (!m || !m.t || m.t === "ping") return;
    if (m.t === "hello") {
      if (pendingPage && m.status === "ready") { liveFinish(true); if (!liveOn) { pendingPage = false; B.status = "ready"; reloadFrame(); } }
      if (m.draft && m.draft.active !== false) {
        liveBegin(m.draft.note, m.draft.mode);
        liveWrite(m.draft.text || m.draft.html || "", true);
        liveSeq = m.draft.seq || 0;
      } else if (liveOn && !liveClosing) liveRemove();
    } else if (m.t === "draft") {
      if (m.op === "start") liveBegin(m.note, m.mode);
      else if (m.op === "append") {
        if (!liveOn) liveBegin(null, m.mode || liveMode);
        if (m.seq <= liveSeq) return;
        if (m.seq !== liveSeq + 1) { livePoll(); return; }
        liveSeq = m.seq; liveWrite(m.chunk);
      } else if (m.op === "end") liveFinish(m.published);
    } else if (m.t === "version" && pendingPage) { if (!liveOn) { pendingPage = false; B.status = "ready"; reloadFrame(); } }
    else if (m.t === "status" && m.status === "failed") { liveRemove(); reloadFrame(); }
  }
  function liveSse() {
    if (typeof EventSource === "undefined") return false;
    try {
      var es = new EventSource("/a/" + B.id + "/live");
      liveEs = es;
      es.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        liveHandleMsg(m);
      };
      return true;
    } catch (e) { return false; }
  }
  function liveConnect() {
    var ws; try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/a/" + B.id + "/ws?live=1"); } catch (e) { return; }
    liveWs = ws;
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      liveHandleMsg(m);
    };
    ws.onclose = function () { if (liveWs === ws) setTimeout(liveConnect, 1500 + Math.random() * 2000); };
  }
  var liveEs = null;
  setInterval(function () { if (liveWs && liveWs.readyState === 1) try { liveWs.send('{"t":"ping"}'); } catch (e) {} }, 20000);
  // Prefer HTTP SSE (works in more mobile WebViews); WS is backup; status poll is last resort.
  function startLive() {
    var ok = liveSse();
    if (!ok) liveConnect();
    else setTimeout(liveConnect, 800); // optional WS alongside SSE
    livePoll();
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", startLive);
  else startLive();
  setInterval(livePoll, 1200);

  /* ---------- modes ---------- */
  function ensureSource() { return source ? Promise.resolve(source) : api("/source").then(function (d) { source = d; return d; }); }
  function staticTexts(html) {
    var doc = new DOMParser().parseFromString(html, "text/html"), out = [], w = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) { if (n.nodeValue.trim() && okNode(n)) out.push(n.nodeValue); } return out;
  }
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|TITLE|SVG|SELECT|OPTION|CODE|PRE)$/;
  function okNode(n) { for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (SKIP.test(p.tagName.toUpperCase())) return false; return true; }
  function applyMode() {
    if (mode === "edit" && B.status !== "ready") return;
    if (mode === "edit") ensureSource().then(function (s) { send({ t: "mode", mode: "edit", texts: staticTexts(s.html) }); });
    else send({ t: "mode", mode: mode });
  }
  function setMode(m) {
    if (!editor) return;
    var next = m === mode && m !== "edit" ? "edit" : m; // editors are always in edit mode; "comment" is a temporary pick mode
    if (mode === "edit" && next !== "edit") { clearTimeout(saveTimer); send({ t: "collect" }); }
    mode = next; hideChip();
    document.body.classList.toggle("m-edit", mode === "edit"); document.body.classList.toggle("m-comment", mode === "comment");
    $("#bComment").classList.toggle("on", mode === "comment");
    $("#hint").textContent = mode === "comment" ? "点击页面上的元素，说明想怎么改 · Click an element to request a change (Esc to cancel)" : "";
    applyMode();
    if (mode === "edit" && newerAvailable && !saving && !dirtyPending) { newerAvailable = false; reloadFrame(); }
  }

  /* ---------- hand edits ---------- */
  function scheduleSave() { dirtyPending = true; setSave("editing"); clearTimeout(saveTimer); saveTimer = setTimeout(function () { if (!saving) { dirtyPending = false; send({ t: "collect" }); } }, 900); }
  function applyEdits(html, edits) {
    var doc = new DOMParser().parseFromString(html, "text/html"), texts = [], w = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) if (okNode(n)) texts.push(n);
    var applied = [], missing = [], used = new Set();
    edits.forEach(function (e) {
      var c = texts.filter(function (t) { return t.nodeValue === e.orig && !used.has(t); });
      var t = c.length === 1 ? c[0] : c[e.occ];
      if (!t) { missing.push(e.key); return; }
      t.nodeValue = e.now; used.add(t); applied.push(e.key);
    });
    var dt = (html.match(/^\s*<!doctype[^>]*>/i) || ["<!DOCTYPE html>"])[0].trim();
    return { html: applied.length ? dt + "\n" + doc.documentElement.outerHTML : html, applied: applied, missing: missing };
  }
  function doSave(edits) {
    if (!edits.length) { if (!dirtyPending) setSave("saved", source && source.version); if (newerAvailable && !saving) { newerAvailable = false; reloadFrame(); } return; }
    saving = true; setSave("saving"); var attempt = 0;
    function tryOnce() {
      return ensureSource().then(function (s) {
        var r = applyEdits(s.html, edits);
        if (r.missing.length) {
          send({ t: "revert", keys: r.missing });
          if (attempt === 0) toast("这段文字是应用动态生成的，不能直接改，可以用「评论」请求修改。This text is generated by the app; use Comment instead.", 6000);
          else { toast("别人刚改了同一段文字，你的这处修改没有保存，已为你刷新到最新版本。Someone else just changed that text; your change wasn't saved.", 7000); needReload = true; }
        }
        if (!r.applied.length) { setSave("conflict"); return; }
        var from = "h" + sid + "-" + (++seq); mySaves.add(from);
        return api("/versions", { method: "POST", body: { base_version: s.version, html: r.html, sid: sid, from: from } }).then(function (d) {
          source = { html: r.html, version: d.version, title: s.title };
          send({ t: "committed", keys: r.applied }); setSave("saved", d.version);
          if (attempt > 0) needReload = true;
        }, function (e) {
          if (e.status === 409 && attempt < 3) { attempt++; source = null; return tryOnce(); }
          throw e;
        });
      });
    }
    tryOnce().catch(function (e) { setSave("error"); toast("保存失败 Save failed: " + e.message, 6000); })
      .then(function () {
        saving = false;
        if (dirtyPending) scheduleSave();
        else if (needReload || newerAvailable) { needReload = newerAvailable = false; reloadFrame(); }
      });
  }

  /* ---------- comments ---------- */
  var pick = null;
  function openCommentForm(p) {
    pick = p; $("#cmTarget").innerHTML = p ? "<b>&lt;" + esc(p.tag) + "&gt;</b> " + esc((p.text || "").slice(0, 140) || "(no text)") : "整个页面 Whole page";
    $("#cmReq").value = ""; $("#cmAuthor").value = ls("ae_author") || "";
    $("#cmModal").classList.add("show"); setTimeout(function () { $("#cmReq").focus(); }, 50);
  }
  function submitComment() {
    if ($("#cmSend").disabled) return;
    var req = $("#cmReq").value.trim(); if (!req) { $("#cmReq").focus(); return; }
    var author = $("#cmAuthor").value.trim(); try { localStorage.setItem("ae_author", author); } catch (e) {}
    $("#cmSend").disabled = true;
    api("/comments", { method: "POST", body: { request: req, author: author, selector: pick ? pick.selector : null, text: pick ? pick.text : null, html: pick ? pick.html : null } })
      .then(function () { $("#cmModal").classList.remove("show"); toast("评论已保存，待处理 · Comment saved; pending", 5000); loadComments(); })
      .catch(function (e) { toast("发送失败 " + e.message, 6000); })
      .then(function () { $("#cmSend").disabled = false; });
  }
  var commentsRequest = 0, commentsPromise = null, commentsError = false, commentSelection = null, commentOpenRequest = 0, directSending = false;
  function loadComments() {
    var request = ++commentsRequest;
    commentsPromise = api("/comments").then(function (d) {
      if (request !== commentsRequest) return commentsPromise;
      commentsError = false; comments = d.comments || []; sendPins();
      if (panel === "comments") renderComments();
    }).catch(function () {
      if (request !== commentsRequest) return commentsPromise;
      commentsError = true;
      if (panel === "comments") renderComments();
    });
    return commentsPromise;
  }
  function sendPins() { if (!editor) return; send({ t: "pins", pins: comments.filter(function (c) { return c.status === "open"; }).map(function (c) { return { id: c.id, n: cnum(c), selector: c.selector, text: c.snippet_text, request: c.request }; }) }); }
  var ST = { open: "待处理 Pending", resolved: "已完成 Done", failed: "失败 Failed" };
  // Optional attribution: unnamed editors and publishers use neutral labels.
  function cnum(c) { return comments.indexOf(c) + 1; }
  function name(value) { return typeof value === "string" ? value.trim() : ""; }
  function asker(c) { return name(c.author) || "Editor"; }
  function answerer(c) { return name(c.resolved_by) || (c.status === "resolved" ? "Assistant" : ""); }
  function commentNumber(text) {
    var matches = String(text || "").match(/评论\s*[0-9]+(?=$|\s|[·•|｜,，:：;；。!?！？)\]】）])/g);
    if (!matches || matches.length !== 1) return null;
    var n = Number(matches[0].replace(/^评论\s*/, ""));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  function findComment(m) {
    if (m.cid) return comments.find(function (c) { return c.id === m.cid; }) || null;
    return Number.isSafeInteger(m.n) && m.n > 0 ? comments[m.n - 1] || null : null;
  }
  function locate(c, prefer) {
    var m = { t: "locate", selector: c ? c.selector : null, text: c ? c.snippet_text : null,
      cid: c ? c.id : commentSelection && commentSelection.cid, n: c ? cnum(c) : commentSelection && commentSelection.n,
      whole: !!c && !c.selector && !c.snippet_text, prefer: prefer || "chip" };
    send(m);
  }
  function people(c) {
    return '<span class="cmn">提问 <b>' + esc(asker(c)) + '</b> <span class="tm">· ' + fmt(c.created) + "</span></span>" +
      (answerer(c) ? '<span class="cmn">回答 <b>' + esc(answerer(c)) + '</b> <span class="tm">· ' + fmt(c.updated) + (c.resolved_version ? " · v" + c.resolved_version : "") + "</span></span>" : "");
  }
  function place(c) { return c.snippet_text || (c.selector ? "选中的元素" : "整个页面 Whole page"); }
  function showComment(m) {
    var txt = String(m.text || "");
    openComments({ cid: m.cid, n: commentNumber(txt), by: (txt.match(/^\s*(.+?)\s*答(?:\s|·|$)/) || [])[1] || "" }, "chip");
  }
  function openComments(selection, prefer) {
    if (mode === "comment") setMode("edit");
    hideChip();
    var request = ++commentOpenRequest;
    commentSelection = selection || null;
    showPanel("comments"); renderComments(true); $("#pclose").focus({ preventScroll: true });
    var c = editor && commentSelection ? findComment(commentSelection) : null;
    // A known selection locates immediately. Opening the list alone never moves the page.
    if (c || (!editor && commentSelection && (commentSelection.cid || commentSelection.n))) locate(c, prefer);
    if (editor) loadComments().then(function () {
      if (request !== commentOpenRequest || panel !== "comments" || c || !commentSelection) return;
      var found = findComment(commentSelection);
      if (found) locate(found, prefer);
    });
  }
  function selectComment(id) {
    var c = findComment({ cid: id }); if (!editor || !c) return;
    commentOpenRequest++; commentSelection = { cid: c.id };
    renderComments(true); $("#commentDetail").focus({ preventScroll: true }); locate(c, "sel");
  }
  function renderComments(resetScroll) {
    var body = $("#pbody"), active = document.activeElement, focusId = body.contains(active) ? active.id : null;
    var input = $("#pgReq"), draft = input ? input.value : "", start = input && input.selectionStart, end = input && input.selectionEnd;
    var scroll = body.scrollTop, c = editor && commentSelection ? findComment(commentSelection) : null, h = "";
    // Once resolved, use the stable ID even if subsequent reloads change the comment ordering.
    if (c) commentSelection.cid = c.id;
    if (commentSelection) {
      h += '<section id="commentDetail" tabindex="-1" aria-label="选中的评论 Selected comment">';
      if (c) {
        h += '<div class="cmh"><span class="cmtag">评论 ' + cnum(c) + '</span><span class="st">' + esc(ST[c.status] || c.status) + '</span></div>' +
          '<div class="cmr">' + esc(c.request) + '</div>' + people(c) +
          '<div class="cms">评论处：' + esc(place(c)) + '</div>' +
          (c.status === "failed" && c.reason ? '<div class="cms err">' + esc(c.reason) + '</div>' : '') +
          '<div class="cmb"><button id="commentLocate">跳到评论处 Locate</button></div>';
      } else {
        h += '<div class="cmtag">' + esc(commentSelection.n ? "评论 " + commentSelection.n : "评论") + '</div>' +
          (commentSelection.by ? '<div class="cmn">回答 <b>' + esc(commentSelection.by) + '</b></div>' : '') +
          '<p class="cms">' + (editor ? (commentsError ? "评论加载失败，请重试 Could not load comments" : "没找到这条评论 Comment not found") : "评论内容只有用编辑链接打开才能看到 · Open with the editor link to see the comment") + '</p>';
      }
      h += '</section>';
    }
    // Public chips are the only source of viewer metadata. Never render the private list or composer.
    if (editor) {
      h += '<div class="pgen"><textarea id="pgReq" aria-label="请求修改整个页面 Request a change to the whole page" placeholder="请求修改整个页面… Request a change to the whole page"></textarea><button class="pri" id="pgSend">发送 Send</button></div>';
      h += '<section id="commentList" aria-label="全部评论 All comments">';
      if (commentsError) h += '<p class="empty">评论加载失败，请重新打开重试。</p>';
      if (!comments.length && !commentsError) h += '<p class="empty">还没有评论。选择页面文字，再点「评论这里」。<br>No comments yet.</p>';
      comments.slice().reverse().forEach(function (item) {
        var selected = c && c.id === item.id;
        h += '<button type="button" class="cm ' + esc(item.status) + (selected ? ' focus' : '') + '" id="cm-' + esc(item.id) + '" data-comment="' + esc(item.id) + '"' + (selected ? ' aria-current="true"' : '') + '>' +
          '<span class="cmh">' + (item.status === "open" ? '<span class="pinb">' + cnum(item) + '</span>' : '') + '<span class="cmtag">评论 ' + cnum(item) + '</span><span class="st">' + esc(ST[item.status] || item.status) + '</span></span>' +
          '<span class="cmr">' + esc(item.request) + '</span><span class="cms">' + esc(place(item)) + '</span>' +
          people(item) +
          (item.status === "failed" && item.reason ? '<span class="cms err">' + esc(item.reason) + '</span>' : '') + '</button>';
      });
      h += '</section>';
    }
    body.innerHTML = h;
    if ($("#commentLocate")) $("#commentLocate").onclick = function () { locate(c, "sel"); };
    body.querySelectorAll("[data-comment]").forEach(function (b) { b.onclick = function () { selectComment(b.dataset.comment); }; });
    if ($("#pgReq")) {
      $("#pgReq").value = draft; $("#pgSend").disabled = directSending;
      $("#pgSend").onclick = function () { var v = $("#pgReq").value.trim(); if (!v) return; $("#pgSend").disabled = true; submitCommentDirect(v); };
    }
    if (!resetScroll && focusId) {
      var next = document.getElementById(focusId) || $("#pclose"); next.focus({ preventScroll: true });
      if (focusId === "pgReq" && $("#pgReq")) $("#pgReq").setSelectionRange(start, end);
    }
    body.scrollTop = resetScroll ? 0 : scroll;
  }
  function submitCommentDirect(v) {
    if (directSending) return;
    directSending = true;
    api("/comments", { method: "POST", body: { request: v, author: ls("ae_author") || "", selector: null } })
      .then(function () { if ($("#pgReq") && $("#pgReq").value === v) $("#pgReq").value = ""; toast("评论已保存，待处理 · Comment saved; pending", 4000); return loadComments(); }).catch(function (e) { toast("发送失败 " + e.message, 6000); })
      .then(function () { directSending = false; if ($("#pgSend")) $("#pgSend").disabled = false; });
  }

  /* ---------- history ---------- */
  var SRC = { generated: "生成 Generated", hand: "手动编辑 Hand edit", cya: "发布者修改 Publisher edit", restore: "恢复 Restore" };
  function loadHistory() {
    $("#pbody").innerHTML = '<p class="empty">加载中… Loading…</p>';
    api("/versions").then(function (d) {
      if (panel !== "history") return;
      var vs = d.versions || [], cur = d.current, h = "";
      vs.forEach(function (v) {
        var lab = v.source === "cya" ? esc(name(v.author) || "Assistant") + " 修改" : v.source === "hand" && name(v.author) ? "手动编辑 · " + esc(name(v.author)) : (SRC[v.source] || SRC.generated);
        h += '<div class="ver' + (v.n === cur ? " cur" : "") + '"><div class="vh"><b>v' + v.n + "</b> <span class=\"tag " + (v.source || "generated") + '">' + lab + "</span>" + (v.n === cur ? ' <span class="tag now">当前 Current</span>' : "") + "</div>" +
          '<div class="tm">' + fmt(v.created) + " · " + Math.round(v.size / 1024 * 10) / 10 + " KB" + (v.note ? " · " + esc(v.note) : "") + "</div>" +
          '<div class="vb"><button data-pv="' + v.n + '">预览 Preview</button>' + (v.n !== cur ? '<button data-rs="' + v.n + '">恢复 Restore</button>' : "") + "</div></div>";
      });
      $("#pbody").innerHTML = h || '<p class="empty">No versions</p>';
      $("#pbody").querySelectorAll("[data-pv]").forEach(function (b) { b.onclick = function () { preview(+b.dataset.pv, cur); }; });
      $("#pbody").querySelectorAll("[data-rs]").forEach(function (b) { b.onclick = function () { restore(+b.dataset.rs); }; });
    }).catch(function (e) { if (panel === "history") $("#pbody").innerHTML = '<p class="empty err">' + esc(e.message) + "</p>"; });
  }
  function preview(n, cur) {
    api("/versions/" + n).then(function (d) {
      $("#pvTitle").textContent = "v" + n + " 预览 Preview";
      $("#pvFrame").srcdoc = d.html;
      $("#pvRestore").style.display = n === cur ? "none" : ""; $("#pvRestore").onclick = function () { restore(n); };
      $("#pvModal").classList.add("show");
    }).catch(function (e) { toast(e.message); });
  }
  function restore(n) {
    if (!confirm("恢复到 v" + n + "？会生成一个新版本，数据不会丢。\nRestore v" + n + "? This creates a new version; shared data is kept.")) return;
    api("/restore", { method: "POST", body: { n: n } }).then(function (d) { $("#pvModal").classList.remove("show"); toast("已恢复为 v" + d.version + " Restored"); source = null; loadHistory(); }).catch(function (e) { toast(e.message, 6000); });
  }

  /* ---------- panel / menu ---------- */
  var panelReturnFocus = null;
  function showPanel(which) {
    if (!panel || document.activeElement === frame) panelReturnFocus = document.activeElement;
    panel = which;
    var drawer = $("#panel"), title = which === "history" ? "版本历史 History" : "评论 Comments";
    drawer.inert = false; drawer.setAttribute("aria-hidden", "false"); drawer.setAttribute("aria-label", title); drawer.dataset.surface = which;
    drawer.classList.add("show"); $("#ptitle").textContent = title;
    document.body.classList.add("panel-open");
    document.body.classList.toggle("comments-open", which === "comments");
  }
  function openPanel(which, focusId) {
    if (!editor) return;
    if (which === "comments") { openComments(focusId ? { cid: focusId } : null, "sel"); return; }
    if (panel === "history") { closePanel(); return; }
    commentOpenRequest++; commentSelection = null;
    showPanel("history"); loadHistory(); $("#pclose").focus({ preventScroll: true });
  }
  function closePanel(restoreFocus) {
    if (!panel) return;
    commentOpenRequest++; panel = null; commentSelection = null;
    var drawer = $("#panel"), back = panelReturnFocus; panelReturnFocus = null;
    drawer.classList.remove("show"); drawer.inert = true; drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("panel-open", "comments-open");
    if (restoreFocus !== false && back && back.isConnected) {
      back.focus({ preventScroll: true });
      if (back === frame) send({ t: "commentFocus" });
    }
  }
  function copy(text, label) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast("已复制 " + label + " Copied"); }, function () { prompt(label, text); }); }
  function shareLink() {
    return location.origin + "/a/" + B.id;
  }
  function doShare(e) {
    if (e) e.stopPropagation();
    var url = shareLink(), title = ($("#ttl") && $("#ttl").textContent) || document.title || "Artifact";
    if (navigator.share) navigator.share({ title: title, url: url }).catch(function () { copy(url, "分享链接 share link"); });
    else copy(url, "分享链接 share link");
  }
  if ($("#bMenu")) $("#bMenu").onclick = doShare;
  if ($("#bExport")) $("#bExport").onclick = function () { location.href = "/a/" + B.id + "/export"; };
  $("#bComment").onclick = function () { setMode("comment"); };
  $("#bHistory").onclick = function () { openPanel("history"); };
  $("#pclose").onclick = closePanel;
  $("#cmSend").onclick = submitComment; $("#cmCancel").onclick = function () { $("#cmModal").classList.remove("show"); };
  $("#cmReq").addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment(); });
  $("#pvClose").onclick = function () { $("#pvModal").classList.remove("show"); $("#pvFrame").srcdoc = ""; };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closePanel(); $("#cmModal").classList.remove("show"); $("#pvModal").classList.remove("show"); if (mode === "comment") setMode("edit"); hideChip(); } });
  document.addEventListener("click", function (e) { if (panel === "comments" && matchMedia("(max-width:640px)").matches && !$("#panel").contains(e.target)) closePanel(); }, true);
  window.addEventListener("resize", hideChip);

  /* ---------- init ---------- */
  if (token) {
    api("/me").then(function (d) {
      editor = true; document.body.classList.add("is-editor"); source = null; ls(TK, token);
      if (history.replaceState && ls(TK) === token) history.replaceState(null, "", "/a/" + B.id);
      mode = null; setMode("edit"); setSave("idle");
      loadComments();
    }).catch(function (e) {
      if (!urlToken) { if (e.status === 403) ls(TK, null); return; }
      toast("编辑链接无效，当前为只读 · Invalid edit link, view only", 6000);
    });
  }
})();
