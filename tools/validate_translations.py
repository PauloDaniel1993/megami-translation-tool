"""Validate Megami translation drafts before patch-job generation."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from block_layout import (
    block_replacement_lines,
    build_blocks,
    explicit_line_override_count_for_block,
    line_override_enabled,
    unsafe_control_lines,
)
from game_management import decode_adx_bytes
from translation_common import (
    configure_stdout,
    cp932_bad_chars,
    contains_japanese,
    cp932_ok,
    disallowed_game_text_chars,
    flatten_translation_records,
    log,
    read_jsonl,
    TEXT_PROFILES,
    visible_char_count,
    write_json,
)


def corpus_index(pages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for page in pages:
        for entry in page["entries"]:
            row = dict(entry)
            row["page_id"] = page["page_id"]
            row["textbox"] = page["textbox"]
            row["page_entries"] = page["entries"]
            index[row["line_id"]] = row
    return index


def split_render_lines(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def flatten_block_records(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    flattened: dict[str, dict[str, Any]] = {}
    for record in records:
        block_id = str(record.get("block_id", ""))
        if block_id:
            flattened[block_id] = record
    return flattened


def load_clean_source_lines(path: Path) -> list[str]:
    if not path.is_file():
        return []
    decoded = decode_adx_bytes(path.read_bytes()).decode("cp932", errors="strict")
    return decoded.splitlines()


def source_lines_for_block_range(block: dict[str, Any], clean_source_lines: list[str]) -> list[str]:
    start = int(block["script_range_start"])
    end = int(block["script_range_end"])
    if clean_source_lines and 1 <= start <= end <= len(clean_source_lines):
        return clean_source_lines[start - 1 : end]
    return [str(line) for line in block["source_lines"]]


def validate(args: argparse.Namespace) -> int:
    stem = Path(args.file).stem
    log(f"Loading corpus pages for {args.file}")
    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    index = corpus_index(pages)
    log(f"Loaded {len(pages)} page(s) and {len(index)} line target(s)")
    log(f"Loading translations from {args.translations}")
    records = read_jsonl(args.translations)
    translations = flatten_translation_records(records)
    log(f"Loaded {len(records)} record(s), {len(translations)} flattened translation(s)")
    block_records: list[dict[str, Any]] = []
    block_translations: dict[str, dict[str, Any]] = {}
    active_block_line_ids: set[str] = set()
    active_block_page_ids: set[str] = set()
    clean_source_lines: list[str] = []
    if args.block_translations:
        block_records = read_jsonl(args.block_translations)
        block_translations = flatten_block_records(block_records)
        log(f"Loaded {len(block_translations)} block translation(s)")
        clean_source_lines = load_clean_source_lines(args.source_dir / args.file)
        blocks_by_id = {block["block_id"]: block for block in build_blocks(pages)}
        for block_id, item in block_translations.items():
            block = blocks_by_id.get(block_id)
            if not block or not str(item.get("en", "")).strip():
                continue
            if explicit_line_override_count_for_block(block, translations):
                continue
            active_block_line_ids.update(str(line_id) for line_id in block.get("line_ids", []))
            active_block_page_ids.update(str(page_id) for page_id in block.get("page_ids", []))
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    checked = 0

    for line_id, item in translations.items():
        if checked and checked % 100 == 0:
            log(f"Validated {checked} translation(s)")
        if line_id not in index:
            failures.append({"line_id": line_id, "issue": "unknown_line_id"})
            continue
        if line_id in active_block_line_ids and not line_override_enabled(item):
            continue
        entry = index[line_id]
        if entry.get("auto"):
            continue
        checked += 1
        en = str(item.get("en", "")).strip()
        render_lines = split_render_lines(en)
        final_lines = [str(entry.get("render_prefix", "")) + line for line in render_lines]

        if not en:
            failures.append({"line_id": line_id, "issue": "empty_translation"})
        if not render_lines:
            failures.append({"line_id": line_id, "issue": "empty_render_lines"})
        for render_line in render_lines:
            if visible_char_count(render_line) > int(entry.get("max_chars", 50)):
                row = {
                    "line_id": line_id,
                    "issue": "line_too_long",
                    "length": visible_char_count(render_line),
                    "max": entry.get("max_chars", 50),
                    "en": en,
                }
                if args.allow_window_overflow:
                    warnings.append({**row, "issue": "auto_line_wrap_required"})
                else:
                    failures.append(row)
        for final_line in final_lines:
            if not cp932_ok(final_line):
                failures.append({"line_id": line_id, "issue": "not_cp932_encodable", "chars": cp932_bad_chars(final_line), "en": en})
            for char_row in disallowed_game_text_chars(final_line, args.text_profile):
                failures.append(
                    {
                        "line_id": line_id,
                        "issue": f"disallowed_{char_row['name']}",
                        "char": char_row["char"],
                        "en": en,
                    }
                )
        if contains_japanese(en) and not args.allow_japanese:
            warnings.append({"line_id": line_id, "issue": "japanese_remaining", "en": en})

    block_checked = validate_blocks(pages, translations, block_translations, clean_source_lines, failures, warnings, args)

    page_line_failures = validate_page_line_counts(index, translations, skip_page_ids=active_block_page_ids)
    if args.allow_window_overflow:
        for row in page_line_failures:
            warnings.append({**row, "issue": "auto_window_overflow_required"})
    else:
        failures.extend(page_line_failures)

    duplicate_check: dict[str, int] = {}
    for record in records:
        for item in record.get("translations", []):
            line_id = str(item.get("line_id", ""))
            duplicate_check[line_id] = duplicate_check.get(line_id, 0) + 1
    for line_id, count in duplicate_check.items():
        if count > 1:
            failures.append({"line_id": line_id, "issue": "duplicate_translation", "count": count})

    report = {
        "file": args.file,
        "translation_file": str(args.translations),
        "text_profile": args.text_profile,
        "checked": checked,
        "checked_blocks": block_checked,
        "failures": failures,
        "warnings": warnings,
        "ok": not failures,
    }
    write_json(args.report_out / f"{stem}_validation.json", report)
    write_html_report(args.report_out / f"{stem}_validation.html", report)
    log(f"Checked {checked} line translation(s), {block_checked} block translation(s): {len(failures)} failure(s), {len(warnings)} warning(s)")
    log(f"Wrote validation reports to {args.report_out}")
    return 1 if failures and args.strict else 0


def validate_page_line_counts(
    index: dict[str, dict[str, Any]],
    translations: dict[str, dict[str, Any]],
    skip_page_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    skip_page_ids = skip_page_ids or set()
    pages: dict[str, list[dict[str, Any]]] = {}
    for entry in index.values():
        pages.setdefault(str(entry["page_id"]), []).append(entry)

    for page_id, entries in pages.items():
        if page_id in skip_page_ids:
            continue
        if not any(entry["line_id"] in translations for entry in entries):
            continue

        max_lines = int(entries[0]["textbox"].get("max_lines_total", 4))
        used_lines = 0
        line_details: list[dict[str, Any]] = []
        for entry in entries:
            if entry.get("auto"):
                used = 1
            elif entry["line_id"] in translations:
                en = str(translations[entry["line_id"]].get("en", "")).strip()
                used = len(split_render_lines(en))
            else:
                used = 1
            used_lines += used
            line_details.append({"line_id": entry["line_id"], "used_lines": used})

        if used_lines > max_lines:
            failures.append(
                {
                    "line_id": page_id,
                    "issue": "page_line_overflow",
                    "used_lines": used_lines,
                    "max_lines": max_lines,
                    "lines": line_details,
                }
            )
    return failures


def validate_blocks(
    pages: list[dict[str, Any]],
    translations: dict[str, dict[str, Any]],
    block_translations: dict[str, dict[str, Any]],
    clean_source_lines: list[str],
    failures: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
    args: argparse.Namespace,
) -> int:
    if not block_translations:
        return 0

    blocks_by_id = {block["block_id"]: block for block in build_blocks(pages)}
    checked = 0
    for block_id, item in block_translations.items():
        block = blocks_by_id.get(block_id)
        if not block:
            failures.append({"line_id": block_id, "issue": "unknown_block_id"})
            continue

        en = str(item.get("en", "")).strip()
        if not en:
            failures.append({"line_id": block_id, "issue": "empty_block_translation"})
            continue

        override_count = explicit_line_override_count_for_block(block, translations)
        if override_count:
            warnings.append(
                {
                    "line_id": block_id,
                    "issue": "block_disabled_by_line_overrides",
                    "line_override_count": override_count,
                }
            )
            continue

        checked += 1
        controls = unsafe_control_lines(source_lines_for_block_range(block, clean_source_lines))
        if controls:
            failures.append(
                {
                    "line_id": block_id,
                    "issue": "unsafe_block_script_controls",
                    "line_start": int(block["script_range_start"]),
                    "line_end": int(block["script_range_end"]),
                    "count": len(controls),
                    "controls": controls[:20],
                }
            )
            continue

        try:
            replacement_lines = block_replacement_lines(block, en)
        except ValueError as exc:
            failures.append({"line_id": block_id, "issue": "block_layout_failed", "error": str(exc)})
            continue

        for final_line in replacement_lines:
            if not cp932_ok(final_line):
                failures.append({"line_id": block_id, "issue": "not_cp932_encodable", "chars": cp932_bad_chars(final_line), "en": en})
            for char_row in disallowed_game_text_chars(final_line, args.text_profile):
                failures.append(
                    {
                        "line_id": block_id,
                        "issue": f"disallowed_{char_row['name']}",
                        "char": char_row["char"],
                        "en": en,
                    }
                )
        if contains_japanese(en) and not args.allow_japanese:
            warnings.append({"line_id": block_id, "issue": "japanese_remaining", "en": en})

    return checked


def write_html_report(path: Path, report: dict[str, Any]) -> None:
    failure_rows = "\n".join(
        f"<tr><td>{row.get('line_id','')}</td><td>{row.get('issue','')}</td><td><pre>{escape(str(row))}</pre></td></tr>"
        for row in report["failures"]
    )
    warning_rows = "\n".join(
        f"<tr><td>{row.get('line_id','')}</td><td>{row.get('issue','')}</td><td><pre>{escape(str(row))}</pre></td></tr>"
        for row in report["warnings"]
    )
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{escape(report['file'])} Translation Validation</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 2rem auto; max-width: 1100px; line-height: 1.5; }}
    table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
    th, td {{ border: 1px solid #ccc; padding: 0.45rem; vertical-align: top; }}
    th {{ background: #eee; }}
    pre {{ margin: 0; white-space: pre-wrap; }}
  </style>
</head>
<body>
  <h1>{escape(report['file'])} Translation Validation</h1>
  <p>Checked: {report['checked']} line translations and {report.get('checked_blocks', 0)} block translations. Failures: {len(report['failures'])}. Warnings: {len(report['warnings'])}.</p>
  <h2>Failures</h2>
  <table><thead><tr><th>Line</th><th>Issue</th><th>Details</th></tr></thead><tbody>{failure_rows}</tbody></table>
  <h2>Warnings</h2>
  <table><thead><tr><th>Line</th><th>Issue</th><th>Details</th></tr></thead><tbody>{warning_rows}</tbody></table>
</body>
</html>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")


def escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate translated Megami JSONL records.")
    parser.add_argument("--file", required=True, help="ADX file name, for example s1.adx")
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--source-dir", type=Path, default=Path("work/clean_source"))
    parser.add_argument("--translations", type=Path, required=True)
    parser.add_argument("--block-translations", type=Path)
    parser.add_argument("--report-out", type=Path, default=Path("qa/reports"))
    parser.add_argument("--text-profile", choices=TEXT_PROFILES, default="vanilla")
    parser.add_argument("--allow-japanese", action="store_true")
    parser.add_argument(
        "--allow-window-overflow",
        action="store_true",
        help="report page line overflow as a warning for overflow-aware patch job builds",
    )
    parser.add_argument("--strict", action="store_true")
    return parser


def main() -> int:
    configure_stdout()
    return validate(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
