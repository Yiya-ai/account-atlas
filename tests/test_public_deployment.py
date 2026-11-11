import ipaddress
import secrets

import pyotp
import pytest

from backend.app import create_app
from backend.deployment import CityGate, PublicDeployment
from test_vault import MASTER, BACKUP, H

ORIGIN = 'https://192.0.2.10:8443'
SOURCE = '198.51.100.10'
OTHER = '198.51.100.11'
TOKEN = secrets.token_urlsafe(48)
BOOTSTRAP = secrets.token_urlsafe(32)


class TestCity:
    __test__ = False
    allowed = ('中国', '福建省', '厦门市')
    revision = 'synthetic-database'

    def permits(self, ip): return ip in (SOURCE, OTHER)


@pytest.fixture
def public_app(tmp_path):
    return create_app(tmp_path, testing=True, deployment=PublicDeployment(ORIGIN, TOKEN, TestCity(), BOOTSTRAP))


def request(client, path, method='GET', data=None, *, ip=SOURCE, headers=None, peer='127.0.0.1'):
    values = {'X-Atlas-Proxy-Token': TOKEN, 'X-Atlas-Proto': 'https', 'X-Atlas-Client-IP': ip,
              'X-Atlas-Request': '1', 'Origin': ORIGIN}
    values.update(headers or {})
    return client.open('/api' + path, method=method, json=data, base_url=ORIGIN,
                       headers=values, environ_overrides={'REMOTE_ADDR':peer})


def setup(client):
    result = request(client, '/setup', 'POST', {'password':MASTER,'bootstrapToken':BOOTSTRAP})
    assert result.status_code == 200, result.json
    return result


def enable(client):
    result = request(client, '/security/setup', 'POST', {'password':MASTER,'bootstrapToken':BOOTSTRAP})
    assert result.status_code == 200, result.json
    binding = result.json
    result = request(client, '/security/enable', 'POST', {'token':binding['token'], 'code':pyotp.TOTP(binding['secret']).now()})
    assert result.status_code == 200, result.json
    return result.json['recoveryCodes']


@pytest.mark.parametrize('headers,peer', [
    ({'X-Atlas-Proxy-Token':''}, '127.0.0.1'),
    ({'X-Atlas-Proxy-Token':'forged'}, '127.0.0.1'),
    ({'X-Atlas-Proto':'http'}, '127.0.0.1'),
    ({}, '198.51.100.50'),
    ({'X-Atlas-Client-IP':'127.0.0.1'}, '127.0.0.1'),
    ({'X-Atlas-Client-IP':'8.8.8.8','X-Forwarded-For':SOURCE}, '127.0.0.1'),
    ({'X-Atlas-Client-IP':SOURCE+', 8.8.8.8'}, '127.0.0.1'),
    ({'X-Atlas-Client-IP':'fe80::1%eth0'}, '127.0.0.1'),
    ({'Origin':'https://attacker.invalid'}, '127.0.0.1'),
    ({'Host':'attacker.invalid'}, '127.0.0.1'),
    ({'Sec-Fetch-Site':'cross-site'}, '127.0.0.1'),
])
def test_public_proxy_origin_and_city_fail_closed(public_app, headers, peer):
    assert request(public_app.test_client(), '/status', headers=headers, peer=peer).status_code == 403


def test_public_mutations_require_origin_and_request_header(public_app):
    client = public_app.test_client()
    for headers in ({'Origin':''}, {'X-Atlas-Request':''}):
        assert request(client, '/setup', 'POST', {'password':MASTER,'bootstrapToken':BOOTSTRAP}, headers=headers).status_code == 403
    assert request(client, '/status').json['initialized'] is False


def test_public_enrollment_restricts_all_data_routes_and_secure_cookie(public_app):
    client = public_app.test_client()
    result = setup(client)
    cookies = result.headers.getlist('Set-Cookie')
    assert any('__Host-atlas_session=' in c and 'Secure;' in c and 'HttpOnly;' in c and 'SameSite=Strict' in c for c in cookies)
    assert request(client, '/status').json['enrollmentRequired'] is True
    assert request(client, '/security').json['totpRequired'] is True
    for method, path in [('GET','/state'),('GET','/accounts/id'),('POST','/accounts'),('POST','/backup'),
                         ('POST','/export/download'),('POST','/import/apply'),('POST','/restore/apply'),
                         ('POST','/password'),('POST','/security/ip'),('POST','/security/recovery')]:
        assert request(client, path, method, {} if method == 'POST' else None).status_code == 423
    assert request(client, '/security/enable', 'POST', {'token':'fake','code':'123456'}).status_code == 409
    assert request(client, '/state').status_code == 423
    enable(client)
    assert request(client, '/status').json['enrollmentRequired'] is False
    assert request(client, '/state').status_code == 200
    assert request(client, '/security/disable', 'POST', {'password':MASTER,'bootstrapToken':BOOTSTRAP}).status_code == 409


