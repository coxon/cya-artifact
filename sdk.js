/* artifact shared-state SDK (window.artifact). Injected into every generated page. */
(function () {
  if (window.artifact) return;
  var BOOT = window.__ARTIFACT_BOOT__ || {};
  var id = BOOT.id || (location.pathname.match(/\/a\/([A-Za-z0-9]+)/) || [])[1];
  var state = BOOT.state && typeof BOOT.state === "object" ? BOOT.state : {};
  var subs = [], presenceSubs = [], statusSubs = [];
  var ws = null, connected = false, queue = [], pending = [], presence = 1, retry = 0, readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var hb = null;
  var clientId = Math.random().toString(36).slice(2, 10);
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function emit(changes, source) {
    for (var i = 0; i < subs.length; i++) { try { subs[i](state, changes, source); } catch (e) { console.error(e); } }
  }
  function apply(changes) {
    for (var k in changes) { if (changes[k] === null) delete state[k]; else state[k] = changes[k]; }
  }
  function send(msg) {
    var s = JSON.stringify(msg);
    if (connected && ws && ws.readyState === 1) ws.send(s);
    else { queue.push(s); if (msg.changes) pending.push(msg.changes); }
  }
  var inFrame = window.parent !== window;
  function up(m) { if (!inFrame) return; m.__artifact = 1; try { window.parent.postMessage(m, "*"); } catch (e) {} }
  function setStatus(s) { up({ t: "status", s: s }); for (var i = 0; i < statusSubs.length; i++) { try { statusSubs[i](s); } catch (e) {} } }
  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    try { ws = new WebSocket(proto + location.host + "/a/" + id + "/ws"); } catch (e) { return schedule(); }
    ws.onopen = function () { retry = 0; };
    if (!hb) hb = setInterval(function () { if (ws && ws.readyState === 1) try { ws.send('{"t":"ping"}'); } catch (e) {} }, 20000);
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === "init") {
        var old = state; state = m.state || {}; connected = true; presence = m.presence || 1;
        for (var q = 0; q < pending.length; q++) apply(pending[q]); // keep local edits made while offline
        var ch = {}; var k;
        for (k in old) if (!(k in state)) ch[k] = null;
        for (k in state) if (JSON.stringify(old[k]) !== JSON.stringify(state[k])) ch[k] = state[k];
        while (queue.length) ws.send(queue.shift());
        pending = [];
        setStatus("online"); readyResolve(state);
        for (var i = 0; i < presenceSubs.length; i++) presenceSubs[i](presence);
        up({ t: "presence", n: presence });
        if (Object.keys(ch).length) emit(ch, "remote");
      } else if (m.t === "ops") {
        if (m.from === clientId) return; // already applied locally
        apply(m.changes); emit(m.changes, "remote");
      } else if (m.t === "presence") {
        presence = m.n; up({ t: "presence", n: presence }); for (var j = 0; j < presenceSubs.length; j++) presenceSubs[j](presence);
      } else if (m.t === "reload" || m.t === "version") {
        if (inFrame) up({ t: "version", v: m.v, from: m.from || null, source: m.source || null });
        else setTimeout(function () { location.reload(); }, 200);
      } else if (m.t === "comments") {
        up({ t: "comments" });
      } else if (m.t === "error") {
        console.warn("[artifact]", m.message);
        if (m.state) { state = m.state; emit({}, "remote"); }
      }
    };
    ws.onclose = function (ev) { connected = false; setStatus("offline"); console.warn("[artifact] socket closed", ev && ev.code); schedule(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function schedule() { retry = Math.min(retry + 1, 6); setTimeout(connect, 300 * Math.pow(2, retry)); }
  function commit(changes) {
    if (!Object.keys(changes).length) return;
    apply(changes); emit(changes, "local");
    send({ t: "merge", changes: changes, from: clientId });
  }
  window.artifact = {
    id: id,
    get state() { return state; },
    get presence() { return presence; },
    get connected() { return connected; },
    ready: ready,
    get: function (k, dflt) { return k in state ? clone(state[k]) : dflt; },
    set: function (k, v) { var c = {}; c[k] = v === undefined ? null : clone(v); commit(c); },
    delete: function (k) { var c = {}; c[k] = null; commit(c); },
    merge: function (obj) { var c = {}; for (var k in obj) c[k] = obj[k] === undefined ? null : clone(obj[k]); commit(c); },
    update: function (fn) {
      var draft = clone(state) || {}; var r = fn(draft); if (r && typeof r === "object") draft = r;
      var c = {}, k;
      for (k in state) if (!(k in draft)) c[k] = null;
      for (k in draft) if (JSON.stringify(draft[k]) !== JSON.stringify(state[k])) c[k] = draft[k] === undefined ? null : draft[k];
      commit(c);
    },
    subscribe: function (cb) { subs.push(cb); return function () { subs = subs.filter(function (x) { return x !== cb; }); }; },
    onPresence: function (cb) { presenceSubs.push(cb); cb(presence); return function () { presenceSubs = presenceSubs.filter(function (x) { return x !== cb; }); }; },
    onStatus: function (cb) { statusSubs.push(cb); cb(connected ? "online" : "connecting"); return function () { statusSubs = statusSubs.filter(function (x) { return x !== cb; }); }; }
  };
  if (id) connect();
})();
