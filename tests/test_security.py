import copy
import time

import pyotp
import pytest

from backend.app import create_app
from backend.security import normalize_policy, matches, address, defaults
from backend.vault import Problem, unseal, seal, dumps
from recover_ip import reset_ip
from test_vault import MASTER, BACKUP, H, app, c, post, add


def enable(c):
    response = post(c, '/security/setup', {'password': MASTER})
    assert response.status_code == 200, response.json
    setup = response.json
    response = post(c, '/security/enable', {'token': setup['token'], 'code': pyotp.TOTP(setup['secret']).now()})
    assert response.status_code == 200, response.json
    return setup['secret'], response.json['recoveryCodes']


def test_mfa_requires_second_factor_and_rotates_cookie(c, app):
    account = add(c)
    original = c.get_cookie('atlas_session').value
    secret, codes = enable(c)
    assert c.get_cookie('atlas_session').value != original
    raw = app.extensions['vault'].path.read_bytes()
    assert secret.encode() not in raw and codes[0].encode() not in raw
    state = c.get('/api/state').json
    assert 'security' not in state and secret not in dumps(state)
    assert secret not in dumps(c.get('/api/security').json)
    post(c, '/lock', {})
    response = post(c, '/unlock', {'password': MASTER})
    assert response.json['mfaRequired'] is True
    assert not c.get_cookie('atlas_session')
    assert c.get_cookie('atlas_challenge', path='/api/unlock').http_only
    assert app.extensions['vault'].data is None and app.extensions['vault'].key is None
    for method, path in [('get','/state'),('get','/security'),('get',f'/accounts/{account["id"]}'),('post','/backup'),('post','/export/download'),('post','/import/apply'),('post','/password'),('post','/restore/apply'),('post','/security/disable')]:
        assert getattr(c, method)('/api'+path, headers=H, **({'json':{}} if method=='post' else {})).status_code == 401
    assert c.get('/api/status').json['unlocked'] is False
    # Enrollment code is already used, even though it is still current.
    assert post(c, '/unlock/verify', {'code':pyotp.TOTP(secret).now()}).status_code == 400
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 200
    assert c.get('/api/state').status_code == 200
    assert not c.get_cookie('atlas_challenge', path='/api/unlock')
    assert c.get('/api/security').json['recoveryRemaining'] == 7
    post(c, '/lock', {})
    post(c, '/unlock', {'password':MASTER})
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 400
    assert post(c, '/unlock/verify', {'code':codes[1]}).status_code == 200


def test_challenge_expiry_cancel_attempts_and_foreign_client(c, app):
    _, codes = enable(c)
    post(c, '/lock', {})
    post(c, '/unlock', {'password': MASTER})
    outsider = app.test_client()
    assert post(outsider, '/unlock/verify', {'code':codes[0]}).status_code == 401
    # A stranger cannot cancel a legitimate challenge.
    assert post(outsider, '/unlock/cancel', {}).status_code == 200
    assert app.extensions['vault'].pending_auth
    assert c.post('/api/unlock/verify', json={'code':codes[0]}, headers=H, environ_overrides={'REMOTE_ADDR':'127.0.0.2'}).status_code == 401
    app.extensions['vault'].pending_auth['expires'] = 0
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 401
    assert app.extensions['vault'].pending_auth is None
    post(c, '/unlock', {'password': MASTER})
    post(c, '/unlock/cancel', {})
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 401
    for batch in range(2):
        post(c, '/unlock', {'password': MASTER})
        for _ in range(5): assert post(c, '/unlock/verify', {'code':'wrong'}).status_code == 400
        assert app.extensions['vault'].pending_auth is None
    assert post(c, '/unlock', {'password': MASTER}).status_code == 429


def test_totp_replay_protection_survives_restart(c, app, monkeypatch):
    secret, _ = enable(c)
    old_step = int(time.time()) // 30
    monkeypatch.setattr('backend.security.time.time', lambda: (old_step+1)*30+1)
    post(c, '/lock', {}); post(c, '/unlock', {'password':MASTER})
    code = pyotp.TOTP(secret).at((old_step+1)*30+1)
    assert post(c, '/unlock/verify', {'code':code}).status_code == 200
    other = create_app(app.extensions['vault'].directory, testing=True).test_client()
    assert post(other, '/unlock', {'password':MASTER}).json['mfaRequired']
    assert post(other, '/unlock/verify', {'code':code}).status_code == 400


