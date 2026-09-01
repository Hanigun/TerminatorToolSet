# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Terminator Sheet (onefile, windowed, no console)."""

import os

block_cipher = None

root = os.path.abspath(os.getcwd())

datas = [
    (os.path.join(root, "templates"), "templates"),
    (os.path.join(root, "static"), "static"),
    (os.path.join(root, "locales"), "locales"),
    (os.path.join(root, "assets", "icons"), os.path.join("assets", "icons")),
]

a = Analysis(
    [os.path.join(root, "main.py")],
    pathex=[root],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
        "lxml._elementpath",
    ],
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
    name="TerminatorSheet",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # windowed app (no console)
    disable_windowed_traceback=False,
    icon=os.path.join(root, "assets", "icons", "app_icon.ico"),
)
