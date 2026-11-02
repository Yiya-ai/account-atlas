import copy
import csv
import io
import json
import time
from pathlib import Path

import pytest
from backend.app import create_app
from backend.vault import KDF

MASTER = 'synthetic master passphrase 2026'
BACKUP = 'synthetic backup passphrase 2026'
H = {'X-Atlas-Request': '1'}


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path, testing=True)


@pytest.fixture
def c(app):
    client = app.test_client()
    assert client.post('/api/setup', json={'password': MASTER}, headers=H).status_code == 200
    return client


def post(c, path, value):
    return c.post('/api' + path, json=value, headers=H)


def add(c, **patch):
    data = {'platformId': 'google', 'identifier': 'owner@example.invalid', 'title': 'Private title',
            'notes': 'PRIVATE_NOTE_MARKER', 'secrets': {'password': '  exact,pass----word  ', 'totp': 'JBSWY3DPEHPK3PXP'},
            'tags': ['work'], 'customFields': [{'name': 'pin', 'value': 'secret-pin', 'secret': True}]}
    data.update(patch)
    r = post(c, '/accounts', data)
    assert r.status_code == 200, r.json
    return r.json


def test_setup_lock_restart_and_encrypted_disk(c, app):
    a = add(c)
    db = app.extensions['vault'].path
    raw = db.read_bytes()
    for marker in (b'owner@example.invalid', b'exact,pass', b'Private title', b'PRIVATE_NOTE_MARKER', b'secret-pin', MASTER.encode()):
        assert marker not in raw
    assert post(c, '/setup', {'password': MASTER}).status_code == 409
    assert post(c, '/lock', {}).status_code == 200
    assert c.get('/api/state').status_code == 401
    assert post(c, '/unlock', {'password': 'wrong'}).status_code == 401
    assert post(c, '/unlock', {'password': MASTER}).status_code == 200
    other = create_app(db.parent, testing=True).test_client()
    assert other.get('/api/state').status_code == 401
    assert post(other, '/unlock', {'password': MASTER}).status_code == 200
    assert post(other, f'/accounts/{a["id"]}/reveal', {}).json['secrets']['password'] == '  exact,pass----word  '


@pytest.mark.parametrize('method,path', [('get','/state'),('post','/accounts'),('post','/platforms'),('put','/platforms/fake'),('delete','/platforms/fake'),('post','/batch'),('post','/backup'),('post','/restore/preview'),('post','/restore/apply'),('post','/import/preview'),('post','/import/apply'),('post','/password'),('get','/accounts/fake'),('post','/accounts/fake/reveal'),('post','/accounts/fake/totp'),('put','/accounts/fake')])
def test_all_private_routes_require_session(app, method, path):
    c = app.test_client()
    assert getattr(c, method)('/api' + path, headers=H, **({'json': {}} if method != 'get' else {})).status_code == 401


