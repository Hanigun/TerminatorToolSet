# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Terminator Sheet (PySide6 + QtWebEngine, onefile, windowed).

QtWebEngine требует доп. ресурсов (QtWebEngineProcess.exe, qtwebengine_*.pak,
icudtl.dat, translations) и DLL. PyInstaller-хук для PySide6 собирает их
автоматически, когда модули QtWebEngine импортируются/в hiddenimports.
Дополнительно собираем их явно через collect_all для надёжности onefile.
"""
import os

from PyInstaller.utils.hooks import collect_all

block_cipher = None

root = os.path.abspath(os.getcwd())

datas = [
    (os.path.join(root, "templates"), "templates"),
    (os.path.join(root, "static"), "static"),
    (os.path.join(root, "locales"), "locales"),
    (os.path.join(root, "assets", "icons"), os.path.join("assets", "icons")),
]

binaries = []
hiddenimports = [
    "PySide6.QtWebEngineWidgets",
    "PySide6.QtWebEngineCore",
    "PySide6.QtWebChannel",
    "PySide6.QtNetwork",
    "PySide6.QtGui",
    "PySide6.QtWidgets",
    "PySide6.QtCore",
    "lxml._elementpath",
]

for pkg in ("PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(root, "main.py")],
    pathex=[root],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="TerminatorSheetQt",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,              # upx портит QtWebEngine DLL/ресурсы
    console=False,          # windowed app (no console)
    disable_windowed_traceback=False,
    icon=os.path.join(root, "assets", "icons", "app_icon.ico"),
)
