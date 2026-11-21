"""Typed failures, each carrying the process exit code it maps to."""


class GhError(Exception):
    code = 3
    # The HTTP status GitHub refused the call with, when it answered one.
    status = None

    def __init__(self, message):
        super().__init__(message)
        self.message = message


class UsageError(GhError):
    code = 1


class AuthError(GhError):
    code = 2


class ApiError(GhError):
    code = 3


class NotFound(GhError):
    code = 4


class RateLimited(GhError):
    code = 5
