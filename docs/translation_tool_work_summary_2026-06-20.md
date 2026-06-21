# Translation Tool Work Summary

Last updated: 2026-06-20

## Objective

The translation workflow was changed from a line-by-line approach to a block-first approach. The goal is to translate a complete passage as one coherent block, then automatically wrap physical lines and insert additional game text windows during patch job generation.

The editor still supports line-level editing when needed, but block editing is now the main quality path.

## Main UI Changes

- Added block editing mode alongside line editing mode.
- Added automatic conversion from a selected block to explicit line overrides when switching to line view.
- Added individual clear and clear-all translation controls for both block and line views.
- Added block-aware save behavior so saved block translations clear conflicting line overrides.
- Added better window budget feedback for block translations.
- Added clickable validation failures that open the matching block, line, or page in the editor.

## DeepSeek Changes

- Added a DeepSeek request modal.
- Added editable prompt fields for each prompt part, with the default prompt visible before sending.
- Added configurable model and temperature fields.
- Added configurable block batch size.
- Added configurable parallel request count.
- Applied DeepSeek suggestions directly to drafts, so the next action is review and save.
- Added request cancellation.
- Added an opaque screen overlay with loader animation, progress count, status text, and cancel button while DeepSeek is running.
- Fixed the false auto-cancel behavior by aborting only on actual request aborts or unfinished response close events.

## Validation And Failure Visibility

- Added CP932 bad-character reporting with exact unsupported character labels.
- Validation failures now show usable summaries in the sidebar.
- Workflow command failures now show a persistent red failure card with:
  - step name
  - exit code
  - command
  - stdout/stderr
- Reinsert now reports a clean missing-jobs error instead of a Python traceback.
- Install now refuses to copy stale or missing ADX artifacts.
- Failed Jobs runs remove the generated jobs file so later Reinsert/Install cannot silently reuse old output.

## Patch Workflow Fixes

The earlier patch appeared not to work because the generated ADX was stale. The actual blocker was a source range mismatch in a block job:

```text
s1:block:00141-00153:block: source line count mismatch in s1.adx:141-154.
Expected 11, found 14.
```

That block crossed script commands such as:

```text
@fl 101 = 1
@go ab
*ab12
```

The first repair made block job source snapshots match the physical decoded source range, which allowed Reinsert to run. That exposed a more important safety issue: some translated block ranges crossed script control commands.

## Unsafe Block Command Fix

Block grouping now splits at physical script gaps. This prevents block patch jobs from replacing script control lines such as labels, jumps, menus, portrait commands, and scene commands.

Implemented in:

- `tools/block_layout.py`
- `translation_tool/server/index.js`

Added a migration tool:

```text
tools/migrate_block_translations_to_safe_blocks.py
```

Migration result:

```text
651 legacy block records -> 682 safe block records
24 unsafe records split into 55 child block records
0 unknown records
```

Backup created:

```text
translations/approved/archive/s1.blocks.approved.20260619-042303.jsonl
```

Migration report:

```text
qa/reports/block_translation_migration.json
```

## Current Verified State

Validation:

```text
Checked 0 line translation(s), 682 block translation(s): 0 failure(s), 0 warning(s)
```

Jobs:

```text
Wrote 688 patch job(s) to patch_jobs/s1_translated_jobs.apostrophes.json
```

Unsafe job scan:

```text
unsafe jobs 0 of 688
```

Reinsert:

```text
Wrote 688 patched result(s)
Report: patched_adx_apostrophes/patch_report.json
```

Overflow report:

```text
"unsafe_block_ranges": []
```

Fresh patched ADX:

```text
patched_adx_apostrophes/variable/s1.adx
```

Decoded inspection:

```text
patched_adx_apostrophes/variable_decoded/s1.txt
```

The first block now shows the new translated text, not the old temporary overflow test lines.

## Verification Commands Used

```powershell
python -m py_compile tools\block_layout.py tools\build_patch_jobs_from_translations.py tools\validate_translations.py tools\game_management.py tools\migrate_block_translations_to_safe_blocks.py
```

```powershell
cd translation_tool
npm run build
node --check server\index.js
```

```powershell
python tools\validate_translations.py --file s1.adx --translations translations/approved/s1.approved.jsonl --block-translations translations/approved/s1.blocks.approved.jsonl --text-profile apostrophe-patched --allow-window-overflow --strict
```

```powershell
python tools\build_patch_jobs_from_translations.py --file s1.adx --translations translations/approved/s1.approved.jsonl --block-translations translations/approved/s1.blocks.approved.jsonl --jobs patch_jobs/s1_translated_jobs.apostrophes.json --source-dir work/clean_source --include-auto-speakers --auto-window-overflow
```

```powershell
python tools\game_management.py reinsert --source-dir work\clean_source --file s1.adx --jobs patch_jobs\s1_translated_jobs.apostrophes.json --out-dir patched_adx_apostrophes --mode variable
```

## Important Notes

- The patched ADX was generated, but Install was not run after the unsafe-block fix.
- The live game `s1.adx` may still be older until the app's Install step is used.
- The migration split unsafe block translations mechanically. It preserves safety, but some split passages should be reviewed for prose quality around control-flow boundaries.
- The app should be restarted after these code changes if an older server is still running.

## Recommended Next Steps

1. Run the app with the updated server.
2. Run `Validate`.
3. Run `Jobs`.
4. Run `Reinsert`.
5. Run `Install` to copy the fresh patched ADX into the game folder.
6. Launch the game and inspect the first block plus the previously unsafe sections around script lines 141-154, 389-407, 424-445, and later menu/scene transitions.