def test_security_reauth_change_rotate_recovery_and_disable(c, app):
    secret, codes = enable(c)
    original = c.get_cookie('atlas_session').value
    assert post(c, '/security/recovery', {'password':'wrong','code':codes[0]}).status_code == 400
    assert post(c, '/security/recovery', {'password':MASTER,'code':'bad'}).status_code == 400
    assert post(c, '/security/setup', {'password':MASTER}).status_code == 409
    response = post(c, '/security/recovery', {'password':MASTER,'code':codes[0]})
    assert response.status_code == 200
    assert c.get_cookie('atlas_session').value != original
    assert post(c, '/security/disable', {'password':MASTER,'code':codes[1]}).status_code == 400
    assert post(c, '/security/disable', {'password':MASTER,'code':response.json['recoveryCodes'][0]}).status_code == 200
    assert c.get('/api/security').json['enabled'] is False
    post(c, '/lock', {})
    assert post(c, '/unlock', {'password':MASTER}).json == {'ok':True}


def test_setup_confirmation_and_expiry(c, app):
    assert post(c, '/security/setup', {'password':'wrong'}).status_code == 400
    setup = post(c, '/security/setup', {'password':MASTER}).json
    assert setup['qr'].startswith('data:image/svg+xml;base64,')
    assert c.get('/api/security').json['enabled'] is False
    assert post(c, '/security/enable', {'token':setup['token'], 'code':'bad'}).status_code == 400
    app.extensions['vault'].pending_setup['expires'] = 0
    assert post(c, '/security/enable', {'token':setup['token'], 'code':pyotp.TOTP(setup['secret']).now()}).status_code == 409
    assert c.get('/api/security').json['enabled'] is False


def test_ip_gate_checks_every_request_and_ignores_proxy_headers(c, app):
    _, codes = enable(c)
    payload = {'enabled':True,'rules':['127.0.0.1'], 'password':MASTER,'code':codes[0]}
    assert post(c, '/security/ip', payload).status_code == 200
    assert c.get('/api/security').json['ip']['rules'] == ['127.0.0.1/32']
    assert c.get('/api/status', headers={'X-Forwarded-For':'8.8.8.8'}).status_code == 200
    for path in ['/', '/assets/fake.js', '/api/status', '/api/state', '/api/security']:
        r = c.get(path, headers={'X-Forwarded-For':'127.0.0.1','CF-Connecting-IP':'127.0.0.1','Forwarded':'for=127.0.0.1'}, environ_overrides={'REMOTE_ADDR':'192.0.2.3'})
        assert r.status_code == 403
    assert c.post('/api/unlock', json={'password':MASTER}, headers=H, environ_overrides={'REMOTE_ADDR':'192.0.2.3'}).status_code == 403
    assert c.get('/api/status', environ_overrides={'REMOTE_ADDR':'::ffff:127.0.0.1'}).status_code == 200
    assert post(c, '/security/ip', {**payload,'rules':['192.0.2.0/24'],'code':codes[1]}).status_code == 400
    assert post(c, '/security/ip', {**payload,'enabled':False,'code':codes[1]}).status_code == 200
    assert c.get('/api/status', environ_overrides={'REMOTE_ADDR':'192.0.2.3'}).status_code == 200
    assert c.get('/api/security').json['enabled'] is True
    post(c, '/lock', {})
    assert post(c, '/unlock', {'password':MASTER}).json['mfaRequired']


@pytest.mark.parametrize('rule', ['0.0.0.0/0','::/0','localhost','1.2.3.999','127.0.0.1/33','fe80::1%eth0',None,{},'::ffff:0.0.0.0/96'])
def test_bad_ip_rules(rule):
    with pytest.raises(Problem): normalize_policy({'enabled':True,'rules':[rule]})


def test_ip_cidr_v4_v6():
    policy = normalize_policy({'enabled':True,'rules':['192.0.2.7/24','2001:db8::123/48','192.0.2.0/24']})
    assert len(policy['rules']) == 2
    assert matches(policy,address('192.0.2.99'))
    assert matches(policy,address('2001:db8::5'))
    assert not matches(policy,address('192.0.3.1'))
    assert not matches(policy,address('2001:db9::1'))
    with pytest.raises(Problem): normalize_policy({'enabled':True,'rules':[]})
    with pytest.raises(Problem): normalize_policy({'enabled':'false','rules':[]})


