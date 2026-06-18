"""Validate Megami translation drafts before patch-job generation."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from translation_common import (
    configure_stdout,
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
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    checked = 0

    for line_id, item in translations.items():
        if checked and checked % 100 == 0:
            log(f"Validated {checked} translation(s)")
        if line_id not in index:
            failures.append({"line_id": line_id, "issue": "unknown_line_id"})
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
                failures.append({"line_id": line_id, "issue": "not_cp932_encodable", "en": en})
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

    page_line_failures = validate_page_line_counts(index, translations)
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
        "failures": failures,
        "warnings": warnings,
        "ok": not failures,
    }
    write_json(args.report_out / f"{stem}_validation.json", report)
    write_html_report(args.report_out / f"{stem}_validation.html", report)
    log(f"Checked {checked} translation(s): {len(failures)} failure(s), {len(warnings)} warning(s)")
    log(f"Wrote validation reports to {args.report_out}")
    return 1 if failures and args.strict else 0


def validate_page_line_counts(
    index: dict[str, dict[str, Any]],
    translations: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    pages: dict[str, list[dict[str, Any]]] = {}
    for entry in index.values():
        pages.setdefault(str(entry["page_id"]), []).append(entry)

    for page_id, entries in pages.items():
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
  <p>Checked: {report['checked']}. Failures: {len(report['failures'])}. Warnings: {len(report['warnings'])}.</p>
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
    parser.add_argument("--translations", type=Path, required=True)
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
