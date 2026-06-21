"""Standalone Megami ADX extraction and reinsertion manager."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


DEFAULT_DECODED_DIR = Path("decoded_adx")
DEFAULT_TEXT_DIR = Path("translation_text")
DEFAULT_CORPUS = DEFAULT_TEXT_DIR / "_all_text.json"
DEFAULT_JOBS = Path("patch_jobs") / "translated_jobs.json"
DEFAULT_PATCHED_DIR = Path("patched_adx")


@dataclass
class ExtractedLine:
    id: str
    file: str
    line_number: int
    kind: str
    command: str
    source_line: str
    text: str
    translation: str


@dataclass
class PatchJob:
    id: str
    file: str
    line_number: int
    source: str
    translation: str
    line_end: int | None = None
    source_lines: list[str] | None = None


@dataclass
class PatchResult:
    id: str
    file: str
    mode: str
    output_path: str
    decoded_inspection_path: str
    original_file_size: int
    patched_file_size: int
    original_line_bytes: int
    translation_bytes: int
    padding_bytes: int
    roundtrip_original_ok: bool
    patched_decodes_strict_cp932: bool
    patched_line: str


def configure_stdout() -> None:
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def rol8(value: int, count: int) -> int:
    count &= 7
    return ((value << count) & 0xFF) | (value >> (8 - count))


def ror8(value: int, count: int) -> int:
    count &= 7
    return (value >> count) | ((value << (8 - count)) & 0xFF)


def decode_adx_bytes(data: bytes) -> bytes:
    decoded = bytearray(data)
    if len(decoded) < 2:
        return bytes(decoded)

    decoded[0] = (~decoded[0]) & 0xFF
    first_span = decoded[0]
    span_remaining = first_span

    decoded[1] = rol8((~decoded[1]) & 0xFF, 1)
    second_span = decoded[1]

    rotation = 1
    offset = 2
    while offset < len(decoded):
        decoded[offset] = rol8(decoded[offset], rotation)
        offset += 1

        rotation += 1
        if rotation >= 7:
            rotation = 1

        span_remaining -= 1
        if span_remaining == 0:
            span_remaining = first_span if rotation > 4 else second_span
            rotation = 1

    return bytes(decoded)


def encode_adx_bytes(decoded_data: bytes) -> bytes:
    encoded = bytearray(decoded_data)
    if len(encoded) < 2:
        return bytes(encoded)

    first_span = decoded_data[0]
    second_span = decoded_data[1]
    encoded[0] = (~decoded_data[0]) & 0xFF
    encoded[1] = (~ror8(decoded_data[1], 1)) & 0xFF

    rotation = 1
    span_remaining = first_span
    offset = 2
    while offset < len(encoded):
        encoded[offset] = ror8(decoded_data[offset], rotation)
        offset += 1

        rotation += 1
        if rotation >= 7:
            rotation = 1

        span_remaining -= 1
        if span_remaining == 0:
            span_remaining = first_span if rotation > 4 else second_span
            rotation = 1

    return bytes(encoded)


def decode_adx_text(data: bytes) -> str:
    return decode_adx_bytes(data).decode("cp932", errors="replace")


def contains_japanese(text: str) -> bool:
    return any(
        0x3040 <= ord(char) <= 0x30FF
        or 0x4E00 <= ord(char) <= 0x9FFF
        or 0xFF66 <= ord(char) <= 0xFF9F
        for char in text
    )


def classify_line(line: str) -> tuple[str, str, str]:
    stripped = line.strip()
    if not stripped:
        return "blank", "", ""

    if stripped.startswith("@"):
        command, _, rest = stripped.partition(" ")
        return "command", command, rest.strip()

    if stripped.startswith("*"):
        marker = stripped[:2] if len(stripped) >= 2 and stripped[1] in "+-" else stripped[0]
        return "comment_or_label", marker, stripped[len(marker):].strip()

    return "text", "", stripped


def extract_lines(file_name: str, decoded_text: str) -> list[ExtractedLine]:
    rows: list[ExtractedLine] = []
    for line_number, line in enumerate(decoded_text.splitlines(), start=1):
        kind, command, text = classify_line(line)
        if not contains_japanese(text):
            continue
        rows.append(
            ExtractedLine(
                id=f"{Path(file_name).stem}:{line_number:05d}",
                file=file_name,
                line_number=line_number,
                kind=kind,
                command=command,
                source_line=line,
                text=text,
                translation="",
            )
        )
    return rows


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_translation_txt(path: Path, lines: list[ExtractedLine]) -> None:
    output: list[str] = []
    for item in lines:
        output.extend(
            [
                f"## {item.id}",
                f"# file: {item.file}",
                f"# line: {item.line_number}",
                f"# kind: {item.kind}",
                f"# command: {item.command}",
                f"source: {item.text}",
                "translation: ",
                "",
            ]
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(output), encoding="utf-8")


def write_unique_corpus(text_dir: Path, entries: list[dict[str, object]]) -> None:
    unique: dict[str, dict[str, object]] = {}
    for entry in entries:
        text = str(entry["text"])
        row = unique.setdefault(
            text,
            {
                "id": f"U{len(unique) + 1:05d}",
                "text": text,
                "translation": "",
                "occurrences": 0,
                "refs": [],
                "kinds": [],
                "commands": [],
            },
        )
        row["occurrences"] += 1
        row["refs"].append(
            {
                "file": entry["file"],
                "line_number": entry["line_number"],
                "entry_id": entry["id"],
                "source_line": entry["source_line"],
            }
        )
        if entry["kind"] not in row["kinds"]:
            row["kinds"].append(entry["kind"])
        if entry["command"] and entry["command"] not in row["commands"]:
            row["commands"].append(entry["command"])

    rows = sorted(unique.values(), key=lambda row: (-int(row["occurrences"]), str(row["text"])))
    write_json(text_dir / "_unique_text.json", rows)


def find_adx_files(target: Path, file_filter: str | None = None) -> list[Path]:
    if file_filter:
        path = target / file_filter
        if not path.is_file():
            raise SystemExit(f"ADX file not found: {path}")
        return [path]
    if target.is_file():
        return [target]
    paths = sorted(target.glob("*.adx"))
    if not paths:
        raise SystemExit(f"No .adx files found in {target}")
    return paths


def process_extract_file(path: Path, decoded_dir: Path, text_dir: Path) -> tuple[dict[str, object], list[ExtractedLine]]:
    decoded_text = decode_adx_text(path.read_bytes())
    decoded_path = decoded_dir / f"{path.stem}.txt"
    decoded_path.parent.mkdir(parents=True, exist_ok=True)
    decoded_path.write_text(decoded_text, encoding="utf-8")

    extracted = extract_lines(path.name, decoded_text)
    write_json(text_dir / f"{path.stem}_text.json", [asdict(item) for item in extracted])
    write_translation_txt(text_dir / f"{path.stem}_text.txt", extracted)

    counts_by_kind: dict[str, int] = {}
    for item in extracted:
        counts_by_kind[item.kind] = counts_by_kind.get(item.kind, 0) + 1

    return (
        {
            "file": path.name,
            "decoded_path": str(decoded_path),
            "extract_path": str(text_dir / f"{path.stem}_text.json"),
            "total_lines": len(decoded_text.splitlines()),
            "translation_entries": len(extracted),
            "counts_by_kind": counts_by_kind,
        },
        extracted,
    )


def command_extract(args: argparse.Namespace) -> None:
    paths = find_adx_files(args.source_dir, args.file)
    summaries: list[dict[str, object]] = []
    all_entries: list[ExtractedLine] = []

    for path in paths:
        summary, entries = process_extract_file(path, args.decoded_out, args.text_out)
        summaries.append(summary)
        all_entries.extend(entries)

    all_dicts = [asdict(item) for item in all_entries]
    write_json(args.text_out / "_summary.json", summaries)
    write_json(args.text_out / "_all_text.json", all_dicts)
    write_translation_txt(args.text_out / "_all_text.txt", all_entries)
    write_unique_corpus(args.text_out, all_dicts)

    print(f"Decoded {len(paths)} .adx file(s) into {args.decoded_out}")
    print(f"Extracted {len(all_entries)} Japanese-bearing line(s) into {args.text_out}")


def entry_to_job(entry: dict[str, object]) -> PatchJob | None:
    translation = str(entry.get("translation", "")).strip()
    if not translation:
        return None
    return PatchJob(
        id=str(entry["id"]),
        file=str(entry["file"]),
        line_number=int(entry["line_number"]),
        source=str(entry.get("source_line") or entry.get("source") or entry.get("text") or ""),
        translation=translation,
    )


def command_build_jobs(args: argparse.Namespace) -> None:
    entries = json.loads(args.corpus.read_text(encoding="utf-8"))
    jobs: list[PatchJob] = []
    for entry in entries:
        if args.file and entry.get("file") != args.file:
            continue
        job = entry_to_job(entry)
        if job:
            jobs.append(job)

    write_json(args.jobs, [asdict(job) for job in jobs])
    print(f"Wrote {len(jobs)} patch job(s) to {args.jobs}")


def load_jobs(path: Path) -> list[PatchJob]:
    if not path.is_file():
        raise SystemExit(f"Patch jobs file not found: {path}. Run Jobs successfully before Reinsert.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [PatchJob(**item) for item in payload]


def validate_unique_lines(jobs: list[PatchJob]) -> None:
    seen: set[tuple[str, int]] = set()
    for job in jobs:
        line_end = job.line_end or job.line_number
        if line_end < job.line_number:
            raise SystemExit(f"{job.id}: line_end must be >= line_number")
        for line_number in range(job.line_number, line_end + 1):
            key = (job.file, line_number)
            if key in seen:
                raise SystemExit(f"Duplicate patch target: {job.file}:{line_number}")
            seen.add(key)


def selected_modes(mode: str) -> list[str]:
    return ["same_size", "variable"] if mode == "both" else [mode]


def split_crlf(decoded: bytes) -> list[bytes]:
    return decoded.split(b"\r\n")


def job_source_lines(job: PatchJob) -> list[str]:
    if job.source_lines is not None:
        return [str(line) for line in job.source_lines]
    normalized = job.source.replace("\r\n", "\n").replace("\r", "\n")
    return normalized.split("\n")


def patch_decoded_bytes(decoded: bytes, jobs: list[PatchJob], mode: str) -> tuple[bytes, list[tuple[PatchJob, bytes, bytes, int]]]:
    lines = split_crlf(decoded)
    prepared: list[tuple[PatchJob, int, int, bytes, bytes, int]] = []

    for job in sorted(jobs, key=lambda item: item.line_number):
        start_index = job.line_number - 1
        end_line = job.line_end or job.line_number
        end_index = end_line - 1
        if start_index < 0 or end_index >= len(lines):
            raise SystemExit(f"{job.id}: line {job.line_number} does not exist in {job.file}")

        original_lines = lines[start_index : end_index + 1]
        source_lines = job_source_lines(job)
        if len(source_lines) != len(original_lines):
            raise SystemExit(
                f"{job.id}: source line count mismatch in {job.file}:{job.line_number}-{end_line}. "
                f"Expected {len(source_lines)}, found {len(original_lines)}."
            )
        source_bytes = [line.encode("cp932", errors="strict") for line in source_lines]
        translation_bytes = job.translation.encode("cp932", errors="strict")

        if original_lines != source_bytes:
            actual = "\r\n".join(line.decode("cp932", errors="replace") for line in original_lines)
            raise SystemExit(
                f"{job.id}: source mismatch in {job.file}:{job.line_number}-{end_line}. "
                f"Expected {source_lines!r}, found {actual!r}. Use clean original .adx files."
            )

        padding = 0
        replacement = translation_bytes
        original_block = b"\r\n".join(original_lines)
        is_block_job = job.line_end is not None or job.source_lines is not None
        if mode == "same_size":
            if is_block_job:
                raise SystemExit(f"{job.id}: range patch jobs require --mode variable")
            if len(translation_bytes) > len(original_block):
                raise SystemExit(
                    f"{job.id}: translation is {len(translation_bytes)} byte(s), "
                    f"but original line is {len(original_block)} byte(s)"
                )
            padding = len(original_block) - len(translation_bytes)
            replacement += b" " * padding

        prepared.append((job, start_index, end_index, original_block, replacement, padding))

    for job, start_index, end_index, _, replacement, _ in sorted(prepared, key=lambda item: item[1], reverse=True):
        if mode == "same_size":
            lines[start_index] = replacement
        else:
            lines[start_index : end_index + 1] = replacement.split(b"\r\n")

    result_rows = [(job, original, replacement, padding) for job, _, _, original, replacement, padding in prepared]
    return b"\r\n".join(lines), result_rows


def write_decoded_inspection(path: Path, decoded: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(decoded.decode("cp932", errors="strict"), encoding="utf-8", newline="")


def process_reinsert_file(file_name: str, jobs: list[PatchJob], source_dir: Path, out_dir: Path, modes: list[str]) -> list[PatchResult]:
    source_path = source_dir / file_name
    if not source_path.is_file():
        raise SystemExit(f"Source ADX file not found: {source_path}")

    original = source_path.read_bytes()
    decoded = decode_adx_bytes(original)
    roundtrip_ok = encode_adx_bytes(decoded) == original
    if not roundtrip_ok:
        raise SystemExit(f"{file_name}: decode/encode roundtrip failed")

    results: list[PatchResult] = []
    for mode in modes:
        patched_decoded, patched_rows = patch_decoded_bytes(decoded, jobs, mode)
        patched_encoded = encode_adx_bytes(patched_decoded)
        decoded_check = decode_adx_bytes(patched_encoded)
        decoded_check.decode("cp932", errors="strict")

        output_path = out_dir / mode / file_name
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(patched_encoded)

        inspection_path = out_dir / f"{mode}_decoded" / f"{Path(file_name).stem}.txt"
        write_decoded_inspection(inspection_path, decoded_check)

        for job, original_line, replacement, padding in patched_rows:
            translation_bytes = job.translation.encode("cp932", errors="strict")
            results.append(
                PatchResult(
                    id=job.id,
                    file=job.file,
                    mode=mode,
                    output_path=str(output_path),
                    decoded_inspection_path=str(inspection_path),
                    original_file_size=len(original),
                    patched_file_size=len(patched_encoded),
                    original_line_bytes=len(original_line),
                    translation_bytes=len(translation_bytes),
                    padding_bytes=padding,
                    roundtrip_original_ok=roundtrip_ok,
                    patched_decodes_strict_cp932=True,
                    patched_line=replacement.decode("cp932", errors="strict"),
                )
            )

    return results


def command_reinsert(args: argparse.Namespace) -> None:
    jobs = load_jobs(args.jobs)
    validate_unique_lines(jobs)

    jobs_by_file: dict[str, list[PatchJob]] = {}
    for job in jobs:
        if args.file and job.file != args.file:
            continue
        jobs_by_file.setdefault(job.file, []).append(job)

    modes = selected_modes(args.mode)
    results: list[PatchResult] = []
    for file_name, file_jobs in sorted(jobs_by_file.items()):
        results.extend(process_reinsert_file(file_name, file_jobs, args.source_dir, args.out_dir, modes))

    report_path = args.out_dir / "patch_report.json"
    write_json(report_path, [asdict(result) for result in results])
    print(f"Wrote {len(results)} patched result(s)")
    print(f"Report: {report_path}")


def command_patch(args: argparse.Namespace) -> None:
    if args.build_jobs:
        command_build_jobs(args)
    command_reinsert(args)


def command_full(args: argparse.Namespace) -> None:
    command_extract(args)
    command_build_jobs(args)
    command_reinsert(args)


def command_status(args: argparse.Namespace) -> None:
    summary_path = args.text_out / "_summary.json"
    if summary_path.is_file():
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        extracted = sum(int(row.get("translation_entries", 0)) for row in summary)
        print(f"Extraction: {len(summary)} file(s), {extracted} extracted line(s)")
    else:
        print(f"Extraction: missing {summary_path}")

    if args.corpus.is_file():
        corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
        translated = sum(1 for row in corpus if str(row.get("translation", "")).strip())
        print(f"Corpus: {len(corpus)} line(s), {translated} translated")
    else:
        print(f"Corpus: missing {args.corpus}")

    if args.jobs.is_file():
        jobs = json.loads(args.jobs.read_text(encoding="utf-8"))
        print(f"Jobs: {len(jobs)} job(s) in {args.jobs}")
    else:
        print(f"Jobs: missing {args.jobs}")


def add_source_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--source-dir", type=Path, default=Path("."), help="directory containing source .adx files")
    parser.add_argument("--file", help="optional single .adx file filter, for example s1.adx")


def add_extract_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--decoded-out", type=Path, default=DEFAULT_DECODED_DIR)
    parser.add_argument("--text-out", type=Path, default=DEFAULT_TEXT_DIR)


def add_patch_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--jobs", type=Path, default=DEFAULT_JOBS)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_PATCHED_DIR)
    parser.add_argument("--mode", choices=["same_size", "variable", "both"], default="both")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract and reinsert Megami .adx script text.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract_parser = subparsers.add_parser("extract", help="decode .adx files and create translation worklists")
    add_source_args(extract_parser)
    add_extract_args(extract_parser)
    extract_parser.set_defaults(func=command_extract)

    jobs_parser = subparsers.add_parser("build-jobs", help="create patch jobs from translated corpus entries")
    jobs_parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    jobs_parser.add_argument("--jobs", type=Path, default=DEFAULT_JOBS)
    jobs_parser.add_argument("--file", help="optional single .adx file filter, for example s1.adx")
    jobs_parser.set_defaults(func=command_build_jobs)

    reinsert_parser = subparsers.add_parser("reinsert", help="patch translated lines into clean .adx files")
    add_source_args(reinsert_parser)
    add_patch_args(reinsert_parser)
    reinsert_parser.set_defaults(func=command_reinsert)

    patch_parser = subparsers.add_parser("patch", help="optionally build jobs, then reinsert")
    add_source_args(patch_parser)
    add_patch_args(patch_parser)
    patch_parser.add_argument("--build-jobs", action="store_true", help="rebuild jobs before reinserting")
    patch_parser.set_defaults(func=command_patch)

    full_parser = subparsers.add_parser("full", help="extract, build jobs, and reinsert")
    add_source_args(full_parser)
    add_extract_args(full_parser)
    add_patch_args(full_parser)
    full_parser.set_defaults(func=command_full)

    status_parser = subparsers.add_parser("status", help="show extraction, corpus, and job counts")
    status_parser.add_argument("--text-out", type=Path, default=DEFAULT_TEXT_DIR)
    status_parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    status_parser.add_argument("--jobs", type=Path, default=DEFAULT_JOBS)
    status_parser.set_defaults(func=command_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    configure_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
