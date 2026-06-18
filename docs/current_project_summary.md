# Megami Translation Project Summary

Last updated: 2026-06-19

This file summarizes the current translation workflow, tools, decisions, and test steps for the Megami ADX translation project.

## Goal

Translate the game script from Japanese to English, keep translation JSON easy to review, patch the game script safely, and run the game with Japanese locale when testing.

## Repository Scope

Tracked project files should be limited to:

- `tools/`: Python extraction, validation, translation, patch-job, reinsertion, and exe-patch scripts.
- `translation_tool/`: local React editor and workflow runner.
- `translations/`: approved translations, drafts, repairs, suggestions, and context.
- `work/corpus/`: generated corpus metadata used by the editor and patch builder.
- `docs/`: workflow notes and summaries.

Ignored/local-only files include original game binaries, ADX files, images, audio, patched output, executables, and build artifacts.

## Required Local Inputs

The workflow needs these files locally:

- Clean source ADX at `work/clean_source/s1.adx`.
- Live game ADX at project root, for install target: `s1.adx`.
- Original executable source for apostrophe patching, usually one of:
  - `main.exe.before-apostrophe-test`
  - `main.org`
  - an unpatched `main.exe`
- Patched executable output at `patched_exe/main_apostrophe.exe`.
- Locale Emulator `LEProc.exe` if launching under Japanese locale.

## Environment

Create or update `translation_tool/.env`:

```text
DEEPSEEK_API_KEY=your_key_here
PORT=5173
LOCALE_EMULATOR_PATH=C:\Users\pdc18\Downloads\Locale.Emulator.2.5.0.1\LEProc.exe
```

`DEEPSEEK_API_KEY` is optional unless using DeepSeek retranslation. `LOCALE_EMULATOR_PATH` lets the Launch button run `main.exe` through Locale Emulator.

## React Editor

Start the local tool:

```powershell
cd translation_tool
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

The header should show:

- Translation progress.
- Dirty line count.
- Flagged line count.
- Generated automatic `@h` count.
- DeepSeek status.
- Locale Emulator status: `Locale ready` or `No LEProc`.

## Editor Concepts

- The left panel lists script lines and filters by scene, role, and issue.
- The center panel edits the selected line.
- `Japanese Source` shows the original Japanese.
- `Scene Context` and `Previous Translations` help keep translation style consistent.
- `Window Budget` estimates the selected page's visible line usage and automatic `@h` breaks.
- The right panel runs the pipeline and shows logs.

## DeepSeek Retranslation

The editor sends DeepSeek:

- Target Japanese line.
- Current English text.
- Speaker.
- Current page, previous page, and next page.
- Scene summary.
- Glossary.
- Character card when available.
- User instruction.

Suggestions are saved under `translations/suggestions/<file>/` and are not applied until clicking `Apply` and saving.

## Text Profile

Use `apostrophe-patched` for current work.

The executable apostrophe patch allows normal ASCII apostrophes and contractions. Vanilla profile still treats apostrophes as disallowed.

## Overflow Window Decision

The translation JSON remains human-readable and does not store script control commands directly.

Automatic window creation happens during patch-job generation:

- The builder wraps overlong English physical lines.
- If a page exceeds its textbox line limit, the builder inserts extra `@h` windows.
- Range patch jobs replace the original page text block.
- Range patch jobs require variable-size reinsertion.

Important rule:

- If one translation entry overflows, its continuation window is closed with `@h` before the next entry starts.

Example corrected output:

```text
Milfe, a port... remote, rich in marine, mining,
First temporary overflow line.
Second temporary overflow line.
Third temporary overflow line.
@h
Fourth temporary overflow line.
Fifth temporary overflow line.
@h
Also thrives as trade hub, independent city.
@h
```

Dialogue overflow repeats the speaker name in each new window:

```text
Celica
   First dialogue line.
   Second dialogue line.
   Third dialogue line.