def test_public_login_mfa_replay_ip_binding_and_additional_allowlist(public_app):
    client = public_app.test_client()
    setup(client)
    codes = enable(client)
    assert request(client, '/status', ip=OTHER).json['unlocked'] is False
    assert request(client, '/state', ip=OTHER).status_code == 401
    assert request(client, '/lock', 'POST', {}).status_code == 200
    result = request(client, '/unlock', 'POST', {'password':MASTER,'bootstrapToken':BOOTSTRAP})
    assert result.json['mfaRequired'] and result.json['passkeyAvailable'] is False
    assert any('__Secure-atlas_challenge=' in c and 'Secure;' in c and 'HttpOnly;' in c for c in result.headers.getlist('Set-Cookie'))
    assert request(client, '/state').status_code == 401
    assert request(client, '/unlock/verify', 'POST', {'code':codes[0]}, ip=OTHER).status_code == 401
    assert request(client, '/unlock/verify', 'POST', {'code':'bad'}).status_code == 400
    assert request(client, '/unlock/verify', 'POST', {'code':codes[0]}).status_code == 200
    assert request(client, '/security/ip', 'POST', {'password':MASTER,'code':codes[1],'enabled':True,'rules':[SOURCE]}).status_code == 200
    assert request(client, '/status', ip=OTHER, headers={'X-Forwarded-For':SOURCE}).status_code == 403
    request(client, '/lock', 'POST', {})
    request(client, '/unlock', 'POST', {'password':MASTER,'bootstrapToken':BOOTSTRAP})
    assert request(client, '/unlock/verify', 'POST', {'code':codes[0]}).status_code == 400


def test_public_unavailable_geo_denies_and_ip_passkeys_disabled(tmp_path):
    city = TestCity()
    deployment = PublicDeployment(ORIGIN,TOKEN,city,BOOTSTRAP)
    client = create_app(tmp_path, testing=True, deployment=deployment).test_client()
    assert request(client,'/security/passkey/options','POST',{}).status_code == 400
    def fail(ip): raise RuntimeError('synthetic offline DB error')
    city.permits = fail
    response = request(client,'/status')
    assert response.status_code == 503
    assert 'synthetic' not in response.get_data(as_text=True)


def test_restored_accounts_remain_inaccessible_until_public_enrollment(tmp_path):
    local = create_app(tmp_path/'local', testing=True).test_client()
    local.post('/api/setup', json={'password':MASTER,'bootstrapToken':BOOTSTRAP}, headers=H)
    local.post('/api/accounts', json={'platformId':'google','identifier':'synthetic@example.invalid'}, headers=H)
    backup = local.post('/api/backup', json={'password':BACKUP}, headers=H).json
    app = create_app(tmp_path/'public', testing=True, deployment=PublicDeployment(ORIGIN,TOKEN,TestCity(),BOOTSTRAP))
    client = app.test_client()
    result = request(client,'/setup','POST',{'password':MASTER,'backup':backup,'backupPassword':BACKUP,'bootstrapToken':BOOTSTRAP})
    assert result.status_code == 200, result.json
    assert request(client,'/state').status_code == 423
    enable(client)
    assert request(client,'/state').json['accounts'][0]['identifier'] == 'synthetic@example.invalid'


@pytest.mark.parametrize('region,expected', [('中国|福建省|厦门市|电信|CN',True),
    ('中国|福建省|福州市|电信|CN',False), ('中国|福建省|0|电信|CN',False), ('',False),
    ('中国|0|福建省|厦门市|电信',False), ('中国|福建省|厦门市恶意后缀|电信|CN',False)])
def test_city_requires_exact_fields(region,expected):
    class Searcher:
        def search(self,ip): return region
    gate = CityGate.__new__(CityGate)
    gate.allowed = ('中国','福建省','厦门市')
    gate.searchers = {4:Searcher(),6:Searcher()}
    assert gate.permits('8.8.8.8') is expected
    for ip in ('127.0.0.1','10.0.0.1','::1','fe80::1'):
        assert gate.permits(ip) is False


@pytest.mark.parametrize('origin', ['http://192.0.2.10','https://192.0.2.10/','https://user@192.0.2.10','https://192.0.2.10?q=x'])
def test_public_config_rejects_ambiguous_origin(origin):
    with pytest.raises(ValueError): PublicDeployment(origin,TOKEN,TestCity(),BOOTSTRAP)


def test_public_initial_setup_cannot_be_claimed_without_bootstrap(public_app):
    client = public_app.test_client()
    for value in (None, '', 'wrong', ['invalid']):
        assert request(client, '/setup', 'POST', {'password':MASTER, 'bootstrapToken':value}).status_code == 403
        assert request(client, '/status').json['initialized'] is False
    setup(client)
    assert request(client, '/setup', 'POST', {'password':MASTER, 'bootstrapToken':BOOTSTRAP}).status_code == 409
