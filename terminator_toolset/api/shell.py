"""Shell routes: pages, boot progress, locales, static assets, misc."""
from __future__ import annotations

import json
import os
import re
import time
import webbrowser

from flask import jsonify, render_template, request, send_from_directory

from ..application.state import _PENDING_FILES, set_pending_files
from ..infrastructure.filesystem import resolve_external as _resolve_external


_ICONS_MEM = {"mt": -1.0, "map": {}}  # name -> data-URL; сброс по mtime папки
_LOGO_MEM = {"path": "", "mt": 0.0, "url": ""}  # инлайн-логотип сплеша


def _logo_data_url(config, base):
    """Логотип сплеша инлайном (data-URL, кэш по mtime файла).

    Отдельным HTTP-запросом картинка приезжала позже страницы, а во
    frozen-сборке первый хит ещё и распаковывал embedded-кэш на диск —
    окно первую секунду стояло без логотипа. Приоритет файла — как у
    /assets/icons (внешний рядом с EXE, embedded-кэш, встроенный)."""
    try:
        from ..services import embedded_cache as _emb
        emb = _emb.ensure()[0]
    except Exception:  # noqa: BLE001
        emb = ""
    cands = [
        _resolve_external([config.dir, os.path.dirname(config.dir)],
                          "assets", "icons", "app_icon.png"),
        os.path.join(emb, "app_icon.png") if emb else "",
        os.path.join(base, "assets", "icons", "app_icon.png"),
    ]
    path = next((p for p in cands if p and os.path.isfile(p)), "")
    if not path:
        return ""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return ""
    mem = _LOGO_MEM
    if mem["url"] and mem.get("path") == path and mem["mt"] == mt:
        return mem["url"]
    try:
        with open(path, "rb") as fh:
            raw = fh.read(1 << 20)
    except OSError:
        return ""
    if len(raw) > 512_000:  # вдруг подменили гигантом — старым URL
        return ""
    import base64
    mem.update(path=path, mt=mt,
               url="data:image/png;base64," + base64.b64encode(raw).decode("ascii"))
    return mem["url"]


