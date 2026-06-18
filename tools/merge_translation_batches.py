"""Merge per-batch translation JSON files into JSONL for review and validation."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from translation_common import configure_stdout, log, read_json, write_jsonl


def batch_sort_key(row: dict[str, Any]) -> tuple[str, int]:
    batch_id = str(row.get("batch_id", ""))
    try:
        return batch_id, int(batch_id.rsplit(":", 1)[-1])
    except ValueError:
        return batch_id, 0


def merge(args: argparse.Namespace) -> None:
    log(f"Reading per-batch JSON files from {args.input_dir}")
    rows: list[dict[str, Any]] = []
    for path in sorted(args.input_dir.glob("*.json")):
        row = read_json(path)
        row["_source_file"] = str(path)
        rows.append(row)

    rows.sort(key=batch_sort_key)
    log(f"Loaded {len(rows)} batch result file(s)")
    write_jsonl(args.output, rows)
    log(f"Wrote merged JSONL to {args.output}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Merge per-batch translation JSON files into JSONL.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    configure_stdout()
    merge(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
