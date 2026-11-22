---
description: Create the state directory and the short commands
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
disable-model-invocation: true
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user.

The script is idempotent and does five things:

1. **Checks the host's version**, refusing below 2.1.287 (the hooks module's
   events and API) or when it cannot be read.
2. **The state directory**, `~/.claude/claude-orchestrator/`: creates
   `measure/` (one measure file per session, the one channel external
   processes read), removes the tap's `ctx/` whole if a previous install left
   one, prunes a measure file only past 90 days and when no live session
   owns it, and removes the tap's copy, its saved object and the old gates'
   logs once no line runs the tap.
3. **The tier map**, `models.json`, with three empty bindings, and **the server
   catalogue**, `mcp.json`, empty (`{"servers": {}, "default": []}`) — and never
   touches one that already exists, because both are the operator's.
4. **settings.json: unwires the tap** a previous install may have left in front
   of the status line: restoring the saved status line object when the tap
   kept one, else stripping the tap's prefix and keeping the command that
   followed it as written, else removing the `statusLine` key if the tap was
   all it held. `settings.json` is backed up under `~/.claude/backups/`; a
   status line carrying no tap is left untouched.
5. **The shell file**, `shell/claude-plugins.sh`, copied to the state directory and sourced by
   ONE guarded line it adds to `.zshrc` or `.bashrc` (from `$SHELL`; the profile is backed up
   first): the sync at each session start keeps the copy current, so the profile changes once. No
   other line is touched; tell the user which earlier lines the output says they may delete.

It also builds **the terminal tooling's environment**, a private interpreter
under the state directory with the module the app's API needs (macOS only).

Report its output, then tell the user two things: to restart their session for
the module to take effect, and to bind `deep`, `standard` and `light` in
`models.json` to the host's family aliases (the unversioned names, never a
versioned identifier, which goes stale). An unbound tier is not an error: the
orchestrator picks the model for its work, writes the choice in the brief and tells the operator in one line at the spawn.

If the environment step failed, say so: the tab tooling refuses to run and prints how to
build it; the other skills are unaffected.

$ARGUMENTS