def test_csrf_host_origin_and_headers(c):
    assert c.post('/api/batch', json={}).status_code == 403
    assert c.get('/api/state', headers={'Origin': 'https://other.example'}).status_code == 403
    assert c.get('/api/state', headers={'Host': 'attacker.example'}).status_code == 403
    assert c.get('/api/state', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
    r = c.get('/api/state')
    assert r.headers['Cache-Control'] == 'no-store'
    assert "frame-ancestors 'none'" in r.headers['Content-Security-Policy']
    assert 'Access-Control-Allow-Origin' not in r.headers


def test_platform_identity_search_and_minimal_lists(c):
    a = add(c)
    add(c, platformId='apple')
    assert post(c, '/accounts', {'platformId': 'google', 'identifier': 'OWNER@example.invalid'}).status_code == 409
    p = post(c, '/platforms', {'name': 'GitHub', 'url': 'https://github.com/login'}).json
    add(c, platformId=p['id'], identifier='owner', secrets={})
    assert post(c, '/platforms', {'name': 'bad', 'url': 'javascript:alert(1)'}).status_code == 400
    result = c.get('/api/state?q=PRIVATE_NOTE_MARKER').json
    assert len(result['accounts']) == 3
    assert 'secrets' not in result['accounts'][0] and 'notes' not in result['accounts'][0]
    assert c.get('/api/state?q=secret-pin').json['accounts'] == []
    detail = c.get(f'/api/accounts/{a["id"]}').json
    assert detail['customFields'][0]['value'] == '' and 'secrets' not in detail


def test_edit_revision_history_and_recycle(c):
    a = add(c)
    detail = c.get(f'/api/accounts/{a["id"]}').json
    detail.update(post(c, f'/accounts/{a["id"]}/reveal', {}).json)
    detail['title'] = 'Changed title'
    detail['revision'] = -1
    assert c.put(f'/api/accounts/{a["id"]}', json=detail, headers=H).status_code == 409
    detail['revision'] = c.get('/api/state').json['revision']
    assert c.put(f'/api/accounts/{a["id"]}', json=detail, headers=H).status_code == 200
    assert 'exact,pass' not in json.dumps(c.get(f'/api/accounts/{a["id"]}').json['history'])
    for action in ('trash', 'restore', 'archive', 'unarchive'):
        assert post(c, '/batch', {'ids': [a['id']], 'action': action}).status_code == 200
    assert post(c, '/batch', {'ids': [a['id']], 'action': 'purge', 'confirm': '永久删除'}).status_code == 400
    post(c, '/batch', {'ids': [a['id']], 'action': 'trash'})
    assert post(c, '/batch', {'ids': [a['id']], 'action': 'purge', 'confirm': '永久删除'}).status_code == 200
    assert not c.get('/api/state').json['accounts']


def test_batch_scope_tags_and_atomic_failure(c):
    a = add(c); b = add(c, identifier='other@example.invalid')
    assert post(c, '/batch', {'ids': [a['id']], 'action': 'tags_add', 'value': ['finance']}).status_code == 200
    entries = c.get('/api/state').json['accounts']
    assert entries[0]['tags'] == ['work', 'finance'] and entries[1]['tags'] == ['work']
    assert post(c, '/batch', {'ids': [a['id'], 'nonexistent'], 'action': 'trash'}).status_code == 409
    assert not any(a['deletedAt'] for a in c.get('/api/state').json['accounts'])


def import_body(**extra):
    return {'text': 'identifier,password,title\nuser@example.invalid,"  x,y----z  ",My account\n,nope,Invalid',
            'platformId': 'google', 'delimiter': ',', 'header': True, 'mapping': {'identifier': 0, 'password': 1, 'title': 2}, **extra}


def test_import_preview_commit_exact_password_and_duplicates(c):
    p = post(c, '/import/preview', import_body()).json
    assert p['added'] == 1 and p['invalid'] == 1
    assert 'x,y' not in json.dumps(p)
    assert c.get('/api/state').json['accounts'] == []
    assert post(c, '/import/apply', {'token': p['token']}).status_code == 200
    a = c.get('/api/state').json['accounts'][0]
    assert post(c, f'/accounts/{a["id"]}/reveal', {}).json['secrets']['password'] == '  x,y----z  '
    assert post(c, '/import/preview', import_body()).json['skipped'] == 1
    p = post(c, '/import/preview', import_body(text='identifier,password,title\nuser@example.invalid,new,New', mode='fill')).json
    post(c, '/import/apply', {'token': p['token']})
    assert post(c, f'/accounts/{a["id"]}/reveal', {}).json['secrets']['password'] == '  x,y----z  '
    p = post(c, '/import/preview', import_body(text='identifier,password,title\nuser@example.invalid,new,New', mode='replace')).json
    post(c, '/import/apply', {'token': p['token']})
    assert post(c, f'/accounts/{a["id"]}/reveal', {}).json['secrets']['password'] == 'new'


def test_stale_preview_rejected(c):
    p = post(c, '/import/preview', import_body()).json
    add(c)
    assert post(c, '/import/apply', {'token': p['token']}).status_code == 409


def test_backup_restore_tamper_and_new_machine(c, app, tmp_path):
    a = add(c)
    backup = post(c, '/backup', {'password': BACKUP}).json
    assert 'owner@example.invalid' not in json.dumps(backup)
    add(c, identifier='second@example.invalid')
    assert post(c, '/restore/preview', {'backup': backup, 'password': 'wrong'}).status_code == 401
    damaged = copy.deepcopy(backup); damaged['ciphertext'] = 'AAAA' + damaged['ciphertext'][4:]
    assert post(c, '/restore/preview', {'backup': damaged, 'password': BACKUP}).status_code == 401
    assert len(c.get('/api/state').json['accounts']) == 2
    hostile = copy.deepcopy(backup); hostile['kdf']['n'] = 2 ** 30
    assert post(c, '/restore/preview', {'backup': hostile, 'password': BACKUP}).status_code == 400
    p = post(c, '/restore/preview', {'backup': backup, 'password': BACKUP}).json
    assert p['accounts'] == 1
    assert post(c, '/restore/apply', {'token': p['token'], 'confirm': 'wrong'}).status_code == 400
    assert post(c, '/restore/apply', {'token': p['token'], 'confirm': '替换资料库'}).status_code == 200
    assert len(c.get('/api/state').json['accounts']) == 1
    checkpoints = list(app.extensions['vault'].directory.glob('before-restore-*.atlas'))
    assert len(checkpoints) == 1
    assert 'owner@example.invalid' not in checkpoints[0].read_text()
    new = create_app(tmp_path / 'new-machine', testing=True).test_client()
    r = post(new, '/setup', {'backup': backup, 'backupPassword': BACKUP, 'password': MASTER + ' new'})
    assert r.status_code == 200
    assert post(new, f'/accounts/{a["id"]}/reveal', {}).json['secrets']['password'] == '  exact,pass----word  '


def test_rotation_expiry_and_session_revocation(c, app):
    add(c)
    old_cookie = c.get_cookie('atlas_session').value
    assert post(c, '/password', {'current': MASTER, 'password': MASTER + 'changed'}).status_code == 200
    other = app.test_client(); other.set_cookie('atlas_session', old_cookie)
    assert other.get('/api/state').status_code == 401
    post(c, '/lock', {})
    assert post(c, '/unlock', {'password': MASTER}).status_code == 401
    assert post(c, '/unlock', {'password': MASTER + 'changed'}).status_code == 200
    vault = app.extensions['vault']; vault.last_used = time.monotonic() - 901
    assert c.get('/api/state').status_code == 401
    assert vault.key is None and vault.data is None and not vault.plans


def test_rate_limit_and_invalid_totp(c):
    assert post(c, '/accounts', {'platformId': 'apple', 'identifier': 'bad', 'secrets': {'totp': '123456'}}).status_code == 400
    post(c, '/lock', {})
    for _ in range(5): assert post(c, '/unlock', {'password': 'wrong'}).status_code == 401
    assert post(c, '/unlock', {'password': 'wrong'}).status_code == 429


def test_failed_disk_write_preserves_memory_and_disk(c, app, monkeypatch):
    a = add(c); vault = app.extensions['vault']; before = copy.deepcopy(vault.data)
    def broken(): raise OSError('simulated full disk')
    with monkeypatch.context() as patch:
        patch.setattr(vault, 'connect', broken)
        assert post(c, '/batch', {'ids': [a['id']], 'action': 'trash'}).status_code == 500
    assert vault.data == before
    post(c, '/lock', {}); post(c, '/unlock', {'password': MASTER})
    assert vault.data == before

def platform_edit(c, id, **patch):
    state = c.get('/api/state').json
    p = next(p for p in state['platforms'] if p['id'] == id)
    return c.put('/api/platforms/' + id, json={**p, **patch, 'revision': state['revision']}, headers=H)


def test_platform_management_protects_accounts_and_stale_edits(c):
    p = post(c, '/platforms', {'name': 'Example', 'url': 'https://example.invalid'}).json
    state = c.get('/api/state').json
    assert platform_edit(c, p['id'], name='Renamed').status_code == 200
    assert c.put('/api/platforms/' + p['id'], json={**p, 'revision': state['revision']}, headers=H).status_code == 409
    a = add(c, platformId=p['id'])
    post(c, '/batch', {'ids':[a['id']], 'action':'trash'})
    rev = c.get('/api/state').json['revision']
    assert c.delete('/api/platforms/' + p['id'], json={'revision':rev, 'confirm':'Renamed'}, headers=H).status_code == 409
    assert c.delete('/api/platforms/google', json={'revision':rev, 'confirm':'Google'}, headers=H).status_code == 400
    post(c, '/batch', {'ids':[a['id']], 'action':'purge', 'confirm':'永久删除'})
    rev = c.get('/api/state').json['revision']
    assert c.delete('/api/platforms/' + p['id'], json={'revision':rev, 'confirm':'wrong'}, headers=H).status_code == 400
    assert c.delete('/api/platforms/' + p['id'], json={'revision':rev, 'confirm':'Renamed'}, headers=H).status_code == 200


def test_field_templates_defaults_and_non_destructive_changes(c):
    assert platform_edit(c, 'google', fields=['password','totp','personalProfile'], fieldTemplates=[{'name':'Birthday','secret':True,'enabled':True}, {'name':'Disabled','secret':False,'enabled':False}]).status_code == 200
    a = add(c, personalProfile='PRIVATE_PROFILE', twoStepPhone='+000123', passkeys='Laptop', googlePrompt='Phone')
    detail = c.get('/api/accounts/' + a['id']).json
    assert [f['name'] for f in detail['customFields']] == ['pin','Birthday']
    assert detail['passkeys'] == 'Laptop'
    assert len(c.get('/api/state?q=PRIVATE_PROFILE').json['accounts']) == 1
    assert 'personalProfile' not in c.get('/api/state').json['accounts'][0]
    assert platform_edit(c, 'google', fields=[], fieldTemplates=[]).status_code == 200
    assert c.get('/api/accounts/' + a['id']).json == detail
    post(c,'/lock',{})
    assert post(c,'/unlock',{'password':MASTER}).status_code == 200
    assert c.get('/api/accounts/' + a['id']).json['personalProfile'] == 'PRIVATE_PROFILE'
    assert next(p for p in c.get('/api/state').json['platforms'] if p['id']=='google')['fields'] == []


def test_platform_field_validation(c):
    assert platform_edit(c, 'google', fields=['invented']).status_code == 400
    assert platform_edit(c, 'google', fieldTemplates=[{'name':'Birthday'},{'name':'birthday'}]).status_code == 400
    assert platform_edit(c, 'google', fieldTemplates=[{'name':'身份验证器'}]).status_code == 400
    assert platform_edit(c, 'google', name='Apple').status_code == 400


def test_templates_apply_to_import_and_survive_backup(c):
    assert platform_edit(c, 'google', fieldTemplates=[{'name':'Birthday','secret':True,'enabled':True}]).status_code == 200
    p = post(c,'/import/preview',import_body()).json
    assert post(c,'/import/apply',{'token':p['token']}).status_code == 200
    a = c.get('/api/state').json['accounts'][0]
    assert c.get('/api/accounts/'+a['id']).json['customFields'] == [{'name':'Birthday','secret':True,'value':''}]
    backup = post(c,'/backup',{'password':BACKUP}).json
    assert platform_edit(c,'google',fieldTemplates=[]).status_code == 200
    preview=post(c,'/restore/preview',{'backup':backup,'password':BACKUP}).json
    assert post(c,'/restore/apply',{'token':preview['token'],'confirm':'替换资料库'}).status_code == 200
    assert next(p for p in c.get('/api/state').json['platforms'] if p['id']=='google')['fieldTemplates'][0]['name'] == 'Birthday'


def test_live_totp_boundary_and_no_session_keepalive(c, app, monkeypatch):
    import pyotp
    a = add(c)
    vault=app.extensions['vault']
    last_used=vault.last_used
    monkeypatch.setattr('backend.app.time.time',lambda: 1735689629.5)
    first=post(c,f'/accounts/{a["id"]}/totp',{}).json
    assert first['code'] == pyotp.TOTP('JBSWY3DPEHPK3PXP').at(1735689629.5)
    assert first['expiresAt']==1735689630
    assert first['serverTime']==1735689629.5
    monkeypatch.setattr('backend.app.time.time',lambda:1735689630.1)
    second=post(c,f'/accounts/{a["id"]}/totp',{}).json
    assert second['code'] == pyotp.TOTP('JBSWY3DPEHPK3PXP').at(1735689630.1)
    assert second['expiresAt']==1735689660
    assert vault.last_used==last_used
    vault.last_used=time.monotonic()-901
    assert post(c,f'/accounts/{a["id"]}/totp',{}).status_code==401


@pytest.mark.parametrize('path', ['/import/analyze', '/import/template'])
def test_import_metadata_endpoints_require_unlock(app, path):
    assert post(app.test_client(), path, {'platformId':'google'}).status_code == 401


def csv_text(rows):
    stream = io.StringIO(newline='')
    csv.writer(stream).writerows(rows)
    return stream.getvalue()


def test_platform_template_roundtrip_all_fields_and_long_mapping(c):
    custom = [{'name':f'Field {i}', 'secret':i == 0, 'enabled':True} for i in range(25)]
    assert platform_edit(c, 'apple', fieldTemplates=custom).status_code == 200
    template = post(c, '/import/template', {'platformId':'apple'}).json
    assert template['csv'].startswith('\ufeff') and template['filename'].endswith('.csv')
    columns = next(csv.reader(io.StringIO(template['csv'].removeprefix('\ufeff'))))
    values = {'identifier':'apple@example.invalid', 'fullName':'Synthetic Name', 'birthday':'2001年1月1日', 'language':'中文\nEnglish', 'recoveryContacts':'Contact A\nContact B', 'legacyContacts':'Legacy contact', 'appleSignInApps':'App A\nApp B', 'password':'  secret,with spaces  ', 'custom:Field 0':'  CUSTOM_PRIVATE_MARKER  ', 'custom:Field 24':'last column'}
    raw = '\ufeff' + csv_text([columns, [values.get(f['key'],'') for f in template['fields']]])
    payload = {'platformId':'apple','text':raw,'header':True,'delimiter':','}
    analysis = post(c, '/import/analyze', payload).json
    assert len(analysis['mapping']) == len(template['fields']) > 30
    preview = post(c, '/import/preview', {**payload,'mapping':analysis['mapping']}).json
    assert preview['added'] == 1 and 'CUSTOM_PRIVATE_MARKER' not in json.dumps(preview)
    assert post(c, '/import/apply', {'token':preview['token']}).status_code == 200
    a = c.get('/api/state').json['accounts'][0]
    detail = c.get('/api/accounts/'+a['id']).json
    assert detail['birthday'] == '2001-01-01' and detail['language'] == '中文\nEnglish'
    assert detail['appleSignInApps'] == 'App A\nApp B'
    assert detail['customFields'][0]['value'] == ''
    secret = post(c, '/accounts/'+a['id']+'/reveal', {}).json
    assert secret['secrets']['password'] == '  secret,with spaces  '
    assert secret['customFields'][0]['value'] == '  CUSTOM_PRIVATE_MARKER  '
    assert secret['customFields'][-1]['value'] == 'last column'
    backup = post(c,'/backup',{'password':BACKUP}).json
    assert post(c,'/restore/preview',{'backup':backup,'password':BACKUP}).status_code == 200


def test_import_custom_fill_replace_and_preserve_other_values(c):
    assert platform_edit(c,'google',fieldTemplates=[{'name':'PIN','secret':True,'enabled':True}]).status_code == 200
    a = add(c, fullName='Original', customFields=[{'name':'PIN','value':'old','secret':True},{'name':'Extra','value':'keep','secret':False}])
    payload = {'platformId':'google','text':'owner@example.invalid,New,new-secret', 'header':False,'mapping':{'identifier':0,'fullName':1,'custom:PIN':2},'mode':'fill'}
    preview = post(c,'/import/preview',payload).json; post(c,'/import/apply',{'token':preview['token']})
    assert c.get('/api/accounts/'+a['id']).json['fullName'] == 'Original'
    assert post(c,'/accounts/'+a['id']+'/reveal',{}).json['customFields'][0]['value'] == 'old'
    preview = post(c,'/import/preview',{**payload,'mode':'replace','text':'owner@example.invalid,New,'}).json
    post(c,'/import/apply',{'token':preview['token']})
    assert c.get('/api/accounts/'+a['id']).json['fullName'] == 'New'
    secret = post(c,'/accounts/'+a['id']+'/reveal',{}).json
    assert secret['customFields'][0] == {'name':'PIN','value':'','secret':True}
    assert secret['customFields'][1]['value'] == 'keep'
    assert secret['secrets']['password'] == '  exact,pass----word  '


def test_invalid_import_row_does_not_partially_change_existing(c):
    a = add(c, fullName='Original')
    before = c.get('/api/accounts/'+a['id']).json
    payload = {'platformId':'google','text':'owner@example.invalid,Changed,2001-02-30\nother@example.invalid,Valid,2000-1-1', 'header':False,'mapping':{'identifier':0,'fullName':1,'birthday':2},'mode':'replace'}
    p = post(c,'/import/preview',payload).json
    assert p['invalid']==1 and p['added']==1
    post(c,'/import/apply',{'token':p['token']})
    assert c.get('/api/accounts/'+a['id']).json==before
    missing=post(c,'/import/preview',{**payload,'text':'owner@example.invalid,Changed'}).json
    assert missing['invalid']==1 and missing['updated']==0
    enum=post(c,'/import/preview',{**payload,'text':'owner@example.invalid,not-a-status','mapping':{'identifier':0,'status':1}}).json
    assert enum['invalid']==1


def test_schema_restrictions_header_ambiguity_and_platform_change(c):
    assert platform_edit(c,'google',fields=['password'],fieldTemplates=[{'name':'Comma, "quoted"','secret':True,'enabled':True},{'name':'Off','secret':False,'enabled':False}]).status_code == 200
    template=post(c,'/import/template',{'platformId':'google'}).json
    keys={f['key'] for f in template['fields']}
    assert 'password' in keys and 'birthday' not in keys and 'custom:Off' not in keys
    result=post(c,'/import/analyze',{'platformId':'google','text':template['csv'],'header':True}).json
    assert 'custom:Comma, "quoted"' in result['mapping']
    duplicate=post(c,'/import/analyze',{'platformId':'google','text':'账号,密码,密码\nx,a,b','header':True}).json
    assert 'password' not in duplicate['mapping'] and duplicate['warnings']
    no_header=post(c,'/import/analyze',{'platformId':'google','text':'x,password','header':False}).json
    assert no_header['mapping']=={}
    forbidden=post(c,'/import/preview',{'platformId':'google','text':'x,b','mapping':{'identifier':0,'birthday':1}})
    assert forbidden.status_code==400
    rev=c.get('/api/state').json['revision']
    assert platform_edit(c,'google',fields=[]).status_code==200
    assert post(c,'/import/preview',{'platformId':'google','text':'x','mapping':{'identifier':0},'revision':rev}).status_code==409


def test_legacy_chinese_profile_templates_and_backup_survive(c, app):
    vault=app.extensions['vault']
    old=copy.deepcopy(vault.data)
    old['platforms'][0].update(fields=['password'],fieldTemplates=[{'name':'生日','secret':True,'enabled':True}, {'name':'遗产联系人访问密钥','secret':True,'enabled':True}])
    vault.commit(old)
    post(c,'/lock',{})
    assert post(c,'/unlock',{'password':MASTER}).status_code==200
    google=next(p for p in c.get('/api/state').json['platforms'] if p['id']=='google')
    assert 'birthday' not in google['fields'] and 'fullName' in google['fields']
    assert any(f['key']=='custom:生日' and f['secret'] for f in google['importFields'])
    assert platform_edit(c,'google').status_code==200
    backup=post(c,'/backup',{'password':BACKUP}).json
    assert post(c,'/restore/preview',{'backup':backup,'password':BACKUP}).status_code==200


def export_plan(c, **payload):
    data = {'scope':'filtered', 'ids':[a['id'] for a in c.get('/api/state').json['accounts']], 'revision':c.get('/api/state').json['revision']}
    response = post(c,'/export/preview',{**data,**payload})
    assert response.status_code==200, response.json
    return response.json


def csv_rows(response):
    assert response.status_code==200
    return list(csv.reader(io.StringIO(response.data.decode('utf-8-sig'),newline='')))


@pytest.mark.parametrize('path',['/export/preview','/export/download'])
def test_export_endpoints_require_unlock(app,path):
    assert post(app.test_client(),path,{}).status_code==401


def test_export_selected_fields_and_sensitive_opt_in(c,app):
    a=add(c); add(c,identifier='excluded@example.invalid')
    before=app.extensions['vault'].path.read_bytes()
    p=export_plan(c,scope='selected',ids=[a['id']])
    assert p['count']==1
    assert all(not f['default'] for f in p['fields'] if f['secret'])
    assert 'secret-pin' not in json.dumps(p) and 'exact,pass' not in json.dumps(p)
    regular=csv_rows(post(c,'/export/download',{'token':p['token'],'fields':['identifier','title'],'format':'csv'}))
    assert regular==[['账号标识','显示名称'],['owner@example.invalid','Private title']]
    custom=next(f['key'] for f in p['fields'] if f.get('name')=='pin')
    with_secrets=csv_rows(post(c,'/export/download',{'token':p['token'],'fields':['identifier','password','totp',custom],'format':'csv','csvExact':True}))
    assert with_secrets[1]==['owner@example.invalid','  exact,pass----word  ','JBSWY3DPEHPK3PXP','secret-pin']
    assert before==app.extensions['vault'].path.read_bytes()


def test_export_platform_archive_trash_and_filtered_all_pages(c,app):
    a=add(c); b=add(c,identifier='archived@example.invalid'); d=add(c,identifier='trash@example.invalid'); add(c,identifier='apple@example.invalid',platformId='apple')
    post(c,'/batch',{'ids':[b['id']],'action':'archive'})
    post(c,'/batch',{'ids':[d['id']],'action':'trash'})
    assert export_plan(c,scope='platform',platformId='google')['count']==2
    assert export_plan(c,scope='platform',platformId='google',includeArchived=False)['count']==1
    assert export_plan(c,scope='platform',platformId='google',includeTrash=True)['count']==3
    # More than one UI page, with explicit order and a separate excluded record.
    ids=[add(c,identifier=f'page-{i}@example.invalid')['id'] for i in range(31)]
    p=export_plan(c,scope='filtered',ids=ids[::-1])
    rows=csv_rows(post(c,'/export/download',{'token':p['token'],'fields':['identifier'],'format':'csv'}))
    assert len(rows)==32 and rows[1][0]=='page-30@example.invalid' and rows[-1][0]=='page-0@example.invalid'
    assert not any('owner@example.invalid' in row for row in rows)


def test_export_custom_columns_are_platform_scoped_and_conservatively_sensitive(c):
    a=add(c,customFields=[{'name':'Shared','value':'Google secret','secret':True}])
    add(c,identifier='plain@example.invalid',customFields=[{'name':'shared','value':'Google public','secret':False}])
    add(c,platformId='apple',customFields=[{'name':'Shared','value':'Apple public','secret':False}])
    p=export_plan(c)
    columns=[f for f in p['fields'] if f.get('name','').lower()=='shared']
    assert len(columns)==2
    google=next(f for f in columns if f['platformId']=='google'); apple=next(f for f in columns if f['platformId']=='apple')
    assert google['secret'] and not apple['secret'] and not google['default']
    rows=csv_rows(post(c,'/export/download',{'token':p['token'],'fields':['platformName',google['key'],apple['key']],'format':'csv'}))
    assert rows[1:]==[['Google','Google secret',''],['Google','Google public',''],['Apple','','Apple public']]


def test_csv_safe_and_exact_modes_preserve_quotes_newlines_and_bom(c):
    a=add(c,title='=1+1',phone='+00123',notes='line 1\nline 2, "quoted"',secrets={'password':'  =PASSWORD()  '})
    p=export_plan(c)
    body={'token':p['token'],'fields':['title','phone','notes','password'],'format':'csv'}
    response=post(c,'/export/download',body)
    assert response.data.startswith(b'\xef\xbb\xbf')
    assert response.headers['Cache-Control']=='no-store'
    assert csv_rows(response)[1]==["'=1+1","'+00123",'line 1\nline 2, "quoted"',"'  =PASSWORD()  "]
    assert csv_rows(post(c,'/export/download',{**body,'csvExact':True}))[1]==['=1+1','+00123','line 1\nline 2, "quoted"','  =PASSWORD()  ']


def test_xlsx_is_real_workbook_literal_text_and_uses_no_temp_files(c,monkeypatch):
    import zipfile
    import xml.etree.ElementTree as ET
    add(c,identifier='001234567890123456789',title='=HYPERLINK("https://example.invalid")',notes='first\nsecond',secrets={'password':'  +PASS  '})
    p=export_plan(c)
    def no_temp(*args,**kwargs): raise AssertionError('plaintext temp file created')
    monkeypatch.setattr('tempfile.mkstemp',no_temp)
    response=post(c,'/export/download',{'token':p['token'],'fields':['identifier','title','notes','password'],'format':'xlsx'})
    assert response.status_code==200 and response.data.startswith(b'PK')
    assert 'spreadsheetml' in response.content_type and 'attachment;' in response.headers['Content-Disposition']
    ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(response.data)) as book:
        strings=ET.fromstring(book.read('xl/sharedStrings.xml'))
        texts=[''.join(si.itertext()) for si in strings]
        sheet=ET.fromstring(book.read('xl/worksheets/sheet1.xml'))
        assert not sheet.findall('.//s:f',ns)
        cells=sheet.findall('.//s:row[@r="2"]/s:c',ns)
        assert all(cell.get('t')=='s' for cell in cells)
        values=[texts[int(cell.find('s:v',ns).text)] for cell in cells]
        assert values==['001234567890123456789','=HYPERLINK("https://example.invalid")','first\nsecond','  +PASS  ']
        assert sheet.find('.//s:pane',ns).get('state')=='frozen'
        assert sheet.find('.//s:autoFilter',ns) is not None
        assert not any('externalLink' in name for name in book.namelist())


def test_export_rejects_bad_fields_stale_expired_empty_or_wrong_plans(c,app):
    add(c)
    p=export_plan(c)
    body={'token':p['token'],'fields':['identifier'],'format':'csv'}
    for fields in ([],['password','password'],['not-real'],['identifier']*129):
        assert post(c,'/export/download',{**body,'fields':fields}).status_code==400
    assert post(c,'/export/download',{**body,'format':'pdf'}).status_code==400
    assert post(c,'/export/download',{**body,'token':'missing'}).status_code==409
    empty=export_plan(c,ids=[])
    assert post(c,'/export/download',{**body,'token':empty['token']}).status_code==400
    app.extensions['vault'].plans[p['token']]['expires']=time.monotonic()-1
    assert post(c,'/export/download',body).status_code==409
    p=export_plan(c); add(c,identifier='changed@example.invalid')
    assert post(c,'/export/download',{**body,'token':p['token']}).status_code==409
    assert c.post('/api/export/preview',json={}).status_code==403
