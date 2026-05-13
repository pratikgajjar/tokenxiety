#!/usr/bin/env python3
"""
Make a Chrome-Web-Store-ready zip from a built extension directory.

Why this exists: `zip` on macOS races against Finder, which regenerates
`.DS_Store` files in any folder you open. Using shell `find -delete`
right before `zip` is unreliable — Finder can repopulate the metadata
file in the gap. This script reads the file list with explicit
exclusions and writes the zip in one pass.

Usage:
    python3 scripts/make-zip.py <source-dir> <output-zip>

The zip is rebuilt with the source dir's basename as the top-level
prefix inside the archive, so unpacking yields `tokenxiety/...`.
"""
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
EXCLUDE_PREFIX = ("._",)
EXCLUDE_SUFFIX = (".swp", ".swo")


def is_excluded(name: str) -> bool:
    if name in EXCLUDE_NAMES:
        return True
    if name.startswith(EXCLUDE_PREFIX):
        return True
    if name.endswith(EXCLUDE_SUFFIX):
        return True
    return False


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} <source-dir> <output-zip>", file=sys.stderr)
        return 2

    source = Path(argv[1]).resolve()
    output = Path(argv[2]).resolve()

    if not source.is_dir():
        print(f"source dir not found: {source}", file=sys.stderr)
        return 1

    top = source.name  # archive everything under this prefix
    written = 0
    skipped = 0

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(source):
            # Prune excluded directories in-place so os.walk doesn't descend.
            dirs[:] = sorted(d for d in dirs if not is_excluded(d))
            for name in sorted(files):
                if is_excluded(name):
                    skipped += 1
                    continue
                abs_path = Path(root) / name
                rel_path = abs_path.relative_to(source)
                arcname = f"{top}/{rel_path.as_posix()}"
                zf.write(abs_path, arcname)
                written += 1

    print(f"wrote {output} — {written} files (skipped {skipped} excluded)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
