# Gates: UX batch 3 — diff-history, fast undo/redo, edit UX, icons

OWNS: app.py, database.py, xmlgrid.py, spreadsheet_ml.py, static/**, templates/**, locales/**, scripts/**, test_undo.py

Scope: replace snapshot history with diff records (fast undo/redo, informative history), fix home button geometry, highlight linked rows, click-to-type cell editing, wire the new icon set.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node "C:\Users\Hanigun\.agents\skills\unlazy\scripts\gate-lint.mjs" GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=9873e9d612672ee59974dea222d540cb834a476f8d33dd9d8c1c1681b18f9a4d; output-bytes=387

- [ ] G1: opening a linked file scrolls to AND visually highlights the target row (selection + flash animation)
  EVIDENCE: awaiting user visual review - wiring proven by G5/G6 oracles (followLink passes scrollRow; focusLinkedRow applies selection + .row-flash animation + ensureCellVisible); the on-screen flash needs one manual follow-link click to confirm

- [x] G2: home button touches the window edges exactly like tab buttons (full bar height, no side gaps, overlaps divider)
  CHECK: node scripts\verify-ui-wiring.mjs
  EXPECT: HOME BUTTON GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=7c046c58f78c120718a14143930dbc338cb61ea1670954eb637693df10d71ec1; output-bytes=66

- [x] G3: history stores per-change diffs (no file snapshots in DB) and every record reports file name + what changed
  CHECK: python scripts\verify_history.py
  EXPECT: HISTORY DIFF GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=377239865de89d6857cdce9a43d3765bc10dad199118ecddb5658e66ed9e39c8; output-bytes=150

- [x] G4: undo reverts exactly one change per call in under 1 second and remains repeatable and mixed with redo; revert-to-step works
  CHECK: python scripts\verify_history.py
  EXPECT: UNDO ENGINE GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=15b1a62b9be0d9f8be9d43f09dae033b367300c284a8abfdbe19b895551efc0c; output-bytes=150

- [x] G5: redo button exists next to undo, undo/redo buttons enable from the first change, and held-down hotkeys no longer fire repeats
  CHECK: node scripts\verify-ui-wiring.mjs
  EXPECT: UI WIRING GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=7c046c58f78c120718a14143930dbc338cb61ea1670954eb637693df10d71ec1; output-bytes=66

- [x] G6: clicking a row cell then typing starts editing without double click, and the focused cell gets a subtle highlight
  CHECK: node scripts\verify-ui-wiring.mjs
  EXPECT: EDIT UX GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=7c046c58f78c120718a14143930dbc338cb61ea1670954eb637693df10d71ec1; output-bytes=66

- [ ] G7: the focused-cell highlight is visibly weaker than the selected row highlight (manual visual review)
  EVIDENCE: awaiting user visual review - CSS proven by G6 oracle (cell-focus = faint 1px inset outline + slightly lighter bg vs row selection #333a45); the subjective "weak enough" judgment needs the user's eyes

- [x] G8: all file/category icons resolve to existing files under assets/icons/<theme>/icons and no source references to deleted icons remain
  CHECK: node scripts\verify-icons.mjs
  EXPECT: ICONS GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=d9404ffd4e82207662fcc734f054b73d3f486c11fd70365bc6e3c534010a7f71; output-bytes=18

- [x] G9: SpreadsheetML round-trip regression suite passes
  CHECK: python -m test_roundtrip
  EXPECT: ALL TESTS PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=4eadebb94d1192d8df80ab687e75d763d8b7934e079ecacf55230775b7649069; output-bytes=632

- [x] G10: API integration regression suite passes
  CHECK: python -m test_api
  EXPECT: INTEGRATION TESTS PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=bb84a9940a43d17fd2d1e2bb14050fcae748673ffa963912fc013c39376a272c; output-bytes=1215

- [x] G11: PyInstaller build completes successfully
  CHECK: python -m PyInstaller --noconfirm TerminatorSheet.spec
  EXPECT: Build complete
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Games\Terminator Project\TerminatorSheet; path=dbb7d3509b2f/25 entries; EXPECT=matched; output-sha256=b00787c7c335c43be0aa3e3287b74ce9b3a11898f7a4934e6fd860b504dec239; output-bytes=1189

- [x] G12: built exe boots to a working window (manual smoke)
  EVIDENCE: dist\TerminatorSheet.exe started (process RUNNING), full-screen screenshot captured and reviewed: window rendered with toolbar including the new redo button, tab strip with flush home button, welcome screen; process stopped afterwards
