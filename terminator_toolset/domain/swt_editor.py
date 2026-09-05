"""SWT (.swt) mission script editor for Terminator: Dark Fate - Defiance.

Формат файла - XML без объявления, плоские строки без отступов:
<Root>
<Variable name="x" type="int" default="0" />
<Trigger any="0" active="1" cutsceneActive="0" guid="7"><Name>start</Name>
<ExecNumber>1</ExecNumber>
<Condition guid="54" disabled="0"><Name>c_showMessageEnd</Name>
<Param>zone</Param>
</Condition>
<Action guid="55" disabled="0"><Name>a_setCamera</Name>
<Param>zone</Param>
</Action>
</Trigger>
</Root>

Разбор/сериализация полностью свои (ElementTree только читает), чтобы
сохранять побайтовый стиль игры: без XML-декларации, без отступов,
<Variable ... /> с пробелом перед />.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import xml.sax.saxutils as sx
import xml.etree.ElementTree as ET

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CMDS_PATH = os.path.join(BASE_DIR, "swt_commands.json")


def _load_cmds() -> list:
    """Словарь команд (action/condition + описание параметров) из JSON рядом."""
    try:
        with open(CMDS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, list):
            return data
    except Exception:  # noqa: BLE001
        pass
    return []


SWT_CMDS = _load_cmds()

# файлы игры содержат числовые ссылки на НЕВАЛИДНЫЕ для XML символы
# (&#12;, &#x1F; и т.п.) - ET на них падает. Но это не мусор: игра использует
# их как маркеры в именах. Подменяем на PUA-сентинелл до парсинга и
# восстанавливаем ИСХОДНЫЙ ВИД ссылки при сериализации (побайтовый round-trip).
_BAD_ENTITY_RE = re.compile(r"&#(x[0-9a-fA-F]+|[0-9]+);")
_ALLOWED = {0x09, 0x0A, 0x0D}
_SENT_OPEN = chr(0xE000)
_SENT_CLOSE = chr(0xE001)
_SENT_RE = re.compile(re.escape(_SENT_OPEN) + "(.*?)" + re.escape(_SENT_CLOSE))


def _clean_entities(text: str) -> str:
    def repl(m: "re.Match[str]") -> str:
        body = m.group(1)
        try:
            cp = int(body[1:], 16) if body[0] in "xX" else int(body)
        except ValueError:
            return ""
        if cp in _ALLOWED or 0x20 <= cp <= 0xD7FF or 0xE000 <= cp <= 0xFFFD:
            return m.group(0)
        # \uE000 + исходное тело ссылки + \uE001 (валидные для XML символы)
        return _SENT_OPEN + body + _SENT_CLOSE

    return _BAD_ENTITY_RE.sub(repl, text)


def _restore_entities(text: str) -> str:
    return _SENT_RE.sub(lambda m: "&#" + m.group(1) + ";", text)


def _attrs_extra(el: ET.Element, known: tuple) -> dict:
    return {k: v for k, v in el.attrib.items() if k not in known}


def _script(el: ET.Element) -> dict:
    """Condition / Action -> плоский dict (с хвостами whitespace)."""
    name_el = el.find("Name")
    return {
        "tag": el.tag,
        "guid": el.attrib.get("guid", ""),
        "disabled": el.attrib.get("disabled", "0"),
        "extra_attrs": _attrs_extra(el, ("guid", "disabled")),
        "name": el.findtext("Name") or "",
        "name_tail": (name_el.tail if name_el is not None and name_el.tail is not None else ""),
        "params": [(p.text if p.text is not None else "") for p in el.findall("Param")],
        "param_tails": [("" if p.tail is None else p.tail) for p in el.findall("Param")],
        "tail": ("" if el.tail is None else el.tail),
    }


def parse_file(path: str) -> dict:
    """Файл -> структура {variables, triggers}. Бросает исключение при мусоре.

    Хвосты (tail) хранят точный whitespace после закрывающего тега - игра
    пишет файлы с аномалиями (несколько элементов в строке, табы, мусорные
    символы после тегов), их сохраняем для побайтового round-trip."""
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        text = raw.decode("utf-8").lstrip("﻿")
    except UnicodeDecodeError as e:
        # битые байты НЕ глотаем через errors="replace": иначе U+FFFD тихо
        # перезапишет исходные байты при первом сохранении (потеря данных)
        raise ValueError("not utf-8 (%s)" % e)
    root = ET.fromstring(_clean_entities(text))
    if root.tag != "Root":
        raise ValueError("not a .swt script: root is <%s>" % root.tag)

    variables = []
    for v in root.findall("Variable"):
        variables.append({
            "name": v.attrib.get("name", ""),
            "type": v.attrib.get("type", "int"),
            "default": v.attrib.get("default", ""),
            "extra_attrs": _attrs_extra(v, ("name", "type", "default")),
            "tail": ("" if v.tail is None else v.tail),
        })

    triggers = []
    for tr in root.findall("Trigger"):
        items = []
        for ch in tr:
            if ch.tag in ("Condition", "Action"):
                items.append(_script(ch))
            elif ch.tag in ("Name", "ExecNumber"):
                continue
            else:
                # аномалии исходника: "<Param>" и прочее ВНЕ Action - храним
                # как есть (сырой XML + хвост), чтобы не потерять при записи
                items.append({"tag": ch.tag, "raw": ET.tostring(ch, encoding="unicode"),
                              "tail": ("" if ch.tail is None else ch.tail)})
        name_el = tr.find("Name")
        exec_el = tr.find("ExecNumber")
        triggers.append({
            "guid": tr.attrib.get("guid", ""),
            "any": tr.attrib.get("any", "0"),
            "active": tr.attrib.get("active", "0"),
            "cutsceneActive": tr.attrib.get("cutsceneActive", "0"),
            "extra_attrs": _attrs_extra(tr, ("any", "active", "cutsceneActive", "guid")),
            "name": tr.findtext("Name") or "",
            "name_tail": (name_el.tail if name_el is not None and name_el.tail is not None else ""),
            "exec_number": tr.findtext("ExecNumber") or "",
            "exec_tail": ("" if exec_el is None or exec_el.tail is None else exec_el.tail),
            "items": items,
            "tail": ("" if tr.tail is None else tr.tail),
        })

    return {"variables": variables, "triggers": triggers,
            "root_text": (root.text if root.text else ""),
            "trailing_newline": raw.endswith(b"\n")}


def _safe_name(name: str, fallback: str) -> str:
    """Имя тега/атрибута без <>&\"' и пробелов. Пустое/битое -> fallback."""
    s = re.sub(r'[<>&"\'\s!?,/]+', "_", str(name or "").strip())
    s = re.sub(r'_+', "_", s).strip("_")
    return s or fallback


