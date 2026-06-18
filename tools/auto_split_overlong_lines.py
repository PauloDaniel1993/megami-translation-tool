"""Deterministically split overlong translations when the page has spare lines."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from translation_common import configure_stdout, flatten_translation_records, log, read_json, read_jsonl, write_jsonl
from validate_translations import split_render_lines


def corpus_index(pages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for page in pages:
        for entry in page["entries"]:
            row = dict(entry)
            row["page_id"] = page["page_id"]
            row["page_entries"] = page["entries"]
            row["textbox"] = page["textbox"]
            index[row["line_id"]] = row
    return index


def find_split(text: str, max_chars: int) -> str | None:
    if len(text.strip()) <= max_chars:
        return None
    stripped = text.strip()
    midpoint = len(stripped) // 2
    candidates = [index for index, char in enumerate(stripped) if char in {" ", ",", ";", ":"}]
    if not candidates:
        return None
    split_at = min(candidates, key=lambda index: abs(index - midpoint))
    first = stripped[:split_at].rstrip(" ,;:")
    second = stripped[split_at:].lstrip(" ,;:")
    if not first or not second:
        return None
    if len(first) > max_chars or len(second) > max_chars:
        return None
    return first + "\n" + second


def page_used_lines(page_entries: list[dict[str, Any]], translations: dict[str, dict[str, Any]]) -> int:
    used = 0
    for entry in page_entries:
        if entry.get("auto"):
            used += 1
        elif entry["line_id"] in translations:
            used += len(split_render_lines(str(translations[entry["line_id"]].get("en", ""))))
        else:
            used += 1
    return used


def run(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    log(f"Loading validation report {args.validation_report}")
    report = read_json(args.validation_report)
    failures = [row for row in report.get("failures", []) if row.get("issue") == "line_too_long"]
    log(f"Found {len(failures)} overlong failure(s)")

    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    corpus = corpus_index(pages)
    rows = read_jsonl(args.translations)
    translations = flatten_translation_records(rows)

    applied = 0
    for failure in failures:
        line_id = str(failure["line_id"])
        if line_id not in corpus or line_id not in translations:
            continue
        entry = corpus[line_id]
        en = str(translations[line_id].get("en", ""))
        if all(len(line) <= int(entry.get("max_chars", 50)) for line in split_render_lines(en)):
            log(f"Skipping {line_id}; current translation already fits")
            continue
        max_lines = int(entry["textbox"].get("max_lines_total", 4))
        used_lines = page_used_lines(entry["page_entries"], translations)
        if used_lines >= max_lines:
            log(f"Skipping {line_id}; page already uses {used_lines}/{max_lines} lines")
            continue
        split = find_split(en, int(entry.get("max_chars", 50)))
        if not split:
            log(f"Skipping {line_id}; no safe deterministic split found")
            continue
        translations[line_id]["en"] = split
        translations[line_id]["auto_split_status"] = "split_applied"
        applied += 1
        log(f"Split {line_id}: {split!r}")

    for row in rows:
        for item in row.get("translations", []):
            line_id = str(item.get("line_id", ""))
            if line_id in translations:
                item.update(translations[line_id])

    write_jsonl(args.output, rows)
    log(f"Applied {applied} split(s)")
    log(f"Wrote output to {args.output}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Auto-split overlong lines when page capacity allows.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--translations", type=Path, required=True)
    parser.add_argument("--validation-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    configure_stdout()
    run(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
