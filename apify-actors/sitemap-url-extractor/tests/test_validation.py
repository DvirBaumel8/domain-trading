"""H3: inputs are validated up front (fake Actor, mock transport, no network)."""
import asyncio
import pathlib
import sys

import httpx
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import main as m  # noqa: E402
from src.core import normalize_start, valid_modified_since  # noqa: E402

REAL_CLIENT = httpx.AsyncClient


class FakeActor:
    def __init__(self, inp):
        self.inp, self.pushed, self.values, self.failed, self.logs = inp, [], {}, None, []
        log = self.logs
        self.log = type('L', (), {'info': staticmethod(log.append), 'warning': staticmethod(log.append)})()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get_input(self):
        return self.inp

    async def push_data(self, rows, charged_event_name=None):
        self.pushed.append((rows, charged_event_name))

    async def set_value(self, k, v):
        self.values[k] = v

    async def set_status_message(self, msg):
        pass

    async def fail(self, status_message=None):
        self.failed = status_message


def run_main(monkeypatch, inp, handler):
    fake, calls = FakeActor(inp), []

    def h(req):
        calls.append(str(req.url))
        return handler(req)
    monkeypatch.setattr(m, 'Actor', fake)
    monkeypatch.setattr(m.httpx, 'AsyncClient', lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(h), **kw))

    async def nosleep(_):
        return None
    monkeypatch.setattr(m.asyncio, 'sleep', nosleep)
    asyncio.run(m.main())
    return fake, calls


def test_modified_since_yesterday_fails_at_once(monkeypatch):
    fake, calls = run_main(monkeypatch, {'startUrls': ['https://ex.com'], 'modifiedSince': 'yesterday'}, lambda r: httpx.Response(404))
    assert fake.failed == 'modifiedSince must look like 2026-01-31' and calls == [] and fake.pushed == []


def test_modified_since_accepts_dates():
    for ok in ('', '2026-01-31', '2026-01-31T10:00:00Z', '2026-01-31T10:00:00+02:00'):
        assert valid_modified_since(ok), ok
    for bad in ('yesterday', '2026-13-01', '31/01/2026', '2026-1-3'):
        assert not valid_modified_since(bad), bad


def test_bad_start_url_makes_no_http_call_and_is_listed(monkeypatch):
    fake, calls = run_main(monkeypatch, {'startUrls': ['not a url']}, lambda r: httpx.Response(404))
    assert calls == [] and fake.values['INVALID_INPUTS'] == ['not a url'] and fake.pushed == []
    assert sum('invalid' in l for l in fake.logs) == 1 and fake.failed


def test_good_and_bad_mixed(monkeypatch):
    sm = b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ex.com/a</loc></url></urlset>'
    fake, calls = run_main(monkeypatch, {'startUrls': ['mailto:a@b.c', 'ex.com/sitemap.xml', 'ftp://x.com']},
                           lambda r: httpx.Response(200, content=sm))
    assert fake.values['INVALID_INPUTS'] == ['mailto:a@b.c', 'ftp://x.com']
    assert [r['url'] for r in fake.pushed[0][0]] == ['https://ex.com/a'] and fake.pushed[0][1] == 'result'
    assert calls == ['https://ex.com/sitemap.xml']


def test_dns_failure_logs_could_not_connect(monkeypatch):
    def h(req):
        e = httpx.ConnectError('x')
        e.__cause__ = __import__('socket').gaierror(-2, 'Name or service not known')
        raise e
    fake, _ = run_main(monkeypatch, {'startUrls': ['https://nope.invalid/sitemap.xml']}, h)
    text = ' '.join(fake.logs)
    assert 'could not connect (dns lookup failed)' in text and 'HTTP None' not in text


@pytest.mark.parametrize('raw,want', [('ex.com', 'https://ex.com'), ('http://ex.com/x', 'http://ex.com/x'),
                                      ('localhost:8080', None), ('javascript:x', None), ('a b.com', None), ('', None)])
def test_normalize_start(raw, want):
    assert normalize_start(raw) == want