@h
Celica
   Fourth dialogue line.
@h
Celica
   Next entry starts fresh.
```

## Main Pipeline

Recommended UI order:

1. `Validate`
2. `Jobs`
3. `Reinsert`
4. `Verify exe`
5. `Build exe`
6. `Install`
7. `Launch`

The important command-line equivalent is:

```powershell
python tools/validate_translations.py --file s1.adx --translations translations/approved/s1.approved.jsonl --text-profile apostrophe-patched --allow-window-overflow --strict

python tools/build_patch_jobs_from_translations.py --file s1.adx --translations translations/approved/s1.approved.jsonl --jobs patch_jobs/s1_translated_jobs.apostrophes.json --include-auto-speakers --auto-window-overflow

python tools/game_management.py reinsert --source-dir work/clean_source --file s1.adx --jobs patch_jobs/s1_translated_jobs.apostrophes.json --out-dir patched_adx_apostrophes --mode variable
```

Use `--mode variable` for reinsertion because automatic windows change script length.

## Workflow Outputs

Patch jobs:

```text
patch_jobs/s1_translated_jobs.apostrophes.json
```

Overflow report:

```text
patch_jobs/s1_translated_jobs.apostrophes.overflow_report.json
```

Patched ADX:

```text
patched_adx_apostrophes/variable/s1.adx
```

Decoded inspection:

```text
patched_adx_apostrophes/variable_decoded/s1.txt
```

Patch report:

```text
patched_adx_apostrophes/patch_report.json
```

## Install Behavior

`Install` backs up the live files first, then copies:

- `patched_exe/main_apostrophe.exe` to `main.exe`
- `patched_adx_apostrophes/variable/s1.adx` to `s1.adx`

The workflow log prints:

- install folder path
- backup id

Example:

```text
install: install folder I:\projects\Personal\translation\new\megami | backup 20260619-123456
```

## Launch Behavior

`Launch` tries to use Locale Emulator:

```text
LEProc.exe main.exe
```

If `LEProc.exe` is found, the workflow log prints:

```text
launcher Locale Emulator | locale ja-JP | C:\...\LEProc.exe
```

If not found, it falls back to direct launch and the header shows `No LEProc`.

Current known local path:

```text
C:\Users\pdc18\Downloads\Locale.Emulator.2.5.0.1\LEProc.exe
```

## Safe UI Test For Overflow

To test overflow prediction without saving:

1. Open the editor.
2. Select `s1:00009`.
3. Paste this into English but do not click Save:

```text
First temporary overflow line.
Second temporary overflow line.
Third temporary overflow line.
Fourth temporary overflow line.
Fifth temporary overflow line.
```

Expected `Window Budget`:

- `3 windows`
- `7/4 lines`
- `2 extra @h`

If saved and Jobs/Reinsert are run, decoded output should show:

```text
@h
Fourth temporary overflow line.
Fifth temporary overflow line.
@h
Also thrives as trade hub, independent city.
@h
```

## Verification Commands

Build frontend:

```powershell
cd translation_tool
npm run build
```

Check server syntax:

```powershell
cd translation_tool
node --check server/index.js
```

Check Python syntax:

```powershell
python -m py_compile tools/build_patch_jobs_from_translations.py tools/game_management.py tools/validate_translations.py
```

Check Locale Emulator detection:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:5173/api/health" |
  Select-Object ok,localeEmulatorConfigured,localeEmulatorPath
```

Inspect patched decoded output:

```powershell
Get-Content patched_adx_apostrophes/variable_decoded/s1.txt
```

## Current Notes

- The app server was restarted after adding `LOCALE_EMULATOR_PATH`.
- Health endpoint confirmed Locale Emulator detection with the path above.
- Current overflow report can show saved temporary overflow text if that test content was saved into `translations/approved/s1.approved.jsonl`.
- Before producing a final translation patch, review any temporary test lines in `translations/approved/s1.approved.jsonl`.

