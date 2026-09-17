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
    "auto_save": False,
    "default_key_column": "sysname",
    "last_project": "",
    # корень текущего проекта (настройка; используется деревом по умолчанию)
    "project_path": "",
    # путь к распакованным ассетам игры (вкладка «Игра» в дереве проекта);
    # заполняется автоматически после успешной распаковки
    "unpacked_path": "",
    # путь к баланс-конфигу карты Uprising (.cfg): сложности зон/юнитов,
    # автозапись при изменениях, импорт/экспорт расстановки сил
    "uprising_cfg_path": "",
    # настройки рандомайзера Uprising и блокировки секторов: localStorage
    # привязан к origin (а порт сервера случаен), поэтому персист — здесь
    "uprising_rnd_opts": {},
    "uprising_rnd_excl": {},
    # глобальный источник Проект | Игра | Мод: localStorage живёт один
    # запуск по той же причине (случайный порт), поэтому персист — здесь
    "tree_view": "project",
    # путь к основному (созданному пользователем) моду: заполняется
    # автоматически при создании мода; используется командой
    # «Скопировать в мод» в контекстных меню дерева и вкладок
    "mod_path": "",
    # Саб-пути мода (саб-меню кнопки пути в настройках): папка вида
    # <МОД>_ASSETS с чистыми текстурами и папка с моделями рядом
    # с корнем мода. Поиск идёт по слоям мода, затем саб-путей —
    # все корни видны программе как одно целое (domain/modroots).
    # mod_overlay_path — старое имя саб-пути ассетов, подхватывается
    # как mod_assets_path для совместимости.
    "mod_assets_path": "",
    "mod_models_path": "",
    # фоновый прогрев текстур (DDS->WebP заранее): галка — автоматом
    # один раз при подключении проекта/мода, кнопка в шапке — вручную
    # в любой момент. warmup_done — normcase-корни, уже гретые авто
    # (свежий кэш всё равно пропускается по mtime, список — чтобы не
    # стартовать заново на каждый сейв настроек).
    "warmup_auto": False,
    "warmup_done": [],
    # пользовательские переназначения горячих клавиш: {action: {code, ctrl, shift, alt}}
    "hotkeys": {},
    # иконка в системном трее (реализуется лаунчером/окном)
    "tray_enabled": True,
    # сворачивать окно в трей при открытии интерфейса в браузере
    "browser_to_tray": True,
    # автоматически скрывать дерево проекта при открытии файла
    "auto_hide_tree": False,
    # открывать интерфейс в системном браузере вместо окна приложения
    "open_in_browser": False,
    # защита распакованной игры: при сохранении файла из unpacked_path
    # предложить сохранить в проект или мод (по умолчанию вкл)
    "guard_unpacked": True,
    # автообновления: Cloudflare Worker поверх GitHub releases;
    # update_repo пусто = репозиторий по умолчанию воркера
    "update_repo": "",
    "update_server": "https://terminatortoolsetupdater.hanigunplus.workers.dev/",
    "update_channel": "release",   # release | beta (бета включает pre-release)
    "update_last_check": 0,        # unix time последней проверки
    # автообновление при старте: проверка + скачивание + установка
    # (по умолчанию выкл — только ручная проверка из настроек)
    "auto_update": False,
    # архив GameAssets (скрипты/локализация стоковой игры из релиза):
    # флаг строго 0/1, версия — только информация (тег релиза-источника)
    "game_assets_downloaded": 0,
    "game_assets_version": "",
    "max_backups_per_file": 200,
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
        self.cfg_dir = os.path.join(dir_path, "configs")
        try:
            os.makedirs(self.cfg_dir, exist_ok=True)
        except Exception:  # noqa: BLE001
            pass
        self.path = os.path.join(self.cfg_dir, "config.json")
        # совместимость: старый config.json в корне -> перенос в configs/
        _old = os.path.join(dir_path, "config.json")
        if not os.path.isfile(self.path) and os.path.isfile(_old):
            try:
                with open(_old, "r", encoding="utf-8") as fh:
                    json.load(fh)
                os.replace(_old, self.path)
            except Exception:  # noqa: BLE001
                pass
        self.db_path = os.path.join(dir_path, "terminator_sheet.db")
        self.data: dict = {}
        self.load()

    def load(self):
        if os.path.isfile(self.path):
            user = self._read_json_retry(self.path)
            if isinstance(user, dict):
                self.data = {**DEFAULTS, **user}
                # follow the system language until the user chooses one
                if "language" not in user:
                    self.data["language"] = _system_language()
                self._normalize()
                return
            # Битый/оборванный config.json (типично: конкурентная запись
            # в момент рестарта после обновления). Раньше ветка ниже молча
            # затирала файл дефолтами — пути пропадали до ручного сейва.
            # Теперь: бэкап в сторону, память — дефолты, дальше работает сейв.
            self._backup_corrupt(self.path)
        else:
            # первый запуск: файла нет — создаём с дефолтами как раньше
            self.data = dict(DEFAULTS)
            self.data["language"] = _system_language()
            self.save()
            return
        self.data = dict(DEFAULTS)
        self.data["language"] = _system_language()
        self.save()

    @staticmethod
    def _read_json_retry(path, tries=3, delay=0.2):
        """Прочитать JSON с повторами: файл может быть momentarily занят
        (Windows-лок) или недописан другим процессом при рестарте.
        Возвращает dict либо None."""
        import time
        for _ in range(tries):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                return data if isinstance(data, dict) else None
            except Exception:  # noqa: BLE001
                time.sleep(delay)
        return None

    @staticmethod
    def _backup_corrupt(path):
        """Убрать битый файл в сторону (config.json.corrupt-<ts>.bak),
        чтобы данные можно было восстановить вручную."""
        import time
        try:
            bak = "%s.corrupt-%d.bak" % (path, int(time.time()))
            if os.path.isfile(path) and not os.path.isfile(bak):
                os.replace(path, bak)
        except Exception:  # noqa: BLE001
            pass

    def _normalize(self):
        """Coerce known value types so a hand-edited/corrupt config.json cannot
        pass a string where the window code expects an int/bool."""
        for k in ("window_width", "window_height", "max_backups_per_file",
                  "update_last_check"):
            try:
                self.data[k] = int(self.data.get(k, DEFAULTS[k]))
            except (TypeError, ValueError):
                self.data[k] = DEFAULTS[k]
            try:
                self.data[k] = int(self.data.get(k, DEFAULTS[k]))
            except (TypeError, ValueError):
                self.data[k] = DEFAULTS[k]
        for k in ("fullscreen", "auto_save", "tray_enabled", "open_in_browser",
                  "browser_to_tray", "auto_hide_tree", "auto_update"):
            v = self.data.get(k, DEFAULTS[k])
            if not isinstance(v, bool):
                self.data[k] = str(v).lower() in ("1", "true", "yes", "on")
        if self.data.get("window_size") not in WINDOW_SIZES:
            self.data["window_size"] = DEFAULTS["window_size"]
        if self.data.get("update_channel") not in ("release", "beta"):
            self.data["update_channel"] = DEFAULTS["update_channel"]
        try:
            self.data["game_assets_downloaded"] = 1 if int(
                self.data.get("game_assets_downloaded", 0)) == 1 else 0
        except (TypeError, ValueError):
            self.data["game_assets_downloaded"] = 0
        try:
            self.data["game_assets_version"] = str(
                self.data.get("game_assets_version", "") or "")
        except Exception:  # noqa: BLE001
            self.data["game_assets_version"] = ""
        if self.data.get("language") not in ("ru", "en", "de", "zh"):
            self.data["language"] = "ru" if str(self.data.get("language", "")).lower().startswith("ru") else "en"
        if self.data.get("tree_view") not in ("project", "game", "mod"):
            self.data["tree_view"] = DEFAULTS["tree_view"]

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2)
        except Exception:  # noqa: BLE001
            pass

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value
        self.save()


