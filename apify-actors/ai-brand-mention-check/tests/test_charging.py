"""A14-A16: one `result` charge per ok row, the pre-run cap, the charge limit."""
import pathlib
import re
from decimal import Decimal

import httpx

from helpers import Fake, drive, inp
from src.runner import Pricing

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


def test_a14_n_ok_rows_n_charges_error_rows_none():
    fake = Fake()
    fake.behave["gemini"] = lambda n, req: httpx.Response(400, json={"error": "bad"})
    res = drive(inp(promptCount=2), fake)
    ok = [r for r in res.rows if r["status"] == "ok"]
    assert len(ok) == 4 and len(res.charged) == 4 and all(r["status"] == "ok" for r in res.charged)
    assert len(res.uncharged) == 2 and all(r["status"] == "error" for r in res.uncharged)


def test_a14_one_charged_push_data_in_the_source():
    main = (SRC / "main.py").read_text()
    assert len(re.findall(r"charged_event_name=", main)) == 1 and "charged_event_name='result'" in main
    for p in SRC.glob("*.py"):
        assert "charged_event_name" not in p.read_text() or p.name == "main.py"
        assert "ApifyClient" not in p.read_text()


def test_a15_pre_run_cap_fails_before_any_provider_call():
    pricing = Pricing(result_usd=Decimal("0.5"), start_usd=Decimal("0.1"), max_total_usd=Decimal("4"))
    res = drive(inp(promptCount=3), Fake(), pricing=pricing)  # 9 rows x 0.5 + 0.1 = 4.6 > 4
    assert res.ok is False and res.fake.calls == [] and res.pushes == []
    assert "4.6" in res.msg and "4" in res.msg.replace("4.6", "")
    ok = drive(inp(promptCount=3), Fake(), pricing=Pricing(Decimal("0.5"), Decimal("0.1"), Decimal("4.6")))
    assert ok.ok is True


def test_a15_cap_from_environment(monkeypatch):
    monkeypatch.setenv("ACTOR_MAX_TOTAL_CHARGE_USD", "1")
    res = drive(inp(promptCount=2), Fake(), pricing=Pricing(result_usd=Decimal("0.3")))
    assert res.ok is False and res.fake.calls == []


def test_a15_no_dollar_digit_literal_in_source():
    for p in SRC.glob("*.py"):
        assert not re.search(r"(?<!\\)\$\s?\d", p.read_text()), p


def test_a16_charge_limit_stops_the_run_and_marks_unrun_rows():
    fake = Fake()
    res = drive(inp(promptCount=8, engines=["chatgpt"]), fake, limit_after=1)
    assert len(res.charged) == 1
    codes = [r["errorCode"] for r in res.rows if r["status"] == "error"]
    assert codes and set(codes) == {"charge_limit"} and len(res.rows) == 8
    assert fake.count("chatgpt") <= 2  # only the two answers already in flight; none started afterwards
    assert res.ok is True and all(not c for r, c in res.pushes if r["errorCode"] == "charge_limit")
