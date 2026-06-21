"""Migrate legacy block translations to safe script-contiguous block IDs."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from block_layout import build_blocks, materialize_block_line_changes
from translation_common import configure_stdout, log, read_jsonl, write_json, write_jsonl


def block_record_index(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(record["block_id"]): record for record in records if record.get("block_id")}


def child_blocks_for_legacy_block(legacy_block: dict[str, Any], safe_blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    legacy_line_ids = set(str(line_id) for line_id in legacy_block.get("line_ids", []))
    children = [
        block
        for block in safe_blocks
        if any(str(line_id) in legacy_line_ids for line_id in block.get("line_ids", []))
    ]
    return sorted(children, key=lambda block: (int(block["line_start"]), int(block["line_end"])))


def migrated_child_record(record: dict[str, Any], legacy_block: dict[str, Any], child: dict[str, Any], timestamp: str) -> dict[str, Any] | None:
    line_changes = materialize_block_line_changes(legacy_block, str(record.get("en", "")))
    line_text = {str(change["line_id"]): str(change["en"]).strip() for change in line_changes}
    en = "\n".join(
        line_text[str(line_id)]
        for line_id in child.get("line_ids", [])
        if line_text.get(str(line_id), "").strip()
    ).strip()
    if not en:
        return None
    migrated = dict(record)
    migrated["block_id"] = child["block_id"]
    migrated["en"] = en
    migrated["edited_at"] = timestamp
    migrated["migrated_from_block_id"] = record["block_id"]
    return migrated


def migrate(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    records = read_jsonl(args.block_translations)
    legacy_blocks = build_blocks(pages, split_on_script_gaps=False)
    safe_blocks = build_blocks(pages, split_on_script_gaps=True)
    legacy_by_id = {str(block["block_id"]): block for block in legacy_blocks}
    safe_by_id = {str(block["block_id"]): block for block in safe_blocks}
    existing = block_record_index(records)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    migrated_by_id: dict[str, dict[str, Any]] = {}
    unchanged = 0
    split_records = 0
    split_children = 0
    unknown = 0

    for block_id, record in existing.items():
        if block_id in safe_by_id:
            migrated_by_id[block_id] = record
            unchanged += 1
            continue

        legacy_block = legacy_by_id.get(block_id)
        if not legacy_block:
            unknown += 1
            continue

        split_records += 1
        for child in child_blocks_for_legacy_block(legacy_block, safe_blocks):
            if child["block_id"] in migrated_by_id:
                continue
            child_record = migrated_child_record(record, legacy_block, child, timestamp)
            if child_record:
                migrated_by_id[str(child["block_id"])] = child_record
                split_children += 1

    output_records = [
        migrated_by_id[block["block_id"]]
        for block in safe_blocks
        if block["block_id"] in migrated_by_id
    ]

    args.archive_dir.mkdir(parents=True, exist_ok=True)
    backup_path = args.archive_dir / f"{args.block_translations.stem}.{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl"
    write_jsonl(backup_path, records)
    write_jsonl(args.output or args.block_translations, output_records)
    write_json(
        args.report,
        {
            "file": args.file,
            "input": str(args.block_translations),
            "output": str(args.output or args.block_translations),
            "backup": str(backup_path),
            "legacy_records": len(records),
            "safe_records": len(output_records),
            "unchanged": unchanged,
            "split_records": split_records,
            "split_children": split_children,
            "unknown_records": unknown,
        },
    )
    log(
        f"Migrated {len(records)} legacy block record(s) to {len(output_records)} safe record(s); "
        f"split {split_records} record(s) into {split_children} child block(s); backup {backup_path}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Migrate legacy block translations to script-contiguous block IDs.")
    parser.add_argument("--file", required=True, help="ADX file name, for example s1.adx")
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--block-translations", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--archive-dir", type=Path, default=Path("translations/approved/archive"))
    parser.add_argument("--report", type=Path, default=Path("qa/reports/block_translation_migration.json"))
    return parser


def main() -> int:
    configure_stdout()
    migrate(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
