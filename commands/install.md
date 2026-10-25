---
name: orchestrator-install
description: Create the state directory, unwire any tap a previous install left, and check the host's version
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user.

The script is idempotent and does four things:

1. **Checks the host's version**, refusing below 2.1.287 — the hooks module's
   events and API — and refusing when the version cannot be read at all. An
   older host loads the plugin and silently runs none of it, so the refusal is
   the honest path.
2. **The state directory**, `~/.claude/claude-orchestrator/`: creates
   `measure/` (one measure file per session, the one channel external
   processes read), removes the tap's `ctx/` whole if a previous install left
   one, and prunes a measure file only past a week and when no live session
   owns it. It also takes the tap off the status line, keeping the command
   that followed it as written, and removes the tap's copy, its saved object
   and the old gates' logs once no line runs the tap.
3. **The tier map**, `models.json`, with three empty bindings, and **the server
   catalogue**, `mcp.json`, empty (`{"servers": {}, "default": []}`) — and never
   touches one that already exists, because both are the operator's.
4. **settings.json: unwires the tap** a previous install may have left in front
   of the status line — restoring the saved status line object when the tap
   kept one, else stripping the tap's prefix and leaving the command that
   followed it spelled as it was written, else removing the `statusLine` key if
   the tap was all it held. Nothing is deleted blindly: `settings.json` is
   backed up under `~/.claude/backups/`, and a status line carrying no tap is
   left untouched.

It also builds **the terminal tooling's environment**, a private interpreter
under the state directory with the module the app's API needs. macOS only;
elsewhere it is skipped and every other skill still works.

Report its output, then tell the user two things: to restart their session for
the module to take effect, and to bind `deep`, `standard` and `light` in
`models.json` to the host's family aliases — the unversioned names it resolves
to each family's latest model, never a versioned identifier, which goes stale
when a newer model ships. An unbound tier is not an error, and until the file
is filled the orchestrator picks the model for work whose tier is unbound,
writes the choice and its reason in the brief, and tells the operator in one
line at the spawn.

If the environment step reported a failure, say so plainly: the tab tooling will
refuse to run and print how to build it, and the other skills are unaffected.

$ARGUMENTS