# секции маркеров правок: каждая со своим списком файлов и English description.
# очистка затрагивает только нужную секцию, общий файл configs/markers.json.
MARKER_SECTIONS = {
    "species": "Files edited in species tables (units, squads, vehicles)",
    "swt": "Mission script files (.swt) edited in SWT Editor",
    "shop": "Shop preset files edited on the Uprising map",
    "other": "Other project files edited and saved by the app",
}


class Markers:
    def __init__(self, cfg_dir: str):
        self.path = os.path.join(cfg_dir, "markers.json")
        self.data: dict = {"_descriptions": dict(MARKER_SECTIONS),
                           "species": [], "swt": [], "shop": [], "other": []}
        self.load()

    def load(self):
        if os.path.isfile(self.path):
            user = Config._read_json_retry(self.path)
            if isinstance(user, dict):
                for k in MARKER_SECTIONS:
                    v = user.get(k)
                    if isinstance(v, list):
                        self.data[k] = [str(x) for x in v]
                self.data["_descriptions"] = dict(MARKER_SECTIONS)
                return
            # битый markers.json: бэкап в сторону вместо молчаливого wipe
            Config._backup_corrupt(self.path)
        self.save()

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2)
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def section_for(path: str) -> str:
        p = (path or "").lower().replace("\\", "/")
        if p.endswith(".swt"):
            return "swt"
        if "shop_presets" in p:
            return "shop"
        if "/species/" in p or p.endswith((".xml",)):
            # species-файлы лежат в basis/scripts/species
            if "/species/" in p:
                return "species"
            return "other"
        return "other"

    def add(self, path: str):
        sec = self.section_for(path)
        lst = self.data.setdefault(sec, [])
        rel = os.path.normpath(path)
        if rel not in lst:
            lst.append(rel)
            self.save()

    def clear_section(self, section: str):
        if section in MARKER_SECTIONS:
            self.data[section] = []
            self.save()

    def all_files(self) -> "list[str]":
        out = []
        for k in MARKER_SECTIONS:
            out.extend(self.data.get(k) or [])
        return out
