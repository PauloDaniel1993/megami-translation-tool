"""Build game_management.py patch jobs from approved structured translations."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from translation_common import configure_stdout, flatten_translation_records, log, read_jsonl, write_json


def corpus_index(pages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for page in pages:
        for entry in page["entries"]:
            row = dict(entry)
            row["page_id"] = page["page_id"]
            index[row["line_id"]] = row
    return index


def render_translation(entry: dict[str, Any], en: str) -> str:
    normalized = en.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in normalized.split("\n") if line.strip()]
    prefix = str(entry.get("render_prefix", ""))
    return "\r\n".join(prefix + line for line in lines)


def build_jobs(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    log(f"Loading corpus pages for {args.file}")
    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    index = corpus_index(pages)
    log(f"Loaded {len(pages)} page(s), {len(index)} line target(s)")
    log(f"Loading translations from {args.translations}")
    translations = flatten_translation_records(read_jsonl(args.translations))
    log(f"Loaded {len(translations)} flattened translation(s)")

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
        if not en:
            continue
        status = str(item.get("status", "") or item.get("review_status", ""))
        if args.require_approved and status not in {"approved", ""}:
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

    write_json(args.jobs, jobs)
    log(f"Wrote {len(jobs)} patch job(s) to {args.jobs}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create patch jobs from approved translation JSONL.")
    parser.add_argument("--file", required=True, help="ADX file name, for example s1.adx")
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--translations", type=Path, required=True)
    parser.add_argument("--jobs", type=Path, default=Path("patch_jobs/translated_jobs.json"))
    parser.add_argument("--include-auto-speakers", action="store_true")
    parser.add_argument("--require-approved", action="store_true")
    return parser


def main() -> int:
    configure_stdout()
    build_jobs(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