def register_shell(app, ctx, boot_progress=None):
    """Pages, launch progress, drop mailbox, locales/assets, i18n, misc."""
    config, i18n, log, base, version, upr = (
        ctx.config, ctx.i18n, ctx.log, ctx.base, ctx.version, ctx.upr)

    # -- pages ---------------------------------------------------------------
    @app.route("/")
    def index():
        build_id = str(int(time.time()))  # cache-busting for static assets
        return render_template("index.html", title=i18n.t("app_title"), v=build_id)

    @app.route("/splash")
    def splash():
        build_id = str(int(time.time()))
        return render_template("splash.html", title=i18n.t("app_title"),
                               version=version, v=build_id,
                               logo_data_url=_logo_data_url(config, base))

    @app.route("/api/version")
    def api_version():
        return jsonify({"ok": True, "version": version})

    # -- прогресс запуска для лаунчера ---------------------------------------
    # Монотонный счётчик 0..100 + подпись: ранние этапы сеет main.py,
    # этапы интерфейса — фронт; лаунчер опрашивает GET и рисует бар.
    # При раннем старте dict уже создан boot-приложением и shared: бар
    # не прыгает назад после hot-swap WSGI.
    boot_progress = boot_progress if isinstance(boot_progress, dict) \
        else {"pct": 0, "label": ""}
    app.boot_progress = boot_progress  # точка доступа для main.py

    def _boot_ping(pct, label=""):
        try:
            pct = max(0, min(100, int(pct)))
        except (TypeError, ValueError):
            return
        if pct >= boot_progress["pct"]:
            boot_progress["pct"] = pct
            if label:
                boot_progress["label"] = label
        elif label and pct == boot_progress["pct"]:
            boot_progress["label"] = label

    app.boot_ping = _boot_ping
    _boot_ping(5, i18n.t("boot_server"))

    @app.route("/api/boot_progress")
    def api_boot_progress():
        return jsonify({"ok": True, "pct": boot_progress["pct"],
                        "label": boot_progress["label"]})

    @app.route("/api/boot_progress", methods=["POST"])
    def api_boot_progress_set():
        data = request.get_json(silent=True) or {}
        _boot_ping(data.get("pct", 0), str(data.get("label") or ""))
        # непустая подпись — событие фронта (stall/boot_failed/boot_retry
        # лоадера): в boot.log, иначе зависший старт недиагностируем.
        # log — boot_log или logging-логгер (как в application.boot_stages).
        try:
            if str(data.get("label") or ""):
                if hasattr(log, "info"):
                    log.info("boot: %s (%s%%)",
                             data.get("label"), data.get("pct", 0))
                else:
                    log("boot: %s (%s%%)" % (data.get("label"),
                                             data.get("pct", 0)))
        except Exception:  # noqa: BLE001
            pass
        return jsonify({"ok": True, "pct": boot_progress["pct"],
                        "label": boot_progress["label"]})

    @app.route("/api/pending_files")
    def api_pending_files():
        """Файлы от второго запуска / Drag&Drop / CLI. Первый забирает и чистит."""
        files, dirs = [], []
        for f in _PENDING_FILES:
            if not os.path.exists(f):
                continue
            (dirs if os.path.isdir(f) else files).append(f)
        set_pending_files([])
        # + mailbox второго инстанса
        try:
            box = os.path.join(os.environ.get("LOCALAPPDATA") or config.dir,
                               "TerminatorSheetQt", "instance", "pending.json")
            if os.path.isfile(box):
                with open(box, "r", encoding="utf-8") as fh:
                    extra = json.load(fh) or []
                try:
                    os.remove(box)
                except Exception:  # noqa: BLE001
                    pass
                for f in extra:
                    if isinstance(f, str) and os.path.exists(f):
                        if os.path.isdir(f):
                            if f not in dirs:
                                dirs.append(f)
                        elif f not in files:
                            files.append(f)
        except Exception:  # noqa: BLE001
            pass
        return jsonify({"ok": True, "files": files, "dirs": dirs})

    @app.route("/api/resolve_drop", methods=["POST"])
    def api_resolve_drop():
        """Сопоставить имена брошенных в окно файлов/папок с известными
        корнями (проект, распакованная игра, мод): WebView2 не отдаёт пути,
        только имена. Возвращает найденные пути + is_dir."""
        data = request.get_json(silent=True) or {}
        items = data.get("items") or []
        roots = []
        for key in ("project_path", "last_project", "unpacked_path", "mod_path"):
            try:
                p = config.get(key) or ""
            except Exception:  # noqa: BLE001
                p = ""
            if p and os.path.isdir(p) and p not in roots:
                roots.append(p)
        try:
            from project import Project
            pr = getattr(Project(), "root", "") or ""
            if pr and os.path.isdir(pr) and pr not in roots:
                roots.append(pr)
        except Exception:  # noqa: BLE001
            pass
        want_files = [str(x.get("name") or "") for x in items
                      if isinstance(x, dict) and not x.get("isDir") and x.get("name")]
        want_dirs = [str(x.get("name") or "") for x in items
                     if isinstance(x, dict) and x.get("isDir") and x.get("name")]
        sizes = {}
        for x in items:
            if isinstance(x, dict) and x.get("name") and x.get("size"):
                try:
                    sizes[str(x["name"])] = int(x["size"])
                except Exception:  # noqa: BLE001
                    pass
        found_files, found_dirs = [], []
        need_f = set(want_files)
        need_d = set(want_dirs)
        try:
            for root in roots:
                if not need_f and not need_d:
                    break
                for dirpath, dirnames, filenames in os.walk(root):
                    if not need_f and not need_d:
                        break
                    for dn in list(dirnames):
                        if dn in need_d:
                            found_dirs.append(os.path.join(dirpath, dn))
                            need_d.discard(dn)
                    for fn in filenames:
                        if fn in need_f:
                            p = os.path.join(dirpath, fn)
                            if fn in sizes:
                                try:
                                    if os.path.getsize(p) != sizes[fn]:
                                        continue
                                except Exception:  # noqa: BLE001
                                    pass
                            found_files.append(p)
                            if len([f for f in found_files
                                    if os.path.basename(f) == fn]) >= 5:
                                need_f.discard(fn)
                    if len(found_files) + len(found_dirs) >= 40:
                        break
        except Exception as e:  # noqa: BLE001
            log.info("resolve_drop walk failed: %s", e)
        unknown = sorted(need_f | need_d)
        return jsonify({"ok": True, "files": found_files,
                        "dirs": found_dirs, "unknown": unknown})

    @app.route("/locales/<lang>.json")
    def locales(lang):
        safe = re.sub(r"[^a-z]", "", (lang or "").lower())[:8] or "en"
        # внешние locales рядом с EXE/конфигом в приоритете над _MEIPASS
        ext = _resolve_external([config.dir,
                                 os.path.dirname(config.dir),
                                 os.getcwd()],
                                "locales", "%s.json" % safe)
        if ext:
            return send_from_directory(os.path.dirname(ext),
                                       "%s.json" % safe)
        path = os.path.join(base, "locales", "%s.json" % safe)
        if os.path.isfile(path):
            return send_from_directory(os.path.join(base, "locales"), "%s.json" % safe)
        return jsonify({})

    @app.route("/assets/icons/<path:filename>")
    def icon_assets(filename):
        # единственные встроенные в EXE; внешние рядом с EXE тоже резолвятся.
        # вложенные пути (dark/icons/*.svg) разрешены, traversal запрещён.
        fn = (filename or "").replace("\\", "/").strip("/")
        if not fn or fn.startswith(".") or "/../" in ("/" + fn + "/"):
            return ("", 404)
        parts = fn.split("/")
        ext = _resolve_external([config.dir, os.path.dirname(config.dir)],
                                "assets", "icons", *parts)
        if ext:
            resp = send_from_directory(os.path.dirname(ext), parts[-1])
        else:
            # frozen exe: icons внутри .exe (embedded-модуль -> локальный кэш)
            emb = ""
            try:
                from terminator_toolset.services import embedded_cache as _emb
                emb = _emb.ensure()[0]
            except Exception:  # noqa: BLE001
                emb = ""
            if emb and os.path.isfile(os.path.join(emb, *parts)):
                resp = send_from_directory(emb, "/".join(parts))
            else:
                resp = send_from_directory(os.path.join(base, "assets", "icons"), fn)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    @app.route("/assets/UprisingMap/<path:filename>")
    def uprising_assets(filename):
        # мелкие веб-ассеты карты (череп сложности и т.п.): внешние рядом
        # с EXE в приоритете, иначе встроенные _base
        fn = (filename or "").replace("\\", "/").strip("/")
        if not fn or fn.startswith(".") or "/../" in ("/" + fn + "/"):
            return ("", 404)
        parts = fn.split("/")
        ext = _resolve_external([config.dir, os.path.dirname(config.dir)],
                                "assets", "UprisingMap", *parts)
        if ext:
            resp = send_from_directory(os.path.dirname(ext), parts[-1])
        else:
            resp = send_from_directory(os.path.join(base, "assets", "UprisingMap"), fn)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    @app.route("/assets/map/<path:filename>")
    def map_assets(filename):
        # одна текстура global_map.webp: внешние assets рядом с EXE
        # в приоритете (правка без пересборки), иначе встроенные _base
        fn = (filename or "").replace("\\", "/").strip("/")
        if fn != "global_map.webp":
            return ("", 404)
        ext = _resolve_external(
            [config.dir, os.path.dirname(config.dir), os.getcwd()],
            "assets", "UprisingMap", fn)
        if ext:
            resp = send_from_directory(os.path.dirname(ext), fn)
        else:
            resp = send_from_directory(
                os.path.join(base, "assets", "UprisingMap"), fn)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    @app.route("/assets/campaign/<path:filename>")
    def campaign_assets(filename):
        # ассеты редактора кампании (GlobalMap.png, cities/*.webp,
        # button_*.webp): внешние рядом с EXE в приоритете (правка без
        # пересборки), иначе встроенные _base
        fn = (filename or "").replace("\\", "/").strip("/")
        if not fn or fn.startswith(".") or "/../" in ("/" + fn + "/"):
            return ("", 404)
        parts = fn.split("/")
        ext = _resolve_external([config.dir, os.path.dirname(config.dir)],
                                "assets", "Campaign", *parts)
        if ext:
            resp = send_from_directory(os.path.dirname(ext), parts[-1])
        else:
            resp = send_from_directory(os.path.join(base, "assets", "Campaign"), fn)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    @app.route("/api/icons_data", methods=["POST"])
    def api_icons_data():
        """Иконки темы одним запросом: {name: data:image/svg+xml;base64}.

        Та же болезнь, что была у щитов карты: десятки/сотни отдельных <img>
        по HTTP/1.0 без keep-alive (каждый — новый коннект), отдельные иконки
        эпизодически не прогружались (пустая иконка главной вкладки и т.п.).
        Один ответ — всё из памяти. Кэш по mtime папки темы."""
        import base64
        data = request.get_json(silent=True) or {}
        names = {str(n).strip().lower() for n in (data.get("names") or [])
                 if str(n).strip()}
        roots = []
        for r in (config.dir, os.path.dirname(config.dir)):
            if r:
                roots.append(os.path.join(r, "assets", "icons", "dark", "icons"))
        try:  # frozen exe: icons внутри .exe (embedded-модуль -> кэш)
            from terminator_toolset.services import embedded_cache as _emb
            _emb_icons = _emb.ensure()[0]
            if _emb_icons:
                roots.append(os.path.join(_emb_icons, "dark", "icons"))
        except Exception:  # noqa: BLE001
            pass
        roots.append(os.path.join(base, "assets", "icons", "dark", "icons"))
        mts, found = [], {}
        for root in roots:
            try:
                mts.append(os.path.getmtime(root))
            except OSError:
                continue
            for fn in (sorted(os.listdir(root)) if not names else names):
                if not fn.lower().endswith(".svg"):
                    continue
                key = fn.lower()
                if key not in found:
                    p = os.path.join(root, fn)
                    try:
                        if os.path.isfile(p):
                            found[key] = p
                    except OSError:
                        pass
        mt = max(mts) if mts else 0.0
        ent = _ICONS_MEM
        if ent["mt"] != mt:
            ent["mt"] = mt
            ent["map"] = {}
        out = {}
        for key, path in found.items():
            hit = ent["map"].get(key)
            if hit is None:
                try:
                    with open(path, "rb") as f:
                        raw = f.read()
                except OSError:
                    continue
                hit = ("data:image/svg+xml;base64,"
                       + base64.b64encode(raw).decode("ascii"))
                ent["map"][key] = hit
            out[key] = hit
        return jsonify({"ok": True, "icons": out})

    @app.route("/assets/shields/<path:filename>")
    def shield_assets(filename):
        # shields теперь WebP: .png-алиас маппим на .webp без редиректа-цикла
        base, extn = os.path.splitext(filename)
        cands = [filename]
        if extn.lower() == ".png":
            cands.append(base + ".webp")
        search_roots = []
        for r in (config.dir, os.path.dirname(config.dir), os.getcwd()):
            if r:
                search_roots.append(os.path.join(r, "assets", "UprisingMap", "shields"))
        search_roots.append(os.path.join(base, "assets", "UprisingMap", "shields"))
        for cand in cands:
            if "/" in cand or "\\" in cand:
                continue
            for root in search_roots:
                p = os.path.join(root, cand)
                try:
                    if os.path.isfile(p):
                        resp = send_from_directory(root, cand)
                        if cand.lower().endswith(".webp"):
                            resp.headers["Content-Type"] = "image/webp"
                        resp.headers["Cache-Control"] = "public, max-age=86400"
                        return resp
                except Exception:  # noqa: BLE001
                    continue
        return ("", 404)

    @app.route("/api/uprising_shields_data")
    def api_uprising_shields_data():
        """Все щиты-бейджи карты одним запросом: {key: data:image/webp;base64}.

        Раньше каждый щит грузился отдельным <img> по HTTP/1.0 без keep-alive
        (десятки коннектов к dev-серверу + ?v=Date.now мимо кэша): на холодном
        HDD часть щитов не успевала прогрузиться. Один ответ — всё из памяти.
        key = имя файла без .webp (напр. player_capital_d3)."""
        return jsonify(upr.shields_data())

    @app.route("/assets/upr-webp/<bucket>/<path:filename>")
    def upr_webp_assets(bucket, filename):
        # готовые webp-иконки карты Uprising: отдаём как есть, без конвертации;
        # custom лежит в подпапках слоёв (BaseGame/проект/мод), поэтому path;
        # immutable-кэш — браузер держит иконки между открытиями карты
        fn = (filename or "").replace("\\", "/")
        if (bucket not in upr.webp_buckets
                or not fn.lower().endswith(".webp") or ".." in fn
                or fn.startswith("/") or not fn.strip("/")):
            return ("", 404)
        resp = send_from_directory(upr.webp_bucket_dir(bucket), fn)
        resp.headers["Cache-Control"] = "public, max-age=86400, immutable"
        return resp

    @app.route("/api/i18n")
    def api_i18n():
        return jsonify(i18n.list())

    @app.route("/api/open_browser", methods=["POST"])
    def api_open_browser():
        """Open the app UI in the default system browser."""
        try:
            webbrowser.open("http://" + request.host + "/")
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True})

    # внешние ссылки интерфейса (донат, соцсети «О программе»): строгий
    # allowlist — произвольные URL из фронта не открываем
    _OPEN_LINK_ALLOW = (
        "https://dalink.to/hanigun",
        "https://github.com/Hanigun/TerminatorToolSet",
        "https://discord.com/invite/mNvUs8rRPS",
    )

    @app.route("/api/open_link", methods=["POST"])
    def api_open_link():
        """Open an allowlisted external URL in the system browser."""
        data = request.get_json(silent=True) or {}
        url = str(data.get("url") or "")
        if url not in _OPEN_LINK_ALLOW:
            return jsonify({"ok": False, "error": "url not allowed"})
        try:
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True})

    @app.route("/api/client_log", methods=["POST"])
    def api_client_log():
        """Ошибки/события фронтенда (window.onerror, unhandledrejection,
        сетевые сбои) -> общий лог-файл, чтобы «молчаливые» сбои были видны."""
        data = request.get_json(silent=True) or {}
        kind = str(data.get("kind") or "js")
        msg = str(data.get("message") or "")
        extra = data.get("extra") or {}
        try:
            log.error("client[%s]: %s | %s", kind, msg,
                      json.dumps(extra, ensure_ascii=False)[:500])
        except Exception:  # noqa: BLE001
            pass
        return jsonify({"ok": True})
