"""Generate reusable scene and chunk summaries with DeepSeek."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from translation_common import (
    configure_stdout,
    deepseek_chat_json,
    log,
    read_json,
    read_jsonl,
    require_env,
    write_json,
    write_jsonl,
)


def page_text(page: dict[str, Any]) -> str:
    lines = [f"{entry['line_id']} {entry['jp']}" for entry in page["entries"]]
    return "\n".join(lines)


def chunk_pages(pages: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [pages[index : index + size] for index in range(0, len(pages), size)]


def make_chunk_prompt(file_name: str, scene: dict[str, Any], pages: list[dict[str, Any]]) -> str:
    body = "\n\n".join(f"[{page['page_id']}]\n{page_text(page)}" for page in pages)
    return f"""Create Japanese-first translator context for this chunk of Eushully's 1998 game Ikusa Megami.

Do not translate each line. Summarize plot, emotional context, active characters, tone, and terminology.
Keep source facts in Japanese to avoid premature translation drift. Use English only for operational translation notes.
Return JSON only.

File: {file_name}
Scene ID: {scene['scene_id']}
Scene title JP: {scene['scene_title_jp']}

Visible script pages:
{body}

Return schema:
{{
  "scene_id": "...",
  "chunk_summary_jp": "...",
  "facts_jp": ["..."],
  "timeline_jp": ["..."],
  "active_characters": ["English glossary names only"],
  "tone_notes_jp": ["..."],
  "important_terms_jp": ["..."],
  "translation_notes_en": ["..."],
  "open_questions_jp": ["..."]
}}
"""


def make_scene_prompt(scene: dict[str, Any], chunk_summaries: list[dict[str, Any]]) -> str:
    return f"""Combine these chunk summaries into one stable Japanese-first scene context for translation.

Do not translate source lines. Keep source facts in Japanese to avoid premature translation drift.
Use English only for the scene title and operational translation notes. Return JSON only.

Scene ID: {scene['scene_id']}
Scene title JP: {scene['scene_title_jp']}

Chunk summaries:
{chunk_summaries}

