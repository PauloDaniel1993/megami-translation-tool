"""Translate structured Megami batches with DeepSeek."""

from __future__ import annotations

import argparse
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from translation_common import (
    configure_stdout,
    deepseek_chat_json,
    load_glossary,
    log,
    read_json,
    read_jsonl,
    require_env,
    TEXT_PROFILES,
    write_json,
)


def load_character_cards(glossary: dict[str, Any], pages: list[dict[str, Any]], context_dir: Path) -> list[str]:
    profile_ids: set[str] = set()
    for page in pages:
        for entry in page["entries"]:
            speaker = entry.get("speaker_jp")
            if speaker and speaker in glossary["character_by_jp"]:
                profile = glossary["character_by_jp"][speaker].get("profile")
                if profile:
                    profile_ids.add(str(profile))

    cards: list[str] = []
    for profile_id in sorted(profile_ids):
        path = context_dir / "characters" / f"{profile_id}.md"
        if path.is_file():
            cards.append(path.read_text(encoding="utf-8"))
    return cards


def pages_for_prompt(pages: list[dict[str, Any]], include_targets: bool) -> list[dict[str, Any]]:
    rendered = []
    for page in pages:
        entries = []
        for entry in page["entries"]:
            row = {
                "line_id": entry["line_id"],
                "role": entry["role"],
                "speaker_en": entry.get("speaker_en"),
                "jp": entry["jp"],
            }
            if include_targets:
                row["translate"] = bool(entry["translatable"] and not entry["auto"])
                row["max_chars"] = entry["max_chars"]
            entries.append(row)
        rendered.append(
            {
                "page_id": page["page_id"],
                "page_role": page["page_role"],
                "speaker_en": page.get("speaker_en"),
                "textbox": page["textbox"],
                "entries": entries,
            }
        )
    return rendered


def text_profile_rules(text_profile: str) -> str:
    if text_profile == "apostrophe-patched":
        return (
            "Text profile: apostrophe-patched. ASCII apostrophes and contractions are allowed.\n"
            "Do not use curly quotes, em dashes, en dashes, ellipsis characters, or non-CP932 punctuation.\n"
            "These text profile rules override any general style note about apostrophes."
        )
    return (
        "Text profile: vanilla. Never use apostrophes or contractions because the unpatched game stops rendering at ASCII apostrophes.\n"
        "Avoid em dashes, en dashes, curly quotes, ellipsis characters, and any punctuation that may fail CP932."
    )