def _attr(name: str, val: str) -> str:
    return '%s="%s"' % (_safe_name(name, "attr"),
                        sx.escape(str(val or ""), {'"': "&quot;"}))


def _text(val: str) -> str:
    # игра экранирует и кавычки в тексте (&quot;) - повторяем её стиль,
    # чтобы round-trip был побайтовым
    return sx.escape(str(val or ""), {'"': "&quot;"})


def serialize(doc: dict) -> str:
    """Структура -> текст в формате игры. Хвосты whitespace воспроизводятся
    дословно (аномалии исходника сохраняются), новые элементы получают
    каноничные переводы строк."""
    out = ["<Root>" + (doc.get("root_text") or "")]

    def emit(s: str):
        out.append(s)

    def tail(t, default: str) -> str:
        return default if t is None else t

    last_tr = None
    for v in doc.get("variables", []):
        parts = ["<Variable", _attr("name", v.get("name")),
                 _attr("type", v.get("type")), _attr("default", v.get("default"))]
        for k, val in (v.get("extra_attrs") or {}).items():
            parts.append(_attr(k, val))
        emit(" ".join(parts) + " />" + tail(v.get("tail"), "\n"))
    for tr in doc.get("triggers", []):
        parts = ["<Trigger", _attr("any", tr.get("any")),
                 _attr("active", tr.get("active")),
                 _attr("cutsceneActive", tr.get("cutsceneActive")),
                 _attr("guid", tr.get("guid"))]
        for k, val in (tr.get("extra_attrs") or {}).items():
            parts.append(_attr(k, val))
        emit(" ".join(parts) + "><Name>%s</Name>%s" % (
            _text(tr.get("name")), tail(tr.get("name_tail"), "\n")))
        emit("<ExecNumber>%s</ExecNumber>%s" % (
            _text(tr.get("exec_number")), tail(tr.get("exec_tail"), "\n")))
        last_tr = tr
        for it in tr.get("items", []):
            if "raw" in it:
                # ET.tostring включает хвост элемента - не задваиваем его
                r = it["raw"]
                t_ = it.get("tail") or ""
                if t_ and not r.endswith(t_):
                    r += t_
                emit(r)
                continue
            parts = ["<%s" % _safe_name(it.get("tag", "Action"), "Action"),
                       _attr("guid", it.get("guid")),
                     _attr("disabled", it.get("disabled"))]
            for k, val in (it.get("extra_attrs") or {}).items():
                parts.append(_attr(k, val))
            emit(" ".join(parts) + "><Name>%s</Name>%s" % (
                _text(it.get("name")), tail(it.get("name_tail"), "\n")))
            params = it.get("params", [])
            ptails = it.get("param_tails") or []
            for i, p in enumerate(params):
                pt = ptails[i] if i < len(ptails) else None
                emit("<Param>%s</Param>%s" % (_text(p), tail(pt, "\n")))
            emit("</%s>%s" % (_safe_name(it.get("tag", "Action"), "Action"),
                              tail(it.get("tail"), "\n")))
        emit("</Trigger>%s" % tail(tr.get("tail"), "\n"))
    emit("</Root>")
    text = _restore_entities("".join(out))
    if doc.get("trailing_newline", True) and not text.endswith("\n"):
        text += "\n"
    return text


