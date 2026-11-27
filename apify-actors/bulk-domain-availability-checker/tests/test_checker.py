"""Offline tests for the TLD check and likely_available (mock transport, fake Actor, no network)."""
import asyncio
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import main as m  # noqa: E402
from src.core import bundled_tlds, is_valid_tld_list, parse_tld_list, should_push, is_charged  # noqa: E402
from src.doh import DohResolver  # noqa: E402


def handler(nx=(), has_ns=(), rdap_404=()):
    """Mock of IANA files, DoH and RDAP. Everything not listed is NXDOMAIN."""
    def h(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if 'tlds-alpha-by-domain' in url:
            return httpx.Response(200, text='# Version 1\n' + '\n'.join(sorted(bundled_tlds())))
        if 'rdap/dns.json' in url:
            return httpx.Response(200, json={'services': [[['com'], ['https://rdap.test/com/']]]})
        if url.startswith('https://rdap.test/com/'):
            return httpx.Response(404)
        if 'dns-query' in url or 'resolve' in url:
            name = req.url.params['name']
            if name in has_ns:
                return httpx.Response(200, json={'Status': 0, 'Answer': [{'name': name, 'type': 2, 'TTL': 1, 'data': 'ns1.example.net.'}]})
            return httpx.Response(200, json={'Status': 3})
        return httpx.Response(404)
    return h


REAL_CLIENT = httpx.AsyncClient


class FakeActor:
    def __init__(self, inp):
        self.inp = inp
        self.pushed = []   # (row, charged_event_name)
        self.values = {}
        self.failed = None
        self.status = None
        self.log = type('L', (), {'info': staticmethod(lambda *a, **k: None), 'warning': staticmethod(lambda *a, **k: None)})()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get_input(self):
        return self.inp

    async def push_data(self, row, charged_event_name=None):
        self.pushed.append((row, charged_event_name))

    async def set_value(self, k, v):
        self.values[k] = v

    async def set_status_message(self, msg):
        self.status = msg

    async def fail(self, status_message=None):
        self.failed = status_message


def run_main(monkeypatch, inp, **hk):
    fake = FakeActor(inp)
    fake.calls = calls = []
    monkeypatch.setattr(m, 'Actor', fake)
    inner = handler(**hk)

    def h(req):
        calls.append(str(req.url))
        return inner(req)
    monkeypatch.setattr(m.httpx, 'AsyncClient', lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(h), **kw))
    monkeypatch.setattr(m, 'RDAP_MIN_INTERVAL', 0)
    asyncio.run(m.main())
    return fake


def by_domain(fake):
    return {r['domain']: (r, ev) for r, ev in fake.pushed}


NO_INPUT_MSG = 'Please add at least one domain in Domains, or a keyword in Keywords.'


def assert_clean_exit(f, msg):
    assert f.calls == [] and f.pushed == [] and f.failed is None and f.status == msg
    assert f.values['STATUS'] == {'ok': False, 'reason': 'invalid_input', 'message': msg}


def test_no_domains_no_keywords_exits_cleanly(monkeypatch):
    for inp in ({}, {'tlds': ['com', 'net']}, {'domains': [], 'keywords': []}):
        f = run_main(monkeypatch, inp)
        assert_clean_exit(f, NO_INPUT_MSG)
        assert 'INVALID_INPUTS' not in f.values


def test_all_domains_invalid_exits_cleanly(monkeypatch):
    f = run_main(monkeypatch, {'domains': ['not a domain', '???', '']})
    assert_clean_exit(f, 'No valid domains or keywords in input.')
    assert f.values['INVALID_INPUTS'] == ['not a domain', '???', '']


def test_valid_domain_still_checked(monkeypatch):
    f = run_main(monkeypatch, {'domains': ['free-name-xyz.com']})
    assert f.failed is None and 'STATUS' not in f.values and by_domain(f)['free-name-xyz.com'][1] == 'result'


def test_bundled_tld_list_is_sane():
    t = bundled_tlds()
    assert is_valid_tld_list(t) and 'com' in t and 'io' in t and 'zz' not in t
    assert parse_tld_list('# c\nCOM\n\nNET\n') == {'com', 'net'}


def test_unknown_tld_is_invalid_uncharged_and_listed(monkeypatch):
    f = run_main(monkeypatch, {'domains': ['google.zz'], 'keywords': ['Test Shop'], 'tlds': ['com', 'zz']})
    rows = by_domain(f)
    for d in ('google.zz', 'testshop.zz'):
        row, ev = rows[d]
        assert row['status'] == 'invalid_tld' and row['available'] is None and ev is None
    assert rows['testshop.com'][1] == 'result'
    assert sorted(f.values['INVALID_INPUTS']) == ['google.zz', 'testshop.zz']


def test_invalid_tld_absent_when_only_available(monkeypatch):
    f = run_main(monkeypatch, {'domains': ['google.zz', 'free-name-xyz.com'], 'onlyAvailable': True})
    rows = by_domain(f)
    assert 'google.zz' not in rows and rows['free-name-xyz.com'][0]['status'] == 'available'


def test_com_behaviour_unchanged():
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler(has_ns=('taken.com',)))) as c:
            kw = dict(resolver=DohResolver(c), client=c, throttle=m.HostThrottle(0), bootstrap={'com': 'https://rdap.test/com/'},
                      valid_tlds=bundled_tlds(), lookup_registered=False)
            return await m.check_domain('taken.com', None, **kw), await m.check_domain('free.com', 'free', **kw)
    taken, free = asyncio.run(go())
    assert (taken['status'], taken['available'], taken['method']) == ('registered', False, 'dns')
    assert (free['status'], free['available'], free['method']) == ('available', True, 'rdap')


def test_no_rdap_server_plus_nxdomain_is_likely_available(monkeypatch):
    # 'museum' is a real TLD that the mocked bootstrap does not list
    f = run_main(monkeypatch, {'domains': ['some-name-xyz.museum']})
    row, ev = by_domain(f)['some-name-xyz.museum']
    assert row['status'] == 'likely_available' and row['available'] is None and row['method'] == 'dns' and ev == 'result'


def test_likely_available_needs_include_flag_with_only_available(monkeypatch):
    inp = {'domains': ['some-name-xyz.museum'], 'onlyAvailable': True}
    assert run_main(monkeypatch, inp).pushed == []
    f = run_main(monkeypatch, dict(inp, includeLikelyAvailable=True))
    assert [r['status'] for r, _ in f.pushed] == ['likely_available']


def test_should_push_and_is_charged():
    assert should_push({'status': 'registered'}, False, False)
    assert not should_push({'status': 'registered'}, True, True)
    assert not is_charged({'status': 'invalid_tld'}) and is_charged({'status': 'unknown'})
