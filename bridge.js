/* Host<->artifact bridge. Inert unless the host page (parent) sends commands. Never saves the DOM:
   it only reports text edits (orig -> now) and element picks; the host applies them to the stored source. */
(function () {
  if (window.parent === window || window.__AE_BRIDGE__) return;
  window.__AE_BRIDGE__ = 1;
  var P = window.parent, mode = null, orig = new WeakMap(), dirty = new Set(), nodeKey = new WeakMap(), keys = new Map(), nextKey = 1, sent = {};
  var editables = [], root = null, sh = null, hl = null, pinsBox = null, pins = [], styleEl = null, allowed = null;
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|TITLE|SVG|SELECT|OPTION|CODE|PRE)$/;
  // answer signature chips (.by) open their comment; keep them clickable, never editable
  (function () { var st = document.createElement("style"); st.setAttribute("data-artifact-by", ""); st.textContent = ".by{cursor:pointer}.by:hover{filter:brightness(.96)}"; (document.head || document.documentElement).appendChild(st); })();
  function post(m) { m.__ae_ev = 1; try { P.postMessage(m, "*"); } catch (e) {} }
  function ok(n) { for (var p = n.parentNode; p && p !== document; p = p.parentNode) { if (p === root) return false; if (p.nodeType === 1 && SKIP.test(p.tagName.toUpperCase())) return false; } return true; }
  function textNodes() { var out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n; while ((n = w.nextNode())) { if (n.nodeValue.trim() && ok(n)) out.push(n); } return out; }
  function ensureRoot() {
    if (root) return;
    root = document.createElement("artifact-overlay");
    root.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none";
    sh = root.attachShadow({ mode: "closed" });
    sh.innerHTML = '<style>#hl{box-sizing:border-box;position:absolute;border:2px solid #f5a524;background:rgba(245,165,36,.12);border-radius:4px;display:none;pointer-events:none;transition:all .06s}' +
      '#fl{box-sizing:border-box;position:absolute;border:3px solid #d97757;background:rgba(217,119,87,.14);border-radius:6px;display:none;pointer-events:none;transition:opacity .5s}' +
      '.pin{position:absolute;width:24px;height:24px;border-radius:12px 12px 12px 2px;background:#f5a524;color:#111;font:700 12px/24px system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer}</style><div id="hl"></div><div id="fl"></div><div id="pins"></div>';
    hl = sh.getElementById("hl"); pinsBox = sh.getElementById("pins");
    document.documentElement.appendChild(root);
  }
  function setStyle(css) { if (!styleEl) { styleEl = document.createElement("style"); styleEl.setAttribute("data-artifact-editor", ""); document.head.appendChild(styleEl); } styleEl.textContent = css; }
  /* Editing is always on for editors: static text (present in the stored source) becomes editable in place;
     the app's own controls (links, buttons, inputs, anything clickable) keep working normally. */
  var INTERACTIVE = 'a,button,input,textarea,select,option,label,summary,details>summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option],[onclick],[draggable=true]';
  var locked = new Map(), mo = null, moT = 0;
  function lock(el) {
    if (!locked.has(el)) locked.set(el, el.getAttribute("contenteditable"));
    el.setAttribute("contenteditable", "false");
  }
  function clickable(el) {
    if (el.closest(INTERACTIVE)) return true;
    for (var x = el; x && x !== document.body && x.nodeType === 1; x = x.parentElement) { try { if (getComputedStyle(x).cursor === "pointer" && !x.hasAttribute("data-ae-ed")) return true; } catch (e) {} }
    return false;
  }
  function scan() {
    // Lock standalone, newly inserted, and explicitly editable signatures as well as nested children.
    document.querySelectorAll(".by,.by [contenteditable]").forEach(lock);
    textNodes().forEach(function (t) {
      if (!orig.has(t)) orig.set(t, t.nodeValue);
      if (allowed && !allowed.has(t.nodeValue)) return; // dynamic text (rendered by the app), not in the source
      var el = t.parentNode;
      if (el.nodeType !== 1 || el.isContentEditable || el.hasAttribute("contenteditable") || el.closest("[data-ae-app]") || el.closest(".by") || clickable(el)) return;
      try { el.contentEditable = "true"; } catch (e) {} if (!el.isContentEditable) { try { el.contentEditable = "plaintext-only"; } catch (e2) {} }
      el.setAttribute("data-ae-ed", ""); el.spellcheck = false; editables.push(el);
      el.querySelectorAll(INTERACTIVE + ",.by").forEach(function (c) { if (!c.hasAttribute("contenteditable")) lock(c); });
    });
  }
  function editOn() {
    orig = new WeakMap(); dirty.clear(); scan();
    setStyle('[data-ae-ed]{cursor:text;-webkit-user-select:text;user-select:text;caret-color:currentColor;outline:none!important;box-shadow:none!important;background:transparent!important;border-radius:0}[data-ae-ed]:hover,[data-ae-ed]:focus{outline:none!important;box-shadow:none!important;background:transparent!important}[data-ae-ed] [contenteditable=false]{cursor:pointer;-webkit-user-select:none;user-select:none}');
    if (!mo && window.MutationObserver) mo = new MutationObserver(function (ms) {
      // text the app itself rewrites (counters, live values) is app-owned: stop offering it for typing
      ms.forEach(function (m) {
        var t = m.target.nodeType === 1 ? m.target : m.target.parentElement, el = t && t.closest && t.closest("[data-ae-ed]");
        if (el && !(el === document.activeElement && Date.now() - lastInput < 1500)) { el.removeAttribute("contenteditable"); el.removeAttribute("data-ae-ed"); el.setAttribute("data-ae-app", ""); editables.splice(editables.indexOf(el) >>> 0, 1); }
      });
      clearTimeout(moT); moT = setTimeout(function () { if (mode === "edit") scan(); }, 400);
    });
    if (mo) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function editOff() {
    if (mo) mo.disconnect();
    editables.forEach(function (el) { el.removeAttribute("contenteditable"); el.removeAttribute("data-ae-ed"); }); editables = [];
    locked.forEach(function (value, el) { if (value === null) el.removeAttribute("contenteditable"); else el.setAttribute("contenteditable", value); }); locked.clear();
    if (document.activeElement && document.activeElement.isContentEditable && document.activeElement.blur) document.activeElement.blur();
  }
  function rectOf(r) { return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function info(el, text, r) { return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: (text || el.innerText || el.textContent || "").trim().slice(0, 400), html: el.outerHTML.slice(0, 1500), rect: rectOf(r || el.getBoundingClientRect()) }; }
  function ownText(el) { for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) return true; return false; }
  var selT = 0, selShown = false;
  function onSel() {
    if (mode !== "edit") return;
    var s = getSelection(), txt = s && s.rangeCount && !s.isCollapsed ? s.toString().trim() : "";
    if (!txt) { if (selShown) { selShown = false; post({ t: "sel", none: true }); } return; }
    var rg = s.getRangeAt(0), el = rg.commonAncestorContainer; if (el.nodeType !== 1) el = el.parentElement; if (!el || (root && root.contains(el)) || el.closest(".by")) return;
    var r = rg.getBoundingClientRect(); if (!r.width && !r.height) return;
    selShown = true; var m = info(el, txt, r); m.t = "sel"; post(m);
  }
  document.addEventListener("selectionchange", function () { clearTimeout(selT); selT = setTimeout(onSel, 220); });
  function markDirty(target) {
    var el = target && target.nodeType === 3 ? target.parentNode : target; if (!el || !el.isContentEditable) return;
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n; while ((n = w.nextNode())) if (orig.has(n)) dirty.add(n);
    post({ t: "dirty" });
  }
  function collect() {
    var edits = [], all = null;
    dirty.forEach(function (n) {
      var o = orig.get(n);
      if (!n.isConnected || n.nodeValue === o) { dirty.delete(n); return; }
      if (!all) all = textNodes();
      var occ = 0; for (var i = 0; i < all.length && all[i] !== n; i++) if (orig.get(all[i]) === o) occ++;
      var k = nodeKey.get(n); if (!k) { k = nextKey++; nodeKey.set(n, k); keys.set(k, n); }
      sent[k] = n.nodeValue; edits.push({ key: k, orig: o, now: n.nodeValue, occ: occ });
    });
    post({ t: "edits", edits: edits });
  }
  function selectorOf(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) { parts.unshift("#" + el.id); return parts.join(" > "); }
      var i = 1, s = el; while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + i + ")"); el = el.parentElement;
    }
    parts.unshift("body"); return parts.join(" > ");
  }
  function box(el, node) {
    var r = el.getBoundingClientRect(), left = Math.max(0, r.left + scrollX - 3), right = Math.min(scrollX + document.documentElement.clientWidth, r.right + scrollX + 3);
    node.style.left = left + "px"; node.style.top = Math.max(0, r.top + scrollY - 3) + "px";
    node.style.width = Math.max(0, right - left) + "px"; node.style.height = (r.height + 6) + "px"; return r;
  }
  function renderPins() {
    if (!pinsBox) return; pinsBox.innerHTML = "";
    pins.forEach(function (p) {
      var el = findSel(p);
      if (!el) return; var r = el.getBoundingClientRect(); if (!r.width && !r.height) return;
      var d = document.createElement("div"); d.className = "pin"; d.textContent = p.n; d.title = p.request || "";
      d.style.left = Math.max(2, Math.min(r.right + scrollX - 14, scrollX + document.documentElement.clientWidth - 26)) + "px"; d.style.top = Math.max(2, r.top + scrollY - 12) + "px";
      d.onclick = function (e) { e.stopPropagation(); post({ t: "pin", id: p.id }); };
      pinsBox.appendChild(d);
    });
  }
  function setMode(m) {
    if (mode === "edit" && m !== "edit") editOff();
    mode = m; ensureRoot(); hl.style.display = "none";
    if (m === "edit") editOn();
    else if (m === "comment") setStyle("*{cursor:crosshair!important}");
    else if (styleEl) { styleEl.remove(); styleEl = null; }
  }
  var lastInput = 0;
  document.addEventListener("beforeinput", function () { lastInput = Date.now(); }, true);
  document.addEventListener("keydown", function () { lastInput = Date.now(); }, true);
  document.addEventListener("input", function (e) { lastInput = Date.now(); if (mode === "edit") markDirty(e.target); }, true);
  document.addEventListener("keydown", function (e) { if (mode === "edit" && e.key === "Enter" && e.target.isContentEditable && e.target.closest("[data-ae-ed]")) e.preventDefault(); }, true);
  document.addEventListener("click", function (e) {
    var by = e.target && e.target.closest && e.target.closest(".by");
    if (by && mode !== "comment" && !(root && e.composedPath && e.composedPath().indexOf(root) >= 0)) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      post({ t: "by", cid: (by.getAttribute("data-cid") || "").trim() || null, text: (by.textContent || "").trim().slice(0, 200), rect: rectOf(by.getBoundingClientRect()) });
      return;
    }
    if (!mode || (root && e.composedPath && e.composedPath().indexOf(root) >= 0)) return;
    var el = e.target.nodeType === 1 ? e.target : e.target.parentElement; if (!el) return;
    if (mode === "edit") return; // app controls work normally
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (mode === "comment") { var p = info(el); p.t = "pick"; post(p); }
  }, true);
  // a tap on app-generated text offers a comment action (pointer events: iOS sends no click for plain text)
  var pd = null;
  document.addEventListener("pointerdown", function (e) { pd = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
  document.addEventListener("pointerup", function (e) {
    if (mode !== "edit" || !pd || Math.abs(e.clientX - pd.x) > 8 || Math.abs(e.clientY - pd.y) > 8 || Date.now() - pd.t > 700) return;
    var el = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    if (!el || (root && root.contains(el)) || /^(HTML|BODY)$/.test(el.tagName) || el.closest(".by")) return;
    // Focusing the editable ancestor here collapses drag/touch selections in some browsers.
    var selection = getSelection();
    if (selection && !selection.isCollapsed) { onSel(); return; }
    var ed = el.closest && el.closest("[data-ae-ed]");
    if (ed && ed.isContentEditable) {
      if (document.activeElement === ed) return;
      try { ed.focus({ preventScroll: true }); } catch (err) { try { ed.focus(); } catch (e2) {} }
      return;
    }
    if (!el || el.isContentEditable || !ownText(el) || clickable(el)) return;
    setTimeout(function () { var s = getSelection(); if (mode === "edit" && el.isConnected && (!s || s.isCollapsed)) { var m = info(el); m.t = "noedit"; post(m); } }, 30);
  }, true);
  ["submit", "dblclick"].forEach(function (ev) { document.addEventListener(ev, function (e) { if (mode === "comment") { e.preventDefault(); e.stopPropagation(); } }, true); });
  document.addEventListener("mousemove", function (e) {
    if (mode !== "comment" || !hl) return; var el = e.target; if (!el || el.nodeType !== 1 || el === root) return;
    hl.style.display = "block"; box(el, hl);
  }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") post({ t: "escape" }); }, true);
  var st = 0; document.addEventListener("scroll", function () {
    if (flashTarget && flashTarget.isConnected) box(flashTarget, sh.getElementById("fl"));
    clearTimeout(st); st = setTimeout(function () { post({ t: "scroll", y: scrollY }); }, 150);
  }, { passive: true, capture: true });
  addEventListener("resize", function () { renderPins(); if (flashTarget && flashTarget.isConnected) box(flashTarget, sh.getElementById("fl")); });
  setInterval(function () { if (pins.length) renderPins(); }, 2000);
  addEventListener("message", function (e) {
    if (e.source !== P) return; var m = e.data || {}; if (!m.__ae) return;
    if (m.t === "mode") { allowed = m.texts ? new Set(m.texts) : null; setMode(m.mode || null); }
    else if (m.t === "collect") collect();
    else if (m.t === "committed") (m.keys || []).forEach(function (k) { var n = keys.get(k); if (!n) return; orig.set(n, sent[k]); if (n.nodeValue === sent[k]) dirty.delete(n); });
    else if (m.t === "revert") (m.keys || []).forEach(function (k) { var n = keys.get(k); if (!n) return; n.nodeValue = orig.get(n); dirty.delete(n); });
    else if (m.t === "pins") { pins = m.pins || []; ensureRoot(); renderPins(); }
    else if (m.t === "scroll") scrollTo(0, m.y || 0);
    else if (m.t === "locate") locate(m);
    else if (m.t === "print") print();
  });
  /* jump to a comment's place: "sel" = the commented element (selector, else its text), "chip" = the answer's signature chip */
  function norm(t) { return String(t || "").replace(/\s+/g, "").replace(/[。，、；：！？.,;:!?]+$/, ""); }
  function commentNumber(text) {
    var matches = String(text || "").matchAll(/评论\s*([0-9]+)(?=$|\s|[·•|｜,，:：;；。!?！？)\]】）])/g), first = matches.next();
    if (first.done || !matches.next().done) return null;
    var n = Number(first.value[1]); return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  function visible(el) { var r = el.getBoundingClientRect(); return !!(r.width && r.height) && getComputedStyle(el).visibility !== "hidden"; }
  function findChip(m) {
    var all = document.querySelectorAll(".by"), i, n = Number(m.n);
    if (m.cid) for (i = 0; i < all.length; i++) if ((all[i].getAttribute("data-cid") || "").trim() === m.cid && visible(all[i])) return all[i];
    if (Number.isSafeInteger(n) && n > 0) for (i = 0; i < all.length; i++) {
      if (!(all[i].getAttribute("data-cid") || "").trim() && commentNumber(all[i].textContent) === n && visible(all[i])) return all[i];
    }
    return null;
  }
  function findSel(m) {
    var el = null, want = norm(m.text).slice(0, 24);
    try { el = m.selector ? document.querySelector(m.selector) : null; } catch (e) {}
    if (el && (!visible(el) || el.closest(".by") || (want && norm(el.textContent).indexOf(want) < 0))) el = null;
    // Rewritten markup can split the selected text across nested spans. Find the smallest visible match.
    if (!el && want) {
      var seen = new Set(), bestLength = Infinity;
      textNodes().forEach(function (t) {
        for (var p = t.parentElement; p && p !== document.body && !seen.has(p); p = p.parentElement) {
          seen.add(p);
          if (p.closest(".by")) continue;
          var text = norm(p.textContent);
          if (text.length < bestLength && text.indexOf(want) >= 0 && visible(p)) { el = p; bestLength = text.length; }
        }
      });
    }
    return el;
  }
  function blockOf(el) { return (el.closest && el.closest("p,li,td,th,blockquote,h1,h2,h3,h4,figure,section")) || el; }
  var flT = 0, flStartT = 0, flashTarget = null;
  function locate(m) {
    var chip = null, el = m.prefer === "sel" ? findSel(m) : ((chip = findChip(m)) && blockOf(chip));
    if (!el) el = m.prefer === "sel" ? ((chip = findChip(m)) && blockOf(chip)) : findSel(m);
    clearTimeout(flT); clearTimeout(flStartT); flashTarget = null;
    if (sh) sh.getElementById("fl").style.display = "none";
    if (!el) { post({ t: "located", ok: false }); return; }
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { el.scrollIntoView(); }
    ensureRoot(); var fl = sh.getElementById("fl");
    flStartT = setTimeout(function () {
      if (!el.isConnected || !visible(el)) return;
      flashTarget = el; box(el, fl); fl.style.opacity = "1"; fl.style.display = "block";
      flT = setTimeout(function () { fl.style.opacity = "0"; flT = setTimeout(function () { fl.style.display = "none"; flashTarget = null; }, 500); }, 2200);
    }, 450);
    post({ t: "located", ok: true });
  }
  function ready() { post({ t: "ready" }); }
  if (document.readyState === "complete") ready(); else addEventListener("load", ready);
})();
