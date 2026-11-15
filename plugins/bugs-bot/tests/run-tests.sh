#!/usr/bin/env bash
# The suite's one entry point, as every plugin of the repository has one: the Python tests, then
# the hooks module's tests (hooks/tests/*.test.ts), which run only in the host's kit. Without
# `claude` the suite fails: it does not skip.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m pytest -q "$@"
claude plugin test .
