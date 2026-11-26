import json, os, re, sys, io, contextlib, urllib.request, urllib.error, traceback, html as H
sys.dont_write_bytecode = True
OUT = "/workspace/company/avc-mock-run"; sys.path.insert(0, OUT); sys.path.insert(0, "/workspace/dt/ai-visibility-check/engine")
import fake_apis
from aivis.order import Order, run_order, build_providers, OrderError
from aivis.report_pro import render
fake_apis.POOLS["cur"] = ["Columbus Plumbing Pros", "Buckeye Drain & Rooter", "Olentangy Plumbing Co", "Capital City Plumbing", "Grandview Pipe Works"]
for k in ("OPENAI_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"): os.environ[k] = "FAKE-LOCAL-MOCK-KEY"
os.environ["AIVIS_ALLOW_PAID"] = "1"
res_all = {}
def text(p):
    t = open(p, encoding="utf-8").read(); t = re.sub(r"<style>.*?</style>", "", t, flags=re.S); t = re.sub(r"<[^>]+>", " ", t); return H.unescape(re.sub(r"\s+", " ", t))
def go(name, order, fail=None, env_patch=None, cap=8.0, roster=None, patch_open=True):
    fake_apis.TARGET["name"] = order.business_name
    def op(req, timeout=None, *a, **k):
        host = urllib.parse.urlsplit(req.full_url).netloc if hasattr(req, "full_url") else ""
        if fail and host in fail:
            code = fail[host]
            if code == "garbage": 
                import io as _io
                class R(_io.BytesIO):
                    def __enter__(s): return s
                    def __exit__(s,*a): return False
                return R(b"<html>gateway</html>")
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)
        return fake_apis.fake_urlopen(req, timeout, *a, **k)
    urllib.request.urlopen = op
    saved = dict(os.environ)
    for k, v in (env_patch or {}).items():
        os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
    r = {"case": name}
    try:
        res, log = run_order(order, mode="paid", cap_usd=cap, roster=roster or [], out_dir=OUT + "/failcases",
                             render=lambda x: render(x, sample=False))
        r.update(outcome="report produced", answers=log["answers"], errors=log["errors"], spent=log["spent_usd"], score=log["score"],
                 engines_in_report=sorted({p.provider for p in res.score.providers}),
                 first_errors=res.errors[:2] if res else [])
        r["text_has_nan"] = bool(re.search(r"\bnan\b|None|\{|\}|undefined|TODO|placeholder", text(f"{OUT}/failcases/{order.order_id}/report.html")))
        r["report_len"] = len(text(f"{OUT}/failcases/{order.order_id}/report.html"))
    except OrderError as e: r.update(outcome="refused", msg=str(e))
    except Exception as e: r.update(outcome="CRASH", err=traceback.format_exc()[-700:])
    os.environ.clear(); os.environ.update(saved); urllib.request.urlopen = fake_apis.REAL_URLOPEN
    res_all[name] = r; print(json.dumps(r, indent=1)[:900], flush=True)
O = lambda oid, **k: Order(**{**dict(order_id=oid, business_name="DrainMaster", city="Columbus, OH", niche="plumber", plan="check", paid_ref="x", paid=True), **k})
go("A_no_scheme_website", O("F-A", website="drainmasterohio.com"))
go("B_openai_always_401", O("F-B"), fail={"api.openai.com": 401})
go("C_all_vendors_down", O("F-C"), fail={"api.openai.com": 500, "api.perplexity.ai": 500, "generativelanguage.googleapis.com": 429, "api.anthropic.com": 529})
go("D_gemini_garbage_json", O("F-D"), fail={"generativelanguage.googleapis.com": "garbage"})
go("E_allow_paid_unset", O("F-E"), env_patch={"AIVIS_ALLOW_PAID": None})
go("F_missing_anthropic_key", O("F-F"), env_patch={"ANTHROPIC_API_KEY": None})
go("G_cap_too_low", O("F-G"), cap=3.0)
go("H_unpaid_order_flag", O("F-H", paid_ref="", paid=False))   # CLI never reads 'paid'
go("I_html_in_name", O("F-I", business_name="Smith & Sons <b>Plumbing</b> \"Pros\""))
go("J_no_competitors_plumber", O("F-J"))
go("K_competitor_same_as_target_case", O("F-K", competitors=["drainmaster", "DRAINMASTER LLC"]))
json.dump(res_all, open(OUT + "/failure-cases.json", "w"), indent=1)
