(function(){
  var K = "aivis_ref", OK = /^[A-Za-z0-9._-]{1,32}$/;
  function clean(v){ if (typeof v !== "string") return ""; v = v.trim(); return OK.test(v) ? v.toLowerCase() : ""; }
  var ref = "";
  try { ref = clean(sessionStorage.getItem(K)); } catch (e) {}
  if (!ref) {
    try { ref = clean(new URLSearchParams(location.search).get("ref")); } catch (e) {}
    if (ref) { try { sessionStorage.setItem(K, ref); } catch (e) {} }
  }
  if (!ref) return;
  function internal(h){
    if (!h || h.charAt(0) === "#" || h.indexOf("//") === 0 || h.indexOf("polar.sh") >= 0) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return false;            // http:, https:, mailto:, tel:, javascript:
    var p = h.split("#")[0].split("?")[0];
    if (/^\/(api|r|status|free)\//.test(p)) return false;
    var last = p.split("/").pop();
    return !last || /\.html$/i.test(last) || last.indexOf(".") < 0;
  }
  function tag(){
    document.querySelectorAll("a[href]").forEach(function(a){
      var h = a.getAttribute("href");
      if (a.hasAttribute("data-pay") || !internal(h) || /[?&]ref=/.test(h)) return;
      var i = h.indexOf("#"), base = i < 0 ? h : h.slice(0, i), hash = i < 0 ? "" : h.slice(i);
      a.setAttribute("href", base + (base.indexOf("?") < 0 ? "?" : "&") + "ref=" + ref + hash);
    });
    ["checkform", "intake"].forEach(function(id){
      var f = document.getElementById(id);
      if (f && !f.querySelector("input[name=ref]")) {
        var i = document.createElement("input"); i.type = "hidden"; i.name = "ref"; i.value = ref; f.appendChild(i);
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tag); else tag();
})();
