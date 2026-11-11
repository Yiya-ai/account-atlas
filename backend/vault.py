"""Versioned, authenticated encrypted vault. Only ciphertext is persisted."""
import base64
import copy
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

AAD = b"account-atlas/v1"
KDF = {"name": "scrypt", "n": 131072, "r": 8, "p": 1}
MAX_ACCOUNTS = 10000
SECRET_FIELDS = ("password", "totp", "recoveryCodes", "appPassword", "recoveryKey", "legacyAccessKey")
TEXT_FIELDS = ("title", "identifier", "email", "phone", "region", "group", "notes", "recoveryEmail", "trustedDevices", "loginMethod", "linkedAccount", "verification", "personalProfile", "twoStepPhone", "passkeys", "googlePrompt")
FIELD_LABELS = {"email": "联系邮箱", "phone": "绑定手机号 / 受信任电话", "region": "地区", "recoveryEmail": "恢复邮箱", "trustedDevices": "受信任设备", "loginMethod": "登录方式", "linkedAccount": "关联账号", "verification": "两步验证方式", "personalProfile": "个人资料", "twoStepPhone": "两步验证手机号", "passkeys": "通行密钥备注", "googlePrompt": "Google 提示", "password": "登录密码", "totp": "身份验证器（TOTP 密钥）", "recoveryCodes": "恢复码 / 备用码", "appPassword": "应用专用密码", "recoveryKey": "恢复密钥", "notes": "备注"}
PROFILE_FIELDS = {"fullName": "姓名", "gender": "性别", "birthday": "生日", "language": "语言", "homeAddress": "住址", "workAddress": "工作地址", "country": "国家或地区", "loginPhones": "登录电话号码", "passwordUpdatedAt": "密码上次更新日期", "recoveryStatus": "账户恢复状态", "recoveryContacts": "账户恢复联系人", "legacyContacts": "遗产联系人", "appleSignInApps": "通过 Apple 登录的 App / 网站"}
APPLE_EXTRA_FIELDS = {"securityKeys": "实体安全密钥", "paymentMethods": "付款方式备注", "shippingAddress": "配送地址", "subscriptions": "订阅备注", "familySharing": "家人共享", "devices": "关联设备", "hideMyEmail": "隐藏邮件地址", "icloudAnalytics": "iCloud 分析", "appleMessages": "来自 Apple 的信息"}
PROFILE_FIELDS.update(APPLE_EXTRA_FIELDS)
TEXT_FIELDS += tuple(PROFILE_FIELDS)
FIELD_LABELS.update(PROFILE_FIELDS, legacyAccessKey="遗产联系人访问密钥")
APPLE_FIELD_LABELS = {"identifier": "Apple 账户（主要邮箱或电话号码）", "email": "其他电子邮件地址", "phone": "受信任电话号码", "region": "商店地区", "birthday": "出生日期", "verification": "双重认证", "appPassword": "App 专用密码"}
APPLE_FIELDS = {"email", "phone", "region", "trustedDevices", "verification", "password", "appPassword", "recoveryKey", "legacyAccessKey", "notes", "fullName", "birthday", "language", "country", "gender", "loginPhones", "passwordUpdatedAt", "recoveryStatus", "recoveryContacts", "legacyContacts", "appleSignInApps", *APPLE_EXTRA_FIELDS}
PROFILE_DEFAULTS = {
    "google": ["fullName", "gender", "birthday", "language", "homeAddress", "workAddress"],
    "apple": ["fullName", "birthday", "language", "country", "loginPhones", "passwordUpdatedAt"],
    "custom": [],
}
PROFILE_ALIASES = {"fullName": {"姓名"}, "birthday": {"生日", "出生日期"}, "country": {"国家或地区", "国家/地区"}, **{k: {v} for k, v in PROFILE_FIELDS.items() if k not in ("fullName", "birthday", "country")}}


