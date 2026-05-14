#!/usr/bin/env python3
"""
Manifest sanity checks beyond `python3 -m json.tool`.

Right now this just enforces Chrome Web Store field-length limits that the
docs publish — but it's the kind of place to drop other invariants when we
discover them by trial and error.

Refs:
  https://developer.chrome.com/docs/extensions/reference/manifest
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Hard limits from the Chrome Web Store / extension manifest docs.
LIMITS = {
    "name":        45,   # extension name
    "short_name":  12,   # optional short name
    "description": 132,  # MUST be 132 or fewer characters
    "version":     35,   # max number of dot-separated segments x 6 digits — way more than we'll ever need
}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <path/to/manifest.json>", file=sys.stderr)
        return 2

    manifest = json.loads(Path(argv[1]).read_text())
    failures = []

    for key, limit in LIMITS.items():
        value = manifest.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            failures.append(f"{key} is not a string: {value!r}")
            continue
        if len(value) > limit:
            failures.append(
                f"{key} is {len(value)} chars (limit {limit}): {value!r}"
            )

    if failures:
        print("manifest.json failed field-length checks:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        return 1

    print(
        "manifest.json ok — "
        + ", ".join(f"{k}={len(manifest[k])}/{LIMITS[k]}" for k in LIMITS if k in manifest)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
