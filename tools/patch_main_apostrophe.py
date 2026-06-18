"""Patch main.exe so ASCII apostrophes are not treated as a script delimiter."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


SIGNATURE_OFFSET = 0x72F61
JUMP_OFFSET = 0x72F64
SIGNATURE = bytes.fromhex("80 FB 27 0F 84 46 02 00 00")
ORIGINAL_JUMP = bytes.fromhex("0F 84 46 02 00 00")
PATCHED_JUMP = bytes.fromhex("90 90 90 90 90 90")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hex_bytes(data: bytes) -> str:
    return " ".join(f"{byte:02X}" for byte in data)


def patch_bytes(data: bytes) -> tuple[bytes, dict[str, str]]:
    found = data[SIGNATURE_OFFSET : SIGNATURE_OFFSET + len(SIGNATURE)]
    if found != SIGNATURE:
        raise SystemExit(
            "Signature mismatch at "
            f"0x{SIGNATURE_OFFSET:X}: expected {hex_bytes(SIGNATURE)}, found {hex_bytes(found)}"
        )

    jump_start = JUMP_OFFSET
    jump_end = jump_start + len(ORIGINAL_JUMP)
    original_jump = data[jump_start:jump_end]
    if original_jump != ORIGINAL_JUMP:
        raise SystemExit(
            "Jump bytes mismatch at "
            f"0x{JUMP_OFFSET:X}: expected {hex_bytes(ORIGINAL_JUMP)}, found {hex_bytes(original_jump)}"
        )

    patched = bytearray(data)
    patched[jump_start:jump_end] = PATCHED_JUMP
    return bytes(patched), {
        "signature_offset": f"0x{SIGNATURE_OFFSET:X}",
        "patched_offset": f"0x{JUMP_OFFSET:X}",
        "verified_signature": hex_bytes(SIGNATURE),
        "original_jump": hex_bytes(ORIGINAL_JUMP),
        "patched_jump": hex_bytes(PATCHED_JUMP),
    }


def count_differences(left: bytes, right: bytes) -> int:
    return sum(1 for old, new in zip(left, right) if old != new) + abs(len(left) - len(right))


def run(args: argparse.Namespace) -> int:
    source_data = args.source.read_bytes()
    patched_data, report = patch_bytes(source_data)
    difference_count = count_differences(source_data, patched_data)
    if difference_count != len(PATCHED_JUMP):
        raise SystemExit(f"Unexpected patch size: {difference_count} byte(s) changed")

    print(f"source: {args.source}")
    print(f"output: {args.output}")
    print(f"verified signature at {report['signature_offset']}: {report['verified_signature']}")
    print(
        f"patched bytes at {report['patched_offset']}: "
        f"{report['original_jump']} -> {report['patched_jump']}"
    )
    print(f"source sha256: {sha256(source_data)}")
    print(f"patched sha256: {sha256(patched_data)}")
    print(f"changed bytes: {difference_count}")

    if args.dry_run:
        print("dry run: no file written")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(patched_data)
    print(f"wrote patched executable: {args.output}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Patch main.exe to allow ASCII apostrophes in script text.")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    return run(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
