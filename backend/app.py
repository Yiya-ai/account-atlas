import copy
import functools
import io
import json
import os
import secrets
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, send_file, redirect, g
from werkzeug.exceptions import HTTPException

from .vault import Vault, Problem, account, audit, derive, dumps, now, password_check, platform, platform_config, FIELD_LABELS, TEXT_FIELDS, seal, summary, unseal

from .importing import import_preview, analyze, template, schema as import_schema
from .exporting import preview as export_preview, build as export_build
from .security import Gates
from .passkeys import Passkeys
from .vault import custom_fields, idle_minutes


def create_app(directory=None, testing=False, port=8765, deployment=None):
    root = Path(__file__).resolve().parents[1]
    app = Flask(__name__, static_folder=None)
    app.config.update(TESTING=testing, MAX_CONTENT_LENGTH=16 * 1024 * 1024)
    vault = Vault(directory or root / "data")
    app.extensions["vault"] = vault
    gates = Gates(vault)
    app.extensions["gates"] = gates
    passkeys = Passkeys(gates, port)
    cookie_name = "__Host-atlas_session" if deployment else "atlas_session"
    challenge_cookie = "__Secure-atlas_challenge" if deployment else "atlas_challenge"
    session_source = {"ip": None}

    def client_ip():
        return g.atlas_client_ip

    def active_session(*, touch=True):
        vault.active(request.cookies.get(cookie_name), touch=touch)
        if deployment and session_source["ip"] != client_ip():
            raise Problem("连接来源已变化，请重新解锁。", 401)

    def enrollment_required():
        return bool(deployment and vault.data and not vault.data.get("security", {}).get("enabled"))

    def body():
        value = request.get_json()
        if not isinstance(value, dict): raise Problem("请求格式不正确。")
        return value

    @app.before_request
    def protect():
        g.atlas_client_ip = deployment.client_ip(request) if deployment else request.remote_addr
        with vault.mutex:
            gates.check_ip(client_ip())
        hosts = {deployment.host} if deployment else {f"127.0.0.1:{port}", f"localhost:{port}"}
        if testing and not deployment: hosts.add("localhost")
        if request.host not in hosts: raise Problem("访问地址与服务配置不匹配。", 403)
        if request.path.startswith("/api/"):
            origin = request.headers.get("Origin")
            expected_origin = deployment.origin if deployment else f"http://{request.host}"
            if origin and origin != expected_origin: raise Problem("不允许跨站请求。", 403)
            if deployment and request.method not in ("GET", "HEAD") and origin != expected_origin:
                raise Problem("缺少有效的请求来源。", 403)
            if request.headers.get("Sec-Fetch-Site") == "cross-site": raise Problem("不允许跨站请求。", 403)
            if request.method not in ("GET", "HEAD") and request.headers.get("X-Atlas-Request") != "1":
                raise Problem("请求校验失败，请刷新页面。", 403)
            if deployment and (request.path.startswith("/api/security/passkey/") or request.path.startswith("/api/unlock/passkey/")):
                raise Problem("IP 地址入口使用验证器或恢复码；通行密钥需域名入口。", 400)

    @app.after_request
    def headers(response):
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()"})
        return response

    @app.errorhandler(Problem)
    def problem(exc):
        return jsonify(error=str(exc)), exc.code

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error={413: "文件超过 16 MB 上限。", 415: "请求需使用 JSON 格式。", 400: "请求格式不正确。", 404: "页面或资料不存在。"}.get(exc.code, "请求无法处理。")), exc.code

    @app.errorhandler(Exception)
    def unexpected(exc):
        # Never log exception values: a validation/database exception can contain secrets.
        app.logger.error("Request failed (%s)", type(exc).__name__)
        return jsonify(error="操作未完成，资料未保存。请重试或查看本地存储空间。"), 500

    def locked(fn=None, *, touch=True):
        if fn is None: return lambda f: locked(f, touch=touch)
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with vault.mutex:
                gates.check_ip(client_ip())
                active_session(touch=touch)
                if enrollment_required() and (request.method, request.path) not in {
                    ("GET", "/api/security"), ("POST", "/api/security/setup"),
                    ("POST", "/api/security/setup/cancel"), ("POST", "/api/security/enable"), ("POST", "/api/lock")
                }:
                    raise Problem("公网访问必须先绑定并验证 2FA，资料访问尚未开放。", 423)
                return fn(*args, **kwargs)
        return wrapper

    def session_response(token, **extra):
        if deployment: session_source["ip"] = client_ip()
        response = jsonify(ok=True, **extra)
        response.set_cookie(cookie_name, token, httponly=True, samesite="Strict", secure=bool(deployment), path="/")
        response.delete_cookie(challenge_cookie, path="/api/unlock", secure=bool(deployment))
        return response

    @app.get("/api/status")
    def status():
        with vault.mutex:
            unlocked = True
            try: active_session(touch=False)
            except Problem: unlocked = False
            return jsonify(app="account-atlas", initialized=vault.envelope() is not None, unlocked=unlocked, idleSeconds=vault.idle_seconds,
                           enrollmentRequired=bool(unlocked and enrollment_required()), publicHttps=bool(deployment))

    @app.post("/api/setup")
    def setup():
        with vault.mutex:
            b = body()
            if deployment and vault.envelope() is None:
                deployment.authorize_setup(b.get("bootstrapToken"))
            vault.throttle()
            try:
                token = vault.setup(b.get("password"), b.get("backup"), b.get("backupPassword", ""))
            except Problem:
                vault.reject(); raise
            return session_response(token)

    @app.post("/api/unlock")
    def unlock():
        with vault.mutex:
            token, challenge = gates.begin(body().get("password", ""), gates.check_ip(client_ip()))
            if token: return session_response(token)
            config = vault.pending_auth["data"]["security"]
            response = jsonify(mfaRequired=True, expiresIn=300, passkeyAvailable=bool(config.get("passkeys")) and not deployment, totpAvailable=config["enabled"])
            response.delete_cookie(cookie_name, path="/", secure=bool(deployment))
            response.set_cookie(challenge_cookie, challenge, httponly=True, samesite="Strict", secure=bool(deployment), path="/api/unlock", max_age=300)
            return response

    @app.post("/api/unlock/verify")
    def verify_unlock():
        with vault.mutex:
            return session_response(gates.finish(request.cookies.get(challenge_cookie), body().get("code", ""), gates.check_ip(client_ip())))

    @app.post("/api/unlock/cancel")
    def cancel_unlock():
        import secrets
        with vault.mutex:
            pending = vault.pending_auth
            token = request.cookies.get(challenge_cookie, "")
            if pending and token.isascii() and secrets.compare_digest(token, pending["token"]): vault.pending_auth = None
            response = jsonify(ok=True)
            response.delete_cookie(challenge_cookie, path="/api/unlock", secure=bool(deployment))
            return response

    @app.get("/api/security")
    @locked
    def security_status():
        result = gates.status(gates.check_ip(client_ip()))
        result.update(totpRequired=bool(deployment), passkeysAvailable=not deployment, idleMinutes=vault.idle_seconds // 60)
        if deployment:
            result['networkGate'] = {'mode': 'city', 'allowed': list(deployment.city_gate.allowed), 'databaseRevision': deployment.city_gate.revision}
        return jsonify(result)

    @app.post("/api/security/idle")
    @locked
    def security_idle():
        minutes = idle_minutes(body().get("minutes"))
        data = copy.deepcopy(vault.data)
        data["idleMinutes"] = minutes
        vault.commit(data)
        return jsonify(ok=True, idleSeconds=vault.idle_seconds)

    @app.post("/api/activity")
    @locked
    def activity():
        return jsonify(ok=True)

    @app.post("/api/security/setup")
    @locked
    def security_setup():
        b = body()
        return jsonify(gates.start_setup(b.get("password", ""), b.get("code", ""), b.get("proof")))

    @app.post("/api/security/setup/cancel")
    @locked
    def security_cancel_setup():
        token = body().get("token")
        pending = vault.pending_setup
        if pending and isinstance(token, str) and token.isascii() and secrets.compare_digest(token, pending["token"]):
            vault.pending_setup = None
        return jsonify(ok=True)

    @app.post("/api/security/passkey/options")
    @locked
    def passkey_register_options():
        passkeys.check_host(request.host)
        return jsonify(passkeys.start_register(body(), gates.check_ip(client_ip())))

    @app.post("/api/security/passkey/register")
    @locked
    def passkey_register():
        passkeys.check_host(request.host)
        token, codes = passkeys.register(body(), gates.check_ip(client_ip()))
        return session_response(token, **({"recoveryCodes":codes} if codes else {}))

    @app.post("/api/security/passkey/manage")
    @locked
    def passkey_manage(): return session_response(passkeys.manage(body()))

    @app.post("/api/security/passkey/proof-options")
    @locked
    def passkey_proof_options():
        passkeys.check_host(request.host)
        return jsonify(passkeys.start_assertion(gates.check_ip(client_ip())))

    @app.post("/api/security/passkey/proof")
    @locked
    def passkey_proof():
        passkeys.check_host(request.host)
        return jsonify(proof=passkeys.assertion(body().get("credential"), gates.check_ip(client_ip())))

    @app.post("/api/unlock/passkey/options")
    def passkey_login_options():
        with vault.mutex:
            passkeys.check_host(request.host)
            return jsonify(passkeys.start_assertion(gates.check_ip(client_ip()), request.cookies.get(challenge_cookie, "")))

    @app.post("/api/unlock/passkey/verify")
    def passkey_login_verify():
        with vault.mutex:
            passkeys.check_host(request.host)
            return session_response(passkeys.assertion(body().get("credential"), gates.check_ip(client_ip()), request.cookies.get(challenge_cookie, "")))

    @app.post("/api/security/enable")
    @locked
    def security_enable():
        b = body()
        token, codes = gates.enable(b.get("token"), b.get("code", ""))
        return session_response(token, recoveryCodes=codes)

    @app.post("/api/security/<action>")
    @locked
    def security_update(action):
        if deployment and action == "disable":
            raise Problem("公网模式必须保留 2FA，不能关闭验证器。", 409)
        token, codes = gates.update(action, body(), gates.check_ip(client_ip()))
        return session_response(token, **({"recoveryCodes": codes} if codes else {}))

    @app.post("/api/lock")
    @locked
    def lock():
        vault.clear()
        response = jsonify(ok=True)
        response.delete_cookie(cookie_name, path="/", secure=bool(deployment))
        return response

    @app.get("/api/state")
    @locked
    def state():
        # Minimal list DTO. Search on notes is performed locally after authorized request,
        # but notes and secret custom fields never travel in this list endpoint.
        q = request.args.get("q", "").strip().casefold()
        entries = vault.data["accounts"]
        if q:
            entries = [a for a in entries if q in " ".join([a.get(k, "") for k in TEXT_FIELDS] + a["tags"] + [f["value"] for f in custom_fields(a, vault.data["platforms"]) if not f["secret"]]).casefold()]
        return jsonify(platforms=[{**platform_config(p), "importFields": import_schema(vault, p["id"])[1], "accountCount": sum(a["platformId"] == p["id"] for a in vault.data["accounts"])} for p in vault.data["platforms"]], fieldCatalog=FIELD_LABELS, accounts=[summary(a) for a in entries], revision=vault.data["revision"],
                       groups=sorted({a["group"] for a in vault.data["accounts"] if a["group"] and not a["deletedAt"]}),
                       tags=sorted({t for a in vault.data["accounts"] if not a["deletedAt"] for t in a["tags"]}),
                       total=len([a for a in vault.data["accounts"] if not a["deletedAt"]]))

    @app.post("/api/platforms")
    @locked
    def add_platform():
        b = body(); b.pop("id", None); b["template"] = "custom"
        p = platform(b)
        if len(vault.data["platforms"]) >= 200: raise Problem("平台数量已达上限。")
        if any(x["name"].casefold() == p["name"].casefold() for x in vault.data["platforms"]): raise Problem("平台名称已存在。")
        data = copy.deepcopy(vault.data); data["platforms"].append(p); vault.commit(data)
        return jsonify(p)

    @app.route("/api/platforms/<id>", methods=["PUT", "DELETE"])
    @locked
    def manage_platform(id):
        b = body()
        if b.get("revision") != vault.data["revision"]: raise Problem("资料已变化，请重新打开平台管理。", 409)
        previous = next((p for p in vault.data["platforms"] if p["id"] == id), None)
        if previous is None: raise Problem("平台不存在。", 404)
        data = copy.deepcopy(vault.data)
        if request.method == "DELETE":
            if previous["template"] != "custom": raise Problem("内置平台可调整字段，不能删除。")
            if any(a["platformId"] == id for a in data["accounts"]): raise Problem("平台仍有账号（包括归档和回收站），请先迁移或清理账号。", 409)
            if b.get("confirm") != previous["name"]: raise Problem("请输入平台名称确认删除。")
            if len(data["platforms"]) <= 1: raise Problem("至少保留一个平台。")
            data["platforms"] = [p for p in data["platforms"] if p["id"] != id]
        else:
            p = platform({**previous, **b, "id": id, "template": previous["template"]})
            if any(x["id"] != id and x["name"].casefold() == p["name"].casefold() for x in data["platforms"]): raise Problem("平台名称已存在。")
            data["platforms"] = [p if x["id"] == id else x for x in data["platforms"]]
            for a in data["accounts"]:
                if a["platformId"] == id:
                    a["customFields"] = custom_fields(a, data["platforms"])
        vault.commit(data)
        return jsonify(ok=True)

    @app.post("/api/accounts")
    @locked
    def create(): return jsonify(vault.save_account(body()))

    @app.get("/api/accounts/<id>")
    @locked
    def detail(id):
        a = copy.deepcopy(vault.find(id)); a.pop("secrets")
        a["customFields"] = [{**f, "value": "" if f["secret"] else f["value"]} for f in custom_fields(a, vault.data["platforms"])]
        return jsonify(a)

    @app.post("/api/accounts/<id>/reveal")
    @locked
    def reveal(id):
        a = vault.find(id)
        return jsonify(secrets=a["secrets"], customFields=custom_fields(a, vault.data["platforms"]))

    @app.put("/api/accounts/<id>")
    @locked
    def update(id):
        b = body()
        if b.pop("revision", None) != vault.data["revision"]: raise Problem("资料已在其他操作中更新，请重新打开后编辑。", 409)
        return jsonify(vault.save_account(b, id))

    @app.post("/api/accounts/<id>/totp")
    @locked(touch=False)
    def totp(id):
        import pyotp
        secret = vault.find(id)["secrets"]["totp"]
        if not secret: raise Problem("该账号未设置 TOTP 密钥。")
        timestamp = time.time()
        try: code = pyotp.TOTP(secret).at(timestamp)
        except Exception: raise Problem("TOTP 密钥无效。") from None
        return jsonify(code=code, expiresAt=(int(timestamp) // 30 + 1) * 30, serverTime=timestamp, period=30)

    @app.post("/api/batch")
    @locked
    def batch(): return jsonify(affected=vault.batch(body()))

    @app.post("/api/import/analyze")
    @locked
    def analyze_import(): return jsonify(analyze(vault, body()))

    @app.post("/api/export/preview")
    @locked
    def preview_export(): return jsonify(export_preview(vault, body()))

    @app.post("/api/export/download")
    @locked
    def download_export():
        content, mimetype, filename = export_build(vault, body())
        return send_file(io.BytesIO(content), mimetype=mimetype, as_attachment=True, download_name=filename, max_age=0)

    @app.post("/api/import/template")
    @locked
    def template_import(): return jsonify(template(vault, body().get("platformId")))

    @app.post("/api/import/preview")
    @locked
    def preview_import(): return jsonify(import_preview(vault, body()))

    @app.post("/api/import/apply")
    @locked
    def apply_import():
        vault.apply_plan(body().get("token"), "import")
        return jsonify(ok=True)

    @app.post("/api/backup")
    @locked
    def backup():
        password = body().get("password"); password_check(password)
        salt = os.urandom(16)
        data = copy.deepcopy(vault.data); data.pop("security", None)
        return jsonify(seal(data, derive(password, salt), salt))

    @app.post("/api/restore/preview")
    @locked
    def preview_restore():
        b = body(); vault.throttle()
        try: data = unseal(b.get("backup"), b.get("password", ""))[0]
        except Problem: vault.reject(); raise
        return jsonify(vault.plan("restore", data, {"accounts": len(data["accounts"]), "platforms": len(data["platforms"]), "current": len(vault.data["accounts"])}))

    @app.post("/api/restore/apply")
    @locked
    def apply_restore():
        b = body()
        if b.get("confirm") != "替换资料库": raise Problem("请输入“替换资料库”确认恢复。")
        vault.apply_plan(b.get("token"), "restore")
        return jsonify(ok=True)

    @app.post("/api/password")
    @locked
    def change_password():
        b = body(); vault.throttle()
        try: unseal(vault.envelope(), b.get("current", ""))
        except Problem: vault.reject(); raise
        password_check(b.get("password"))
        salt = os.urandom(16); key = derive(b["password"], salt)
        env = seal(vault.data, key, salt)
        with vault.connect() as conn: conn.execute("UPDATE vault SET envelope=? WHERE id=1", (dumps(env),))
        token = vault.session(vault.data, key, salt)
        return session_response(token)

    @app.get("/")
    def index():
        if not deployment and request.host == f"127.0.0.1:{port}": return redirect(f"http://localhost:{port}/", code=302)
        return send_from_directory(root / "frontend" / "dist", "index.html")

    @app.get("/assets/<path:name>")
    def assets(name): return send_from_directory(root / "frontend" / "dist" / "assets", name)

    @app.get("/favicon.svg")
    def favicon(): return send_from_directory(root / "frontend" / "dist", "favicon.svg")

    @app.get("/ocr/<path:name>")
    def ocr_assets(name):
        # Static, bundled model/runtime files only. There is no screenshot upload API.
        return send_from_directory(root / "frontend" / "dist" / "ocr", name)

    # Expiry clears references even when no more requests arrive.
    if not testing:
        def expire():
            while True:
                time.sleep(5)
                with vault.mutex:
                    if vault.token and time.monotonic() - vault.last_used >= vault.idle_seconds: vault.clear()
                    if vault.pending_auth and vault.pending_auth["expires"] <= time.monotonic(): vault.pending_auth = None
                    if vault.pending_setup and vault.pending_setup["expires"] <= time.monotonic(): vault.pending_setup = None
                    if vault.webauthn and vault.webauthn["expires"] <= time.monotonic(): vault.webauthn = None
                    if vault.passkey_proof and vault.passkey_proof["expires"] <= time.monotonic(): vault.passkey_proof = None
        threading.Thread(target=expire, daemon=True, name="vault-expiry").start()
    return app
