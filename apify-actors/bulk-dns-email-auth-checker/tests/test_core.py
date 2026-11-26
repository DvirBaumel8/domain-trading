import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.core import analyse_spf, analyse_dmarc, parse_mx, detect_provider, unquote_txt, normalize_domain, email_score, parked_hint

def test_txt_and_mx():
    assert unquote_txt('"v=spf1 include:_spf.google.com" " ~all"') == 'v=spf1 include:_spf.google.com ~all'
    mx = parse_mx(['10 alt1.aspmx.l.google.com.', '1 aspmx.l.google.com.'])
    assert mx[0] == {'priority': 1, 'host': 'aspmx.l.google.com'} and detect_provider(mx) == 'Google Workspace'
    assert detect_provider([{'priority': 0, 'host': 'acme-com.mail.protection.outlook.com'}]) == 'Microsoft 365'
    assert detect_provider([]) is None

def test_spf():
    spf, allm, n, issues, score = analyse_spf(['v=spf1 include:_spf.google.com include:sendgrid.net -all', 'google-site-verification=x'])
    assert allm == '-all' and n == 2 and issues == [] and score == 25
    _, allm, _, issues, score = analyse_spf(['v=spf1 +all'])
    assert allm == '+all' and score == 0 and any('ANY' in i for i in issues)
    assert analyse_spf(['v=spf1 -all', 'v=spf1 ~all'])[4] == 0
    assert analyse_spf([])[0] is None
    many = 'v=spf1 ' + ' '.join(f'include:s{i}.com' for i in range(12)) + ' ~all'
    assert any('limit is 10' in i for i in analyse_spf([many])[3])

def test_dmarc():
    rec, p, rua, issues, score = analyse_dmarc(['v=DMARC1; p=reject; rua=mailto:d@x.com'])
    assert p == 'reject' and rua == 'mailto:d@x.com' and issues == [] and score == 35
    _, p, _, issues, score = analyse_dmarc(['v=DMARC1; p=none'])
    assert p == 'none' and len(issues) == 2 and score == 12
    assert analyse_dmarc([])[4] == 0

def test_misc():
    assert normalize_domain('Jane@Sub.Example.CO.uk') == 'sub.example.co.uk'
    assert email_score(True, 25, 35, True, True, True) == 100
    assert parked_hint(['ns1.sedoparking.com']) == 'Sedo parking'

def test_null_mx_and_dkim():
    from src.core import is_null_mx, dkim_has_key
    assert is_null_mx(['0 .']) and not is_null_mx(['10 mx.a.com.'])
    assert parse_mx(['0 .']) == []
    assert not dkim_has_key(['v=DKIM1; p=']) and dkim_has_key(['v=DKIM1; k=rsa; p=MIIBIjANBg'])
