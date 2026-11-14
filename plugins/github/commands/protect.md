---
description: Check that the default branch refuses force-push and deletion on GitHub; "apply" puts it in place, "ci" adds the required CI check
argument-hint: "[apply] [ci]"
---

Answered by the module. Without it: run `python3 "${CLAUDE_PLUGIN_ROOT}/engine/gh.py" protect-check`
(`protect-apply` when the arguments say apply, `--require-ci` when they say ci) and report its output verbatim.
