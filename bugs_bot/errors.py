"""The one failure type every module raises."""

from __future__ import annotations


class BugsError(Exception):
    """A failure that stops the command with a non-zero exit."""


class RateLimited(BugsError):
    """The platform refused a call for now (HTTP 429): ``retry_after`` seconds before the next one."""

    def __init__(self, message: str, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after
