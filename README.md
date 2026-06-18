# Megami Translation Tool

Translation workspace for the Megami ADX script patching workflow.

This repository intentionally tracks only the translation tooling and text data:

- Python scripts in `tools/`
- React editor app in `translation_tool/`
- Translation JSONL/context files in `translations/`
- Generated corpus JSON in `work/corpus/`
- Workflow notes in `docs/`

Original game binaries, ADX files, images, audio, patched executables, patched ADX output, and local build artifacts are ignored.

## React Editor

```powershell
cd translation_tool
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

For DeepSeek retranslation, create `translation_tool/.env`:

```text
DEEPSEEK_API_KEY=your_key_here
```

## Validation

```powershell
python tools/validate_translations.py --file s1.adx --translations translations/approved/s1.approved.jsonl --text-profile apostrophe-patched --allow-window-overflow --strict
python tools/build_patch_jobs_from_translations.py --file s1.adx --translations translations/approved/s1.approved.jsonl --jobs patch_jobs/s1_translated_jobs.apostrophes.json --include-auto-speakers --auto-window-overflow
python tools/game_management.py reinsert --source-dir work/clean_source --file s1.adx --jobs patch_jobs/s1_translated_jobs.apostrophes.json --out-dir patched_adx_apostrophes --mode variable
```

The source game files are required locally to rebuild and install patched ADX/exe outputs, but they are not part of this repository.
