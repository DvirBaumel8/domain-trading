"""One paid report job: the same pipeline as `python -m aivis order --mode paid`,
built in a temp folder and handed back only if the whole run succeeded.

No partial reports: any failure raises JobFailed and the temp folder is deleted.
No secrets or response bodies are ever put in an error message.
"""
import os
import tempfile

from . import config
from .niches import get_niche
from .order import TIERS, AnswerShortfall, CapExceeded, Order, OrderError, run_order
from . import stored
from .report_pro import render
from .roster import from_nppes

MIN_ANSWER_SHARE = 0.8     # every selected engine must deliver at least this share of its planned answers
FILES = ("report.html", "answers.json", "order-log.json")


class JobFailed(RuntimeError):
    def __init__(self, reason, spent=0.0, retryable=True):
        super().__init__(reason)
        self.spent, self.retryable = spent, retryable


def order_cap_usd():
    """Per-order cap: config default (12.00), AIVIS_ORDER_CAP_USD overrides. Invalid or <= 0 fails the job."""
    try:
        cap = float(config.order_cap_usd())
    except (ValueError, TypeError):
        cap = 0.0
    if cap <= 0:
        raise JobFailed("AIVIS_ORDER_CAP_USD is not a positive number", retryable=False)
    return cap


def check_quality(res, order, plan_calls):
    """Every selected engine must have answered enough; else raise (no report)."""
    if res.score.total_answers == 0:
        raise JobFailed("no AI answers at all")
    got = {}
    for ans, _, _ in res.records:
        got[ans.provider] = got.get(ans.provider, 0) + 1
    low = [e for e in order.engines if got.get(e, 0) < MIN_ANSWER_SHARE * plan_calls]
    if low:
        raise JobFailed("engines under-answered: " + ", ".join(low))


def build_report(order_dict, cap_usd, roster_fn=None, providers=None):
    """-> {filename: text, 'spent_usd': float}. Raises JobFailed. `providers` is for tests."""
    if order_dict.get("paid") is not True:
        raise JobFailed("order is not paid", retryable=False)
    try:
        order = Order.from_dict(order_dict)
    except (OrderError, TypeError) as e:
        raise JobFailed("invalid order: " + type(e).__name__, retryable=False) from None
    niche = get_niche(order.niche)
    names = []
    if niche.npi_taxonomy:
        city, state = [x.strip() for x in order.city.split(",")]
        try:
            names = (roster_fn or (lambda t, c, s: [e.name for e in from_nppes(t, c, s, limit=1000)]))(
                niche.npi_taxonomy, city, state)
        except Exception as e:
            raise JobFailed("roster lookup failed: " + type(e).__name__) from None
    n, r = TIERS[order.plan]
    rk = order_dict.get("_render")      # agency bundle run: brand options of the report (render keywords)
    seen = []

    def paint(x):
        seen.append(x)
        return render(x, sample=False, **rk) if rk else render(x, sample=False)
    with tempfile.TemporaryDirectory(prefix="aivis-job-") as tmp:
        try:
            res, log = run_order(order, mode="paid", cap_usd=cap_usd, roster=names, out_dir=tmp,
                                 providers=providers, render=paint)
        except AnswerShortfall as e:     # vendors answered too little: retryable, and it cost money
            raise JobFailed("engines under-answered: " + str(e)[:100], spent=e.spent,
                            retryable=e.spent < cap_usd - 1e-9) from None
        except CapExceeded as e:         # real usage passed the cap mid-run: it cost money, never retried
            raise JobFailed("spend cap exceeded: " + str(e)[:100], spent=e.spent, retryable=False) from None
        except OrderError as e:          # locked / missing keys / estimate over cap: nothing was called
            raise JobFailed("refused: " + str(e), retryable=False) from None
        except JobFailed:
            raise
        except Exception as e:
            raise JobFailed("run failed: " + type(e).__name__) from None
        spent = log.get("spent_usd", 0.0)
        try:
            check_quality(res, order, n * r)
        except JobFailed as e:
            e.spent = spent
            if spent >= cap_usd - 1e-9:
                e.retryable = False
            raise
        out = {"spent_usd": spent}
        if rk and seen:         # kept so a re-brand can re-render without any new engine call
            out["result.json"] = stored.dumps(stored.to_dict(seen[-1], rk.get("date") or ""))
        folder = os.path.join(tmp, order.order_id)
        for name in FILES:
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                out[name] = fh.read()
        return out
