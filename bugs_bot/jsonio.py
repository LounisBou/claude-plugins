"""Atomic JSON writes, shared by the inbox, the registry and the machine files."""

from __future__ import annotations

import json
import os
from pathlib import Path


def write_json(path: Path, data: dict) -> None:
    """Write JSON atomically: a temp file in the same directory, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)
