"""JSON config living next to the executable / source folder.

Generated on first run with defaults. Persists window size, language, theme,
auto-save, comparison key column, last opened project.
"""
from __future__ import annotations

import json
import os

DEFAULTS = {
    "language": "ru",
    "theme": "dark",
    "fullscreen": False,
    "window_size": "normal",   # normal | wide (+20% w) | big (+20% w & h)
    "window_width": 1280,
    "window_height": 800,
    "auto_save": True,
    "default_key_column": "sysname",
    "last_project": "",
    "max_backups_per_file": 200,
    # Доп. флаги QtWebEngine/Chromium (опционально). Примеры для экспериментов:
    #   "--disable-frame-rate-limit"        - не резать FPS (соответствует герцам, но грузит CPU)
    #   "--use-angle=d3d9"                  - другой бэкенд ANGLE (убирает жёлтые артефакты)
    #   "--disable-gpu-compositing"         - софтверный композитинг (убирает артефакты, тихо)
    "chromium_flags": "",
}

WINDOW_SIZES = {
    "normal": (1280, 800),
    "wide": (1536, 800),
    "big": (1536, 960),
}


def _system_language() -> str:
    """Detect the OS UI language (ru -> 'ru', everything else -> 'en').
    Used on first run only, before the user picks a language manually."""
    try:
        import ctypes
        langid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
        primary = int(langid) & 0x3FF   # primary language id (low 10 bits)
        if primary == 0x19:             # Russian
            return "ru"
    except Exception:  # noqa: BLE001
        pass
    return "en"


class Config:
    def __init__(self, dir_path: str):
        self.dir = dir_path
        self.path = os.path.join(dir_path, "config.json")
        self.db_path = os.path.join(dir_path, "terminator_sheet.db")
        self.data: dict = {}
        self.load()

    def load(self):
        if os.path.isfile(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    user = json.load(fh)
                self.data = {**DEFAULTS, **user}
                # follow the system language until the user chooses one
                if "language" not in user:
                    self.data["language"] = _system_language()
                self._normalize()
                return
            except Exception:  # noqa: BLE001
                pass
        self.data = dict(DEFAULTS)
        self.data["language"] = _system_language()

    def _normalize(self):
        """Coerce known value types so a hand-edited/corrupt config.json cannot
        pass a string where the window code expects an int/bool."""
        for k in ("window_width", "window_height", "max_backups_per_file"):
            try:
                self.data[k] = int(self.data.get(k, DEFAULTS[k]))
            except (TypeError, ValueError):
                self.data[k] = DEFAULTS[k]
        for k in ("fullscreen", "auto_save"):
            v = self.data.get(k, DEFAULTS[k])
            if not isinstance(v, bool):
                self.data[k] = str(v).lower() in ("1", "true", "yes", "on")
        if self.data.get("window_size") not in WINDOW_SIZES:
            self.data["window_size"] = DEFAULTS["window_size"]
        if self.data.get("language") not in ("ru", "en"):
            self.data["language"] = "ru" if str(self.data.get("language", "")).lower().startswith("ru") else "en"

    def save(self):
        try:
            with open(self.path, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2)
        except Exception:  # noqa: BLE001
            pass

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value
        self.save()
