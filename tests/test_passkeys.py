import copy
import hashlib
import json
import secrets

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from webauthn.helpers import bytes_to_base64url as b64, base64url_to_bytes as unb64

from backend.app import create_app
from test_vault import MASTER, H, app, c, post
from test_security import enable

ORIGIN='http://localhost:8765'
HEADERS={**H,'Host':'localhost:8765'}


def call(c,path,data={}):
    return c.post('/api'+path,json=data,headers=HEADERS)


class Authenticator:
    def __init__(self):
        self.key=ec.generate_private_key(ec.SECP256R1())
        self.id=secrets.token_bytes(24)
        self.counter=0
        self.handle=None

    def client(self,options,kind,**patch):
        return json.dumps({'type':kind,'challenge':options['challenge'],'origin':ORIGIN,'crossOrigin':False,**patch},separators=(',',':')).encode()

    def register(self,options,flags=0x45,**patch):
        self.handle=options['user']['id']
        public=self.key.public_key().public_numbers()
        cose=cbor2.dumps({1:2,3:-7,-1:1,-2:public.x.to_bytes(32,'big'),-3:public.y.to_bytes(32,'big')})
        data=hashlib.sha256(b'localhost').digest()+bytes([flags])+(0).to_bytes(4,'big')+bytes(16)+len(self.id).to_bytes(2,'big')+self.id+cose
        attestation=cbor2.dumps({'fmt':'none','authData':data,'attStmt':{}})
        return {'id':b64(self.id),'rawId':b64(self.id),'type':'public-key','response':{'clientDataJSON':b64(self.client(options,'webauthn.create',**patch)),'attestationObject':b64(attestation)}}

    def assert_key(self,options,flags=5,rp='localhost',**patch):
        self.counter+=1
        client=self.client(options,'webauthn.get',**patch)
        data=hashlib.sha256(rp.encode()).digest()+bytes([flags])+self.counter.to_bytes(4,'big')
        signature=self.key.sign(data+hashlib.sha256(client).digest(),ec.ECDSA(hashes.SHA256()))
        return {'id':b64(self.id),'rawId':b64(self.id),'type':'public-key','response':{'clientDataJSON':b64(client),'authenticatorData':b64(data),'signature':b64(signature),'userHandle':self.handle}}


def enroll(c,code='',auth=None):
    auth=auth or Authenticator()
    r=call(c,'/security/passkey/options',{'password':MASTER,'code':code,'name':'Test key'})
    assert r.status_code==200,r.json
    assert r.json['authenticatorSelection']['userVerification']=='required'
    result=call(c,'/security/passkey/register',{'credential':auth.register(r.json)})
    assert result.status_code==200,result.json
    return auth,result.json.get('recoveryCodes')


def challenge(c):
    post(c,'/lock',{})
    response=post(c,'/unlock',{'password':MASTER})
    assert response.json['mfaRequired'] and response.json['passkeyAvailable']
    return call(c,'/unlock/passkey/options').json


def test_passkey_only_login_recovery_and_replay(c,app):
    auth,codes=enroll(c)
    assert len(codes)==8
    assert c.get('/api/security').json['factorEnabled']
    assert not c.get('/api/security').json['enabled']
    assert 'publicKey' not in c.get('/api/security').text
    options=challenge(c)
    assert c.get('/api/state').status_code==401
    assertion=auth.assert_key(options)
    assert call(c,'/unlock/passkey/verify',{'credential':assertion}).status_code==200
    assert call(c,'/unlock/passkey/verify',{'credential':assertion}).status_code==401
    challenge(c)
    assert post(c,'/unlock/verify',{'code':codes[0]}).status_code==200
    assert c.get('/api/security').json['recoveryRemaining']==7
    other=create_app(app.extensions['vault'].directory,testing=True).test_client()
    assert post(other,'/unlock',{'password':MASTER}).json['passkeyAvailable']
    options=call(other,'/unlock/passkey/options').json
    assert call(other,'/unlock/passkey/verify',{'credential':auth.assert_key(options)}).status_code==200


@pytest.mark.parametrize('patch',[{'origin':'https://evil.example'},{'crossOrigin':True},{'challenge':'wrong'},{'flags':1},{'flags':4},{'rp':'evil.example'},{'userHandle':'wrong'},{'signature':'broken'},{'id':'unknown'}])
def test_assertion_rejects_bad_origin_challenge_uv_signature_rp(c,patch):
    auth,_=enroll(c)
    options=challenge(c)
    patches=copy.deepcopy(patch)
    response_changes={k:patches.pop(k) for k in ('userHandle','signature') if k in patches}
    id_value=patches.pop('id',None)
    response=auth.assert_key(options,**patches)
    response['response'].update(response_changes)
    if id_value: response['id']=id_value
    assert call(c,'/unlock/passkey/verify',{'credential':response}).status_code==400
    assert c.get('/api/state').status_code==401
    assert call(c,'/unlock/passkey/verify',{'credential':response}).status_code==409


