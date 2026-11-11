#!/bin/bash
# /drift:install: the pinned Playwright and its Chromium that `drift shots` drives, installed once per
# machine in the shared directory core names (`<config dir>/playwright/<version>`). Idempotent: a
# complete install is left as it is; a half-done one is removed and installed again.
exec "$(dirname "$0")/skills/drift/scripts/drift.sh" install
