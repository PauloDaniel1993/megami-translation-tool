"""Clean disposable translation workflow outputs while preserving completed patches."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from translation_common import configure_stdout, log


DEFAULT_REMOVE_DIRS = [
    Path("work"),
    Path("qa/reports"),
    Path("qa/screenshots"),
    Path("translations/blocks"),
    Path("translations/batches"),
    Path("translations/drafts"),
    Path("translations/repairs"),
    Path("translations/context/chunk_summaries"),
    Path("translations/context/scene_summaries"),
    Path("patch_jobs"),
]

DEFAULT_RECREATE_DIRS = [
    Path("work"),
    Path("work/corpus"),
    Path("work/decoded_adx"),
    Path("qa"),
    Path("qa/reports"),
    Path("qa/screenshots"),
    Path("translations/blocks"),
    Path("translations/batches"),
    Path("translations/drafts"),
    Path("translations/repairs"),
    Path("translations/context/chunk_summaries"),
    Path("translations/context/scene_summaries"),
    Path("patch_jobs"),
]

PRESERVED_PATHS = [
    Path("patched_adx"),
    Path("translations/approved"),
    Path("translations/manual_overrides"),
    Path("translations/context/glossary.json"),
    Path("translations/context/global_style.md"),
    Path("translations/context/characters"),
    Path("docs"),
    Path("tools"),
]


def resolve_under(root: Path, target: Path) -> Path:
    resolved = (root / target).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise SystemExit(f"Refusing to clean path outside workspace: {resolved}") from exc
    return resolved


def remove_path(path: Path, execute: bool) -> None:
    if not path.exists():
        log(f"Skip missing: {path}")
        return
    if execute:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        log(f"Removed: {path}")
    else:
        log(f"Would remove: {path}")


def recreate_dirs(root: Path, dirs: list[Path], execute: bool) -> None:
    for directory in dirs:
        path = resolve_under(root, directory)
        if execute:
            path.mkdir(parents=True, exist_ok=True)
            log(f"Ensured directory: {path}")
        else:
            log(f"Would ensure directory: {path}")


def clean(args: argparse.Namespace) -> None:
    root = Path.cwd().resolve()
    log(f"Workspace: {root}")
    if not args.execute:
        log("Dry run only. Pass --execute to remove files.")

    remove_dirs = list(DEFAULT_REMOVE_DIRS)
    recreate_dirs_list = list(DEFAULT_RECREATE_DIRS)

    if args.keep_patch_jobs:
        remove_dirs = [path for path in remove_dirs if path != Path("patch_jobs")]
        recreate_dirs_list = [path for path in recreate_dirs_list if path != Path("patch_jobs")]

    log("Preserving:")
    for path in PRESERVED_PATHS:
        log(f"  {root / path}")

    log("Cleaning disposable generated outputs")
    for directory in remove_dirs:
        remove_path(resolve_under(root, directory), args.execute)

    if args.recreate:
        log("Recreating empty workflow directories")
        recreate_dirs(root, recreate_dirs_list, args.execute)

    log("Clean complete")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Remove disposable workflow outputs while preserving completed patches "
            "under patched_adx and human-owned translation/context files."
        )
    )
    parser.add_argument("--execute", action="store_true", help="Actually remove files. Without this, only prints actions.")
    parser.add_argument("--no-recreate", dest="recreate", action="store_false", help="Do not recreate empty workflow folders.")
    parser.add_argument("--keep-patch-jobs", action="store_true", help="Preserve patch_jobs as well as patched_adx.")
    parser.set_defaults(recreate=True)
    return parser


def main() -> int:
    configure_stdout()
    clean(build_parser().parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
