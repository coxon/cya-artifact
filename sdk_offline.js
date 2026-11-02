/* Offline artifact SDK: same API as window.artifact, in-memory only (used for exports and history previews). */
(function () {
  if (window.artifact) return;
  var BOOT = window.__ARTIFACT_BOOT__ || {}, state = BOOT.state || {}, subs = [];
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function commit(c) { for (var k in c) { if (c[k] === null) delete state[k]; else state[k] = c[k]; } for (var i = 0; i < subs.length; i++) { try { subs[i](state, c, "local"); } catch (e) { console.error(e); } } }
  window.artifact = {
    id: BOOT.id, offline: true, get state() { return state; }, presence: 1, connected: false, ready: Promise.resolve(state),
    get: function (k, d) { return k in state ? clone(state[k]) : d; },
    set: function (k, v) { var c = {}; c[k] = v === undefined ? null : clone(v); commit(c); },
    delete: function (k) { var c = {}; c[k] = null; commit(c); },
    merge: function (o) { var c = {}; for (var k in o) c[k] = o[k] === undefined ? null : clone(o[k]); commit(c); },
    update: function (fn) { var d = clone(state) || {}, r = fn(d); if (r && typeof r === "object") d = r; var c = {}, k;
      for (k in state) if (!(k in d)) c[k] = null; for (k in d) if (JSON.stringify(d[k]) !== JSON.stringify(state[k])) c[k] = d[k] === undefined ? null : d[k]; if (Object.keys(c).length) commit(c); },
    subscribe: function (cb) { subs.push(cb); return function () { subs = subs.filter(function (x) { return x !== cb; }); }; },
    onPresence: function (cb) { cb(1); return function () {}; },
    onStatus: function (cb) { cb("offline"); return function () {}; }
  };
})();
