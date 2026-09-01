"""i18n: RU/EN UI strings, loaded from locales/*.json."""

from __future__ import annotations

import json
import os

_DEFAULT_LANG = "ru"
_CACHE: "dict[str, dict]" = {}


def _load(lang: str) -> dict:
    if lang in _CACHE:
        return _CACHE[lang]
    path = os.path.join(os.path.dirname(__file__), "locales", "%s.json" % lang)
    data = {}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:  # noqa: BLE001
            data = {}
    _CACHE[lang] = data
    return data


class I18n:
    def __init__(self, lang: str = _DEFAULT_LANG):
        self.lang = lang
        self._fallback = _load(_DEFAULT_LANG)
        self._data = _load(lang)

    def switch(self, lang: str):
        self.lang = lang
        self._data = _load(lang)

    def t(self, key: str) -> str:
        if key in self._data:
            return self._data[key]
        if key in self._fallback:
            return self._fallback[key]
        return key

    def list(self) -> dict:
        merged = dict(self._fallback)
        merged.update(self._data)
        return merged
