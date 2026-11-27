"""A25: no key, header or provider text anywhere."""
import logging

import httpx

from helpers import CANARIES, ROOT, Fake, drive, inp
from src.providers import ProviderError


def echo(status):
    def behave(n, req):
        key = req.headers.get("authorization", "") + req.headers.get("x-api-key", "") + req.headers.get("x-goog-api-key", "")
        return httpx.Response(status, json={"error": {"message": f"Incorrect API key provided: {key}", "echo": dict(req.headers)}})
    return behave


def everything(res, caplog, capsys):
    out = capsys.readouterr()
    return "\n".join([caplog.text, out.out, out.err, repr(res.rows), repr(res.summary), repr(res.statuses), str(res.msg)])


def test_a25_canary_keys_never_leak(caplog, capsys):
    caplog.set_level(logging.DEBUG)
    for status in (401, 500, 429, 403):
        fake = Fake()
        for e in ("chatgpt", "gemini", "claude"):
            fake.behave[e] = echo(status)
        res = drive(inp(promptCount=2), fake)
        blob = everything(res, caplog, capsys)
        assert not any(c in blob for c in CANARIES.values()), status
        assert "Incorrect API key" not in blob
        assert all(r["errorCode"] in {"provider_error", "rate_limited", "quota_exhausted"} for r in res.rows)


def test_a25_extractor_error_body_with_key_is_not_kept(caplog, capsys):
    caplog.set_level(logging.DEBUG)
    fake = Fake()
    fake.behave["extractor"] = echo(500)
    res = drive(inp(promptCount=1), fake)
    assert res.ok and not any(c in everything(res, caplog, capsys) for c in CANARIES.values())


def test_a25_key_only_in_headers_and_never_in_exceptions():
    seen = []
    fake = Fake()
    fake.behave["gemini"] = lambda n, req: seen.append((str(req.url), req.headers.get("x-goog-api-key"))) or None
    drive(inp(promptCount=1, engines=["gemini"]), fake)
    assert seen[0][1] == CANARIES["GEMINI_API_KEY"] and CANARIES["GEMINI_API_KEY"] not in seen[0][0]
    for e in (ProviderError("rate_limited", 429), ProviderError("provider_error")):
        assert not any(c in str(e) + repr(e) for c in CANARIES.values())


def test_a25_no_canary_in_repo_files():
    for p in ROOT.rglob("*"):
        if p.is_file() and p.suffix in {".py", ".json", ".md", ".txt", ".yml"} and "tests" not in p.parts:
            text = p.read_text(errors="ignore")
            assert not any(c in text for c in CANARIES.values()) and "sk-CANARY" not in text, p
