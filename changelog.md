# Changelog

<!-- Новая версия = новый блок <details> СВЕРХУ, со словом open (развёрнут
     по умолчанию). Старые версии остаются без open (свёрнуты). -->

<details open>
<summary><b>v0.9.4</b></summary>

### Performance (page open and icons 5–10x faster)

- Species tables are read in one pass per row (`Row.values_row`): per-cell reads rebuilt XML children on every call (4.7M calls, 1.1s per file). `units_list` 0.7–1.4s → 0.08–0.22s per category.
- Prices 5.6s → 0.35s cold / 0.01s warm; icon states 0.8s → 0.05s on repeat opens (memoized).
- One shared icon core (`static/js/icons.js`) for map, campaign and units: tiny URL batches instead of megabyte data-URL batches, background preload in chunks, session cache per root — reopening a tab paints instantly from memory.
- Pages paint first, icons and prices fill in progressively (no more blocking spinner over the whole load).
- Uncompressed DDS (90% of mod textures) decodes via a raw fast path: 7–12s → 0.01s; full 2K convert 9–13s → 0.3–0.5s; WebP method tuned; texture warmup runs in a thread pool (leaves one CPU core for the UI).
- Warmup button heats the current Project|Game|Mod source (fell back to the configured roots); progress is a thin YouTube-style strip on the tab-bar edge.

</details>

<details>
<summary><b>v0.9.1</b></summary>

### General

- Added Uprising-style gear animation and custom tab dragging.
- Added Markdown changelog support and a dedicated **Changelog** button.
- Improved close-button styling and reorganized **Recent**.
- Fixed first-launch layout issues after updates.
- Added unsaved-changes protection before restarting updates.
- Fixed crash on PCs without a compatible .NET host (`Failed to resolve Python.Runtime.Loader.Initialize`): a dead native window now falls back to browser mode instead of `Failed to execute script 'main'`.
- Pinned the .NET bridge to the in-box Framework (`PYTHONNET_RUNTIME=netfx` in `main.py` + a pre-flight `clr` check in `run_pywebview`): no external .NET Desktop Runtime is required anymore.

### Comparison

- Major performance, scrolling, and layout improvements.
- Reworked Merge, Keys, Mirror, Sync, filters, and row highlighting.
- Fixed Undo/Redo, transfer highlighting, and Diff mode behavior.
- Added better handling for write-protected Game files.
- Improved search, tab selection, and horizontal scrolling.

### XML Tables

- Optimized the XML engine for better performance.
- Improved Compare and Analyze behavior.

### Uprising Map Editor

- Widened Sector Settings to support 5 sectors.

### Tree

- Reworked filters, depth, icons, and folder structure.
- Reorganized Infantry, Weapons, Animations, Inventory, and Squad-related files.
- Game unpacked files are now the source of truth.

### Unpacking

- Improved `.pak` extraction order for the base game and DLCs.
- Removed the unpacking progress log.

</details>

<details>
<summary><b>v0.9.0</b></summary>

- Created and Added `.dds` to `.webp` (Python\Pillow) converter with spinners and progress bar. Auto adds icons to `assets\CustomImages`. (You can add or remove .webp images or leave it as is) **AutoMods Support**
- Fix: incorrect text pos on tabs
- Fix: Project and mod opens the same folder.
- Added: New DropDown menu for Compare page with searchbar
- Added: Mirror checkbox on Compare page
- Added: New indicator marker for Unpack tool for every basis.pak
- Added: Context menu - "Open in Grid" Opens unit and highlights sysname
- Fix: Missing localization keys
- Fix: Finally fixed drag n drop files and folders to a ToolSet
- Added: Ability to disable a `.pak` from unpacking (Green Unpacking done, gray you disabled this pack)
- Fix: Tree doesnt update itself when new file added via base game protect feature
- Fix: editing `xml` field scroll bug (hiding under sysname)
- Fix: Cross file links doesnt work
- Fix: Broken icons path
- Added: All icons now auto detects and converts from `.dds` to `webp` (Nothing stored in toolset)
- Fix: Window drag-and-drop behavior.
- Fix: Opening of shop_presets.xml from campaigns, and auto-detection of map vs. campaign files (fallback).
- Fix: Grey buttons not returning to grey when closing all folders.
- Fix: Strange behavior when deleting the project folder path. Added "Close" buttons to path settings
- Fix: Folder icon issue.

</details>
