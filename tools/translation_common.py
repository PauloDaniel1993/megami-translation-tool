"""Shared helpers for the Megami translation workflow."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_MAX_CHARS = 50
DEFAULT_MAX_LINES = 4
DEFAULT_SPEAKER_DIALOGUE_LINES = 3
DEFAULT_DIALOGUE_PREFIX = "   "
TEXT_PROFILES = ("vanilla", "apostrophe-patched")
DISALLOWED_GAME_TEXT_CHARS_BY_PROFILE = {
    "vanilla": {
        "'": "apostrophe",
    },
    "apostrophe-patched": {},
}


def configure_stdout() -> None:
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    path.write_text(payload + ("\n" if payload else ""), encoding="utf-8")


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def source_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def contains_japanese(text: str) -> bool:
    return any(
        0x3040 <= ord(char) <= 0x30FF
        or 0x4E00 <= ord(char) <= 0x9FFF
        or 0xFF66 <= ord(char) <= 0xFF9F
        for char in text
    )


def visible_char_count(text: str) -> int:
    return len(text.strip())


def cp932_ok(text: str) -> bool:
    try:
        text.encode("cp932", errors="strict")
    except UnicodeEncodeError:
        return False
    return True


def cp932_bad_chars(text: str) -> list[str]:
    bad: list[str] = []
    seen: set[str] = set()
    for char in text:
        if char in seen:
            continue
        try:
            char.encode("cp932", errors="strict")
        except UnicodeEncodeError:
            bad.append(char)
            seen.add(char)
    return bad


def disallowed_game_text_chars(text: str, text_profile: str = "vanilla") -> list[dict[str, str]]:
    if text_profile not in DISALLOWED_GAME_TEXT_CHARS_BY_PROFILE:
        raise ValueError(f"Unknown text profile: {text_profile}")
    return [
        {"char": char, "name": name}
        for char, name in DISALLOWED_GAME_TEXT_CHARS_BY_PROFILE[text_profile].items()
        if char in text
    ]


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing environment variable: {name}")
    return value


def flatten_translation_records(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    flattened: dict[str, dict[str, Any]] = {}
    for record in records:
        translations = record.get("translations")
        if isinstance(translations, list):
            for item in translations:
                line_id = str(item.get("line_id", ""))
                if line_id:
                    flattened[line_id] = item
        else:
            line_id = str(record.get("line_id", ""))
            if line_id:
                flattened[line_id] = record
    return flattened


def load_glossary(path: Path) -> dict[str, Any]:
    glossary = read_json(path)
    characters = glossary.get("characters", [])
    glossary["character_by_jp"] = {row["jp"]: row for row in characters}
    glossary["character_by_en"] = {row["en"]: row for row in characters}
    return glossary


def deepseek_chat_json(
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    timeout: int = 120,
) -> dict[str, Any]:
    import urllib.error
    import urllib.request

    request_payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"DeepSeek API error {exc.code}: {body}") from exc

    content = payload["choices"][0]["message"]["content"]
    return json.loads(content)