Return schema:
{{
  "scene_id": "...",
  "scene_title_jp": "...",
  "scene_title_en": "...",
  "summary_jp": "...",
  "facts_jp": ["..."],
  "timeline_jp": ["..."],
  "active_characters": ["English glossary names only"],
  "tone_notes_jp": ["..."],
  "important_terms_jp": ["..."],
  "translation_notes_en": ["..."],
  "open_questions_jp": ["..."],
  "status": "draft"
}}
"""


def build_messages(prompt: str) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "You prepare concise translator context for a Japanese visual novel translation project. Output valid JSON only.",
        },
        {"role": "user", "content": prompt},
    ]


def summarize(args: argparse.Namespace) -> None:
    stem = Path(args.file).stem
    log(f"Loading corpus for {args.file}")
    scenes = read_json(args.corpus_dir / f"{stem}.scenes.json")
    pages = read_jsonl(args.corpus_dir / f"{stem}.pages.jsonl")
    log(f"Loaded {len(scenes)} scene(s) and {len(pages)} page(s)")
    pages_by_scene: dict[str, list[dict[str, Any]]] = {}
    for page in pages:
        pages_by_scene.setdefault(str(page["scene_id"]), []).append(page)

    if args.dry_run:
        log("Dry run enabled; prompts will be written without API calls")
        api_key = ""
    else:
        log(f"Using model {args.model} for scene summaries")
        api_key = require_env("DEEPSEEK_API_KEY")
    chunk_rows: list[dict[str, Any]] = []
    scene_rows: list[dict[str, Any]] = []
    prompt_rows: list[dict[str, Any]] = []

    selected_scenes = scenes[: args.limit_scenes] if args.limit_scenes else scenes
    log(f"Summarizing {len(selected_scenes)} scene(s)")
    for scene_index, scene in enumerate(selected_scenes, start=1):
        scene_pages = pages_by_scene.get(scene["scene_id"], [])
        scene_chunks = chunk_pages(scene_pages, args.chunk_pages)
        scene_chunk_summaries: list[dict[str, Any]] = []
        log(
            f"Scene {scene_index}/{len(selected_scenes)} {scene['scene_id']} "
            f"({scene['scene_title_jp']}): {len(scene_pages)} page(s), {len(scene_chunks)} chunk(s)"
        )

        for chunk_index, chunk in enumerate(scene_chunks, start=1):
            prompt = make_chunk_prompt(args.file, scene, chunk)
            chunk_id = f"{scene['scene_id']}:chunk:{chunk_index:04d}"
            prompt_rows.append({"kind": "chunk", "id": chunk_id, "prompt": prompt})
            log(f"Preparing chunk {chunk_index}/{len(scene_chunks)}: {chunk_id}")
            if args.dry_run:
                summary = {
                    "scene_id": scene["scene_id"],
                    "chunk_id": chunk_id,
                    "chunk_summary_jp": "",
                    "facts_jp": [],
                    "timeline_jp": [],
                    "active_characters": [],
                    "tone_notes_jp": [],
                    "important_terms_jp": [],
                    "translation_notes_en": [],
                    "open_questions_jp": [],
                    "status": "prompt_only",
                }
            else:
                log(f"Calling DeepSeek for chunk {chunk_id}")
                summary = deepseek_chat_json(
                    api_key=api_key,
                    model=args.model,
                    messages=build_messages(prompt),
                    temperature=args.temperature,
                )
                summary["chunk_id"] = chunk_id
                summary["status"] = "draft"
            summary["file"] = args.file
            summary["page_start"] = chunk[0]["page_index"] if chunk else None
            summary["page_end"] = chunk[-1]["page_index"] if chunk else None
            summary["created_at"] = datetime.now(timezone.utc).isoformat()
            summary["model"] = args.model
            chunk_rows.append(summary)
            scene_chunk_summaries.append(summary)

        scene_prompt = make_scene_prompt(scene, scene_chunk_summaries)
        prompt_rows.append({"kind": "scene", "id": scene["scene_id"], "prompt": scene_prompt})
        log(f"Preparing combined scene summary for {scene['scene_id']}")
        if args.dry_run:
            scene_summary = {
                "scene_id": scene["scene_id"],
                "scene_title_jp": scene["scene_title_jp"],
                "scene_title_en": "",
                "summary_jp": "",
                "facts_jp": [],
                "timeline_jp": [],
                "active_characters": [],
                "tone_notes_jp": [],
                "important_terms_jp": [],
                "translation_notes_en": [],
                "open_questions_jp": [],
                "status": "prompt_only",
            }
        else:
            log(f"Calling DeepSeek for combined scene summary {scene['scene_id']}")
            scene_summary = deepseek_chat_json(
                api_key=api_key,
                model=args.model,
                messages=build_messages(scene_prompt),
                temperature=args.temperature,
            )
            scene_summary["status"] = "draft"
        scene_summary["file"] = args.file
        scene_summary["created_at"] = datetime.now(timezone.utc).isoformat()
        scene_summary["model"] = args.model
        scene_rows.append(scene_summary)

    if args.dry_run:
        write_jsonl(args.report_out / f"{stem}_summary_prompts.jsonl", prompt_rows)
        log(f"Wrote {len(prompt_rows)} summary prompt row(s) to {args.report_out}")
        return

    write_jsonl(args.chunk_out / f"{stem}.chunks.jsonl", chunk_rows)
    write_json(args.scene_out / f"{stem}.scenes.json", scene_rows)
    log(f"Wrote {len(chunk_rows)} chunk summary row(s) and {len(scene_rows)} scene summary row(s)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate DeepSeek scene summaries.")
    parser.add_argument("--file", required=True, help="ADX file name, for example s1.adx")
    parser.add_argument("--corpus-dir", type=Path, default=Path("work/corpus"))
    parser.add_argument("--chunk-out", type=Path, default=Path("translations/context/chunk_summaries"))
    parser.add_argument("--scene-out", type=Path, default=Path("translations/context/scene_summaries"))
    parser.add_argument("--report-out", type=Path, default=Path("qa/reports"))
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--chunk-pages", type=int, default=40)
    parser.add_argument("--limit-scenes", type=int)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    configure_stdout()
    summarize(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
