"""Build game_management.py patch jobs from approved structured translations."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from block_layout import (
    block_preview,
    block_replacement_lines,
    build_blocks,
    explicit_line_override_count_for_block,
)
from translation_common import configure_stdout, flatten_translation_records, log, read_jsonl, write_json


def corpus_index(pages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for page in pages:
        for entry in page["entries"]:
            row = dict(entry)
            row["page_id"] = page["page_id"]
            index[row["line_id"]] = row
    return index


def split_translation_lines(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def wrap_visible_line(line: str, max_chars: int) -> list[str]:
    stripped = line.strip()
    if len(stripped) <= max_chars:
        return [stripped]

    words = [word for word in stripped.split(" ") if word]
    if len(words) <= 1:
        return [stripped[index : index + max_chars] for index in range(0, len(stripped), max_chars)]

    wrapped: list[str] = []
    current = ""
    for word in words:
        while len(word) > max_chars:
            if current:
                wrapped.append(current)
                current = ""
            wrapped.append(word[:max_chars])
            word = word[max_chars:]

        if not word:
            continue
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= max_chars:
            current = f"{current} {word}"
        else:
            wrapped.append(current)
            current = word

    if current:
        wrapped.append(current)
    return wrapped


def wrap_translation_lines(lines: list[str], max_chars: int) -> list[str]:
    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(wrap_visible_line(line, max_chars))
    return wrapped


def render_lines_from_visible(entry: dict[str, Any], lines: list[str]) -> list[str]:
    prefix = str(entry.get("render_prefix", ""))
    return [prefix + line for line in lines]


def render_translation_lines(entry: dict[str, Any], en: str, *, wrap: bool = False) -> list[str]:
    lines = split_translation_lines(en)
    if wrap:
        lines = wrap_translation_lines(lines, int(entry.get("max_chars", 50)))
    return render_lines_from_visible(entry, lines)


def render_translation(entry: dict[str, Any], en: str, *, wrap: bool = False) -> str:
    return "\r\n".join(render_translation_lines(entry, en, wrap=wrap))


def translation_is_allowed(item: dict[str, Any], args: argparse.Namespace) -> bool:
    status = str(item.get("status", "") or item.get("review_status", ""))
    return not args.require_approved or status in {"approved", ""}


def flatten_block_records(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    flattened: dict[str, dict[str, Any]] = {}
    for record in records:
        block_id = str(record.get("block_id", ""))
        if block_id:
            flattened[block_id] = record
    return flattened


def source_lines_for_page(page: dict[str, Any]) -> list[str]:
    return [str(entry["source_line"]) for entry in page["entries"]]


def entries_are_contiguous(page: dict[str, Any]) -> bool:
    line_numbers = [int(entry["line_number"]) for entry in page["entries"]]
    return line_numbers == list(range(min(line_numbers), max(line_numbers) + 1))


def chunk_lines(lines: list[str], size: int) -> list[list[str]]:
    if size <= 0:
        raise SystemExit("Cannot create overflow windows with zero available text lines")
    return [lines[index : index + size] for index in range(0, len(lines), size)]


def narration_windows(rendered_items: list[dict[str, Any]], max_lines: int) -> list[list[str]]:
    windows: list[list[str]] = []
    current: list[str] = []

    def flush_current() -> None:
        nonlocal current
        if current:
            windows.append(current)
            current = []

    for item in rendered_items:
        lines = item["lines"]
        chunks = chunk_lines(lines, max_lines)
        if len(chunks) == 1:
            if current and len(current) + len(lines) > max_lines:
                flush_current()
            current.extend(lines)
            continue

        flush_current()
        windows.extend(chunks)

    flush_current()
    return windows


def dialogue_windows(
    rendered_items: list[dict[str, Any]],
    speaker_lines: list[str],
    body_capacity: int,
) -> list[list[str]]:
    windows: list[list[str]] = []
    current_body: list[str] = []

    def flush_current() -> None:
        nonlocal current_body
        if current_body:
            windows.append(speaker_lines + current_body)
            current_body = []

    for item in rendered_items:
        entry = item["entry"]
        if entry.get("role") == "speaker":
            continue

        lines = item["lines"]
        chunks = chunk_lines(lines, body_capacity)
        if len(chunks) == 1:
            if current_body and len(current_body) + len(lines) > body_capacity:
                flush_current()
            current_body.extend(lines)
            continue

        flush_current()
        windows.extend(speaker_lines + chunk for chunk in chunks)

    flush_current()
    return windows or [speaker_lines]


def flatten_windows(windows: list[list[str]]) -> list[str]:
    output: list[str] = []
    for index, window in enumerate(windows):
        if index:
            output.append("@h")
        output.extend(window)
    return output


def windowed_page_lines(page: dict[str, Any], rendered_items: list[dict[str, Any]]) -> list[str]:
    textbox = page.get("textbox", {})
    max_lines = int(textbox.get("max_lines_total", 4))
    if max_lines <= 0:
        raise SystemExit(f"{page['page_id']}: max_lines_total must be positive")

    if not page.get("speaker_present"):
        return flatten_windows(narration_windows(rendered_items, max_lines))

    speaker_lines: list[str] = []
    speaker_consumed = False
    for item in rendered_items:
        entry = item["entry"]
        if not speaker_consumed and entry.get("role") == "speaker":
            speaker_lines.extend(item["lines"])
            speaker_consumed = True

    if not speaker_lines:
        return flatten_windows(narration_windows(rendered_items, max_lines))

    body_capacity = max_lines - len(speaker_lines)
    if body_capacity <= 0:
        raise SystemExit(f"{page['page_id']}: speaker line consumes the full textbox")

    return flatten_windows(dialogue_windows(rendered_items, speaker_lines, body_capacity))


def page_render_items(
    page: dict[str, Any],
    translations: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rendered_items: list[dict[str, Any]] = []
    wrapped_lines: list[dict[str, Any]] = []

    for entry in page["entries"]:
        source_line = str(entry["source_line"])
        lines = [source_line]
        should_patch = False

        if entry.get("auto"):
            if args.include_auto_speakers and entry.get("en"):
                lines = render_translation_lines(entry, str(entry["en"]), wrap=False)
                should_patch = lines != [source_line]
        else:
            item = translations.get(entry["line_id"])
            if item and translation_is_allowed(item, args):
                en = str(item.get("en", "")).strip()
                if en:
                    visible_lines = split_translation_lines(en)
                    wrapped_visible_lines = wrap_translation_lines(visible_lines, int(entry.get("max_chars", 50)))
                    if wrapped_visible_lines != visible_lines:
                        wrapped_lines.append(
                            {
                                "line_id": entry["line_id"],
                                "original_lines": visible_lines,
                                "wrapped_lines": wrapped_visible_lines,
                            }
                        )
                    lines = render_lines_from_visible(entry, wrapped_visible_lines)
                    should_patch = True

        rendered_items.append({"entry": entry, "lines": lines, "patch": should_patch})

    return rendered_items, wrapped_lines


def build_normal_jobs(
    index: dict[str, dict[str, Any]],
    translations: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()

    if args.include_auto_speakers:
        log("Including auto-glossary speaker lines")
        for line_id, entry in index.items():
            if entry.get("auto") and entry.get("en"):
                jobs.append(
                    {
                        "id": line_id,
                        "file": entry["file"],
                        "line_number": entry["line_number"],
                        "source": entry["source_line"],
                        "translation": str(entry["en"]),
                    }
                )
                seen.add(line_id)
        log(f"Added {len(seen)} auto-glossary speaker job(s)")

    for count, (line_id, item) in enumerate(translations.items(), start=1):
        if count % 100 == 0:
            log(f"Processed {count} translation row(s)")
        if line_id in seen:
            continue
        if line_id not in index:
            raise SystemExit(f"Unknown line_id in translation file: {line_id}")
        entry = index[line_id]
        en = str(item.get("en", "")).strip()
        if not en or not translation_is_allowed(item, args):
            continue
        jobs.append(
            {
                "id": line_id,
                "file": entry["file"],
                "line_number": entry["line_number"],
                "source": entry["source_line"],
                "translation": render_translation(entry, en),
            }
        )

    return jobs


def build_windowed_jobs(
    pages: list[dict[str, Any]],
    translations: dict[str, dict[str, Any]],
    args: argparse.Namespace,
    skip_page_ids: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "file": args.file,
        "auto_window_overflow": True,
        "overflow_pages": [],
        "wrapped_lines": [],
    }
    skip_page_ids = skip_page_ids or set()

    known_line_ids = {entry["line_id"] for page in pages for entry in page["entries"]}
    for line_id in translations:
        if line_id not in known_line_ids:
            raise SystemExit(f"Unknown line_id in translation file: {line_id}")

    for page in pages:
        if page["page_id"] in skip_page_ids:
            continue
        rendered_items, wrapped_lines = page_render_items(page, translations, args)
        report["wrapped_lines"].extend(wrapped_lines)
        if not any(item["patch"] for item in rendered_items):
            continue

        max_lines = int(page.get("textbox", {}).get("max_lines_total", 4))
        used_lines = sum(len(item["lines"]) for item in rendered_items)
        if used_lines <= max_lines:
            for item in rendered_items:
                if not item["patch"]:
                    continue
                entry = item["entry"]
                jobs.append(
                    {
                        "id": entry["line_id"],
                        "file": entry["file"],
                        "line_number": entry["line_number"],
                        "source": entry["source_line"],
                        "translation": "\r\n".join(item["lines"]),
                    }
                )
            continue

        if page.get("terminator") != "@h":
            raise SystemExit(
                f"{page['page_id']}: cannot auto-create overflow windows because terminator is {page.get('terminator')!r}"
            )
        if not entries_are_contiguous(page):
            raise SystemExit(f"{page['page_id']}: cannot range-patch non-contiguous text entries")

        replacement_lines = windowed_page_lines(page, rendered_items)
        source_lines = source_lines_for_page(page)
        jobs.append(
            {
                "id": f"{page['page_id']}:overflow-windows",
                "file": page["file"],
                "line_number": int(page["entries"][0]["line_number"]),
                "line_end": int(page["entries"][-1]["line_number"]),
                "source": "\r\n".join(source_lines),
                "source_lines": source_lines,
                "translation": "\r\n".join(replacement_lines),
            }
        )
        report["overflow_pages"].append(
            {
                "page_id": page["page_id"],
                "file": page["file"],
                "line_start": int(page["entries"][0]["line_number"]),
                "line_end": int(page["entries"][-1]["line_number"]),
                "used_lines": used_lines,
                "max_lines": max_lines,
                "inserted_windows": replacement_lines.count("@h"),
                "replacement_lines": replacement_lines,
            }
        )

    return jobs, report


def build_block_jobs(
    pages: list[dict[str, Any]],
    translations: dict[str, dict[str, Any]],
    block_translations: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> tuple[list[dict[str, Any]], dict[str, Any], set[str]]:
    jobs: list[dict[str, Any]] = []
    covered_page_ids: set[str] = set()
    blocks = build_blocks(pages)
    blocks_by_id = {block["block_id"]: block for block in blocks}
    report: dict[str, Any] = {
        "block_mode": True,
        "block_jobs": [],
        "line_override_blocks": [],
        "unknown_blocks": [],
    }

    for block_id in block_translations:
        if block_id not in blocks_by_id:
            raise SystemExit(f"Unknown block_id in block translation file: {block_id}")

    for block in blocks:
        block_id = str(block["block_id"])
        item = block_translations.get(block_id)
        if not item or not translation_is_allowed(item, args):
            continue
        en = str(item.get("en", "")).strip()
        if not en:
            continue

        override_count = explicit_line_override_count_for_block(block, translations)
        if override_count:
            report["line_override_blocks"].append(
                {
                    "block_id": block_id,
                    "line_override_count": override_count,
                    "line_ids": block["line_ids"],
                }
            )
            continue

        replacement_lines = block_replacement_lines(block, en)
        if not replacement_lines:
            continue

        source_lines = [str(line) for line in block["source_lines"]]
        jobs.append(
            {
                "id": f"{block_id}:block",
                "file": block["file"],
                "line_number": int(block["script_range_start"]),
                "line_end": int(block["script_range_end"]),
                "source": "\r\n".join(source_lines),
                "source_lines": source_lines,
                "translation": "\r\n".join(replacement_lines),
            }
        )
        covered_page_ids.update(str(page_id) for page_id in block["page_ids"])
        preview = block_preview(block, en)
        report["block_jobs"].append(
            {
                "block_id": block_id,
                "file": block["file"],
                "page_start": block["page_start"],
                "page_end": block["page_end"],
                "line_start": int(block["script_range_start"]),
                "line_end": int(block["script_range_end"]),
                "body_line_count": preview["body_line_count"],
                "window_count": preview["window_count"],
                "inserted_windows": preview["inserted_windows"],
                "replacement_lines": replacement_lines,
            }
        )

    return jobs, report, covered_page_ids


def build_jobs(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    log(f"Loading corpus pages for {args.file}")
    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    index = corpus_index(pages)
    log(f"Loaded {len(pages)} page(s), {len(index)} line target(s)")
    log(f"Loading translations from {args.translations}")
    translations = flatten_translation_records(read_jsonl(args.translations))
    log(f"Loaded {len(translations)} flattened translation(s)")
    block_translations: dict[str, dict[str, Any]] = {}
    if args.block_translations:
        log(f"Loading block translations from {args.block_translations}")
        block_translations = flatten_block_records(read_jsonl(args.block_translations))
        log(f"Loaded {len(block_translations)} block translation(s)")

    if args.auto_window_overflow:
        log("Building overflow-aware patch jobs")
        block_jobs: list[dict[str, Any]] = []
        block_report: dict[str, Any] = {
            "block_mode": bool(block_translations),
            "block_jobs": [],
            "line_override_blocks": [],
            "unknown_blocks": [],
        }
        covered_page_ids: set[str] = set()
        if block_translations:
            block_jobs, block_report, covered_page_ids = build_block_jobs(pages, translations, block_translations, args)
            log(f"Prepared {len(block_jobs)} block patch job(s)")
        line_jobs, report = build_windowed_jobs(pages, translations, args, skip_page_ids=covered_page_ids)
        jobs = block_jobs + line_jobs
        report["block_mode"] = bool(block_translations)
        report["block_jobs"] = block_report["block_jobs"]
        report["line_override_blocks"] = block_report["line_override_blocks"]
        report_path = args.overflow_report or args.jobs.with_name(f"{args.jobs.stem}.overflow_report.json")
        write_json(report_path, report)
        log(
            f"Prepared {len(report['overflow_pages'])} overflow page(s) "
            f"and {len(report['block_jobs'])} block job(s); "
            f"wrapped {len(report['wrapped_lines'])} line(s); report {report_path}"
        )
    else:
        jobs = build_normal_jobs(index, translations, args)

    write_json(args.jobs, jobs)
    log(f"Wrote {len(jobs)} patch job(s) to {args.jobs}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create patch jobs from approved translation JSONL.")
    parser.add_argument("--file", required=True, help="ADX file name, for example s1.adx")
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--translations", type=Path, required=True)
    parser.add_argument("--block-translations", type=Path, help="optional approved block translation JSONL")
    parser.add_argument("--jobs", type=Path, default=Path("patch_jobs/translated_jobs.json"))
    parser.add_argument("--include-auto-speakers", action="store_true")
    parser.add_argument("--require-approved", action="store_true")
    parser.add_argument(
        "--auto-window-overflow",
        action="store_true",
        help="wrap overlong English lines and insert extra @h windows when a textbox exceeds its line limit",
    )
    parser.add_argument("--overflow-report", type=Path, help="optional JSON report for generated overflow windows")
    return parser


def main() -> int:
    configure_stdout()
    build_jobs(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
