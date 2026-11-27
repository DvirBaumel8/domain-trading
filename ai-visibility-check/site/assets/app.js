(function(){
  const C = window.AIVIS_CONFIG || {};
  function wirePay(root){
    (root || document).querySelectorAll("[data-pay]").forEach(a => {
      if (a.dataset.payReady) return;
      a.dataset.payReady = "1";
      const link = C[a.dataset.pay];
      if (link) {
        a.href = link;
      } else {
        const email = C.contactEmail || "";
        a.textContent = "Contact us — coming soon";
        if (email) {
          a.href = "mailto:" + email + "?subject=" + encodeURIComponent("Coming soon");
        } else {
          a.href = "#";
          a.addEventListener("click", e => { e.preventDefault();
            alert("This is coming soon. Please contact us."); });
        }
      }
    });
  }
  wirePay(document);
  const f = document.getElementById("checkform"); if (!f) return;
  const out = document.getElementById("result");
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries());
    out.className = "result show card"; out.innerHTML = "Checking…";
    try {
      const r = await fetch((C.apiBase || "") + "/api/check", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
      const j = await r.json();
      if (r.status === 503) { out.innerHTML = "<b>" + esc(j.error || "The free check is temporarily unavailable. Please try again later.") + "</b>"; return; }
      if (!r.ok) throw new Error(j.error || "error");
      out.innerHTML = render(j, data);
      wirePay(out);
    } catch (err) {
      out.innerHTML = "<b>Preview mode.</b> The free check is not connected on this copy of the site. " +
        "Nothing was sent. <span class='small'>(" + (err.message || err) + ")</span>";
    }
  });
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function namesHtml(n){
    if (!n) return "";
    let h = `<h4 style="margin:14px 0 4px">${esc(n.heading)}</h4>`;
    if (n.based_on) h += `<p class="small">${esc(n.based_on)}</p>`;
    if (n.answers) h += `<p class="small">Your business: ${n.named_in ? (n.answers === 1 ? "named in the AI's list" : "named in " + n.named_in + " of " + n.answers + " answers") : "not named"}.</p>`;
    if (n.names && n.names.length) {
      h += "<ul class='small' style='margin:4px 0 4px 18px'>" + n.names.map(x =>
        `<li>${esc(x.name)} — ${n.answers > 1 ? x.answers + " of " + n.answers + " answers" : "named by the AI"}${x.match ? " (" + esc(x.match) + ")" : ""}</li>`).join("") + "</ul>";
    } else { h += `<p class="small">${esc(n.empty_note || "The AI did not name any businesses in its answers.")}</p>`; }
    return h + `<p class="small">${esc(n.register_note || "")}</p>`;
  }
  // Live only: the visitor who asked sees these once. Search Suggestions are Google's snippet, passed through
  // unmodified inside a sandboxed frame (its own CSS stays inside; a tap opens the Google results page in a new tab).
  function liveHtml(j){
    let h = "";
    if (j.citations && j.citations.length) {
      h += "<h4 style='margin:14px 0 4px'>Sources the AI searched (AI output, not verified)</h4><ul class='small' style='margin:4px 0 4px 18px'>" +
        j.citations.filter(c => /^https?:\/\//i.test(c.url || "")).map(c =>
          `<li><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.url)}</a></li>`).join("") + "</ul>";
    }
    if (j.suggestions && j.suggestions.length) { h += "<div class='search-suggestions' data-n='" + j.suggestions.length + "'></div>"; }
    return h;
  }
  function mountSuggestions(j, root){
    const box = root.querySelector(".search-suggestions"); if (!box || !j.suggestions) return;
    j.suggestions.forEach(sug => {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
      f.setAttribute("title", "Search suggestions");
      f.style.cssText = "width:100%;border:0;height:96px;display:block";
      f.srcdoc = '<base target="_blank">' + sug;
      box.appendChild(f);
    });
  }
  function render(j, d){
    if (j.status === "instant") {
      return `<h3 style="margin-top:0">${esc(d.business)}: named in <span style="color:${j.named_in? '#059669':'#b91c1c'}">${j.named_in} of ${j.answers}</span> AI answers</h3>
      <p>In our latest free test for <b>${esc(j.niche_label)} in ${esc(j.city)}</b>, AI named <b>${j.competitors}</b> other local businesses.
      ${j.unverified_pct}% of the names it gave did not match the official register.</p>
      ${namesHtml(j.names)}
      <p class="small">Free quick check: ${esc(j.source_note)} The full $149 report asks the major AI assistants many more questions, several times, and lists every competitor and fix.</p>
      <a class="btn" data-pay="payLinkCheck" href="#pricing">Get the full report — $149</a>`;
    }
    if (j.status === "queued") {
      return `<h3 style="margin-top:0">Got it — your free check is running</h3><p>We are asking an AI model which businesses customers are given for ${esc(j.niche_label)} in ${esc(d.city)}. This page updates when it finishes (about ${j.eta_min} minutes).</p><div id="poll" data-id="${esc(j.id)}"></div>`;
    }
    return `<h3 style="margin-top:0">Thanks — request saved</h3><p>We don't have ${esc(d.city)} data yet. We saved your request.</p>`;
  }
  new MutationObserver(() => {
    const p = document.getElementById("poll"); if (!p || p.dataset.on) return; p.dataset.on = 1;
    const started = Date.now();
    const stop = (t, html) => { clearInterval(t); p.innerHTML = html; };
    const t = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) { return stop(t, "<p>This is taking longer than expected. Please try again in a few minutes.</p>"); }
      try { const r = await fetch((C.apiBase||"") + "/api/check/" + p.dataset.id); const j = await r.json();
        if (j.status === "done") { stop(t, `<p><b>Done.</b> ${j.answers === 1 ? (j.named_in ? "Your business was named in the AI's list." : "Your business was not named in the AI's list.") : "Named in " + j.named_in + " of " + j.answers + " answers."} <a href="${esc(j.report)}" target="_blank">Open your free result</a></p>${namesHtml(j.names)}${liveHtml(j)}`); mountSuggestions(j, p); }
        if (j.status === "partial") { stop(t, `<p><b>${esc(j.message)}</b> This is not a reliable check, so we are not showing a score. <a href="${esc(j.report)}" target="_blank">Open the partial result</a></p>${namesHtml(j.names)}${liveHtml(j)}`); mountSuggestions(j, p); }
        if (j.status === "failed") { stop(t, `<p>${esc(j.message || "We could not get answers from the AI model right now. Please try again in a few minutes.")} We saved your request.</p>`); }
        if (j.status === "unavailable") { stop(t, `<p><b>${esc(j.message || "The free check is temporarily unavailable. Please try again later.")}</b></p>`); }
        if (j.status === "unknown") { stop(t, "<p>This check expired. Please run it again.</p>"); }
      } catch(e) {}
    }, 5000);
  }).observe(out, {childList: true, subtree: true});
})();