def platform_config(p):
    out = copy.deepcopy(p)
    excluded = {"personalProfile", "twoStepPhone", "passkeys", "googlePrompt", "trustedDevices"}
    if p["template"] == "google": excluded = {"trustedDevices", "recoveryKey"}
    if p["template"] == "apple": excluded = {"googlePrompt", "twoStepPhone", "totp"}
    excluded |= set(PROFILE_FIELDS) | {"legacyAccessKey"}
    legacy_names = {f["name"].casefold() for f in out.get("fieldTemplates", [])}
    defaults = ["email", "phone", "verification", "password", "appPassword", "securityKeys", "notes"] if p["template"] == "apple" else [key for key in FIELD_LABELS if key not in excluded]
    defaults = [key for key in defaults if not legacy_names.intersection(PROFILE_ALIASES.get(key, set()))]
    out.setdefault("fields", defaults)
    out.setdefault("fieldTemplates", [])
    if out.get("fieldVersion", 1) < 2:
        for key in PROFILE_DEFAULTS[p["template"]]:
            if key not in out["fields"] and not legacy_names.intersection(PROFILE_ALIASES[key]): out["fields"].append(key)
    out["fieldVersion"] = 2
    # Presentation policy only: account values and custom templates remain intact.
    out["availableFields"] = [key for key in FIELD_LABELS if p["template"] != "apple" or key in APPLE_FIELDS]
    out["fieldLabels"] = APPLE_FIELD_LABELS.copy() if p["template"] == "apple" else {}
    if p["template"] == "apple":
        out["fields"] = [key for key in out["fields"] if key in APPLE_FIELDS]
    return out


