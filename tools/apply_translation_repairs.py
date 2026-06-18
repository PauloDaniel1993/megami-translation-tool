"""Apply repair JSONL records over a base translation JSONL."""

from __future__ import annotations

import argparse
from pathlib import Path

from translation_common import configure_stdout, flatten_translation_records, log, read_jsonl, write_jsonl


def run(args: argparse.Namespace) -> None:
    log(f"Loading base translations from {args.base}")
    base_rows = read_jsonl(args.base)
    log(f"Loading repairs from {args.repairs}")
    repairs = flatten_translation_records(read_jsonl(args.repairs))
    log(f"Loaded {len(repairs)} repair translation(s)")

    applied = 0
    for row in base_rows:
        for item in row.get("translations", []):
            line_id = str(item.get("line_id", ""))
            if line_id in repairs:
                item["en"] = str(repairs[line_id].get("en", "")).strip()
                item["repair_status"] = "repair_applied"
                item["repair_notes"] = repairs[line_id].get("notes", "")
                applied += 1

    write_jsonl(args.output, base_rows)
    log(f"Applied {applied} repair(s)")
    log(f"Wrote repaired translations to {args.output}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply repair JSONL records over base translation JSONL.")
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--repairs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    configure_stdout()
    run(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
