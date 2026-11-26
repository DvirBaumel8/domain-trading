import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.core import (
    analyse_dmarc_basic,
    analyse_spf_basic,
    check_trademark_risk,
    compute_score_and_summary,
    detect_email_provider,
    detect_ns_provider,
    detect_parked_ns,
    extract_js_or_meta_redirect,
    index_bootstrap,
    inspect_landing_html,
    normalize_domain,
    parse_rdap,
    rdap_base_for,
)


def test_normalize():
    assert normalize_domain('https://www.Example.com/path?x=1') == 'example.com'
    assert normalize_domain('john@Acme.co.uk') == 'acme.co.uk'
    assert normalize_domain('münchen.de') == 'xn--mnchen-3ya.de'
    assert normalize_domain('bad_domain.com') is None
    assert normalize_domain('-bad.com') is None
    assert normalize_domain('nodot') is None
    assert normalize_domain('example.c0m') is None


def test_rdap_bootstrap_and_parse():
    bs = index_bootstrap({
        'services': [
            [['com', 'net'], ['https://rdap.verisign.com/com/v1']],
            [['uk'], ['http://x/', 'https://rdap.nominet.uk/uk/']],
        ]
    })
    assert rdap_base_for('a.com', bs) == 'https://rdap.verisign.com/com/v1/'
    assert rdap_base_for('bbc.co.uk', bs) == 'https://rdap.nominet.uk/uk/'
    assert rdap_base_for('a.zz', bs) is None

    j = {
        'events': [
            {'eventAction': 'registration', 'eventDate': '2009-09-25T10:00:00Z'},
            {'eventAction': 'expiration', 'eventDate': '2027-09-25T10:00:00Z'},
        ],
        'entities': [
            {
                'roles': ['registrar'],
                'vcardArray': ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'GoDaddy.com, LLC']]],
            }
        ],
        'status': ['client transfer prohibited'],
        'nameservers': [{'ldhName': 'NS5.AFTERNIC.COM'}],
    }
    now = datetime(2026, 11, 25, tzinfo=timezone.utc)
    p = parse_rdap(j, now=now)
    assert p['registrar'] == 'GoDaddy.com, LLC'
    assert p['createdDate'] == '2009-09-25'
    assert p['expiryDate'] == '2027-09-25'
    assert p['domainAgeYears'] > 17.0
    assert p['daysUntilExpiry'] == 304
    assert p['rdapNameservers'] == ['ns5.afternic.com']


def test_providers_and_parked_ns():
    assert detect_ns_provider(['ns1.cloudflare.com', 'ns2.cloudflare.com']) == 'Cloudflare'
    assert detect_ns_provider(['ns-123.awsdns-45.org']) == 'Amazon Route 53'
    assert detect_parked_ns(['ns1.sedoparking.com', 'ns2.sedoparking.com']) == 'Sedo parking'
    assert detect_parked_ns(['ns5.afternic.com']) == 'Afternic (listed for sale)'
    assert detect_parked_ns(['ns1.cloudflare.com']) is None
    assert detect_email_provider([{'priority': 1, 'host': 'aspmx.l.google.com'}]) == 'Google Workspace'
    assert detect_email_provider([], null_mx=True) == 'Null MX (accepts no email)'


def test_spf_dmarc():
    assert analyse_spf_basic(['v=spf1 include:_spf.google.com ~all']) == (True, '~all')
    assert analyse_spf_basic(['v=spf1 redirect=_spf.google.com']) == (True, 'redirect')
    assert analyse_spf_basic(['hello']) == (False, None)
    assert analyse_dmarc_basic(['v=DMARC1; p=reject; rua=mailto:a@b.com']) == (True, 'reject')
    assert analyse_dmarc_basic(['other']) == (False, None)


def test_landing_redirect_and_for_sale_price():
    js_html = '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>'
    assert extract_js_or_meta_redirect(js_html, 'https://mineunited.com') == 'https://mineunited.com/lander'

    gd_html = '''
    <html><head>
      <title>mineunited.com is for sale — Buy for $1,488, Lease, or Offer | GoDaddy</title>
      <meta name="description" content="mineunited.com is for sale on GoDaddy. Own it today for $1,488.">
      <script type="application/ld+json">{"@type":"Product","offers":{"price":1488,"priceCurrency":"USD"}}</script>
    </head><body></body></html>
    '''
    res = inspect_landing_html('https://forsale.godaddy.com/forsale/mineunited.com', gd_html, 'mineunited.com')
    assert res['pageForSale'] is True
    assert res['askingPrice'] == '$1,488'
    assert 'GoDaddy' in res['pageReason']

    normal_html = '<html><head><title>Acme Shop - Widgets for $19</title></head><body>Buy widgets for $19</body></html>'
    res2 = inspect_landing_html('https://acmeshop.com/', normal_html, 'acmeshop.com')
    assert res2['pageForSale'] is False
    assert res2['askingPrice'] is None


def test_trademark_risk():
    risk, matches, note = check_trademark_risk('my-paypal-login.com')
    assert risk == 'high' and 'paypal' in matches
    assert 'not legal advice' in note.lower()

    risk2, matches2, _ = check_trademark_risk('cloudstripeapp.io')
    assert risk2 == 'possible' and 'stripe' in matches2

    risk3, matches3, _ = check_trademark_risk('example.com')
    assert risk3 == 'none_detected' and matches3 == []

    # Short brand 'hp' or 'lg' must not false-positive inside 'alpha.com' or 'shoplg.com' without hyphen/exact
    risk4, matches4, _ = check_trademark_risk('alphashop.com')
    assert risk4 == 'none_detected' and matches4 == []


def test_scoring_and_summary():
    healthy = {
        'domain': 'acme.com',
        'registered': True,
        'domainAgeYears': 12.0,
        'daysUntilExpiry': 400,
        'registrar': 'Cloudflare, Inc.',
        'hasNs': True,
        'hasA': True,
        'hasMx': True,
        'httpsValid': True,
        'httpStatus': 200,
        'isParkedOrForSale': False,
        'hasSpf': True,
        'spfPolicy': '-all',
        'hasDmarc': True,
        'dmarcPolicy': 'reject',
        'safetyStatus': 'not_flagged',
        'trademarkRisk': 'none_detected',
        'trademarkMatches': [],
    }
    s, reasons, summary = compute_score_and_summary(healthy)
    assert s == 100
    assert 'acme.com' in summary and '100/100' in summary

    avail = {
        'domain': 'quietbluefalcon9912.com',
        'registered': False,
        'rdapSource': 'rdap',
        'trademarkRisk': 'none_detected',
        'trademarkMatches': [],
    }
    s2, _, sum2 = compute_score_and_summary(avail)
    assert s2 == 0 and 'not registered' in sum2

    flagged = dict(healthy, safetyStatus='flagged_malware_or_phishing')
    s3, reasons3, sum3 = compute_score_and_summary(flagged)
    assert s3 == 30
    assert 'FLAGGED' in sum3
    assert any('malware/phishing' in r for r in reasons3)