class Problem(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def uid():
    return uuid.uuid4().hex


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def b64(value):
    return base64.b64encode(value).decode("ascii")


def password_check(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 1024:
        raise Problem("密码需为 12–1024 个字符，建议使用多个不相关的词。")


def derive(password, salt):
    if not isinstance(password, str) or len(password) > 1024:
        raise Problem("密码格式不正确。")
    return Scrypt(salt=salt, length=32, n=KDF["n"], r=8, p=1).derive(password.encode("utf-8"))


def seal(data, key, salt):
    plaintext = dumps(data).encode()
    if len(plaintext) > 10 * 1024 * 1024:
        raise Problem("资料库超过本地版 10 MB 内容上限，请缩短备注或移除不需要的资料。")
    nonce = os.urandom(12)
    return {"format": "account-atlas", "version": 1, "kdf": KDF,
            "salt": b64(salt), "nonce": b64(nonce),
            "ciphertext": b64(AESGCM(key).encrypt(nonce, plaintext, AAD))}


def unseal(envelope, password):
    # Fixed parameters prevent malicious backups from requesting arbitrary KDF work.
    try:
        if not isinstance(envelope, dict) or envelope.get("format") != "account-atlas" or envelope.get("version") != 1 or envelope.get("kdf") != KDF:
            raise ValueError()
        salt = base64.b64decode(envelope["salt"], validate=True)
        nonce = base64.b64decode(envelope["nonce"], validate=True)
        ct = base64.b64decode(envelope["ciphertext"], validate=True)
        if len(salt) != 16 or len(nonce) != 12 or not 16 <= len(ct) <= 16 * 1024 * 1024:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise Problem("文件格式不正确或版本暂不支持。") from None
    key = derive(password, salt)
    try:
        data = json.loads(AESGCM(key).decrypt(nonce, ct, AAD))
    except (InvalidTag, ValueError, UnicodeError):
        raise Problem("密码不正确，或加密文件已损坏。", 401) from None
    validate_vault(data)
    return data, key, salt


def text(value, limit=2000):
    if not isinstance(value, str) or len(value) > limit:
        raise Problem(f"字段须为文本且不超过 {limit} 个字符。")
    return value


def boolean(value):
    if type(value) is not bool:
        raise Problem("开关字段须为布尔值。")
    return value


def custom_fields(a, platforms):
    """A platform's sensitive designation also protects pre-existing records."""
    p = next(p for p in platforms if p["id"] == a["platformId"])
    sensitive = {f["name"].casefold() for f in p.get("fieldTemplates", []) if f["secret"]}
    return [{**f, "secret": f["secret"] or f["name"].casefold() in sensitive} for f in a["customFields"]]


def tags(value):
    if not isinstance(value, list) or len(value) > 30:
        raise Problem("最多可设置 30 个标签。")
    return list(dict.fromkeys(text(v, 60).strip() for v in value if v))


def platform(value):
    if not isinstance(value, dict):
        raise Problem("平台资料格式不正确。")
    name = text(value.get("name", ""), 60).strip()
    url = text(value.get("url", ""), 1000).strip()
    if not name:
        raise Problem("请输入平台名称。")
    try:
        if url and (urlparse(url).scheme not in ("http", "https") or not urlparse(url).hostname):
            raise ValueError()
    except ValueError:
        raise Problem("网址必须以 https:// 或 http:// 开头，且地址格式有效。") from None
    out = {"id": text(value.get("id", uid()), 80), "name": name, "url": url,
           "template": value.get("template") if value.get("template") in ("google", "apple") else "custom"}
    if "fieldVersion" in value:
        if value["fieldVersion"] != 2: raise Problem("平台字段版本不受支持。")
        out["fieldVersion"] = 2
    if "fields" in value:
        fields = value["fields"]
        if not isinstance(fields, list) or any(not isinstance(k, str) or k not in FIELD_LABELS for k in fields) or len(set(fields)) != len(fields):
            raise Problem("默认字段配置不正确。")
        out["fields"] = fields
    if "fieldTemplates" in value:
        templates = value["fieldTemplates"]
        if not isinstance(templates, list) or len(templates) > 30:
            raise Problem("最多配置 30 个自定义字段。")
        # Preserve earlier custom templates such as 姓名/生日/语言 in old backups.
        seen = {label.casefold() for k, label in FIELD_LABELS.items() if k not in PROFILE_FIELDS and k != "legacyAccessKey"} | {"身份验证器", "totp 密钥", "通行密钥", "账号标识", "显示名称", "分组", "标签", "状态"}
        out["fieldTemplates"] = []
        for field in templates:
            if not isinstance(field, dict): raise Problem("字段配置不正确。")
            label = text(field.get("name", ""), 100).strip()
            if not label or label.casefold() in seen: raise Problem("字段名称为空或重复，请优先启用已有字段。")
            if any(key in value.get("fields", []) and label.casefold() in aliases for key, aliases in PROFILE_ALIASES.items()):
                raise Problem("同名个人信息字段已启用，请保留内置字段或原自定义字段其中一个。")
            seen.add(label.casefold())
            out["fieldTemplates"].append({"name": label, "secret": boolean(field.get("secret", False)), "enabled": boolean(field.get("enabled", True))})
    return out


def account(value, platforms, previous=None, *, legacy_duplicates=False):
    if not isinstance(value, dict):
        raise Problem("账号资料格式不正确。")
    out = {field: text(value.get(field, ""), 12000 if field == "notes" else 2000).strip() for field in TEXT_FIELDS}
    for key in ("birthday", "passwordUpdatedAt"):
        if out[key]:
            try: date.fromisoformat(out[key])
            except ValueError: raise Problem(f"{FIELD_LABELS[key]}请使用 YYYY-MM-DD 格式。") from None
    if not out["identifier"]:
        raise Problem("请输入账号标识（邮箱、手机号或用户名）。")
    out["platformId"] = text(value.get("platformId", ""), 80)
    if out["platformId"] not in {p["id"] for p in platforms}:
        raise Problem("请选择有效的平台。")
    out["title"] = out["title"] or out["identifier"]
    out["tags"] = tags(value.get("tags", []))
    out["status"] = value.get("status", "active")
    if out["status"] not in ("active", "reserve", "attention", "disabled"):
        raise Problem("账号状态不正确。")
    out["favorite"] = boolean(value.get("favorite", False))
    out["archived"] = boolean(value.get("archived", False))
    sec = value.get("secrets", {})
    if not isinstance(sec, dict):
        raise Problem("敏感字段格式不正确。")
    out["secrets"] = {k: text(sec.get(k, ""), 16000) for k in SECRET_FIELDS}
    if out["secrets"]["totp"]:
        import pyotp
        out["secrets"]["totp"] = "".join(out["secrets"]["totp"].split()).upper()
        try:
            pyotp.TOTP(out["secrets"]["totp"]).now()
        except Exception:
            raise Problem("TOTP 密钥无效，请填写 Base32 密钥，而不是六位验证码。") from None
    custom = copy.deepcopy(value.get("customFields", []))
    if not isinstance(custom, list) or len(custom) > 30:
        raise Problem("最多可设置 30 个自定义字段。")
    names = set()
    for field in custom:
        if not isinstance(field, dict): raise Problem("自定义字段格式不正确。")
        field["name"] = text(field.get("name", ""), 100).strip()
        name = field["name"].casefold()
        if not name or (name in names and not legacy_duplicates):
            raise Problem("自定义字段名称不能为空或重复（不区分大小写）。")
        names.add(name)
    if not previous and isinstance(custom, list):
        config = platform_config(next(p for p in platforms if p["id"] == out["platformId"]))
        for field in config["fieldTemplates"]:
            if field["enabled"] and not any(isinstance(f, dict) and f.get("name", "").casefold() == field["name"].casefold() for f in custom):
                custom.append({"name": field["name"], "value": "", "secret": field["secret"]})
    if not isinstance(custom, list) or len(custom) > 30:
        raise Problem("最多可设置 30 个自定义字段。")
    out["customFields"] = []
    for field in custom:
        if not isinstance(field, dict):
            raise Problem("自定义字段格式不正确。")
        name = text(field.get("name", ""), 100).strip()
        if not name:
            raise Problem("请填写自定义字段名称。")
        out["customFields"].append({"name": name, "value": text(field.get("value", ""), 12000), "secret": boolean(field.get("secret", False))})
    out["customFields"] = custom_fields(out, platforms)
    out.update(id=previous["id"] if previous else uid(), createdAt=previous["createdAt"] if previous else now(), updatedAt=now(),
               deletedAt=previous.get("deletedAt") if previous else None, history=copy.deepcopy(previous.get("history", [])) if previous else [])
    return out


def identity(a):
    # Case folding is applied only to email-shaped identifiers, not arbitrary usernames.
    ident = a["identifier"].strip()
    return a["platformId"], ident.casefold() if "@" in ident else ident


def audit(a, action, fields=None):
    a["updatedAt"] = now()
    a["history"] = ([{"at": now(), "action": action, "fields": fields or []}] + a.get("history", []))[:50]


def summary(a):
    keys = {"id", "platformId", "title", "identifier", "email", "phone", "region", "group", "tags", "status", "loginMethod", "linkedAccount", "verification", "favorite", "archived", "createdAt", "updatedAt", "deletedAt"}
    out = {k: copy.deepcopy(v) for k, v in a.items() if k in keys}
    out["hasPassword"] = bool(a["secrets"]["password"])
    out["hasTotp"] = bool(a["secrets"]["totp"])
    return out


def empty_vault():
    return {"schema": 1, "revision": 0, "platforms": [
        {"id": "google", "name": "Google", "template": "google", "url": "https://accounts.google.com/"},
        {"id": "apple", "name": "Apple", "template": "apple", "url": "https://account.apple.com/"}], "accounts": []}


def validate_vault(data):
    if not isinstance(data, dict) or data.get("schema") != 1 or type(data.get("revision")) is not int or data["revision"] < 0:
        raise Problem("资料版本不受支持。")
    if "security" in data:
        from .security import validate_security
        validate_security(data["security"])
    ps, entries = data.get("platforms"), data.get("accounts")
    if not isinstance(ps, list) or not 1 <= len(ps) <= 200 or not isinstance(entries, list) or len(entries) > MAX_ACCOUNTS:
        raise Problem("备份资料数量或结构不正确。")
    seen = set()
    for p in ps:
        if platform(p) != p or p["id"] in seen:
            raise Problem("备份中的平台资料不正确。")
        seen.add(p["id"])
    ids, identities = set(), set()
    for a in entries:
        try:
            normalized = account(a, ps, a, legacy_duplicates=True)
            if not text(a["id"], 80).strip(): raise Problem("备份账号 ID 不能为空。")
            text(a["createdAt"], 80)
            text(a["updatedAt"], 80)
            if a.get("deletedAt") is not None:
                text(a["deletedAt"], 80)
            if not isinstance(a.get("history"), list) or len(a["history"]) > 50:
                raise Problem("历史记录格式不正确。")
            for h in a["history"]:
                text(h["at"], 80); text(h["action"], 100)
                if not isinstance(h.get("fields", []), list) or len(h.get("fields", [])) > 128: raise Problem("历史字段记录不正确。")
                for field in h.get("fields", []): text(field, 200)
            if a["id"] in ids or identity(a) in identities:
                raise Problem("备份中存在重复账号。")
            ids.add(a["id"]); identities.add(identity(a))
            # Do not accept ambiguous sensitivity in an encrypted backup. Older
            # application-created records always contain this boolean marker.
            for field in a.get("customFields", []):
                if type(field.get("secret")) is not bool: raise Problem("备份自定义字段缺少敏感标记。")
            # Fill older optional fields only after validation; never keep raw,
            # unvalidated types that can poison later search/detail operations.
            normalized["updatedAt"] = a["updatedAt"]
            a.clear(); a.update(normalized)
        except (KeyError, TypeError):
            raise Problem("备份账号结构不完整。") from None
    for a in entries:
        if a.get("linkedAccount") and a["linkedAccount"] not in ids:
            raise Problem("备份中的关联账号不存在。")


class Vault:
    def __init__(self, directory, idle_seconds=900):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "vault.db"
        self.mutex = threading.RLock()
        self.idle_seconds = idle_seconds
        self.clear()
        self.failures, self.next_attempt = 0, 0
        with self.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id=1), envelope TEXT NOT NULL)")

    def connect(self):
        conn = sqlite3.connect(self.path)
        conn.execute("PRAGMA synchronous=FULL")
        return conn

    def clear(self):
        self.data = self.key = self.salt = self.token = None
        self.pending_auth = self.pending_setup = None
        self.webauthn = self.passkey_proof = None
        self.last_used = 0
        self.plans = {}

    def envelope(self):
        with self.connect() as conn:
            row = conn.execute("SELECT envelope FROM vault WHERE id=1").fetchone()
        return json.loads(row[0]) if row else None

    def active(self, token, touch=True):
        if self.token and time.monotonic() - self.last_used >= self.idle_seconds:
            self.clear()
        if not self.token or not isinstance(token, str) or not token.isascii() or not secrets.compare_digest(self.token, token):
            raise Problem("资料库已锁定，请重新解锁。", 401)
        if touch:
            self.last_used = time.monotonic()

    def throttle(self):
        if time.monotonic() < self.next_attempt:
            raise Problem("尝试过于频繁，请稍后再试。", 429)

    def reject(self):
        self.failures += 1
        if self.failures >= 5:
            self.next_attempt = time.monotonic() + min(60, 2 ** min(self.failures - 4, 6))

    def session(self, data, key, salt):
        self.clear()
        self.data, self.key, self.salt = data, key, salt
        self.token = secrets.token_urlsafe(32)
        self.last_used = time.monotonic()
        self.failures = self.next_attempt = 0
        return self.token

    def setup(self, password, backup=None, backup_password=""):
        if self.envelope():
            raise Problem("资料库已存在，请解锁。", 409)
        password_check(password)
        data = unseal(backup, backup_password)[0] if backup else empty_vault()
        # Access gates belong to this installation, not a portable account backup.
        data.pop("security", None)
        salt = os.urandom(16)
        key = derive(password, salt)
        env = seal(data, key, salt)
        with self.connect() as conn:
            conn.execute("INSERT INTO vault(id,envelope) VALUES(1,?)", (dumps(env),))
        return self.session(data, key, salt)

    def unlock(self, password):
        self.throttle()
        env = self.envelope()
        if not env:
            raise Problem("请先创建资料库。")
        try:
            data, key, salt = unseal(env, password)
        except Problem:
            self.reject()
            raise
        if data.get("security", {}).get("enabled") or data.get("security", {}).get("passkeys"):
            raise Problem("此资料库需通过二次验证流程解锁。", 401)
        return self.session(data, key, salt)

    def commit(self, data):
        if len(data["accounts"]) > MAX_ACCOUNTS:
            raise Problem("本地版最多保存 10000 条账号。")
        data["revision"] = self.data["revision"] + 1
        env = seal(data, self.key, self.salt)
        with self.connect() as conn:
            conn.execute("UPDATE vault SET envelope=? WHERE id=1", (dumps(env),))
        self.data = data

    def find(self, id):
        for a in self.data["accounts"]:
            if a["id"] == id:
                return a
        raise Problem("账号不存在。", 404)

    def save_account(self, value, id=None):
        prev = self.find(id) if id else None
        if prev and prev["deletedAt"]:
            raise Problem("请先从回收站恢复账号。")
        a = account(value, self.data["platforms"], prev)
        if any(identity(x) == identity(a) and x["id"] != a["id"] for x in self.data["accounts"]):
            raise Problem("该平台下的账号已存在（包括回收站），请编辑或恢复已有记录。", 409)
        if a["linkedAccount"] and (a["linkedAccount"] == a["id"] or not any(x["id"] == a["linkedAccount"] and not x["deletedAt"] for x in self.data["accounts"])):
            raise Problem("关联账号不存在或不可用。")
        changed = [k for k in TEXT_FIELDS + ("tags", "status", "secrets", "customFields") if prev and prev.get(k) != a.get(k)]
        audit(a, "编辑资料" if prev else "创建账号", changed)
        data = copy.deepcopy(self.data)
        data["accounts"] = [a if x["id"] == a["id"] else x for x in data["accounts"]] if prev else data["accounts"] + [a]
        self.commit(data)
        return summary(a)

    def batch(self, payload):
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids or len(ids) > MAX_ACCOUNTS or any(not isinstance(i, str) for i in ids):
            raise Problem("请先勾选要整理的账号。")
        selected = set(ids)
        if not selected.issubset({a["id"] for a in self.data["accounts"]}):
            raise Problem("部分账号已变化，请刷新后重试。", 409)
        action = payload.get("action")
        allowed = ("group", "tags_add", "tags_remove", "status", "archive", "unarchive", "trash", "restore", "purge", "favorite")
        if action not in allowed:
            raise Problem("批量操作不正确。")
        data = copy.deepcopy(self.data)
        for a in data["accounts"]:
            if a["id"] not in selected:
                continue
            if action in ("restore", "purge") and not a["deletedAt"]:
                raise Problem("只能恢复或彻底删除回收站中的账号。")
            if action not in ("restore", "purge") and a["deletedAt"]:
                raise Problem("请先恢复回收站中的账号。")
            if action == "group": a["group"] = text(payload.get("value", ""), 100).strip()
            elif action.startswith("tags_"):
                ts = tags(payload.get("value", []))
                a["tags"] = tags(a["tags"] + ts) if action == "tags_add" else [t for t in a["tags"] if t not in ts]
            elif action == "status":
                if payload.get("value") not in ("active", "reserve", "attention", "disabled"): raise Problem("状态不正确。")
                a["status"] = payload["value"]
            elif action in ("archive", "unarchive"): a["archived"] = action == "archive"
            elif action == "favorite": a["favorite"] = bool(payload.get("value"))
            elif action == "trash": a["deletedAt"] = now()
            elif action == "restore": a["deletedAt"] = None
            audit(a, {"trash": "移入回收站", "restore": "恢复账号", "archive": "归档", "unarchive": "取消归档"}.get(action, "批量整理"), [action])
        if action == "purge":
            if payload.get("confirm") != "永久删除": raise Problem("请输入“永久删除”确认。")
            data["accounts"] = [a for a in data["accounts"] if a["id"] not in selected]
            for a in data["accounts"]:
                if a["linkedAccount"] in selected:
                    a["linkedAccount"] = ""
                    audit(a, "关联账号已删除")
        self.commit(data)
        return len(selected)

    def plan(self, kind, value, report):
        self.plans = {k: p for k, p in self.plans.items() if p["expires"] > time.monotonic()}
        if len(self.plans) >= 5:
            self.plans.pop(next(iter(self.plans)))
        token = secrets.token_urlsafe(24)
        self.plans[token] = {"kind": kind, "data": value, "revision": self.data["revision"], "expires": time.monotonic() + 600}
        return {"token": token, **report}

    def apply_plan(self, token, kind):
        p = self.plans.get(token) if isinstance(token, str) else None
        if not p or p["kind"] != kind or p["expires"] < time.monotonic():
            raise Problem("预览已过期，请重新预览。", 409)
        if p["revision"] != self.data["revision"]:
            raise Problem("预览后资料已变化，请重新预览再提交。", 409)
        if kind == "restore":
            checkpoint = self.directory / ("before-restore-" + uid() + ".atlas")
            with checkpoint.open("x", encoding="utf-8") as file:
                file.write(dumps(self.envelope()))
                file.flush(); os.fsync(file.fileno())
        candidate = copy.deepcopy(p["data"])
        if kind == "restore":
            candidate.pop("security", None)
            if "security" in self.data: candidate["security"] = copy.deepcopy(self.data["security"])
        self.commit(candidate)
        self.plans.pop(token, None)