def test_backup_restore_preserves_gates_and_new_machine_starts_fresh(c, app):
    add(c)
    old_backup = post(c, '/backup', {'password':BACKUP}).json
    _, codes = enable(c)
    assert post(c, '/security/ip', {'enabled':True, 'rules':['127.0.0.1'], 'password':MASTER,'code':codes[0]}).status_code == 200
    before = copy.deepcopy(app.extensions['vault'].data['security'])
    backup = post(c, '/backup', {'password':BACKUP}).json
    assert 'security' not in unseal(backup, BACKUP)[0]
    plan = post(c, '/restore/preview', {'backup':old_backup,'password':BACKUP}).json
    assert post(c, '/restore/apply', {'token':plan['token'],'confirm':'替换资料库'}).status_code == 200
    assert app.extensions['vault'].data['security'] == before
    assert c.get('/api/security').json['ip']['enabled']
    # Even a full snapshot cannot silently install foreign authentication settings.
    snapshot = app.extensions['vault'].envelope()
    other = create_app(app.extensions['vault'].directory/'other', testing=True).test_client()
    assert post(other, '/setup', {'password':MASTER,'backup':snapshot,'backupPassword':MASTER}).status_code == 200
    assert other.get('/api/security').json['enabled'] is False


def test_password_change_keeps_2fa(c, app):
    _, codes = enable(c)
    assert post(c, '/password', {'current':MASTER,'password':BACKUP}).status_code == 200
    post(c, '/lock', {})
    assert post(c, '/unlock', {'password':BACKUP}).json['mfaRequired']
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 200


def test_disk_failure_does_not_consume_code_or_grant_access(c, app, monkeypatch):
    _, codes = enable(c)
    post(c, '/lock', {}); post(c, '/unlock', {'password':MASTER})
    gates=app.extensions['gates']; original=gates.persist
    def fail(*args, **kwargs): raise OSError('test')
    monkeypatch.setattr(gates,'persist',fail)
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 500
    assert c.get('/api/state').status_code == 401
    monkeypatch.setattr(gates,'persist',original)
    assert post(c, '/unlock/verify', {'code':codes[0]}).status_code == 200


def test_local_ip_recovery_requires_both_factors(c, app):
    _, codes = enable(c)
    v = app.extensions['vault']
    with v.connect() as conn: conn.execute('INSERT INTO ip_gate VALUES(1,?)', (dumps({'enabled':True,'rules':['192.0.2.1/32']}),))
    with pytest.raises(Problem): reset_ip(v.directory, MASTER, 'bad')
    backup = reset_ip(v.directory, MASTER, codes[0])
    assert backup.is_file()
    other = create_app(v.directory, testing=True).test_client()
    assert post(other, '/unlock', {'password':MASTER}).json['mfaRequired']
    assert post(other, '/unlock/verify', {'code':codes[0]}).status_code == 400
    assert post(other, '/unlock/verify', {'code':codes[1]}).status_code == 200
    assert other.get('/api/security').json['ip']['enabled'] is False


@pytest.mark.parametrize('path',['/security','/security/setup','/security/enable','/security/disable','/security/recovery','/security/ip'])
def test_gate_endpoints_require_session_and_csrf(app, path):
    c=app.test_client()
    method=c.get if path=='/security' else c.post
    assert method('/api'+path,headers=H).status_code == 401
    if path!='/security': assert c.post('/api'+path,json={}).status_code == 403


def test_invalid_security_config_fails_closed(c, app):
    v=app.extensions['vault']
    data=copy.deepcopy(v.data); data['security']={'enabled':False}
    env=seal(data,v.key,v.salt)
    with pytest.raises(Problem): unseal(env,MASTER)


@pytest.mark.parametrize('token', [[], {}, 5, None, '非 ASCII'])
def test_invalid_preview_tokens_are_rejected_without_server_error(c, token):
    for path in ['/export/download','/import/apply','/restore/apply']:
        assert post(c,path,{'token':token,'confirm':'替换资料库'}).status_code == 409
    assert post(c,'/security/enable',{'token':token,'code':'000000'}).status_code == 409


def test_non_ascii_session_cookie_rejected(c):
    c.set_cookie('atlas_session','非法')
    assert c.get('/api/state').status_code == 401