@pytest.mark.parametrize('patch',[{'origin':'http://localhost:9999'},{'flags':0x41},{'crossOrigin':True}])
def test_registration_requires_origin_uv_and_top_level(c,patch):
    auth=Authenticator()
    options=call(c,'/security/passkey/options',{'password':MASTER,'name':'Test'}).json
    r=call(c,'/security/passkey/register',{'credential':auth.register(options,**patch)})
    assert r.status_code==400
    assert not c.get('/api/security').json['factorEnabled']


def test_manage_requires_password_and_new_factor_and_proof_is_single_use(c):
    auth,codes=enroll(c)
    id=b64(auth.id)
    payload={'action':'rename','id':id,'name':'Updated','password':MASTER}
    assert call(c,'/security/passkey/manage',payload).status_code==400
    assert call(c,'/security/passkey/options',{'password':MASTER,'name':'Another'}).status_code==400
    options=call(c,'/security/passkey/proof-options').json
    proof=call(c,'/security/passkey/proof',{'credential':auth.assert_key(options)}).json['proof']
    assert call(c,'/security/passkey/manage',{**payload,'password':'wrong','proof':proof}).status_code==400
    assert call(c,'/security/passkey/manage',{**payload,'proof':proof}).status_code==200
    assert call(c,'/security/passkey/manage',{**payload,'proof':proof}).status_code==400
    assert call(c,'/security/passkey/manage',{'action':'remove','id':id,'password':MASTER,'code':codes[0]}).status_code==200
    assert not c.get('/api/security').json['factorEnabled']
    assert c.get('/api/security').json['recoveryRemaining']==0
    post(c,'/lock',{})
    assert post(c,'/unlock',{'password':MASTER}).json=={'ok':True}


def test_totp_and_passkey_coexist(c):
    _,codes=enable(c)
    auth,new_codes=enroll(c,codes[0])
    assert new_codes is None
    options=challenge(c)
    assert call(c,'/unlock/passkey/verify',{'credential':auth.assert_key(options)}).status_code==200
    assert post(c,'/security/disable',{'password':MASTER,'code':codes[1]}).status_code==200
    assert c.get('/api/security').json['factorEnabled']
    assert len(c.get('/api/security').json['passkeys'])==1


def test_passkey_bound_to_pending_session_ip_expiry_and_revision(c,app):
    auth,codes=enroll(c)
    options=challenge(c)
    assertion=auth.assert_key(options)
    other=app.test_client()
    assert call(other,'/unlock/passkey/options').status_code==401
    assert c.post('/api/unlock/passkey/verify',json={'credential':assertion},headers=HEADERS,environ_overrides={'REMOTE_ADDR':'127.0.0.2'}).status_code==401
    app.extensions['vault'].pending_auth['webauthn']['expires']=0
    assert call(c,'/unlock/passkey/verify',{'credential':assertion}).status_code==409
    assert post(c,'/unlock/verify',{'code':codes[0]}).status_code==200
    options=call(c,'/security/passkey/proof-options').json
    app.extensions['vault'].data['revision']+=1
    assert call(c,'/security/passkey/proof',{'credential':auth.assert_key(options)}).status_code==409


def test_canonical_localhost_and_ip_origin_not_accepted(c):
    assert c.get('/',headers={'Host':'127.0.0.1:8765'}).location=='http://localhost:8765/'
    c.set_cookie('atlas_session',c.get_cookie('atlas_session').value,domain='127.0.0.1')
    assert c.post('/api/security/passkey/options',json={'password':MASTER,'name':'Key'},headers={**H,'Host':'127.0.0.1:8765'}).status_code==400


@pytest.mark.parametrize('path',['/security/passkey/options','/security/passkey/register','/security/passkey/manage','/security/passkey/proof-options','/security/passkey/proof','/unlock/passkey/options','/unlock/passkey/verify'])
def test_passkey_routes_auth_and_csrf(app,path):
    c=app.test_client()
    assert call(c,path).status_code==401
    assert c.post('/api'+path,json={},headers={'Host':'localhost:8765'}).status_code==403
