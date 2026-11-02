"""WebAuthn verification via py_webauthn; no private keys stored by the app."""
import copy
import json
import secrets
import time

from webauthn import generate_registration_options, generate_authentication_options, verify_registration_response, verify_authentication_response
from webauthn.helpers import bytes_to_base64url as encode, base64url_to_bytes as decode, options_to_json
from webauthn.helpers.structs import AuthenticatorSelectionCriteria, ResidentKeyRequirement, UserVerificationRequirement, PublicKeyCredentialDescriptor

from .vault import Problem, now
from .security import defaults, factor_enabled, new_recovery


def validate_passkeys(keys):
    if not isinstance(keys, list) or len(keys) > 10: raise Problem("最多保存 10 把通行密钥。")
    seen = set()
    for p in keys:
        if not isinstance(p, dict): raise Problem("通行密钥格式不正确。")
        for k, limit in (("id",2048),("publicKey",4096),("userHandle",128),("name",60),("createdAt",80),("lastUsedAt",80)):
            if not isinstance(p.get(k),str) or len(p[k]) > limit: raise Problem("通行密钥字段不正确。")
        if not p['id'] or p['id'] in seen or not p['name'].strip() or type(p.get('signCount')) is not int or p['signCount'] < 0:
            raise Problem("通行密钥标识或计数器不正确。")
        try:
            if not decode(p['publicKey']) or not decode(p['userHandle']) or not decode(p['id']): raise ValueError()
        except Exception: raise Problem("通行密钥编码不正确。") from None
        seen.add(p['id'])


def check_client(credential):
    # py_webauthn checks challenge/origin/RP/signature/UP/UV; reject embedded ceremonies too.
    if not isinstance(credential,dict) or len(json.dumps(credential)) > 40000: raise ValueError()
    raw = credential['response']['clientDataJSON']
    data = json.loads(decode(raw))
    if data.get('crossOrigin',False) is not False or data.get('topOrigin'): raise ValueError()


