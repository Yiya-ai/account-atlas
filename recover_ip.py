"""Interactive local IP-policy recovery; does not disable or bypass 2FA."""
import argparse
import getpass
import sqlite3
from pathlib import Path

import portalocker

from backend.vault import Vault, Problem, dumps, seal, unseal, uid
from backend.security import consume_code, defaults, factor_enabled


def reset_ip(directory, password, code=""):
    vault = Vault(directory)
    data, key, salt = unseal(vault.envelope(), password)
    config = data.get("security", defaults())
    if factor_enabled(config) and not consume_code(config, code):
        raise Problem("验证码或恢复码不正确、已使用或已过期；IP 门禁未修改。")
    # Save an encrypted database snapshot before any change; never print secrets.
    backup = vault.directory / ("before-ip-recovery-" + uid() + ".db")
    with vault.connect() as source, sqlite3.connect(backup) as target: source.backup(target)
    data["revision"] += 1
    env = seal(data, key, salt)
    with vault.connect() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS ip_gate (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL)")
        conn.execute("UPDATE vault SET envelope=? WHERE id=1", (dumps(env),))
        conn.execute("INSERT INTO ip_gate(id,policy) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET policy=excluded.policy",
                     (dumps({"enabled": False, "rules": ["127.0.0.1/32", "::1/128"]}),))
    return backup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recover local IP access. Keeps master password and 2FA enabled.")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "data")
    args = parser.parse_args()
    if not (args.data_dir / "vault.db").is_file(): raise SystemExit("未找到资料库。")
    try:
        with portalocker.Lock(str(args.data_dir / ".instance.lock"), timeout=0):
            print("仅重置 IP 白名单，不关闭 2FA。请先停止账号簿服务。")
            password = getpass.getpass("主密码: ")
            code = getpass.getpass("2FA 验证码或恢复码（未启用 2FA 可留空）: ")
            backup = reset_ip(args.data_dir, password, code)
            print("IP 门禁已关闭。加密快照：", backup)
    except portalocker.exceptions.LockException: raise SystemExit("请先运行 stop.cmd 停止服务，再执行恢复。")
    except Problem as exc: raise SystemExit(str(exc))
