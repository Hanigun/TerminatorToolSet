"""Terminator ToolSet — SpreadsheetML editor for Terminator: Dark Fate - Defiance mods.

Single version source: pyproject.toml (project.version). Installed dist
read via importlib.metadata; source runs and the frozen exe read the
pyproject next to the sources / bundled at the _MEIPASS root (spec datas).
"""
from __future__ import annotations

import os
import sys
import tomllib


def _detect_version():
    try:
        from importlib.metadata import PackageNotFoundError
        from importlib.metadata import version as _dist_version
        try:
            return _dist_version("terminator-toolset")
        except PackageNotFoundError:
            pass
    except Exception:  # noqa: BLE001 - metadata backend missing, use file
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, os.pardir, "pyproject.toml"),
        os.path.join(getattr(sys, "_MEIPASS", "") or "", "pyproject.toml"),
    ]
    for path in candidates:
        try:
            with open(path, "rb") as fh:
                data = tomllib.load(fh)
            found = (data.get("project") or {}).get("version")
            if found:
                return str(found)
        except Exception:  # noqa: BLE001 - try the next candidate
            continue
    return "0.0.0+unknown"


__version__ = _detect_version()
