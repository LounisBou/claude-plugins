#!/usr/bin/env bash
# The suite's one entry point, as every plugin of the repository has one: the Python tests.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -m pytest -q "$@"