def make_prompt(
    batch: dict[str, Any],
    glossary: dict[str, Any],
    global_style: str,
    character_cards: list[str],
    scene_summary: dict[str, Any] | None,
    text_profile: str,
) -> str:
    glossary_compact = {
        "characters": [{"jp": row["jp"], "en": row["en"]} for row in glossary.get("characters", [])],
        "menu_terms": glossary.get("menu_terms", {}),
        "locations": glossary.get("locations", {}),
        "terms": glossary.get("terms", {}),
    }
    targets = [
        entry["line_id"]
        for page in batch["pages"]
        for entry in page["entries"]
        if entry["translatable"] and not entry["auto"]
    ]
    return f"""Translate the current target pages from Japanese to English for the game Ikusa Megami.

Return JSON only. Translate only entries where translate=true. Do not return context-only entries.
Do not merge or split target lines. Do not add, remove, or rename line_id values.
Every physical rendered line must be 50 visible ASCII/CP932-safe characters or fewer.
You may include `\n` inside one `en` value to split it into multiple displayed lines if the page has spare textbox capacity.
Never exceed the page's total textbox line limit.
{text_profile_rules(text_profile)}
If a literal translation would exceed 50 characters, compress it while preserving meaning and character voice.

Global style:
{global_style}

Glossary:
{glossary_compact}

Relevant character voice cards:
{character_cards}

Japanese-first scene summary and translation notes:
{scene_summary or {}}

Read-only previous context:
{pages_for_prompt(batch.get('context_before', []), include_targets=False)}

Current pages to translate:
{pages_for_prompt(batch['pages'], include_targets=True)}

Read-only next context:
{pages_for_prompt(batch.get('context_after', []), include_targets=False)}

Expected target line_ids:
{targets}

Return schema:
{{
  "batch_id": "{batch['batch_id']}",
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
            "content": "You are a careful Japanese-to-English game translator. Output valid JSON only.",
        },
        {"role": "user", "content": prompt},
    ]


def safe_batch_filename(batch_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", batch_id) + ".json"


def translate_one_batch(
    *,
    batch: dict[str, Any],
    args: argparse.Namespace,
    api_key: str,
    glossary: dict[str, Any],
    global_style: str,
    scene_summaries: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    cards = load_character_cards(glossary, batch["pages"], args.context_dir)
    prompt = make_prompt(
        batch,
        glossary,
        global_style,
        cards,
        scene_summaries.get(batch["scene_id"]),
        args.text_profile,
    )
    if args.dry_run:
        return {
            "batch_id": batch["batch_id"],
            "prompt": prompt,
            "status": "prompt_only",
        }

    result = deepseek_chat_json(
        api_key=api_key,
        model=args.model,
        messages=build_messages(prompt),
        temperature=args.temperature,
    )
    result["file"] = args.file
    result["model"] = args.model
    result["prompt_version"] = "translation-v2-jp-context"
    result["created_at"] = datetime.now(timezone.utc).isoformat()
    result["status"] = "drafted"
    return result


def translate(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    log(f"Loading batches for {args.file}")
    batches = read_jsonl(args.corpus_dir / f"{stem}.batches.jsonl")
    log(f"Loaded {len(batches)} batch(es)")
    if args.limit:
        batches = batches[: args.limit]
        log(f"Limit applied; processing first {len(batches)} batch(es)")

    log("Loading glossary and global style")
    glossary = load_glossary(args.glossary)
    global_style = args.global_style.read_text(encoding="utf-8")
    scene_summaries_path = args.scene_summary_dir / f"{stem}.scenes.json"
    scene_summaries = {}
    if scene_summaries_path.is_file():
        for row in read_json(scene_summaries_path):
            scene_summaries[row["scene_id"]] = row
        log(f"Loaded {len(scene_summaries)} scene summarie(s)")
    else:
        log(f"No scene summary file found at {scene_summaries_path}; continuing without summaries")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    existing_files = {
        path.stem: path
        for path in args.output_dir.glob("*.json")
    }
    if existing_files:
        log(f"Found {len(existing_files)} existing per-batch output file(s)")
    if args.dry_run:
        log("Dry run enabled; prompts will be written without API calls")
        api_key = ""
    else:
        log(f"Using model {args.model} for translation")
        api_key = require_env("DEEPSEEK_API_KEY")
    todo: list[tuple[int, dict[str, Any], Path]] = []
    skipped = 0
    for index, batch in enumerate(batches, start=1):
        output_path = args.output_dir / safe_batch_filename(batch["batch_id"])
        if output_path.is_file() and not args.force and not args.dry_run:
            skipped += 1
            log(f"Skipping completed batch {index}/{len(batches)}: {batch['batch_id']}")
            continue
        todo.append((index, batch, output_path))

    log(f"Queued {len(todo)} batch(es); skipped {skipped}; concurrency={args.concurrency}")
    if args.dry_run:
        prompt_rows: list[dict[str, Any]] = []
        for index, batch, _ in todo:
            target_count = sum(
                1
                for page in batch["pages"]
                for entry in page["entries"]
                if entry["translatable"] and not entry["auto"]
            )
            log(f"Preparing dry-run prompt {index}/{len(batches)}: {batch['batch_id']} ({target_count} target line(s))")
            prompt_rows.append(
                translate_one_batch(
                    batch=batch,
                    args=args,
                    api_key=api_key,
                    glossary=glossary,
                    global_style=global_style,
                    scene_summaries=scene_summaries,
                )
            )
        from translation_common import write_jsonl

        write_jsonl(args.report_out / f"{stem}_translation_prompts.jsonl", prompt_rows)
        log(f"Wrote {len(prompt_rows)} translation prompt row(s) to {args.report_out}")
        return

    completed = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as executor:
        futures = {}
        for index, batch, output_path in todo:
            target_count = sum(
                1
                for page in batch["pages"]
                for entry in page["entries"]
                if entry["translatable"] and not entry["auto"]
            )
            log(
                f"Submitting batch {index}/{len(batches)} {batch['batch_id']} "
                f"({batch['scene_title_jp']}), {len(batch['pages'])} page(s), {target_count} target line(s)"
            )
            futures[
                executor.submit(
                    translate_one_batch,
                    batch=batch,
                    args=args,
                    api_key=api_key,
                    glossary=glossary,
                    global_style=global_style,
                    scene_summaries=scene_summaries,
                )
            ] = (batch, output_path)

        for future in as_completed(futures):
            batch, output_path = futures[future]
            try:
                result = future.result()
                write_json(output_path, result)
                completed += 1
                log(
                    f"Completed {batch['batch_id']}: "
                    f"{len(result.get('translations', []))} translation row(s) -> {output_path}"
                )
            except Exception as exc:
                failed += 1
                log(f"FAILED {batch['batch_id']}: {exc}")

    log(f"Translation complete: {completed} completed, {failed} failed, {skipped} skipped")
    if failed:
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Translate structured batches with DeepSeek.")
    parser.add_argument("--file", required=True, help="ADX file name, for example s1.adx")
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--context-dir", type=Path, default=Path("translations/context"))
    parser.add_argument("--glossary", type=Path, default=Path("translations/context/glossary.json"))
    parser.add_argument("--global-style", type=Path, default=Path("translations/context/global_style.md"))
    parser.add_argument("--scene-summary-dir", type=Path, default=Path("translations/context/scene_summaries"))
    parser.add_argument("--output-dir", type=Path, help="Defaults to translations/drafts/<stem>.<model>/")
    parser.add_argument("--report-out", type=Path, default=Path("qa/reports"))
    parser.add_argument("--text-profile", choices=TEXT_PROFILES, default="vanilla")
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    configure_stdout()
    args = build_parser().parse_args()
    if args.output_dir is None:
        stem = Path(args.file).stem
        args.output_dir = Path("translations/drafts") / f"{stem}.{args.model}"
    translate(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
