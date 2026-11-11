"""Platform-aware import schema, CSV template, header matching and atomic row validation."""
import copy
import csv
import io
import re

from .vault import (Problem, FIELD_LABELS, SECRET_FIELDS, MAX_ACCOUNTS, account, audit,
                    identity, platform_config, tags, text)

CORE = {"identifier": "账号标识", "title": "显示名称", "group": "分组", "tags": "标签", "status": "状态"}
ALIASES = {"identifier": ["账号", "邮箱账号", "username"], "password": ["密码"], "totp": ["TOTP 密钥", "2FA", "身份验证器"], "phone": ["手机号", "电话", "受信任电话号码"], "email": ["邮箱", "电子邮件"], "birthday": ["出生日期"], "region": ["商店地区"], "linkedAccount": ["关联账号"], "personalProfile": ["个人资料"]}
ENUMS = {
    "status": {"使用中": "active", "备用": "reserve", "待处理": "attention", "停用": "disabled"},
    "loginMethod": {"账号密码": "password", "通过 Google 登录": "google", "通过 Apple 登录": "apple", "通行密钥": "passkey", "其他": "other"},
    "verification": {"未记录": "none", "身份验证器 TOTP": "totp", "受信任设备": "device", "短信 / 电话": "sms", "安全密钥 / 通行密钥": "passkey", "多种方式": "multiple", "已开启双重认证": "twofactor", "未开启双重认证": "disabled"},
}


def schema(vault, platform_id):
    p = next((p for p in vault.data["platforms"] if p["id"] == platform_id), None)
    if not p: raise Problem("请选择有效的平台。")
    p = platform_config(p)
    fields = [{"key": k, "label": p["fieldLabels"].get(k, v), "secret": False} for k, v in CORE.items()]
    for key in p["fields"]:
        label = p["fieldLabels"].get(key, FIELD_LABELS[key])
        if key == "linkedAccount": label = "关联账号 ID（已存在）"
        if key == "region" and p["template"] == "apple": label = "商店地区"
        fields.append({"key": key, "label": label, "secret": key in SECRET_FIELDS})
    for f in p["fieldTemplates"]:
        if f["enabled"]:
            fields.append({"key": "custom:" + f["name"], "label": "自定义：" + f["name"], "secret": f["secret"], "name": f["name"]})
    return p, fields


def parse(payload):
    raw = text(payload.get("text", ""), 3_000_000).removeprefix("\ufeff")
    delimiter = payload.get("delimiter", ",")
    if delimiter not in (",", "\t", "----", "——", "|"): raise Problem("分隔符不受支持。")
    try:
        rows = list(csv.reader(io.StringIO(raw, newline=""), delimiter=delimiter, strict=True)) if len(delimiter) == 1 else [line.split(delimiter) for line in raw.splitlines()]
    except csv.Error: raise Problem("CSV 引号或分隔符不正确，请检查原文件。") from None
    if len(rows) > 5000 + bool(payload.get("header")): raise Problem("单次最多导入 5000 条。")
    if any(len(row) > 128 for row in rows): raise Problem("单行最多支持 128 列。")
    return rows


def header_key(value):
    return value.strip().removeprefix("'").strip().casefold()


def analyze(vault, payload):
    _, fields = schema(vault, payload.get("platformId"))
    rows = parse(payload)
    count = max((len(row) for row in rows), default=0)
    headers = rows[0] if payload.get("header") and rows else []
    mapping = {}
    warnings = []
    for f in fields:
        # Keep accepting pre-adaptation CSV headings as well as Apple-specific labels.
        names = [f["key"], f["label"], *ALIASES.get(f["key"], [])]
        for catalog in (FIELD_LABELS, CORE):
            if f["key"] in catalog: names.append(catalog[f["key"]])
        aliases = {header_key(v) for v in names}
        if f.get("name"): aliases.add(header_key(f["name"]))
        matches = [i for i, name in enumerate(headers) if header_key(name) in aliases]
        if len(matches) == 1: mapping[f["key"]] = matches[0]
        elif len(matches) > 1: warnings.append(f'{f["label"]}匹配到多个表头，请手动选择。')
    if headers:
        unmatched = count - len(set(mapping.values()))
        if unmatched:
            warnings.append(f"有 {unmatched} 列未自动匹配，将不会导入。请检查字段映射；可选字段可先在平台管理中启用，再重新导入。")
    # No positional guessing: a missing password column must never map another value.
    return {"fields": fields, "columns": [{"index": i, "label": f"第 {i+1} 列" + (f" · {headers[i][:100]}" if i < len(headers) else "")} for i in range(count)], "mapping": mapping, "warnings": warnings}


def template(vault, platform_id):
    p, fields = schema(vault, platform_id)
    stream = io.StringIO(newline="")
    # Custom header names may contain spreadsheet formula prefixes. No account data is exported.
    csv.writer(stream, quoting=csv.QUOTE_ALL).writerow([("'" if f["label"].lstrip().startswith(("=", "+", "-", "@")) else "") + f["label"] for f in fields])
    filename = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", p["name"]) + "-导入模板.csv"
    return {"csv": "\ufeff" + stream.getvalue(), "filename": filename, "fields": fields}


