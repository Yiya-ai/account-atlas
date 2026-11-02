"""Local access gates. Call under the vault mutex; never trust proxy headers."""
import base64
import copy
import hashlib
import io
import ipaddress
import json
import re
import secrets
import time

import pyotp
import qrcode
from qrcode.image.svg import SvgPathImage

from .vault import Problem, dumps, now, seal, unseal


def defaults():
    return {"enabled": False, "secret": "", "lastStep": -1, "recoveryHashes": [], "changedAt": "", "passkeys": []}


def factor_enabled(config):
    return bool(config["enabled"] or config.get("passkeys"))


def validate_security(value):
    if not isinstance(value, dict) or set(value) not in (set(defaults()), set(defaults()) - {"passkeys"}):
        raise Problem("门禁配置损坏或版本不支持，无法解锁。")
    if type(value["enabled"]) is not bool or type(value["lastStep"]) is not int or value["lastStep"] < -1:
        raise Problem("门禁配置不正确。")
    if not isinstance(value["secret"], str) or (value["enabled"] and not re.fullmatch(r"[A-Z2-7]{32}", value["secret"])):
        raise Problem("门禁密钥不正确。")
    hashes = value["recoveryHashes"]
    if not isinstance(hashes, list) or len(hashes) > 8 or any(not isinstance(h, str) or not re.fullmatch(r"[a-f0-9]{64}", h) for h in hashes):
        raise Problem("门禁恢复码格式不正确。")
    if not isinstance(value["changedAt"], str) or len(value["changedAt"]) > 80:
        raise Problem("门禁更新时间不正确。")
    from .passkeys import validate_passkeys
    validate_passkeys(value.get("passkeys", []))


def address(value):
    try:
        if not isinstance(value, str) or "%" in value: raise ValueError()
        ip = ipaddress.ip_address(value)
        return ip.ipv4_mapped if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped else ip
    except ValueError:
        raise Problem("无法确认连接来源 IP，已拒绝访问。", 403) from None


def normalize_policy(value):
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool:
        raise Problem("IP 门禁配置不正确。")
    rules = value.get("rules")
    if not isinstance(rules, list) or len(rules) > 50:
        raise Problem("最多设置 50 条 IP 或 CIDR 网段。")
    result = []
    for rule in rules:
        try:
            if not isinstance(rule, str) or len(rule) > 80 or "%" in rule: raise ValueError()
            net = ipaddress.ip_network(rule.strip(), strict=False)
            if net.prefixlen < (8 if net.version == 4 else 16): raise ValueError()
            if net.version == 6 and net.network_address.ipv4_mapped:
                if net.prefixlen < 96: raise ValueError()
                net = ipaddress.ip_network(f"{net.network_address.ipv4_mapped}/{net.prefixlen - 96}")
                if net.prefixlen < 8: raise ValueError()
        except ValueError:
            raise Problem("IP / CIDR 格式不正确，IPv4 网段不能宽于 /8，IPv6 不能宽于 /16。") from None
        if str(net) not in result: result.append(str(net))
    if value["enabled"] and not result: raise Problem("启用 IP 门禁前请至少添加一条白名单。")
    return {"enabled": value["enabled"], "rules": result}


def matches(policy, ip):
    return any(ip in ipaddress.ip_network(rule) for rule in policy["rules"])


def recovery_hash(code):
    return hashlib.sha256(code.replace("-", "").upper().encode("ascii")).hexdigest()


def new_recovery():
    codes = ["-".join([raw[i:i+4] for i in range(0, 24, 4)]) for raw in [secrets.token_hex(12).upper() for _ in range(8)]]
    return codes, [recovery_hash(c) for c in codes]


