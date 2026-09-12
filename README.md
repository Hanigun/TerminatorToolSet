<h1 align="center">Terminator ToolSet</h1>

<p align="center"><i>Modding tool for <b>Terminator: Dark Fate — Defiance</b>.</i></p>

<p align="center">
  <a href="../../releases"><img src="https://img.shields.io/badge/version-0.9.2--pre4-blue" alt="Version"></a>
  <a href="../../releases"><img src="https://img.shields.io/badge/platform-Windows_10_11-lightgrey" alt="Platform"></a>
  <a href="../../releases"><img src="https://img.shields.io/badge/lang-RU_EN_DE_ZH-green" alt="Languages"></a>
</p>

<p align="center">
  <a href="https://discord.com/invite/mNvUs8rRPS"><img src="https://img.shields.io/badge/Join_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord"></a>
</p>

> Please leave your suggestions and bug reports on the official Discord, in the **Modding Threads - Terminator ToolSet (Modding Tool)** section.
> 👉 **[Join Discord](https://discord.com/invite/mNvUs8rRPS)**

**Edit units and game data as tables instead of raw XML.** Compare files, merge new units, edit missions and Uprising maps, unpack `.pak` archives and manage mods.

**Safe to use:** stock game files are **read-only by default** — every edit is backed up with history and rollback.

> [!WARNING]
> **Always back up your files before using this tool.**
> The tool is under active development — the author takes no responsibility for any damage.
> *That said, not a single file has been damaged during the entire development.*

---

## ✨ Features

| Area | What you get |
|------|--------------|
| 📊 Spreadsheet editor | Safe save, game format preserved |
| 🗂 Project browser | Project / Game / Mod trees — search, filters, drag & drop |
| 🔀 Compare & Merge | Diff two files by any column, copy rows and columns between them |
| 🔗 Cross-file links | `sysname` references jump to the target file, plus readable unit names from localization |
| 🎯 Mission editor | SWT triggers and actions with command dictionary |
| 🏪 Campaign editor | Campaign shop editing tool |
| 🗺 Uprising tools | Map editor, prices and unit limits |
| 📦 .pak unpacker | Ordered extraction of base game and DLCs, per-pack skip |
| 🛠 Mod tools | Create mods, copy files into them, GameAssets download, DDS to WEBP icons auto-convert |
| 🛡 Safety net | Backups before every write, SQLite history, Undo / Redo, autosave |
| ⚙ Service | Auto-update, single instance, tray and browser modes |

---

## ⬇️ Installation

1. Download the latest `Terminator_ToolSet` zip from [**Releases**](../../releases).
2. Extract it **WHOLE** into an empty folder.
3. Check the layout — next to `Terminator ToolSet.exe` you must have:

   ```text
   ToolSetLibs/
   assets/
   locales/
   ```

4. Run **Terminator ToolSet.exe** and open your mod folder — or just drop files into the window.

---

## 💻 Requirements

- **Windows 10 / 11**, 64-bit
- **No external .NET needed** — uses built-in Framework 4.8 + WebView2
- Do **not** run from OneDrive or a network folder
- If antivirus eats files from `ToolSetLibs`, restore the folder and add an exclusion

---

## 👥 Credits

Terminator Dark fate Defiance team.
Game by Slitherine / Cats Who Play.
*Fan modding tool, not affiliated with the publisher.*