class Passkeys:
    def __init__(self, gates, port):
        self.gates, self.vault = gates, gates.vault
        self.origin = f"http://localhost:{port}"
        self.rp = 'localhost'

    def check_host(self, host):
        if 'http://'+host != self.origin:
            raise Problem("请通过 localhost 地址打开账号簿后使用通行密钥。", 400)

    def options(self, kind, data, ip, name=''):
        config = data.get('security',defaults())
        keys = config.get('passkeys',[])
        challenge = secrets.token_bytes(32)
        p = {'kind':kind, 'challenge':challenge, 'expires':time.monotonic()+120, 'ip':ip, 'revision':data['revision']}
        descriptors=[PublicKeyCredentialDescriptor(id=decode(k['id'])) for k in keys]
        if kind == 'register':
            if len(keys) >= 10: raise Problem("最多保存 10 把通行密钥。")
            handle=decode(keys[0]['userHandle']) if keys else secrets.token_bytes(32)
            p.update(name=name,userHandle=encode(handle))
            options=generate_registration_options(rp_id=self.rp,rp_name='Account Atlas',user_name='local-vault',user_display_name='账号簿本地资料库',user_id=handle,challenge=challenge,timeout=120000,
                exclude_credentials=descriptors,authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.REQUIRED,user_verification=UserVerificationRequirement.REQUIRED))
        else:
            if not keys: raise Problem("尚未绑定通行密钥。")
            options=generate_authentication_options(rp_id=self.rp,challenge=challenge,timeout=120000,allow_credentials=descriptors,user_verification=UserVerificationRequirement.REQUIRED)
        return p,json.loads(options_to_json(options))

    def start_register(self, payload, ip):
        name=payload.get('name','')
        if not isinstance(name,str) or not 1 <= len(name.strip()) <= 60: raise Problem("请填写 1–60 字的通行密钥名称。")
        v=self.vault
        data=self.gates.reauth(payload.get('password',''),payload.get('code',''),payload.get('proof'))
        # Persist consumed recovery/TOTP credentials even if the OS prompt is cancelled.
        if factor_enabled(data['security']): self.gates.persist(data,v.key,v.salt); v.data=data
        v.webauthn,options=self.options('register',v.data,ip,name.strip())
        return options

    def take(self, container, kind, ip, data):
        p=container.pop('webauthn',None)
        if not p or p['kind'] != kind or p['expires'] <= time.monotonic() or p['ip'] != ip or p['revision'] != data['revision']:
            raise Problem("通行密钥验证已失效，请重新开始。",409)
        return p

    def register(self, payload, ip):
        v=self.vault; self.gates.throttle()
        holder={'webauthn':v.webauthn}; v.webauthn=None
        p=self.take(holder,'register',ip,v.data)
        credential=payload.get('credential')
        try:
            check_client(credential)
            result=verify_registration_response(credential=credential,expected_challenge=p['challenge'],expected_origin=self.origin,expected_rp_id=self.rp,require_user_verification=True)
        except Exception:
            self.gates.failures.append(time.monotonic())
            raise Problem("通行密钥注册校验失败，请重新开始并完成设备验证。") from None
        data=copy.deepcopy(v.data); config=data.setdefault('security',defaults()); keys=config.setdefault('passkeys',[])
        if any(k['id']==encode(result.credential_id) for k in keys): raise Problem("此通行密钥已绑定。",409)
        codes=None
        if not factor_enabled(config): codes,config['recoveryHashes']=new_recovery()
        keys.append({'id':encode(result.credential_id),'publicKey':encode(result.credential_public_key),'userHandle':p['userHandle'],'signCount':result.sign_count,'name':p['name'],'createdAt':now(),'lastUsedAt':''})
        config['changedAt']=now()
        self.gates.persist(data,v.key,v.salt)
        return v.session(data,v.key,v.salt),codes

    def pending(self, token, ip):
        v=self.vault; p=v.pending_auth
        if not p or not isinstance(token,str) or not token.isascii() or not secrets.compare_digest(token,p['token']) or p['ip']!=ip:
            raise Problem("请重新输入主密码。",401)
        if p['expires']<=time.monotonic() or p['attempts']>=5:
            v.pending_auth=None; raise Problem("验证已过期，请重新输入主密码。",401)
        return p

    def start_assertion(self, ip, token=None):
        self.gates.throttle(); v=self.vault
        if token is not None:
            p=self.pending(token,ip)
            p['webauthn'],options=self.options('login',p['data'],ip)
        else: v.webauthn,options=self.options('reauth',v.data,ip)
        return options

    def assertion(self, credential, ip, token=None):
        self.gates.throttle(); v=self.vault
        if token is not None:
            pending=self.pending(token,ip); source=pending['data']; p=self.take(pending,'login',ip,source)
        else:
            source=v.data; holder={'webauthn':v.webauthn}; v.webauthn=None; p=self.take(holder,'reauth',ip,source)
        data=copy.deepcopy(source)
        try:
            check_client(credential)
            key=next(k for k in data['security']['passkeys'] if k['id']==credential.get('id'))
            handle=credential['response'].get('userHandle')
            if handle is not None and decode(handle)!=decode(key['userHandle']): raise ValueError()
            result=verify_authentication_response(credential=credential,expected_challenge=p['challenge'],expected_origin=self.origin,expected_rp_id=self.rp,
                credential_public_key=decode(key['publicKey']),credential_current_sign_count=key['signCount'],require_user_verification=True)
        except Exception:
            self.gates.failures.append(time.monotonic())
            if token is not None:
                pending['attempts']+=1
                if pending['attempts']>=5: v.pending_auth=None
            raise Problem("通行密钥验证失败，请重新尝试，或使用验证码 / 恢复码。") from None
        key['signCount']=result.new_sign_count; key['lastUsedAt']=now()
        if token is not None:
            self.gates.persist(data,pending['key'],pending['salt'])
            return v.session(data,pending['key'],pending['salt'])
        self.gates.persist(data,v.key,v.salt); v.data=data
        proof=secrets.token_urlsafe(32)
        v.passkey_proof={'token':proof,'expires':time.monotonic()+120}
        return proof

    def manage(self, payload):
        v=self.vault
        data=self.gates.reauth(payload.get('password',''),payload.get('code',''),payload.get('proof'))
        config=data['security']; keys=config.get('passkeys',[])
        target=next((k for k in keys if k['id']==payload.get('id')),None)
        if not target: raise Problem("通行密钥不存在。",404)
        if payload.get('action')=='rename':
            name=payload.get('name','')
            if not isinstance(name,str) or not 1<=len(name.strip())<=60: raise Problem("请填写 1–60 字名称。")
            target['name']=name.strip()
        elif payload.get('action')=='remove':
            config['passkeys']=[k for k in keys if k is not target]
            if not factor_enabled(config): config['recoveryHashes']=[]
        else: raise Problem("通行密钥操作不正确。")
        config['changedAt']=now(); self.gates.persist(data,v.key,v.salt)
        return v.session(data,v.key,v.salt)
