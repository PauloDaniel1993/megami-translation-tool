"""Repair only failed translation lines reported by validate_translations.py."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from translation_common import (
    configure_stdout,
    deepseek_chat_json,
    flatten_translation_records,
    log,
    read_json,
    read_jsonl,
    require_env,
    TEXT_PROFILES,
    write_jsonl,
)


REPAIR_ISSUES_BY_PROFILE = {
    "vanilla": {"line_too_long", "not_cp932_encodable", "disallowed_apostrophe"},
    "apostrophe-patched": {"line_too_long", "not_cp932_encodable"},
}


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


def chunk(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def punctuation_rules(text_profile: str) -> str:
    if text_profile == "apostrophe-patched":
        return (
            "ASCII apostrophes and contractions are allowed for the patched executable.\n"
            "Do not use em dashes, en dashes, curly quotes, or ellipsis characters."
        )
    return (
        "Do not use apostrophes, contractions, em dashes, en dashes, curly quotes, or ellipsis characters.\n"
        'Rewrite possessives to avoid apostrophes, for example "Shuri hand freezes" or "Shuri freezes".'
    )


def make_prompt(items: list[dict[str, Any]], text_profile: str) -> str:
    repair_items = []
    for item in items:
        entry = item["entry"]
        repair_items.append(
            {
                "line_id": item["line_id"],
                "issue": item["issue"],
                "jp": entry["jp"],
                "current_en": item["current_en"],
                "role": entry["role"],
                "speaker_en": entry.get("speaker_en"),
                "max_chars": entry.get("max_chars", 50),
                "textbox": entry.get("textbox", {}),
                "page_context": [
                    {
                        "line_id": page_entry["line_id"],
                        "role": page_entry["role"],
                        "jp": page_entry["jp"],
                    }
                    for page_entry in entry.get("page_entries", [])
                ],
            }
        )

    return f"""Repair these English translation lines for a CP932 visual novel textbox.

Return JSON only. Repair only the listed line_id values.
Each physical rendered line must be 50 visible characters or fewer.
You may include `\\n` inside an `en` value to split one target line into two displayed lines if the page has spare textbox capacity.
Do not exceed the page's total textbox line limit.
Use ASCII/CP932-safe punctuation only.
{punctuation_rules(text_profile)}
Do not add Japanese unless intentionally preserving a glossary term.
Preserve meaning and character voice, but prefer concise wording over literal overflow.

Lines to repair:
{repair_items}

Return schema:
{{
  "translations": [
    {{
      "line_id": "...",
      "en": "...",
      "notes": ""
    }}
  ]
}}
"""


def build_messages(prompt: str) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "You repair visual novel translation lines to satisfy strict textbox constraints. Output valid JSON only.",
        },
        {"role": "user", "content": prompt},
    ]


def repair_one(
    *,
    repair_id: str,
    items: list[dict[str, Any]],
    args: argparse.Namespace,
    api_key: str,
) -> dict[str, Any]:
    prompt = make_prompt(items, args.text_profile)
    if args.dry_run:
        return {"repair_id": repair_id, "prompt": prompt, "status": "prompt_only"}

    result = deepseek_chat_json(
        api_key=api_key,
        model=args.model,
        messages=build_messages(prompt),
        temperature=args.temperature,
    )
    result["repair_id"] = repair_id
    result["file"] = args.file
    result["model"] = args.model
    result["prompt_version"] = "repair-v1"
    result["created_at"] = datetime.now(timezone.utc).isoformat()
    result["status"] = "repair_draft"
    return result


def run(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    log(f"Loading validation report {args.validation_report}")
    report = read_json(args.validation_report)
    repair_issues = REPAIR_ISSUES_BY_PROFILE[args.text_profile]
    failures = [row for row in report.get("failures", []) if row.get("issue") in repair_issues]
    log(f"Found {len(failures)} repairable failure(s)")

    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    index = corpus_index(pages)
    translations = flatten_translation_records(read_jsonl(args.translations))

    repair_items: list[dict[str, Any]] = []
    for failure in failures:
        line_id = str(failure["line_id"])
        if line_id not in index or line_id not in translations:
            log(f"Skipping {line_id}; missing corpus entry or translation")
            continue
        repair_items.append(
            {
                "line_id": line_id,
                "issue": failure["issue"],
                "current_en": str(translations[line_id].get("en", "")),
                "entry": index[line_id],
            }
        )

    groups = chunk(repair_items, args.chunk_size)
    log(f"Created {len(groups)} repair request group(s)")
    api_key = "" if args.dry_run else require_env("DEEPSEEK_API_KEY")

    rows: list[dict[str, Any]] = []
    if args.dry_run:
        for index_, items in enumerate(groups, start=1):
            repair_id = f"{stem}:repair:{index_:04d}"
            log(f"Preparing repair prompt {index_}/{len(groups)}: {repair_id}")
            rows.append(repair_one(repair_id=repair_id, items=items, args=args, api_key=api_key))
        write_jsonl(args.report_out / f"{stem}_repair_prompts.jsonl", rows)
        log(f"Wrote {len(rows)} repair prompt row(s) to {args.report_out}")
        return

    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as executor:
        futures = {}
        for index_, items in enumerate(groups, start=1):
            repair_id = f"{stem}:repair:{index_:04d}"
            log(f"Submitting repair group {index_}/{len(groups)}: {repair_id} ({len(items)} line(s))")
            futures[
                executor.submit(repair_one, repair_id=repair_id, items=items, args=args, api_key=api_key)
            ] = repair_id

        for future in as_completed(futures):
            repair_id = futures[future]
            result = future.result()
            rows.append(result)
            completed += 1
            log(f"Completed {repair_id}: {len(result.get('translations', []))} repaired line(s)")

    rows.sort(key=lambda row: str(row.get("repair_id", "")))
    write_jsonl(args.output, rows)
    log(f"Wrote {completed} repair group(s) to {args.output}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Repair failed translation lines with DeepSeek.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--translations", type=Path, required=True)
    parser.add_argument("--validation-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report-out", type=Path, default=Path("qa/reports"))
    parser.add_argument("--text-profile", choices=TEXT_PROFILES, default="vanilla")
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--temperature", type=float, default=0.1)
    parser.add_argument("--chunk-size", type=int, default=20)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    configure_stdout()
    run(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
