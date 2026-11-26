import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.core import normalize_domain, generate_candidates, parse_rdap, rdap_base_for, index_bootstrap

def test_normalize():
    assert normalize_domain('https://www.Example.com/path?x=1') == 'example.com'
    assert normalize_domain('john@Acme.io') == 'acme.io'
    assert normalize_domain('münchen.de') == 'xn--mnchen-3ya.de'
    assert normalize_domain('bad_domain.com') is None
    assert normalize_domain('-bad.com') is None
    assert normalize_domain('nodot') is None
    assert normalize_domain('example.c0m') is None

def test_generate():
    out = list(generate_candidates(['Rent Guitar', 'rentguitar'], ['com', '.io'], ['get'], ['hq']))
    doms = [d for d, _ in out]
    assert doms[:2] == ['rentguitar.com', 'rentguitar.io']
    assert 'getrentguitarhq.com' in doms and len(doms) == len(set(doms)) == 8

def test_bootstrap_and_parse():
    bs = index_bootstrap({'services': [[['com', 'net'], ['https://rdap.verisign.com/com/v1']], [['uk'], ['http://x/', 'https://rdap.nominet.uk/uk/']]]})
    assert rdap_base_for('a.com', bs) == 'https://rdap.verisign.com/com/v1/'
    assert rdap_base_for('a.co.uk', bs) == 'https://rdap.nominet.uk/uk/'
    assert rdap_base_for('a.zz', bs) is None
    j = {'events': [{'eventAction': 'registration', 'eventDate': '1995-08-14T04:00:00Z'}, {'eventAction': 'expiration', 'eventDate': '2030-08-13T04:00:00Z'}],
         'entities': [{'roles': ['registrar'], 'vcardArray': ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-IANA']]]}],
         'status': ['client delete prohibited'], 'nameservers': [{'ldhName': 'A.IANA-SERVERS.NET'}]}
    p = parse_rdap(j)
    assert p['registrar'] == 'RESERVED-IANA' and p['createdDate'] == '1995-08-14' and p['expiryDate'] == '2030-08-13'
    assert p['domainAgeYears'] > 30 and p['rdapNameservers'] == ['a.iana-servers.net']

def test_parked():
    from src.core import parked_hint
    assert parked_hint(['ns1.afternic.com', 'ns2.afternic.com']).startswith('Afternic')
    assert parked_hint(['ns1.domaincontrol.com']) is None
    assert parked_hint([]) is None
