"""Explicit, revision-bound exports. Plaintext files are built only in memory."""
import csv
import io
import time
from datetime import datetime

import xlsxwriter

from .importing import ENUMS
from .vault import FIELD_LABELS, TEXT_FIELDS, SECRET_FIELDS, MAX_ACCOUNTS, Problem, dumps, APPLE_FIELD_LABELS

LABELS = {"platformName":"平台", "identifier":"账号标识", "title":"显示名称", "group":"分组", "tags":"标签", "status":"状态", **FIELD_LABELS, "id":"记录 ID", "favorite":"收藏", "archived":"已归档", "deletedAt":"删除时间", "createdAt":"创建时间", "updatedAt":"更新时间"}
DEFAULTS = {"platformName", "identifier", "title", "email", "phone", "group", "tags", "status"}


def preview(vault, payload):
    if payload.get("revision") != vault.data["revision"]:
        raise Problem("资料已变化，请关闭导出窗口并刷新列表后重试。", 409)
    scope = payload.get("scope")
    if scope in ("selected", "filtered"):
        ids = payload.get("ids")
        if not isinstance(ids, list) or len(ids) > MAX_ACCOUNTS or any(not isinstance(i, str) for i in ids): raise Problem("导出范围不正确。")
        by_id = {a["id"]:a for a in vault.data["accounts"]}
        if any(i not in by_id for i in ids): raise Problem("选中的账号已变化，请刷新后重试。",409)
        entries = [by_id[i] for i in dict.fromkeys(ids)]
    elif scope == "platform":
        pid = payload.get("platformId")
        if not any(p["id"] == pid for p in vault.data["platforms"]): raise Problem("请选择要导出的平台。")
        if type(payload.get("includeArchived", True)) is not bool or type(payload.get("includeTrash", False)) is not bool: raise Problem("导出范围选项不正确。")
        entries = [a for a in vault.data["accounts"] if a["platformId"] == pid and
                   (payload.get("includeTrash", False) or not a["deletedAt"]) and
                   (payload.get("includeArchived", True) or not a["archived"])]
        entries.sort(key=lambda a:a["updatedAt"],reverse=True)
    else: raise Problem("请选择有效的导出范围。")
    platforms = {p["id"]:p for p in vault.data["platforms"]}
    templates = {platforms[a["platformId"]]["template"] for a in entries}
    if scope == "platform": templates = {platforms[payload["platformId"]]["template"]}
    labels = {**LABELS, **APPLE_FIELD_LABELS} if templates == {"apple"} else LABELS
    fields = [{"key":k, "label":v, "secret":k in SECRET_FIELDS, "default":k in DEFAULTS, "group":"敏感资料" if k in SECRET_FIELDS else "基础与个人资料"} for k,v in labels.items()]
    custom = {}
    for a in entries:
        p = platforms[a["platformId"]]
        for f in a["customFields"]:
            key = "custom:" + dumps([p["id"],f["name"].casefold()])
            configured_secret = any(t["name"].casefold() == f["name"].casefold() and t["secret"] for t in p.get("fieldTemplates",[]))
            column = custom.setdefault(key, {"key":key,"label":f'自定义：{f["name"]}（{p["name"]}）',"name":f["name"],"platformId":p["id"],"secret":False,"default":False,"group":"自定义字段"})
            column["secret"] = column["secret"] or f["secret"] or configured_secret
    fields.extend(custom.values())
    report = {"count":len(entries),"fields":fields,"archived":sum(bool(a["archived"]) for a in entries),"trashed":sum(bool(a["deletedAt"]) for a in entries)}
    return vault.plan("export", {"ids":[a["id"] for a in entries],"fields":fields},report)


def value_for(a, f, platforms):
    key = f["key"]
    if key.startswith("custom:"):
        if a["platformId"] != f["platformId"]: return ""
        matches = [v for v in a["customFields"] if v["name"].casefold() == f["name"].casefold()]
        if len(matches) > 1: raise Problem("部分账号有同名自定义字段，请先整理后再导出该字段。")
        return matches[0]["value"] if matches else ""
    if key == "platformName": return platforms[a["platformId"]]["name"]
    if key in SECRET_FIELDS: return a["secrets"].get(key, "")
    if key == "tags": return ", ".join(a["tags"])
    if key in ("favorite","archived"): return "是" if a.get(key) else "否"
    value = a.get(key) or ""
    if key in ENUMS: return {v:k for k,v in ENUMS[key].items()}.get(value,value)
    return value


def csv_cell(value, exact):
    # CSV has no cell type. Safe mode prevents formula evaluation by common spreadsheet apps.
    if not exact and (value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n"))): return "'" + value
    return value


def build(vault, payload):
    token = payload.get("token")
    plan = vault.plans.get(token) if isinstance(token, str) else None
    if not plan or plan["kind"] != "export" or plan["expires"] < time.monotonic(): raise Problem("导出范围已过期，请重新打开导出窗口。",409)
    if plan["revision"] != vault.data["revision"]: raise Problem("资料已变化，请重新打开导出窗口。",409)
    selected = payload.get("fields")
    if not isinstance(selected,list) or not 1 <= len(selected) <= 128 or any(not isinstance(k,str) for k in selected) or len(set(selected)) != len(selected): raise Problem("请选择 1–128 个不同的导出字段。")
    allowed = {f["key"]:f for f in plan["data"]["fields"]}
    if any(k not in allowed for k in selected): raise Problem("字段不属于此导出范围。")
    fields = [allowed[k] for k in selected]
    entries = [vault.find(i) for i in plan["data"]["ids"]]
    if not entries: raise Problem("当前范围没有可导出的账号。")
    platforms = {p["id"]:p for p in vault.data["platforms"]}
    fmt = payload.get("format")
    filename = "账号簿导出-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    if fmt == "csv":
        exact = payload.get("csvExact",False)
        if type(exact) is not bool: raise Problem("CSV 格式选项不正确。")
        stream = io.StringIO(newline="")
        writer = csv.writer(stream,quoting=csv.QUOTE_ALL)
        writer.writerow([csv_cell(f["label"],exact) for f in fields])
        for a in entries: writer.writerow([csv_cell(value_for(a,f,platforms),exact) for f in fields])
        return ("\ufeff" + stream.getvalue()).encode("utf-8"), "text/csv; charset=utf-8", filename+".csv"
    if fmt != "xlsx": raise Problem("请选择 CSV 或 Excel 格式。")
    stream = io.BytesIO()
    with xlsxwriter.Workbook(stream, {"in_memory":True,"strings_to_formulas":False,"strings_to_urls":False}) as book:
        sheet = book.add_worksheet("账号资料")
        header = book.add_format({"bold":True,"font_color":"#FFFFFF","bg_color":"#203E53","text_wrap":True,"valign":"vcenter"})
        regular = book.add_format({"num_format":"@","text_wrap":True,"valign":"top"})
        sheet.freeze_panes(1,0); sheet.set_row(0,34)
        sheet.set_column(0,len(fields)-1,26,regular)
        for col, f in enumerate(fields): sheet.write_string(0,col,f["label"],header)
        for row,a in enumerate(entries,1):
            for col,f in enumerate(fields):
                value = value_for(a,f,platforms)
                if value and sheet.write_string(row,col,value,regular) != 0: raise Problem("字段内容超过 Excel 单元格上限，请改用 CSV。")
        sheet.autofilter(0,0,len(entries),len(fields)-1)
    return stream.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename+".xlsx"
