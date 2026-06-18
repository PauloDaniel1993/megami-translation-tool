# Megami Translation Tool

Local React tool for editing Megami translation JSONL files and running the patch workflow.

## Run

```powershell
cd translation_tool
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## DeepSeek

Create `translation_tool/.env` if you need to configure the API key locally:

```text
DEEPSEEK_API_KEY=your_key_here
```

The app sends the selected Japanese line, nearby page context, glossary, character card, scene summary, and current English text to DeepSeek. Suggestions are saved under `translations/suggestions/<file>/` and are not applied until you click Apply and Save.

## Workflow Buttons

- `Validate`: checks `translations/approved/<file>.approved.jsonl` with the selected text profile and allows page overflow for automatic windows.
- `Jobs`: rebuilds `patch_jobs/<file>_translated_jobs.<profile>.json` with automatic overflow window generation.
- `Reinsert`: writes patched ADX output under `patched_adx_<profile>/`.
- `Verify exe`: checks the apostrophe patch against the original executable backup.
- `Build exe`: writes `patched_exe/main_apostrophe.exe`.
- `Install`: backs up live `main.exe` and `<file>.adx`, then installs the patched versions.
- `Launch`: runs `main.exe` through Locale Emulator when `LEProc.exe` is found; otherwise it launches directly.
- `Restore`: restores the latest app-created backup.

## Files Edited

Line edits are saved to `translations/approved/<file>.approved.jsonl`. Unknown fields in existing translation records are preserved.

## Overflow Windows

The editor shows a `Window Budget` card for the selected page. It estimates physical wrapped lines, predicted windows, and extra `@h` breaks from the current draft text. The workflow panel also shows the last Jobs report count for generated overflow pages, inserted `@h` breaks, and wrapped lines.

## Locale Emulator

Set `LOCALE_EMULATOR_PATH` or `LEPROC_PATH` to the full `LEProc.exe` path if Locale Emulator is installed in a custom folder. The Launch action passes `main.exe` to `LEProc.exe`, which uses the app/global/default Japanese profile.