def convert(key, value):
    if key in ENUMS:
        cleaned = value.strip()
        if not cleaned: return {"status": "active", "loginMethod": "password", "verification": "none"}[key]
        result = ENUMS[key].get(cleaned, cleaned)
        if result not in ENUMS[key].values(): raise Problem(f"{CORE.get(key, FIELD_LABELS.get(key))}不是有效选项。")
        return result
    if key in ("birthday", "passwordUpdatedAt") and value.strip():
        normalized = re.sub(r"[年/月]", "-", value.strip()).removesuffix("日")
        parts = normalized.split("-")
        if len(parts) == 3 and all(p.isdigit() for p in parts): return f"{int(parts[0]):04d}-{int(parts[1]):02d}-{int(parts[2]):02d}"
    return value


def import_preview(vault, payload):
    if "revision" in payload and payload["revision"] != vault.data["revision"]: raise Problem("平台或账号资料已变化，请关闭导入窗口并刷新后重试。", 409)
    _, fields = schema(vault, payload.get("platformId"))
    allowed = {f["key"]: f for f in fields}
    mode = payload.get("mode", "skip")
    if mode not in ("skip", "fill", "replace"): raise Problem("重复处理方式不正确。")
    mapping = payload.get("mapping", {})
    if not isinstance(mapping, dict) or "identifier" not in mapping: raise Problem("请映射账号标识列。")
    if any(k not in allowed or type(v) is not int or not 0 <= v < 128 for k, v in mapping.items()): raise Problem("字段映射不属于当前平台配置，或列号不正确。")
    rows = parse(payload)
    data = copy.deepcopy(vault.data)
    by_key = {identity(a): a for a in data["accounts"]}
    batch_tags = tags(payload.get("tags", []))
    default_group = text(payload.get("group", ""), 2000).strip()
    result = {"added": 0, "updated": 0, "skipped": 0, "invalid": 0, "rows": []}
    start = 1 if payload.get("header") else 0
    for line, cols in enumerate(rows[start:], start + 1):
        if not any(cols): continue
        report = {"line": line, "identifier": cols[mapping["identifier"]] if mapping["identifier"] < len(cols) else "", "result": "新增"}
        try:
            if any(index >= len(cols) for index in mapping.values()): raise Problem("本行缺少已映射的列，未导入；请补齐空列分隔符。")
            identifier = text(cols[mapping["identifier"]]).strip()
            if not identifier: raise Problem("账号标识不能为空。")
            existing = by_key.get(identity({"platformId": payload["platformId"], "identifier": identifier}))
            if existing and (existing["deletedAt"] or mode == "skip"):
                result["skipped"] += 1
                report["result"] = "跳过（回收站）" if existing["deletedAt"] else "跳过重复"
            else:
                candidate = copy.deepcopy(existing) if existing else {"platformId": payload["platformId"], "secrets": {}, "customFields": []}
                for descriptor in fields:
                    key = descriptor["key"]
                    if key not in mapping: continue
                    index = mapping[key]
                    value = cols[index]
                    if key.startswith("custom:"):
                        f = allowed[key]
                        matches = [cf for cf in candidate["customFields"] if cf["name"].casefold() == f["name"].casefold()]
                        if len(matches) > 1: raise Problem("已有账号包含同名自定义字段，请先整理后再导入。")
                        target = matches[0] if matches else {"name": f["name"], "value": "", "secret": f["secret"]}
                        if mode == "replace" or not target["value"]: target["value"] = value
                        target["secret"] = target["secret"] or f["secret"]
                        if not matches: candidate["customFields"].append(target)
                    elif key in SECRET_FIELDS:
                        if mode == "replace" or not candidate["secrets"].get(key): candidate["secrets"][key] = value
                    elif key == "tags":
                        candidate["tags"] = tags(candidate.get("tags", []) + [s.strip() for s in value.replace("，", ",").split(",") if s.strip()])
                    elif mode == "replace" or not candidate.get(key) or (key == "verification" and candidate[key] == "none"):
                        candidate[key] = convert(key, value)
                if "group" not in mapping and default_group and (mode == "replace" or not candidate.get("group")): candidate["group"] = default_group
                candidate["tags"] = tags(candidate.get("tags", []) + batch_tags)
                a = account(candidate, data["platforms"], existing)
                if a["linkedAccount"] and not any(x["id"] == a["linkedAccount"] and x["id"] != a["id"] and not x["deletedAt"] for x in data["accounts"]): raise Problem("关联账号 ID 不存在、已在回收站或指向自身。")
                audit(a, "批量导入更新" if existing else "批量导入", list(mapping))
                if existing:
                    existing.clear(); existing.update(a)
                    result["updated"] += 1; report["result"] = "更新"
                else:
                    data["accounts"].append(a); by_key[identity(a)] = a; result["added"] += 1
        except Problem as exc:
            result["invalid"] += 1; report["result"] = str(exc)
        if len(result["rows"]) < 100: result["rows"].append(report)
    if len(data["accounts"]) > MAX_ACCOUNTS: raise Problem("导入后超过 10000 条上限。")
    return vault.plan("import", data, result)
