"""Build structured translation corpus files from Megami ADX scripts."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from game_management import decode_adx_bytes
from translation_common import (
    DEFAULT_DIALOGUE_PREFIX,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_LINES,
    DEFAULT_SPEAKER_DIALOGUE_LINES,
    configure_stdout,
    load_glossary,
    log,
    source_hash,
    write_json,
    write_jsonl,
)


def line_kind(line: str) -> str:
    stripped = line.strip()
    if not stripped:
        return "blank"
    if stripped.startswith("@"):
        return "command"
    if stripped.startswith("*"):
        return "label"
    return "text"


def command_name(line: str) -> str:
    stripped = line.strip()
    if not stripped.startswith("@"):
        return ""
    return stripped.split(maxsplit=1)[0]


def decode_lines(path: Path) -> list[str]:
    decoded = decode_adx_bytes(path.read_bytes())
    return decoded.decode("cp932", errors="strict").splitlines()


def scene_ranges(file_stem: str, lines: list[str]) -> list[dict[str, Any]]:
    starts: list[tuple[int, str, str]] = []
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("*+"):
            title = stripped[2:].strip() or "__untitled__"
            starts.append((line_number, title, line))

    if not starts:
        return [
            {
                "scene_id": f"{file_stem}:scene:0001",
                "scene_index": 1,
                "scene_title_jp": "__file_start__",
                "scene_title_en": "",
                "start_line": 1,
                "end_line": len(lines),
                "source_line": "",
                "source_hash": "",
            }
        ]

    scenes: list[dict[str, Any]] = []
    for index, (start, title, source_line) in enumerate(starts, start=1):
        end = starts[index][0] - 1 if index < len(starts) else len(lines)
        scenes.append(
            {
                "scene_id": f"{file_stem}:scene:{index:04d}",
                "scene_index": index,
                "scene_title_jp": title,
                "scene_title_en": "",
                "start_line": start,
                "end_line": end,
                "source_line": source_line,
                "source_hash": source_hash(source_line),
            }
        )
    return scenes


def find_scene(scenes: list[dict[str, Any]], line_number: int) -> dict[str, Any]:
    for scene in scenes:
        if int(scene["start_line"]) <= line_number <= int(scene["end_line"]):
            return scene
    return scenes[0]


def collect_display_pages(file_stem: str, lines: list[str], scenes: list[dict[str, Any]], glossary: dict[str, Any]) -> list[dict[str, Any]]:
    character_by_jp = glossary["character_by_jp"]
    settings = glossary.get("settings", {})
    max_chars = int(settings.get("max_chars_per_line", DEFAULT_MAX_CHARS))
    max_lines = int(settings.get("max_lines_total", DEFAULT_MAX_LINES))
    speaker_lines = int(settings.get("speaker_dialogue_lines", DEFAULT_SPEAKER_DIALOGUE_LINES))
    dialogue_prefix = str(settings.get("dialogue_prefix", DEFAULT_DIALOGUE_PREFIX))

    pages: list[dict[str, Any]] = []
    current_visible: list[tuple[int, str]] = []
    page_start = 1
    page_index = 1

    def close_page(end_line: int, terminator: str) -> None:
        nonlocal current_visible, page_start, page_index
        if not current_visible:
            current_visible = []
            page_start = end_line + 1
            return

        first_line_number = current_visible[0][0]
        last_line_number = current_visible[-1][0]
        scene = find_scene(scenes, first_line_number)
        first_text = current_visible[0][1].strip()
        speaker = character_by_jp.get(first_text)
        speaker_present = speaker is not None
        page_role = "dialogue" if speaker_present else "narration"
        entries: list[dict[str, Any]] = []

        for visible_index, (line_number, source_line) in enumerate(current_visible):
            stripped = source_line.strip()
            role = "narration"
            speaker_jp = None
            speaker_en = None
            render_prefix = ""
            translatable = True
            status = "pending"
            en = ""
            auto = False

            if speaker_present and visible_index == 0:
                role = "speaker"
                speaker_jp = first_text
                speaker_en = speaker["en"]
                en = speaker["en"]
                status = "auto_glossary"
                auto = True
            elif speaker_present:
                role = "dialogue"
                speaker_jp = first_text
                speaker_en = speaker["en"]
                render_prefix = dialogue_prefix

            entries.append(
                {
                    "line_id": f"{file_stem}:{line_number:05d}",
                    "file": f"{file_stem}.adx",
                    "line_number": line_number,
                    "source_line": source_line,
                    "source_hash": source_hash(source_line),
                    "jp": stripped,
                    "en": en,
                    "role": role,
                    "kind": "text",
                    "speaker_jp": speaker_jp,
                    "speaker_en": speaker_en,
                    "render_prefix": render_prefix,
                    "translatable": translatable,
                    "auto": auto,
                    "status": status,
                    "max_chars": max_chars,
                }
            )

        pages.append(
            {
                "page_id": f"{file_stem}:page:{first_line_number:05d}-{last_line_number:05d}",
                "page_index": page_index,
                "file": f"{file_stem}.adx",
                "scene_id": scene["scene_id"],
                "scene_title_jp": scene["scene_title_jp"],
                "start_line": first_line_number,
                "end_line": last_line_number,
                "script_range_start": page_start,
                "script_range_end": end_line,
                "terminator": terminator,
                "speaker_present": speaker_present,
                "speaker_jp": first_text if speaker_present else None,
                "speaker_en": speaker["en"] if speaker_present else None,
                "page_role": page_role,
                "textbox": {
                    "max_lines_total": max_lines,
                    "max_chars_per_line": max_chars,
                    "speaker_present": speaker_present,
                    "dialogue_lines_available": speaker_lines if speaker_present else max_lines,
                    "dialogue_prefix": dialogue_prefix,
                },
                "entries": entries,
            }
        )
        page_index += 1
        current_visible = []
        page_start = end_line + 1

    for line_number, line in enumerate(lines, start=1):
        kind = line_kind(line)
        stripped = line.strip()
        if kind == "text":
            if not current_visible:
                page_start = line_number
            current_visible.append((line_number, line))
            continue

        if current_visible:
            if kind == "command" and command_name(line) == "@h":
                close_page(line_number, "@h")
            elif kind in {"command", "label"}:
                close_page(line_number - 1, "control_break")

    if current_visible:
        close_page(len(lines), "eof")

    return pages


def summarize_scene_counts(scenes: list[dict[str, Any]], pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pages_by_scene: dict[str, list[dict[str, Any]]] = {}
    for page in pages:
        pages_by_scene.setdefault(str(page["scene_id"]), []).append(page)

    result: list[dict[str, Any]] = []
    for scene in scenes:
        scene_pages = pages_by_scene.get(scene["scene_id"], [])
        visible_lines = sum(len(page["entries"]) for page in scene_pages)
        translatable_lines = sum(
            1
            for page in scene_pages
            for entry in page["entries"]
            if entry["translatable"] and not entry["auto"]
        )
        row = dict(scene)
        row.update(
            {
                "page_count": len(scene_pages),
                "visible_line_count": visible_lines,
                "translatable_line_count": translatable_lines,
            }
        )
        result.append(row)
    return result


def build_batches(file_stem: str, pages: list[dict[str, Any]], batch_pages: int) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    batch_index = 1
    by_scene: dict[str, list[dict[str, Any]]] = {}
    for page in pages:
        by_scene.setdefault(str(page["scene_id"]), []).append(page)

    for scene_id, scene_pages in by_scene.items():
        for offset in range(0, len(scene_pages), batch_pages):
            current = scene_pages[offset : offset + batch_pages]
            previous_context = scene_pages[max(0, offset - 2) : offset]
            next_context = scene_pages[offset + batch_pages : offset + batch_pages + 1]
            if not current:
                continue
            batches.append(
                {
                    "batch_id": f"{file_stem}:batch:{batch_index:04d}",
                    "batch_index": batch_index,
                    "file": f"{file_stem}.adx",
                    "scene_id": scene_id,
                    "scene_title_jp": current[0]["scene_title_jp"],
                    "page_start": current[0]["page_index"],
                    "page_end": current[-1]["page_index"],
                    "line_start": current[0]["start_line"],
                    "line_end": current[-1]["end_line"],
                    "context_before": previous_context,
                    "pages": current,
                    "context_after": next_context,
                    "status": "pending",
                }
            )
            batch_index += 1
    return batches


def write_preview(path: Path, file_name: str, scenes: list[dict[str, Any]], pages: list[dict[str, Any]], batches: list[dict[str, Any]]) -> None:
    scene_rows = "\n".join(
        f"<tr><td>{scene['scene_id']}</td><td>{scene['scene_title_jp']}</td><td>{scene['page_count']}</td><td>{scene['translatable_line_count']}</td></tr>"
        for scene in scenes
    )
    sample_rows = "\n".join(
        f"<tr><td>{page['page_id']}</td><td>{page['scene_title_jp']}</td><td>{page['page_role']}</td><td><pre>{html_escape(chr(10).join(entry['jp'] for entry in page['entries']))}</pre></td></tr>"
        for page in pages[:25]
    )
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{html_escape(file_name)} Corpus Preview</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 2rem auto; max-width: 1100px; line-height: 1.5; }}
    table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
    th, td {{ border: 1px solid #ccc; padding: 0.45rem; vertical-align: top; }}
    th {{ background: #eee; }}
    pre {{ margin: 0; white-space: pre-wrap; }}
  </style>
</head>
<body>
  <h1>{html_escape(file_name)} Corpus Preview</h1>
  <p>Scenes: {len(scenes)}. Display pages: {len(pages)}. Medium batches: {len(batches)}.</p>
  <h2>Scenes</h2>
  <table><thead><tr><th>ID</th><th>JP Title</th><th>Pages</th><th>Translatable Lines</th></tr></thead><tbody>{scene_rows}</tbody></table>
  <h2>First 25 Display Pages</h2>
  <table><thead><tr><th>Page</th><th>Scene</th><th>Role</th><th>Visible Text</th></tr></thead><tbody>{sample_rows}</tbody></table>
</body>
</html>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")


def html_escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_for_file(path: Path, args: argparse.Namespace, glossary: dict[str, Any]) -> None:
    log(f"Building structured corpus for {path.name}")
    file_stem = path.stem
    lines = decode_lines(path)
    log(f"{path.name}: decoded {len(lines)} script line(s)")
    decoded_out = args.decoded_out / f"{file_stem}.txt"
    decoded_out.parent.mkdir(parents=True, exist_ok=True)
    decoded_out.write_text("\n".join(lines), encoding="utf-8")

    scenes = scene_ranges(file_stem, lines)
    log(f"{path.name}: detected {len(scenes)} scene(s)")
    pages = collect_display_pages(file_stem, lines, scenes, glossary)
    log(f"{path.name}: built {len(pages)} display page(s)")
    scene_summary = summarize_scene_counts(scenes, pages)
    batches = build_batches(file_stem, pages, args.batch_pages)
    log(f"{path.name}: built {len(batches)} batch(es) with up to {args.batch_pages} page(s) each")

    write_json(args.corpus_out / f"{file_stem}.scenes.json", scene_summary)
    write_jsonl(args.corpus_out / f"{file_stem}.pages.jsonl", pages)
    write_jsonl(args.corpus_out / f"{file_stem}.batches.jsonl", batches)
    write_preview(args.report_out / f"{file_stem}_corpus_preview.html", path.name, scene_summary, pages, batches)

    translatable = sum(
        1 for page in pages for entry in page["entries"] if entry["translatable"] and not entry["auto"]
    )
    log(
        f"{path.name}: {len(scene_summary)} scene(s), {len(pages)} display page(s), "
        f"{translatable} model-translated line(s), {len(batches)} batch(es)"
    )


def find_files(source_dir: Path, file_filter: str | None) -> list[Path]:
    if file_filter:
        path = source_dir / file_filter
        if not path.is_file():
            raise SystemExit(f"ADX file not found: {path}")
        return [path]
    files = sorted(source_dir.glob("*.adx"))
    if not files:
        raise SystemExit(f"No .adx files found in {source_dir}")
    return files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build structured Megami translation corpus files.")
    parser.add_argument("--source-dir", type=Path, default=Path("."))
    parser.add_argument("--file", help="Optional ADX file, for example s1.adx")
    parser.add_argument("--glossary", type=Path, default=Path("translations/context/glossary.json"))
    parser.add_argument("--decoded-out", type=Path, default=Path("work/decoded_adx"))
    parser.add_argument("--corpus-out", type=Path, default=Path("work/corpus"))
    parser.add_argument("--report-out", type=Path, default=Path("qa/reports"))
    parser.add_argument("--batch-pages", type=int, default=20)
    return parser


def main() -> int:
    configure_stdout()
    args = build_parser().parse_args()
    log("Loading glossary")
    glossary = load_glossary(args.glossary)
    files = find_files(args.source_dir, args.file)
    log(f"Found {len(files)} ADX file(s) to process")
    for index, path in enumerate(files, start=1):
        log(f"Processing file {index}/{len(files)}: {path.name}")
        build_for_file(path, args, glossary)
    log("Corpus build complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
