"""Block translation grouping and layout helpers."""

from __future__ import annotations

import math
from typing import Any


MAX_BLOCK_PAGES = 8
MAX_BLOCK_ENTRIES = 16


def split_translation_lines(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def wrap_visible_line(line: str, max_chars: int) -> list[str]:
    stripped = line.strip()
    if not stripped:
        return []
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


def chunk_lines(lines: list[str], size: int) -> list[list[str]]:
    if size <= 0:
        raise ValueError("Cannot create windows with zero available text lines")
    return [lines[index : index + size] for index in range(0, len(lines), size)] or [[]]


def flatten_windows(windows: list[list[str]]) -> list[str]:
    output: list[str] = []
    for index, window in enumerate(windows):
        if index:
            output.append("@h")
        output.extend(window)
    return output


def block_key(page: dict[str, Any]) -> tuple[str, str, str]:
    speaker = str(page.get("speaker_en") or page.get("speaker_jp") or "")
    return (str(page.get("scene_id", "")), str(page.get("page_role", "")), speaker)


def block_translatable_entries(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for page in pages:
        for entry in page.get("entries", []):
            if entry.get("translatable") and not entry.get("auto"):
                entries.append(entry)
    return entries


def page_source_lines(page: dict[str, Any], *, include_terminator: bool) -> list[str]:
    lines = [str(entry["source_line"]) for entry in page.get("entries", [])]
    if include_terminator and page.get("terminator") == "@h":
        lines.append("@h")
    return lines


def is_script_control_line(line: str) -> bool:
    stripped = str(line).strip()
    if not stripped or stripped == "@h":
        return False
    return stripped.startswith("@") or stripped.startswith("*")


def unsafe_control_lines(lines: list[str]) -> list[str]:
    return [str(line) for line in lines if is_script_control_line(str(line))]


def pages_are_physically_contiguous(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    return int(current["script_range_start"]) == int(previous["script_range_end"]) + 1


def block_source_lines(block: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    pages = block.get("pages", [])
    for page in pages:
        lines.extend(page_source_lines(page, include_terminator=True))
    return lines


def finish_block(pages: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not pages:
        return None
    entries = block_translatable_entries(pages)
    if not entries:
        return None

    first_page = pages[0]
    last_page = pages[-1]
    first_line = int(first_page["start_line"])
    last_line = int(last_page["end_line"])
    stem = str(first_page["file"]).rsplit(".", 1)[0]
    source_lines: list[str] = []
    for page in pages:
        source_lines.extend(page_source_lines(page, include_terminator=True))

    return {
        "block_id": f"{stem}:block:{first_line:05d}-{last_line:05d}",
        "file": first_page["file"],
        "scene_id": first_page.get("scene_id"),
        "scene_title_jp": first_page.get("scene_title_jp"),
        "page_role": first_page.get("page_role"),
        "speaker_jp": first_page.get("speaker_jp"),
        "speaker_en": first_page.get("speaker_en"),
        "page_start": int(first_page["page_index"]),
        "page_end": int(last_page["page_index"]),
        "line_start": first_line,
        "line_end": last_line,
        "script_range_start": int(first_page["script_range_start"]),
        "script_range_end": int(last_page["script_range_end"]),
        "textbox": first_page.get("textbox", {}),
        "page_ids": [page["page_id"] for page in pages],
        "line_ids": [entry["line_id"] for entry in entries],
        "jp": "\n".join(str(entry.get("jp", "")) for entry in entries if str(entry.get("jp", "")).strip()),
        "source_lines": source_lines,
        "pages": pages,
    }


def build_blocks(pages: list[dict[str, Any]], *, split_on_script_gaps: bool = True) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_key: tuple[str, str, str] | None = None
    current_entries = 0

    def flush() -> None:
        nonlocal current, current_key, current_entries
        block = finish_block(current)
        if block:
            blocks.append(block)
        current = []
        current_key = None
        current_entries = 0

    for page in pages:
        entries = block_translatable_entries([page])
        safe = page.get("terminator") == "@h" and bool(entries)
        key = block_key(page)
        would_exceed = (
            len(current) >= MAX_BLOCK_PAGES
            or current_entries + len(entries) > MAX_BLOCK_ENTRIES
        )
        crosses_script_gap = bool(
            split_on_script_gaps
            and current
            and not pages_are_physically_contiguous(current[-1], page)
        )

        if not safe:
            flush()
            continue

        if current and (key != current_key or would_exceed or crosses_script_gap):
            flush()

        current.append(page)
        current_key = key
        current_entries += len(entries)

    flush()
    return blocks


def speaker_lines_for_block(block: dict[str, Any]) -> list[str]:
    speaker = str(block.get("speaker_en") or block.get("speaker_jp") or "").strip()
    return [speaker] if speaker else []


def body_capacity_for_block(block: dict[str, Any]) -> int:
    textbox = block.get("textbox", {})
    max_lines = int(textbox.get("max_lines_total", 4))
    if block.get("page_role") != "dialogue":
        return max_lines
    speaker_lines = speaker_lines_for_block(block)
    capacity = max_lines - len(speaker_lines)
    if capacity <= 0:
        raise ValueError(f"{block['block_id']}: speaker line consumes the full textbox")
    return capacity


def block_body_lines(block: dict[str, Any], en: str) -> list[str]:
    max_chars = int(block.get("textbox", {}).get("max_chars_per_line", 50))
    return wrap_translation_lines(split_translation_lines(en), max_chars)


def block_windows(block: dict[str, Any], en: str) -> list[list[str]]:
    body_lines = block_body_lines(block, en)
    if not body_lines:
        return []

    capacity = body_capacity_for_block(block)
    chunks = chunk_lines(body_lines, capacity)
    if block.get("page_role") != "dialogue":
        return chunks

    speaker_lines = speaker_lines_for_block(block)
    return [speaker_lines + chunk for chunk in chunks]


def block_replacement_lines(block: dict[str, Any], en: str) -> list[str]:
    windows = block_windows(block, en)
    if not windows:
        return []
    return flatten_windows(windows) + ["@h"]


def materialize_block_line_changes(block: dict[str, Any], en: str) -> list[dict[str, str]]:
    line_ids = [str(line_id) for line_id in block.get("line_ids", [])]
    if not line_ids:
        return []

    body_lines = block_body_lines(block, en)
    if not body_lines:
        return [{"line_id": line_id, "en": ""} for line_id in line_ids]

    per_line: list[list[str]] = [[] for _ in line_ids]
    for index, line in enumerate(body_lines):
        target = min(index, len(line_ids) - 1)
        per_line[target].append(line)

    return [
        {
            "line_id": line_id,
            "en": "\n".join(lines),
        }
        for line_id, lines in zip(line_ids, per_line)
    ]


def block_preview(block: dict[str, Any], en: str) -> dict[str, Any]:
    windows = block_windows(block, en)
    line_count = sum(len(window) for window in windows)
    return {
        "windows": windows,
        "window_count": len(windows),
        "body_line_count": len(block_body_lines(block, en)),
        "rendered_line_count": line_count + (len(windows) if windows else 0),
        "inserted_windows": max(0, len(windows) - 1),
        "replacement_lines": block_replacement_lines(block, en),
    }


def line_override_enabled(item: dict[str, Any] | None) -> bool:
    if not item:
        return False
    return item.get("layout_mode") == "line" or item.get("line_override") is True


def legacy_line_count_for_block(block: dict[str, Any], translations: dict[str, dict[str, Any]]) -> int:
    return sum(1 for line_id in block.get("line_ids", []) if str(translations.get(line_id, {}).get("en", "")).strip())


def explicit_line_override_count_for_block(block: dict[str, Any], translations: dict[str, dict[str, Any]]) -> int:
    return sum(
        1
        for line_id in block.get("line_ids", [])
        if line_override_enabled(translations.get(str(line_id)))
    )


def joined_line_translation_for_block(block: dict[str, Any], translations: dict[str, dict[str, Any]]) -> str:
    pieces: list[str] = []
    for line_id in block.get("line_ids", []):
        en = str(translations.get(str(line_id), {}).get("en", "")).strip()
        if en:
            pieces.append(en)
    return "\n".join(pieces)


def block_effective_mode(
    block: dict[str, Any],
    block_record: dict[str, Any] | None,
    line_translations: dict[str, dict[str, Any]],
) -> str:
    if explicit_line_override_count_for_block(block, line_translations):
        return "lines"
    if block_record and str(block_record.get("en", "")).strip():
        return "block"
    if legacy_line_count_for_block(block, line_translations):
        return "legacy-lines"
    return "source"


def window_count_for_body_lines(block: dict[str, Any], body_line_count: int) -> int:
    if body_line_count <= 0:
        return 0
    capacity = body_capacity_for_block(block)
    return int(math.ceil(body_line_count / capacity))
