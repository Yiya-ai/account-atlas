"""Security regressions use synthetic data and disposable databases only."""
import copy

from backend.vault import seal
from test_vault import MASTER, H, app, c, post, add
from test_security import enable


def configure(c, secret=False):
    state = c.get('/api/state').json
    p = next(p for p in state['platforms'] if p['id'] == 'google')
    p['fieldTemplates'] = [{'name': 'private-token', 'secret': secret, 'enabled': True}]
    p['revision'] = state['revision']
    assert c.put('/api/platforms/google', json=p, headers=H).status_code == 200


def test_template_sensitivity_applies_to_existing_records(c):
    configure(c)
    a = add(c, customFields=[{'name':'private-token', 'value':'UNIQUE_PRIVATE_VALUE', 'secret':False}])
    configure(c, True)
    detail = c.get('/api/accounts/'+a['id']).json
    assert detail['customFields'][0]['secret'] is True
    assert detail['customFields'][0]['value'] == ''
    assert c.get('/api/state?q=UNIQUE_PRIVATE_VALUE').json['accounts'] == []
    shown = post(c, '/accounts/'+a['id']+'/reveal', {}).json
    assert shown['customFields'][0] == {'name':'private-token', 'value':'UNIQUE_PRIVATE_VALUE', 'secret':True}
    configure(c, False)
    assert c.get('/api/accounts/'+a['id']).json['customFields'][0]['value'] == ''


def test_custom_invalid_type_and_duplicates_are_rejected(c):
    configure(c)
    for fields in ([{'name':42}], [{'name':'x','value':'1'}, {'name':'X','value':'2'}]):
        r = post(c, '/accounts', {'platformId':'google','identifier':'invalid@example.invalid','customFields':fields})
        assert r.status_code == 400
    assert c.get('/api/state').json['accounts'] == []


def test_malformed_backup_does_not_poison_session(c, app):
    add(c)
    v = app.extensions['vault']
    for patch in ({'customFields':[{'name':'token','value':7,'secret':False}]},
                  {'favorite':[]}, {'id':''}, {'customFields':[{'name':'token','value':'secret'}]}):
        data = copy.deepcopy(v.data)
        data['accounts'][0].update(patch)
        response = post(c, '/restore/preview', {'backup':seal(data,v.key,v.salt), 'password':MASTER})
        assert response.status_code == 400
        assert c.get('/api/state').status_code == 200


def test_every_private_route_denies_password_only_challenge(c, app):
    enable(c)
    post(c, '/lock', {})
    assert post(c, '/unlock', {'password':MASTER}).json['mfaRequired']
    public = {'/api/status','/api/setup','/api/unlock','/api/unlock/verify','/api/unlock/cancel',
              '/api/unlock/passkey/options','/api/unlock/passkey/verify'}
    checked = 0
    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith('/api/') or rule.rule in public: continue
        path = rule.rule.replace('<id>', 'fake').replace('<action>', 'disable')
        for method in rule.methods - {'OPTIONS','HEAD'}:
            response = c.open(path, method=method, json={}, headers=H)
            assert response.status_code == 401, (method,path,response.status_code)
            checked += 1
    assert checked >= 25


def test_cancelled_2fa_enrollment_cannot_be_completed(c, app):
    import pyotp
    first = post(c, '/security/setup', {'password':MASTER}).json
    second = post(c, '/security/setup', {'password':MASTER}).json
    post(c, '/security/setup/cancel', {'token':first['token']})
    assert app.extensions['vault'].pending_setup['token'] == second['token']
    assert post(c, '/security/setup/cancel', {'token':second['token']}).status_code == 200
    assert app.extensions['vault'].pending_setup is None
    r = post(c, '/security/enable', {'token':second['token'], 'code':pyotp.TOTP(second['secret']).now()})
    assert r.status_code == 409
    assert c.get('/api/security').json['factorEnabled'] is False


def test_bad_platform_url_is_validation_error(c):
    r = post(c, '/platforms', {'name':'Synthetic', 'url':'https://[broken'})
    assert r.status_code == 400


def test_whitelist_cannot_be_bypassed_on_any_route_or_with_proxy_headers(c, app):
    assert post(c, '/security/ip', {'enabled':True,'rules':['127.0.0.1'],'password':MASTER}).status_code == 200
    spoofed = {**H, 'X-Forwarded-For':'127.0.0.1', 'X-Real-IP':'127.0.0.1',
               'Forwarded':'for=127.0.0.1;host=localhost;proto=http'}
    for rule in app.url_map.iter_rules():
        path = rule.rule.replace('<id>','fake').replace('<action>','disable').replace('<path:name>','fake.js')
        for method in rule.methods:
            response = c.open(path, method=method, headers=spoofed, json={}, environ_overrides={'REMOTE_ADDR':'192.0.2.1'})
            assert response.status_code == 403, (method,path)


def test_route_type_fuzz_does_not_crash_or_mutate(c, app):
    configure(c)
    cases = [('/accounts', {'identifier':'fuzz@example.invalid', 'platformId':'google'}, ['identifier','platformId','secrets','customFields','tags','notes','favorite']),
             ('/platforms', {'name':'fuzz'}, ['name','url','fields','fieldTemplates']),
             ('/import/analyze', {'platformId':'google','text':'account\na@example.invalid','header':True}, ['platformId','text','delimiter']),
             ('/import/preview', {'platformId':'google','mapping':{'identifier':0},'text':'a@example.invalid'}, ['mapping','tags','mode']),
             ('/batch', {'ids':['missing'],'action':'group'}, ['ids','action']),
             ('/security/ip', {'enabled':True,'rules':['127.0.0.1'],'password':MASTER}, ['enabled','rules'])]
    for path, base, keys in cases:
        for key in keys:
            for value in (None, {}, [17], 42):
                if key == 'secrets' and value == {}: continue  # An empty secret map is valid.
                before = app.extensions['vault'].data['revision']
                r = post(c,path,{**base,key:value})
                assert 400 <= r.status_code < 500, (path,key,type(value),r.status_code)
                assert app.extensions['vault'].data['revision'] == before


def test_static_files_cannot_expose_database_or_source(c):
    for path in ['/data/vault.db','/backend/app.py','/assets/../data/vault.db','/assets/%2e%2e/%2e%2e/data/vault.db','/.env','/requirements.lock.txt']:
        assert c.get(path).status_code == 404
    for path in ['/api/state','/api/security']:
        r = c.get(path)
        assert r.headers['Cache-Control'] == 'no-store'
        assert "frame-ancestors 'none'" in r.headers['Content-Security-Policy']