def consume_code(config, raw):
    """Mutate only a candidate copy; caller persists before granting access."""
    if not isinstance(raw, str) or len(raw) > 80: return False
    code = raw.strip()
    if config["enabled"] and re.fullmatch(r"[0-9]{6}", code):
        step = int(time.time()) // 30
        totp = pyotp.TOTP(config["secret"])
        for counter in (step, step - 1, step + 1):
            if counter > config["lastStep"] and secrets.compare_digest(totp.at(counter * 30), code):
                config["lastStep"] = counter
                return True
        return False
    if re.fullmatch(r"[a-fA-F0-9-]{24,29}", code):
        hashed = recovery_hash(code)
        for existing in config["recoveryHashes"]:
            if secrets.compare_digest(existing, hashed):
                config["recoveryHashes"].remove(existing)
                return True
    return False


class Gates:
    def __init__(self, vault):
        self.vault = vault
        self.failures = []
        with vault.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS ip_gate (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL)")
        self.policy = self.read_policy()

    def read_policy(self):
        with self.vault.connect() as conn:
            row = conn.execute("SELECT policy FROM ip_gate WHERE id=1").fetchone()
        if not row: return {"enabled": False, "rules": ["127.0.0.1/32", "::1/128"]}
        try: return normalize_policy(json.loads(row[0]))
        except (ValueError, Problem): raise Problem("IP 门禁配置损坏，请通过本机恢复命令重设。", 503) from None

    def check_ip(self, raw):
        ip = address(raw)
        if self.policy["enabled"] and not matches(self.policy, ip):
            raise Problem("当前 IP 不在访问白名单中。请从允许的地址访问，或在本机恢复 IP 门禁。", 403)
        return str(ip)

    def throttle(self):
        cutoff = time.monotonic() - 900
        self.failures = [t for t in self.failures if t > cutoff]
        if len(self.failures) >= 10: raise Problem("验证尝试过多，请 15 分钟后再试。", 429)

    def reject(self):
        self.failures.append(time.monotonic())
        raise Problem("验证码或恢复码不正确、已使用或已过期。请检查验证器时间，或使用下一组验证码。", 400)

    def persist(self, data, key, salt, policy=None):
        data["revision"] += 1
        env = seal(data, key, salt)
        with self.vault.connect() as conn:
            conn.execute("UPDATE vault SET envelope=? WHERE id=1", (dumps(env),))
            if policy is not None:
                conn.execute("INSERT INTO ip_gate(id,policy) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET policy=excluded.policy", (dumps(policy),))
        if policy is not None: self.policy = policy

    def begin(self, password, ip):
        v = self.vault
        v.throttle(); self.throttle()
        env = v.envelope()
        if not env: raise Problem("请先创建资料库。")
        try: data, key, salt = unseal(env, password)
        except Problem: v.reject(); raise
        config = data.get("security", defaults())
        if not factor_enabled(config): return v.session(data, key, salt), None
        # A password alone never creates an authorized session or populates v.data.
        v.clear()
        token = secrets.token_urlsafe(32)
        v.pending_auth = {"token": token, "data": data, "key": key, "salt": salt, "ip": ip,
                          "expires": time.monotonic()+300, "attempts": 0}
        return None, token

    def finish(self, token, code, ip):
        v = self.vault; self.throttle()
        p = v.pending_auth
        if not p or not isinstance(token, str) or not token.isascii() or not secrets.compare_digest(token, p["token"]) or p["ip"] != ip:
            raise Problem("二次验证已失效，请重新输入主密码。", 401)
        if p["expires"] <= time.monotonic() or p["attempts"] >= 5:
            v.pending_auth = None
            raise Problem("二次验证已过期或尝试次数过多，请重新输入主密码。", 401)
        candidate = copy.deepcopy(p["data"])
        if not consume_code(candidate["security"], code):
            p["attempts"] += 1
            if p["attempts"] >= 5: v.pending_auth = None
            self.reject()
        self.persist(candidate, p["key"], p["salt"])
        return v.session(candidate, p["key"], p["salt"])

    def status(self, ip):
        config = self.vault.data.get("security", defaults())
        return {"enabled": config["enabled"], "factorEnabled": factor_enabled(config), "passkeys": [{k: p[k] for k in ("id", "name", "createdAt", "lastUsedAt")} for p in config.get("passkeys", [])], "recoveryRemaining": len(config["recoveryHashes"]),
                "changedAt": config["changedAt"], "ip": {**self.policy, "current": ip, "matched": matches(self.policy, address(ip))}}

    def reauth(self, password, code, proof=None):
        v = self.vault; v.throttle(); self.throttle()
        try: unseal(v.envelope(), password)
        except Problem:
            v.reject()
            raise Problem("主密码不正确，无法修改门禁。") from None
        data = copy.deepcopy(v.data)
        config = data.setdefault("security", defaults())
        valid_proof = v.passkey_proof and isinstance(proof,str) and proof.isascii() and secrets.compare_digest(proof,v.passkey_proof["token"]) and v.passkey_proof["expires"] > time.monotonic()
        if factor_enabled(config):
            if valid_proof: v.passkey_proof = None
            elif not consume_code(config, code): self.reject()
        return data

    def start_setup(self, password, code="", proof=None):
        if self.vault.data.get("security", defaults())["enabled"]: raise Problem("2FA 已启用，请先验证并关闭后重新绑定。", 409)
        data = self.reauth(password, code, proof)
        if factor_enabled(data["security"]):
            self.persist(data, self.vault.key, self.vault.salt)
            self.vault.data = data
        secret = pyotp.random_base32()
        uri = pyotp.TOTP(secret).provisioning_uri(name="本地资料库", issuer_name="Account Atlas")
        buffer = io.BytesIO()
        qrcode.make(uri, image_factory=SvgPathImage).save(buffer)
        token = secrets.token_urlsafe(24)
        self.vault.pending_setup = {"secret": secret, "token": token, "expires": time.monotonic()+600}
        return {"secret": secret, "token": token, "qr": "data:image/svg+xml;base64,"+base64.b64encode(buffer.getvalue()).decode(), "expiresIn": 600}

    def enable(self, token, code):
        self.throttle(); v = self.vault
        p = v.pending_setup
        if not p or not isinstance(token, str) or not token.isascii() or not secrets.compare_digest(p["token"], token) or p["expires"] <= time.monotonic():
            raise Problem("绑定已过期，请重新开始。", 409)
        config = {**defaults(), "enabled": True, "secret": p["secret"], "changedAt": now(), "passkeys": copy.deepcopy(v.data.get("security", {}).get("passkeys", []))}
        if not consume_code(config, code): self.reject()
        codes, config["recoveryHashes"] = new_recovery()
        data = copy.deepcopy(v.data); data["security"] = config
        self.persist(data, v.key, v.salt)
        token = v.session(data, v.key, v.salt)
        return token, codes

    def update(self, action, payload, ip):
        v = self.vault
        policy = None
        if action == "ip":
            policy = normalize_policy(payload)
            if policy["enabled"] and not matches(policy, address(ip)):
                raise Problem("白名单必须包含当前连接 IP，避免将自己锁在资料库之外。")
        if action not in ("ip", "disable", "recovery"): raise Problem("门禁操作不正确。")
        data = self.reauth(payload.get("password", ""), payload.get("code", ""), payload.get("proof"))
        config = data["security"]
        codes = None
        if action == "disable" and not config["enabled"]: raise Problem("尚未启用身份验证器。", 409)
        if action == "recovery" and not factor_enabled(config): raise Problem("尚未启用二次验证。", 409)
        if action == "disable":
            data["security"] = {**defaults(), "passkeys": config.get("passkeys", []), "recoveryHashes": config["recoveryHashes"] if config.get("passkeys") else []}
        elif action == "recovery": codes, config["recoveryHashes"] = new_recovery()
        data["security"]["changedAt"] = now()
        self.persist(data, v.key, v.salt, policy)
        token = v.session(data, v.key, v.salt)
        return token, codes
