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
      if (!r.ok) throw new Error(j.error || "error");
      out.innerHTML = render(j, data);
      wirePay(out);
    } catch (err) {
      out.innerHTML = "<b>Preview mode.</b> The free check is not connected on this copy of the site. " +
        "Nothing was sent. <span class='small'>(" + (err.message || err) + ")</span>";
    }
  });
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function render(j, d){
    if (j.status === "instant") {
      return `<h3 style="margin-top:0">${esc(d.business)}: named in <span style="color:${j.named_in? '#059669':'#b91c1c'}">${j.named_in} of ${j.answers}</span> AI answers</h3>
      <p>In our latest free test for <b>${esc(j.niche_label)} in ${esc(j.city)}</b>, AI named <b>${j.competitors}</b> other local businesses.
      ${j.unverified_pct}% of the names it gave did not match the official register.</p>
      <p class="small">Free quick check: ${esc(j.source_note)} The full $149 report asks the major AI assistants many more questions, several times, and lists every competitor and fix.</p>
      <a class="btn" data-pay="payLinkCheck" href="#pricing">Get the full report — $149</a>`;
    }
    if (j.status === "queued") {
      return `<h3 style="margin-top:0">Got it — your free check is running</h3><p>We are asking an AI model ${j.prompts} questions customers ask about ${esc(j.niche_label)} in ${esc(d.city)}. This page updates when it finishes (about ${j.eta_min} minutes).</p><div id="poll" data-id="${esc(j.id)}"></div>`;
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
        if (j.status === "done") { stop(t, `<p><b>Done.</b> Named in ${j.named_in} of ${j.answers} answers. <a href="${j.report}" target="_blank">Open your free result</a></p>`); }
        if (j.status === "failed") { stop(t, "<p>Sorry, the free model didn't answer. We saved your request.</p>"); }
        if (j.status === "unknown") { stop(t, "<p>This check expired. Please run it again.</p>"); }
      } catch(e) {}
    }, 5000);
  }).observe(out, {childList: true, subtree: true});
})();
