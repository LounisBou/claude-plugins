---
description: Wire the context tap in front of the status line and create the state directory
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user.

The script is idempotent and does three things:

1. **The gauge's tap.** Copies it into `~/.claude/claude-orchestrator/`, creates
   `ctx/`, saves the current `statusLine` object, and rewrites `statusLine.command`
   in `~/.claude/settings.json` so the tap runs first and hands the payload to the
   previous command untouched. Nothing is deleted: `settings.json` is backed up
   under `~/.claude/backups/`.
2. **The tier map**, `models.json`, with three empty bindings — and never touches
   one that already exists, because the bindings are the operator's.
3. **The terminal tooling's environment**, a private interpreter under the state
   directory with the module the app's API needs. macOS only; elsewhere it is
   skipped and every other skill still works.

Report its output, then tell the user two things: to restart their session for the
tap to take effect, and to bind `deep`, `standard` and `light` in `models.json` to
the model identifiers this host accepts. An unbound tier is not an error — the host
then chooses — but until the file is filled the routing table is advisory, and the
orchestrator should say so rather than report a wave as routed.

If the environment step reported a failure, say so plainly: the tab tooling will
refuse to run and print how to build it, and the other skills are unaffected.

$ARGUMENTS
