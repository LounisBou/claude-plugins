"""Atomic JSON writes, shared by the inbox, the registry and the machine files."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def write_json(path: Path, data: dict) -> None:
    """Write JSON atomically: a temp file of its own in the same directory, then rename.

    The temp name is unique, so two writers never share one; a failed write leaves none behind.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
