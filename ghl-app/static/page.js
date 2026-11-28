(function () {
  var app = document.getElementById("app"), ctx = null;
  function post(path, body) {
    body.context = ctx;
    return fetch(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  }
  function say(t) { var s = document.getElementById("status"); if (s) s.textContent = t; }
  function load() {
    post("/page/view", {}).then(function (r) { return r.text(); }).then(function (h) { app.innerHTML = h; bind(); });
  }
  function bind() {
    var save = document.getElementById("save"), run = document.getElementById("run");
    if (!save) return;
    save.onclick = function () {
      var lines = document.getElementById("prompts").value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
      if (lines.length > 10) { say("At most 10 prompts."); return; }
      post("/page/prompts", {prompts: lines}).then(function (r) { return r.json(); })
        .then(function (j) { say(j.error ? j.error.message : "Saved."); });
    };
    run.onclick = function () {
      post("/page/run", {}).then(function (r) { return r.json(); })
        .then(function (j) { say(j.error ? j.error.message : "Run requested."); });
    };
  }
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.message === "REQUEST_USER_DATA_RESPONSE" && d.payload) { ctx = d.payload; load(); }
  });
  if (window.parent !== window) window.parent.postMessage({message: "REQUEST_USER_DATA"}, "*");
})();