def _max_guid(items: list) -> int:
    mx = 0
    for it in items:
        g = str(it.get("guid", ""))
        if g.isdigit():
            mx = max(mx, int(g))
    return mx


def fix_duplicate_guids(doc: dict) -> int:
    """Повторные guid внутри одного типа (Trigger/Condition/Action) получают
    новые свободные номера. Возвращает число исправлений. guid у Trigger,
    Condition и Action - три независимые нумерации."""
    fixed = 0
    groups = [doc.get("triggers", [])]
    for tr in doc.get("triggers", []):
        groups.append([it for it in tr.get("items", []) if it.get("tag") == "Condition"])
        groups.append([it for it in tr.get("items", []) if it.get("tag") == "Action"])
    for items in groups:
        seen = set()
        nxt = _max_guid(items) + 1
        for it in items:
            g = str(it.get("guid", ""))
            if g == "":
                continue
            if g in seen:
                while str(nxt) in seen:
                    nxt += 1
                it["guid"] = str(nxt)
                seen.add(str(nxt))
                nxt += 1
                fixed += 1
            else:
                seen.add(g)
    return fixed


def save_file(path: str, doc: dict) -> bool:
    """Записать структуру в файл. Без изменений файл не переписывается.
    Предыдущая версия - в <имя>.swt.bak. Запись атомарна (tmp + os.replace):
    падение посреди записи не оставляет обрезанный файл. True = записан."""
    text = serialize(doc)
    old = None
    if os.path.isfile(path):
        try:
            with open(path, "rb") as fh:
                old = fh.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            old = None
    if old is not None and old.lstrip("﻿") == text:
        return False
    if old is not None:
        try:
            shutil.copy2(path, path + ".bak")
        except Exception:  # noqa: BLE001
            pass
    tmp = path + ".tmp-%d" % os.getpid()
    try:
        with open(tmp, "wb") as fh:
            fh.write(text.encode("utf-8"))
        os.replace(tmp, path)
    except BaseException:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except Exception:  # noqa: BLE001
            pass
        raise
    return True
