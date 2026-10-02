"""The one failure type every module raises."""

from __future__ import annotations


class BugsError(Exception):
    """A failure that stops the command with a non-zero exit."""
